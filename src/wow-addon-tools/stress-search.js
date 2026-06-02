"use strict";

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const { parseCommandLine } = require("../mplus-matrix/config");
const {
  DEFAULT_CACHE_PATH,
  buildCacheKey,
  listCachedRecords,
  loadCache,
} = require("./cache");
const { DEFAULT_LOOKUP_PROVIDER } = require("./live-provider");
const { runAddonRequestSync } = require("./sync-service");

const DEFAULT_COUNT = 30;
const DEFAULT_STRESS_ROOT = path.join(process.cwd(), "output", "search-stress");

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  npm run stress:search -- --count 30 --workers 2 --provider web",
      "  npm run stress:search -- 30 2 web",
      "  node src/wow-addon-tools/stress-search.js --count 30 --workers 2 --provider web",
      "",
      "This is a manual-only benchmark. It is not part of npm test or npm run dev.",
      "",
      "Optional flags:",
      "  --count <number>          Number of lookups to run (default: 30)",
      "  --workers <number>        Worker count to pass to the sync service",
      `  --provider <auto|web|api|off> Lookup provider (default: ${DEFAULT_LOOKUP_PROVIDER})`,
      "  --db-path <path>          Source DB to clone for the run",
      "  --run-dir <path>          Output directory for this stress run",
      "  --lookups-file <path>     JSON or text lookup list",
      "  --browser-path <path>     Browser executable override for web mode",
      "  --force <true|false>      Force fresh lookups instead of cache hits (default: true)",
      "",
      "Reports:",
      "  stress-report.json",
      "  stress-report.csv",
      "",
    ].join("\n")
  );
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null) {
    return fallback;
  }
  if (value === true || value === false) {
    return value;
  }

  const normalized = String(value).trim().toLocaleLowerCase("en-US");
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function getOptionValue(options, positionals, name, positionalIndex, fallback = null) {
  if (options[name] != null) {
    return options[name];
  }

  const envName = `npm_config_${name.replace(/-/g, "_")}`;
  if (process.env[envName] != null) {
    return process.env[envName];
  }

  return positionals[positionalIndex] ?? fallback;
}

function safeRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function normalizeLookup(input) {
  if (!input) {
    return null;
  }

  if (typeof input === "string") {
    const parts = input
      .split(/[,|]/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 3) {
      return {
        region: parts[0],
        realm: parts[1],
        characterName: parts[2],
      };
    }
    if (parts.length === 2) {
      return {
        region: "us",
        realm: parts[0],
        characterName: parts[1],
      };
    }

    const dashMatch = input.match(/^(.+)-([^-]+)$/u);
    if (dashMatch) {
      return {
        region: "us",
        realm: dashMatch[2].trim(),
        characterName: dashMatch[1].trim(),
      };
    }
    return null;
  }

  const characterName = input.characterName || input.name;
  if (!input.realm || !characterName) {
    return null;
  }

  return {
    region: input.region || "us",
    realm: input.realm,
    characterName,
    assignedRole: input.assignedRole || input.role || null,
    localizedClass: input.localizedClass || input.class || input.className || null,
  };
}

function readLookupsFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const entries = Array.isArray(parsed) ? parsed : parsed.lookups || parsed.records || [];
    return entries.map(normalizeLookup).filter(Boolean);
  }

  return trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(normalizeLookup)
    .filter(Boolean);
}

function pickLookupsFromCache(cache, count) {
  const seen = new Set();
  const records = listCachedRecords(cache)
    .filter((record) => record && record.region && record.realm && record.name)
    .sort((left, right) =>
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""), "en-US")
    );
  const lookups = [];

  for (const record of records) {
    const lookup = normalizeLookup(record);
    if (!lookup) {
      continue;
    }

    const key = buildCacheKey(lookup.region, lookup.realm, lookup.characterName);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    lookups.push(lookup);
    if (lookups.length >= count) {
      break;
    }
  }

  return lookups;
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, percent) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeDurations(statuses, totalRunDurationMs) {
  const lookupDurations = statuses
    .map((status) => Number(status.lookupDurationMs))
    .filter((value) => Number.isFinite(value));
  const queueWaitDurations = statuses
    .map((status) => Number(status.queueWaitMs))
    .filter((value) => Number.isFinite(value));
  const totalDurations = statuses
    .map((status) => Number(status.totalDurationMs))
    .filter((value) => Number.isFinite(value));
  const stateCounts = {};

  for (const status of statuses) {
    stateCounts[status.state] = (stateCounts[status.state] || 0) + 1;
  }

  return {
    completed: statuses.length,
    stateCounts,
    totalRunDurationMs,
    throughputPerMinute:
      totalRunDurationMs > 0 ? (statuses.length / totalRunDurationMs) * 60000 : null,
    lookupDurationMs: {
      avg: average(lookupDurations),
      min: lookupDurations.length ? Math.min(...lookupDurations) : null,
      p50: percentile(lookupDurations, 50),
      p90: percentile(lookupDurations, 90),
      max: lookupDurations.length ? Math.max(...lookupDurations) : null,
    },
    queueWaitMs: {
      avg: average(queueWaitDurations),
      min: queueWaitDurations.length ? Math.min(...queueWaitDurations) : null,
      p50: percentile(queueWaitDurations, 50),
      p90: percentile(queueWaitDurations, 90),
      max: queueWaitDurations.length ? Math.max(...queueWaitDurations) : null,
    },
    totalDurationMs: {
      avg: average(totalDurations),
      min: totalDurations.length ? Math.min(...totalDurations) : null,
      p50: percentile(totalDurations, 50),
      p90: percentile(totalDurations, 90),
      max: totalDurations.length ? Math.max(...totalDurations) : null,
    },
  };
}

function buildFinalStatuses(statuses) {
  const byKey = new Map();
  for (const status of statuses || []) {
    const key = status.key || buildCacheKey(status.region, status.realm, status.name || status.characterName);
    if (!status.finishedAt && status.state === "searching") {
      if (!byKey.has(key)) {
        byKey.set(key, status);
      }
      continue;
    }
    byKey.set(key, status);
  }
  return [...byKey.values()].filter((status) => status.state !== "searching" || status.finishedAt);
}

function csvEscape(value) {
  if (value == null) {
    return "";
  }
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, statuses) {
  const columns = [
    "region",
    "realm",
    "name",
    "state",
    "source",
    "workerIndex",
    "queuedAt",
    "startedAt",
    "finishedAt",
    "queueWaitMs",
    "lookupDurationMs",
    "totalDurationMs",
    "message",
  ];
  const rows = [
    columns.join(","),
    ...statuses.map((status) =>
      columns
        .map((column) => csvEscape(status[column]))
        .join(",")
    ),
  ];
  fs.writeFileSync(filePath, `${rows.join("\n")}\n`, "utf8");
}

function formatMs(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return "-";
  }
  const numeric = Number(value);
  return numeric < 1000 ? `${Math.round(numeric)}ms` : `${(numeric / 1000).toFixed(2)}s`;
}

async function main() {
  const { options, positionals } = parseCommandLine(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const count = parsePositiveInt(getOptionValue(options, positionals, "count", 0), DEFAULT_COUNT);
  const provider = getOptionValue(options, positionals, "provider", 2, DEFAULT_LOOKUP_PROVIDER);
  const rawWorkers = getOptionValue(options, positionals, "workers", 1, null);
  const workers = rawWorkers == null ? null : parsePositiveInt(rawWorkers, 1);
  const force = parseBoolean(getOptionValue(options, positionals, "force", 3, true), true);
  const sourceDbPath = path.resolve(String(getOptionValue(options, positionals, "db-path", 4, DEFAULT_CACHE_PATH)));
  const runDir = path.resolve(String(getOptionValue(options, positionals, "run-dir", 5, path.join(DEFAULT_STRESS_ROOT, safeRunId()))));
  const stressDbPath = path.join(runDir, "lnnrank-db.json");
  const outputDir = path.join(runDir, "addon-output");
  const addonsDir = path.join(runDir, "addons");
  const sourceCache = loadCache(sourceDbPath);
  const lookupsFile = getOptionValue(options, positionals, "lookups-file", 6, null);
  const browserPath = getOptionValue(options, positionals, "browser-path", 7, null);
  const lookups = lookupsFile
    ? readLookupsFile(path.resolve(String(lookupsFile)))
    : pickLookupsFromCache(sourceCache, count);

  if (lookups.length < count) {
    throw new Error(`Only found ${lookups.length} lookups, but --count requested ${count}.`);
  }

  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.dirname(stressDbPath), { recursive: true });
  fs.copyFileSync(sourceDbPath, stressDbPath);

  const requestedAt = new Date().toISOString();
  const requests = lookups.slice(0, count).map((lookup, index) => ({
    ...lookup,
    requestOrigin: "manual",
    requestSource: "stress",
    statusSource: "stress",
    source: "stress",
    force,
    updatedAt: requestedAt,
    eventId: `stress:${index + 1}:${buildCacheKey(lookup.region, lookup.realm, lookup.characterName)}`,
  }));
  const updates = [];
  const runStartedAtMs = Date.now();

  process.stdout.write(
    `Running ${requests.length} search stress lookups with provider=${provider}, workers=${workers || "default"}, force=${force}.\n`
  );

  const result = await runAddonRequestSync({
    dbPath: stressDbPath,
    outputDir,
    addonsDir,
    provider,
    browserPath,
    requests,
    workers,
    installWow: false,
    onUpdate: async (update) => {
      updates.push({
        ...update,
        observedAt: new Date().toISOString(),
      });
    },
  });

  const finishedAt = new Date().toISOString();
  const totalRunDurationMs = Date.now() - runStartedAtMs;
  const finalStatuses = buildFinalStatuses(result.statuses);
  const summary = summarizeDurations(finalStatuses, totalRunDurationMs);
  const report = {
    runId: path.basename(runDir),
    requestedAt,
    finishedAt,
    sourceDbPath,
    stressDbPath,
    outputDir,
    provider,
    workers: result.workers,
    requestedWorkers: workers,
    force,
    requestedCount: requests.length,
    summary,
    lookups: requests.map((request) => ({
      region: request.region,
      realm: request.realm,
      characterName: request.characterName,
      force: request.force,
    })),
    finalStatuses,
    statusEvents: result.statuses,
    updates,
  };

  const jsonPath = path.join(runDir, "stress-report.json");
  const csvPath = path.join(runDir, "stress-report.csv");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeCsv(csvPath, finalStatuses);

  process.stdout.write(
    [
      "",
      "Search stress summary:",
      `  completed: ${summary.completed}/${requests.length}`,
      `  states: ${JSON.stringify(summary.stateCounts)}`,
      `  run: ${formatMs(summary.totalRunDurationMs)}`,
      `  lookup avg/p50/p90/max: ${formatMs(summary.lookupDurationMs.avg)} / ${formatMs(summary.lookupDurationMs.p50)} / ${formatMs(summary.lookupDurationMs.p90)} / ${formatMs(summary.lookupDurationMs.max)}`,
      `  wait avg/p50/p90/max: ${formatMs(summary.queueWaitMs.avg)} / ${formatMs(summary.queueWaitMs.p50)} / ${formatMs(summary.queueWaitMs.p90)} / ${formatMs(summary.queueWaitMs.max)}`,
      `  throughput: ${summary.throughputPerMinute == null ? "-" : summary.throughputPerMinute.toFixed(2)} lookups/min`,
      `  report: ${jsonPath}`,
      `  csv: ${csvPath}`,
      "",
    ].join("\n")
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
