#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_LOG = String.raw`C:\Program Files (x86)\World of Warcraft\_retail_\Logs\WoWChatLog.txt`;

function parseArgs(argv) {
  const args = {
    logPath: DEFAULT_LOG,
    durationMs: 60_000,
    settleMs: 1_000,
    channelContains: [],
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
      args.channelContains.push(String(argv[index + 1]).toLowerCase());
      index += 1;
      continue;
    }
  }

  return args;
}

function parseLineTimestamp(line, now) {
  const match = line.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+/);
  if (!match) {
    return null;
  }

  const [, monthText, dayText, hourText, minuteText, secondText, millisText] = match;
  return new Date(
    now.getFullYear(),
    Number(monthText) - 1,
    Number(dayText),
    Number(hourText),
    Number(minuteText),
    Number(secondText),
    Number(millisText),
  );
}

function classifyLine(line) {
  const channelMatch = line.match(/^\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\[(\d+)\.\s+([^\]]+)\]/);
  if (channelMatch) {
    return {
      kind: "channel",
      channelNumber: Number(channelMatch[1]),
      channelName: channelMatch[2],
      summary: `#${channelMatch[1]} ${channelMatch[2]}`,
    };
  }

  if (line.includes(" says: ")) {
    return { kind: "say", summary: "say" };
  }
  if (line.includes(" yells: ")) {
    return { kind: "yell", summary: "yell" };
  }
  if (line.includes(" whispers: ")) {
    return { kind: "whisper", summary: "whisper" };
  }

  return { kind: "other", summary: "other" };
}

function summarize(values) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const average = sum / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];

  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    average,
    median,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const initialStats = fs.statSync(args.logPath);
  let offset = initialStats.size;
  let partial = "";
  const latencySamples = [];
  const gapSamples = [];
  const channelCounts = new Map();
  let lastArrivalAt = null;

  console.log(JSON.stringify({
    phase: "start",
    logPath: args.logPath,
    startOffset: offset,
    durationMs: args.durationMs,
    settleMs: args.settleMs,
    channelContains: args.channelContains,
  }));

  function shouldKeepLine(line) {
    if (!args.channelContains.length) {
      return true;
    }
    const lowered = line.toLowerCase();
    return args.channelContains.some((needle) => lowered.includes(needle));
  }

  function processChunk(chunk) {
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim() || !shouldKeepLine(line)) {
        continue;
      }

      const arrivalAt = new Date();
      const loggedAt = parseLineTimestamp(line, arrivalAt);
      const info = classifyLine(line);
      channelCounts.set(info.summary, (channelCounts.get(info.summary) ?? 0) + 1);

      if (lastArrivalAt) {
        const gapMs = arrivalAt.getTime() - lastArrivalAt.getTime();
        if (gapMs > 1000) {
          gapSamples.push(gapMs);
        }
      }
      lastArrivalAt = arrivalAt;

      let latencyMs = null;
      if (loggedAt) {
        latencyMs = arrivalAt.getTime() - loggedAt.getTime();
        if (latencyMs >= -2000 && latencyMs <= 10 * 60 * 1000) {
          latencySamples.push(latencyMs);
        }
      }

      console.log(JSON.stringify({
        phase: "line",
        arrivalAt: arrivalAt.toISOString(),
        loggedAt: loggedAt ? loggedAt.toISOString() : null,
        latencyMs,
        channel: info.summary,
        line,
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
    try {
      await pollOnce();
    } catch (error) {
      console.error(JSON.stringify({
        phase: "error",
        message: String((error && error.message) || error),
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, args.settleMs));
  }

  const latencySummary = summarize(latencySamples);
  const gapSummary = summarize(gapSamples);
  console.log(JSON.stringify({
    phase: "summary",
    latencySummary,
    gapSummary,
    channelCounts: Object.fromEntries(
      [...channelCounts.entries()].sort((left, right) => right[1] - left[1]),
    ),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
