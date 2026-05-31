#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_DIR = String.raw`C:\Program Files (x86)\World of Warcraft\_retail_\Screenshots`;

function parseArgs(argv) {
  const args = {
    dirPath: DEFAULT_DIR,
    durationMs: 60_000,
    pollMs: 250,
    stablePolls: 3,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dir" && argv[index + 1]) {
      args.dirPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--seconds" && argv[index + 1]) {
      args.durationMs = Math.max(1, Number(argv[index + 1])) * 1000;
      index += 1;
      continue;
    }
    if (token === "--poll-ms" && argv[index + 1]) {
      args.pollMs = Math.max(50, Number(argv[index + 1]));
      index += 1;
      continue;
    }
    if (token === "--stable-polls" && argv[index + 1]) {
      args.stablePolls = Math.max(1, Number(argv[index + 1]));
      index += 1;
      continue;
    }
  }

  return args;
}

async function waitForStableFile(filePath, pollMs, stablePolls) {
  let stableCount = 0;
  let lastSize = -1;
  let lastStats = null;
  while (stableCount < stablePolls) {
    const stats = await fs.promises.stat(filePath);
    if (stats.size === lastSize) {
      stableCount += 1;
    } else {
      stableCount = 0;
      lastSize = stats.size;
    }
    lastStats = stats;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return lastStats;
}

async function main() {
  const args = parseArgs(process.argv);
  const known = new Set((await fs.promises.readdir(args.dirPath)).map((name) => name.toLowerCase()));
  const latencies = [];

  console.log(JSON.stringify({
    phase: "start",
    dirPath: args.dirPath,
    durationMs: args.durationMs,
    pollMs: args.pollMs,
    stablePolls: args.stablePolls,
    knownCount: known.size,
  }));

  const startedAt = Date.now();
  while (Date.now() - startedAt < args.durationMs) {
    const names = await fs.promises.readdir(args.dirPath);
    for (const name of names) {
      const lowered = name.toLowerCase();
      if (known.has(lowered)) {
        continue;
      }
      known.add(lowered);
      const filePath = path.join(args.dirPath, name);
      const noticedAt = new Date();
      const stableStats = await waitForStableFile(filePath, args.pollMs, args.stablePolls);
      const stableAt = new Date();
      const writeLagMs = stableAt.getTime() - stableStats.mtime.getTime();
      const stabilizeAfterNoticeMs = stableAt.getTime() - noticedAt.getTime();
      latencies.push(stabilizeAfterNoticeMs);
      console.log(JSON.stringify({
        phase: "file",
        filePath,
        noticedAt: noticedAt.toISOString(),
        stableAt: stableAt.toISOString(),
        mtime: stableStats.mtime.toISOString(),
        size: stableStats.size,
        writeLagMs,
        stabilizeAfterNoticeMs,
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, args.pollMs));
  }

  const summary = latencies.length
    ? {
        count: latencies.length,
        min: Math.min(...latencies),
        max: Math.max(...latencies),
        average: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      }
    : null;
  console.log(JSON.stringify({ phase: "summary", summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
