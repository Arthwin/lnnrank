"use strict";

function parseArgs(argv) {
  const options = {
    channel: "",
    intervalMs: 2000,
    message: "boot",
    prefix: "LNNRANK",
    session: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return options;
}

function randomId(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  while (value.length < length) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

const options = parseArgs(process.argv.slice(2));
const state = {
  channel: String(options.channel || `lnnrank${randomId(12)}`).replace(/[^a-zA-Z0-9]/g, "").slice(0, 30),
  currentEnvelope: "",
  history: [],
  intervalMs: Number.isFinite(Number(options["interval-ms"])) ? Math.max(0, Number(options["interval-ms"])) : 2000,
  keepAlive: null,
  prefix: String(options.prefix || "LNNRANK"),
  sequence: 0,
  session: String(options.session || randomId(10)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20),
};

function buildEnvelope(message) {
  state.sequence += 1;
  return [
    state.prefix,
    `channel=${state.channel}`,
    `session=${state.session}`,
    `seq=${state.sequence}`,
    `message=${message}`,
    `timestamp=${new Date().toISOString()}`,
  ].join("|");
}

function refreshKeepAlive(envelope) {
  const utf8 = Buffer.from(envelope, "utf8");
  const utf16 = Buffer.from(envelope, "utf16le");
  const channelUtf16 = Buffer.from(state.channel, "utf16le");

  state.keepAlive = {
    strings: Array.from({ length: 96 }, (_, index) => `${envelope}|copy=${index}`),
    utf8Buffers: Array.from({ length: 48 }, () => Buffer.from(utf8)),
    utf16Buffers: Array.from({ length: 48 }, () => Buffer.from(utf16)),
    framedBlocks: Array.from({ length: 24 }, (_, index) =>
      Buffer.concat([
        Buffer.from(`FRAME${index}|`, "utf8"),
        channelUtf16,
        Buffer.from([0x00, 0x00]),
        utf16,
      ])
    ),
  };
}

function publish(message, reason) {
  const envelope = buildEnvelope(String(message || "empty"));
  state.currentEnvelope = envelope;
  state.history.unshift(envelope);
  state.history = state.history.slice(0, 32);
  refreshKeepAlive(envelope);
  process.stdout.write(`[${reason}] ${envelope}\n`);
}

publish(String(options.message || "boot"), "start");
process.stdout.write(`PID=${process.pid}\n`);
process.stdout.write(`CHANNEL=${state.channel}\n`);
process.stdout.write(`SESSION=${state.session}\n`);
process.stdout.write("Type a line and press Enter to rotate the in-memory payload.\n");

if (state.intervalMs > 0) {
  setInterval(() => {
    publish(`auto-${state.sequence + 1}`, "tick");
  }, state.intervalMs);
}

process.stdin.setEncoding("utf8");
process.stdin.resume();

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    publish(trimmed, "stdin");
  }
});
