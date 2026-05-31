#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_LOG = String.raw`C:\Program Files (x86)\World of Warcraft\_retail_\Logs\WoWChatLog.txt`;
const DEFAULT_CHANNEL = "wclbridge";
const DEFAULT_PREFIX = "WCLMPLUS|";

function parseArgs(argv) {
  const args = {
    logPath: DEFAULT_LOG,
    durationMs: 60_000,
    settleMs: 250,
    channelName: DEFAULT_CHANNEL,
    prefix: DEFAULT_PREFIX,
    fromStart: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--log" && argv[index + 1]) {
      args.logPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--seconds" && argv[index + 1]) {
      args.durationMs = Math.max(1, Number(argv[index + 1])) * 1000;
      index += 1;
      continue;
    }
    if (token === "--settle-ms" && argv[index + 1]) {
      args.settleMs = Math.max(50, Number(argv[index + 1]));
      index += 1;
      continue;
    }
    if (token === "--channel" && argv[index + 1]) {
      args.channelName = String(argv[index + 1]).toLowerCase();
      index += 1;
      continue;
    }
    if (token === "--prefix" && argv[index + 1]) {
      args.prefix = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--from-start") {
      args.fromStart = true;
      continue;
    }
  }

  return args;
}

function tryParseBridgeMessage(line, expectedChannelName, prefix) {
  const match = line.match(/^\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\[(\d+)\.\s+([^\]]+)\]\s+([^:]+):\s+(.*)$/);
  if (!match) {
    return null;
  }

  const [, channelNumberText, channelName, sender, message] = match;
  if (String(channelName).toLowerCase() !== expectedChannelName) {
    return null;
  }
  if (!message.startsWith(prefix)) {
    return null;
  }

  const payload = message.slice(prefix.length).split("|");
  const [region = "", realm = "", name = "", source = "world", nonce = ""] = payload;
  if (!region || !realm || !name) {
    return null;
  }

  return {
    channelNumber: Number(channelNumberText),
    channelName,
    sender,
    message,
    lookup: {
      region: region.toLowerCase(),
      realm,
      name,
      source,
      nonce,
      normalizedKey: `${region.toLowerCase()}:${realm.toLowerCase()}:${name.toLowerCase()}`,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const initialStats = fs.statSync(args.logPath);
  let offset = args.fromStart ? 0 : initialStats.size;
  let partial = "";
  const seen = new Set();
  const queue = [];

  console.log(JSON.stringify({
    phase: "start",
    logPath: args.logPath,
    channelName: args.channelName,
    prefix: args.prefix,
    startOffset: offset,
    durationMs: args.durationMs,
    fromStart: args.fromStart,
  }));

  function processChunk(chunk) {
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? "";

    for (const line of lines) {
      const parsed = tryParseBridgeMessage(line, args.channelName, args.prefix);
      if (!parsed) {
        continue;
      }

      const dedupeKey = `${parsed.lookup.normalizedKey}|${parsed.lookup.source}|${parsed.lookup.nonce}`;
      if (seen.has(dedupeKey)) {
        console.log(JSON.stringify({ phase: "duplicate", dedupeKey, line }));
        continue;
      }

      seen.add(dedupeKey);
      queue.push(parsed.lookup);
      console.log(JSON.stringify({
        phase: "queued",
        dedupeKey,
        lookup: parsed.lookup,
        sender: parsed.sender,
        channel: `${parsed.channelNumber}. ${parsed.channelName}`,
      }));
    }
  }

  async function pollOnce() {
    const stats = fs.statSync(args.logPath);
    if (stats.size <= offset) {
      return;
    }

    const stream = fs.createReadStream(args.logPath, {
      start: offset,
      end: stats.size - 1,
      encoding: "utf8",
    });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    offset = stats.size;
    processChunk(chunks.join(""));
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < args.durationMs) {
    await pollOnce();
    await new Promise((resolve) => setTimeout(resolve, args.settleMs));
  }

  console.log(JSON.stringify({
    phase: "summary",
    queueLength: queue.length,
    queue,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
