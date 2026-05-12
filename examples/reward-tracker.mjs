// ValidatorRewarded reward tracker — gRPC version of the original
// 
//
// Setup:
//   npm install
//   node reward-tracker.mjs                # localhost TCP, default proto
//   node reward-tracker.mjs 1.2.3.4:10000  # remote target
//
// Requires Node >= 18 (for the global Buffer/import.meta.url usage).
// Assumes MON has 18 decimals (native token convention).

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GRPC_TARGET = process.argv[2] || "127.0.0.1:10000";
const PROTO_PATH =
  process.argv[3] ||
  path.resolve(__dirname, "../../grpc-proto/proto/monad.proto");
// x-token via env when the server is started with --x-token. argv stays
// positional (target, proto) for backwards-compat with users from before
// auth landed; pass MONAD_X_TOKEN=... if your server requires it.
const X_TOKEN = process.env.MONAD_X_TOKEN || null;

const STAKING_ADDR = "0x0000000000000000000000000000000000001000";
const VALIDATOR_REWARDED_TOPIC =
  "0x3a420a01486b6b28d6ae89c51f5c3bde3e0e74eecbb646a0c481ccba3aae3754";

// Switch to "BLOCK_STAGE_FINALIZED" for accounting (~800ms latency, no
// reorg risk). Note: as of Phase 4d server still gates min_stage only on
// UpdateBlockMeta; for TxnLog updates the gate becomes effective in Phase 5.
const MIN_STAGE = "BLOCK_STAGE_PROPOSED";

// proto-loader options:
//   keepCase     — keep snake_case field names so update.update_oneof
//                  stays exactly as the proto declares it
//   longs:String — uint64 values come through as strings (BigInt-compatible)
//   enums:String — BlockStage values come through as e.g. "BLOCK_STAGE_PROPOSED"
//   oneofs:true  — adds an `update_oneof: "txn_log"` discriminator field
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef);
const Monad = proto.monad.grpc.v1.Monad;

const client = new Monad(GRPC_TARGET, grpc.credentials.createInsecure());

// One named filter: matches every TxnLog whose address is the staking
// precompile AND whose topic0 is the ValidatorRewarded signature. The
// server echoes the filter name ("validator_rewards") back in
// SubscribeUpdate.filters — usable for routing if you add more named
// filters later.
const SUBSCRIBE_REQUEST = {
  logs: {
    validator_rewards: {
      address: [STAKING_ADDR],
      topic0: [VALIDATOR_REWARDED_TOPIC],
      topic1: [],
      topic2: [],
    },
  },
  block_meta: {},
  block_end: {},
  transactions: {},
  call_frames: {},
  state_access: {},
  min_stage: MIN_STAGE,
};

/** @type {Map<number, {address: string, count: number, totalWei: bigint, lastEpoch: number, lastBlock: number}>} */
const stats = new Map();
let totalEvents = 0;
let connected = false;
const startMs = Date.now();
let dirty = true;
/** @type {grpc.ClientDuplexStream<unknown, unknown> | null} */
let stream = null;

function formatMON(wei) {
  const WAD = 10n ** 18n;
  const whole = wei / WAD;
  const frac = wei % WAD;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
  return `${whole.toString()}.${fracStr}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function handleLog(log) {
  
  const topics = log.topics || [];
  if (topics.length < 3) return;
  if ((log.address || "").toLowerCase() !== STAKING_ADDR) return;
  if (topics[0].toLowerCase() !== VALIDATOR_REWARDED_TOPIC) return;

  // topics[1] = validatorId  (uint64 left-padded into 32 bytes)
  // topics[2] = validatorAddr (20 bytes left-padded into 32 bytes)
  // data      = amount (32 bytes) || epoch (32 bytes)
  const validatorId = Number(BigInt(topics[1]));
  const validatorAddr = "0x" + topics[2].slice(2).slice(24);

  const dataHex = (log.data || "").slice(2);
  if (dataHex.length < 128) return;

  const amountWei = BigInt("0x" + dataHex.slice(0, 64));
  const epoch = Number(BigInt("0x" + dataHex.slice(64, 128)));
  const block = Number(log.block_number || 0);

  let row = stats.get(validatorId);
  if (!row) {
    row = {
      address: validatorAddr,
      count: 0,
      totalWei: 0n,
      lastEpoch: 0,
      lastBlock: 0,
    };
    stats.set(validatorId, row);
  }
  row.address = validatorAddr;
  row.count += 1;
  row.totalWei += amountWei;
  if (epoch > row.lastEpoch) row.lastEpoch = epoch;
  if (block > row.lastBlock) row.lastBlock = block;

  totalEvents += 1;
  dirty = true;
}

function render() {
  if (!dirty) return;
  dirty = false;

  const lines = [
    `Monad ValidatorRewarded tracker (gRPC)  |  target=${GRPC_TARGET}  |  ${
      connected ? "CONNECTED" : "disconnected"
    }  |  stage=${MIN_STAGE}  |  events=${totalEvents}  |  uptime=${formatUptime(
      Date.now() - startMs
    )}`,
    "",
  ];

  if (stats.size === 0) {
    lines.push("waiting for events…");
  } else {
    const header = [
      "VALIDATOR".padEnd(10),
      "ADDRESS".padEnd(42),
      "COUNT".padStart(7),
      "TOTAL (MON)".padStart(22),
      "LAST EPOCH".padStart(11),
      "LAST BLOCK".padStart(12),
    ].join("  ");
    lines.push(header, "-".repeat(header.length));
    const sorted = [...stats.entries()].sort((a, b) => {
      if (a[1].totalWei === b[1].totalWei) return 0;
      return a[1].totalWei > b[1].totalWei ? -1 : 1;
    });
    for (const [id, row] of sorted) {
      lines.push(
        [
          String(id).padEnd(10),
          row.address.padEnd(42),
          String(row.count).padStart(7),
          formatMON(row.totalWei).padStart(22),
          String(row.lastEpoch).padStart(11),
          String(row.lastBlock).padStart(12),
        ].join("  ")
      );
    }
  }

  process.stdout.write("\x1b[H\x1b[2J" + lines.join("\n") + "\n");
}

function connect() {
  connected = false;
  dirty = true;

  const metadata = new grpc.Metadata();
  if (X_TOKEN) metadata.set("x-token", X_TOKEN);
  stream = client.Subscribe(metadata);

  stream.on("data", (update) => {
    if (!connected) {
      connected = true;
      dirty = true;
    }
    if (update.update_oneof === "txn_log" && update.txn_log) {
      handleLog(update.txn_log);
    }
    // Other variants (block_meta, txn_header, ping/pong, …) are ignored
    // here — the named log filter is the only one we asked for.
  });

  const onDown = (err) => {
    if (!connected) return;
    connected = false;
    dirty = true;
    if (err) {
      process.stderr.write(`stream down: ${err.code || ""} ${err.message || err}\n`);
    }
    setTimeout(connect, 2000);
  };
  stream.on("error", onDown);
  stream.on("end", () => onDown(undefined));

  stream.write(SUBSCRIBE_REQUEST);
}

process.on("SIGINT", () => {
  try {
    stream?.cancel();
  } catch {}
  process.stdout.write("\n");
  process.exit(0);
});

setInterval(render, 500);
render();
connect();
