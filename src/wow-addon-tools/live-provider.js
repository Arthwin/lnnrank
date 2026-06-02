"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { formatIsoTimestamp } = require("../mplus-matrix/utils");
const { WclClient, WclRateLimitError } = require("../mplus-matrix/wcl-client");
const { extractZoneStats } = require("../mplus-matrix/zone-rankings");
const { normalizeText, slugifyRealm } = require("../mplus-matrix/normalization");
const {
  detectSpecInfoFromText,
  getPreferredMetricForRole,
  getSpecInfo,
  normalizeRoleValue,
  resolveRoleForCharacterContext,
} = require("../shared/wow-specs");
const { buildDerivedPresentation, decorateDungeonArray } = require("../shared/wow-performance");
const { buildCharacterRecord } = require("./lnnrank-bridge");

const DEFAULT_LOOKUP_PROVIDER = "auto";
const SUPPORTED_LOOKUP_PROVIDERS = new Set(["auto", "web", "api", "off"]);
const DEFAULT_WEB_DATA_TIMEOUT_MS = Math.max(
  10000,
  Number.parseInt(process.env.WCL_WEB_DATA_TIMEOUT_MS || "15000", 10) || 15000
);
const DEFAULT_SHARED_BROWSER_IDLE_MS = Math.max(
  10000,
  Number.parseInt(process.env.WCL_WEB_BROWSER_IDLE_MS || "120000", 10) || 120000
);
const DEFAULT_BROWSER_CANDIDATES = [
  process.env.WCL_WEB_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
let sharedWebSessionState = null;

const CHARACTER_QUERY = `
  query CharacterLookup(
    $name: String!,
    $serverSlug: String!,
    $serverRegion: String!,
    $zoneId: Int!,
    $metric: CharacterPageRankingMetricType!
  ) {
    characterData {
      character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
        id
        canonicalID
        name
        hidden
        server {
          name
          slug
          normalizedName
          region {
            name
            slug
            compactName
          }
        }
        zoneRankings(
          zoneID: $zoneId,
          metric: $metric,
          timeframe: Historical,
          includePrivateLogs: false
        )
      }
    }
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

const CHARACTER_DUAL_METRIC_QUERY = `
  query CharacterLookupDualMetric(
    $name: String!,
    $serverSlug: String!,
    $serverRegion: String!,
    $zoneId: Int!,
    $scoreMetric: CharacterPageRankingMetricType!,
    $parseMetric: CharacterPageRankingMetricType!
  ) {
    characterData {
      character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
        id
        canonicalID
        name
        hidden
        server {
          name
          slug
          normalizedName
          region {
            name
            slug
            compactName
          }
        }
        scoreRankings: zoneRankings(
          zoneID: $zoneId,
          metric: $scoreMetric,
          timeframe: Historical,
          includePrivateLogs: false
        )
        parseRankings: zoneRankings(
          zoneID: $zoneId,
          metric: $parseMetric,
          timeframe: Historical,
          includePrivateLogs: false
        )
      }
    }
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

function resolveLookupProvider(value) {
  const provider = String(value || process.env.WCL_LOOKUP_PROVIDER || DEFAULT_LOOKUP_PROVIDER).toLowerCase();
  if (!SUPPORTED_LOOKUP_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported lookup provider "${provider}". Expected one of: auto, web, api, off.`);
  }
  return provider;
}

function hasApiCredentials() {
  return Boolean(process.env.WCL_CLIENT_ID && process.env.WCL_CLIENT_SECRET);
}

async function warmWclApiAccessToken() {
  if (!hasApiCredentials()) {
    return false;
  }
  const client = new WclClient();
  await client.getAccessToken();
  return true;
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (normalized === "") {
      return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cleanDungeonName(value) {
  return normalizeText(String(value || "").split("\n")[0]);
}

function normalizeLookupInput(input = {}) {
  const normalized = {
    region: normalizeText(input.region || "us").toLocaleLowerCase("en-US"),
    realm: normalizeText(input.realm || ""),
    name: normalizeText(input.name || input.characterName || ""),
  };
  const roleHint = normalizeRoleHint(input.roleHint || input.assignedRole || input.role || null);
  const classNameHint = normalizeText(input.classNameHint || input.localizedClass || input.class || "") || null;
  if (roleHint) {
    normalized.roleHint = roleHint;
  }
  if (classNameHint) {
    normalized.classNameHint = classNameHint;
  }
  return normalized;
}

function normalizeRoleHint(value) {
  return normalizeRoleValue(value);
}

function parseBestPercent(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function parseDungeonLevel(value) {
  if (value == null) {
    return null;
  }

  const text = String(value);
  const explicitLevelMatch = text.match(/(?:^|\b)Level\s*\+?(\d+)\b/i);
  if (explicitLevelMatch) {
    return Number(explicitLevelMatch[1]);
  }

  const timedMatch = text.match(/\(\+(\d+)\)/);
  if (timedMatch) {
    return Number(timedMatch[1]);
  }

  const plainMatch = text.match(/^\s*\+?(\d+)\s*$/);
  if (plainMatch) {
    return Number(plainMatch[1]);
  }

  return null;
}

function formatDungeonLevelText(level) {
  if (typeof level !== "number" || !Number.isFinite(level)) {
    return null;
  }
  return `+${Math.floor(level)}`;
}

function buildRecordFromWebSnapshot(snapshot, lookup, options = {}) {
  const score =
    toNumber(snapshot.allStarPoints) ??
    toNumber(snapshot.score) ??
    null;
  const specInfo = detectSpecInfoFromText(snapshot.text || "");
  const dungeons = {};

  for (const row of snapshot.rows || []) {
    if (!Array.isArray(row) || row.length < 7) {
      continue;
    }

    const name = cleanDungeonName(row[0]);
    if (!name || /^Dungeon$/i.test(name) || /^Points$/i.test(name)) {
      continue;
    }

    const localRowMode = options.rowMode || null;
    const looksLikeByLevel =
      row.length >= 8 &&
      /^-?\d+$/.test(String(row[1] || "").trim()) &&
      /^\d+:\d{2}/.test(String(row[2] || "").trim());
    const byLevelShape = localRowMode === "byLevel" || (localRowMode == null && looksLikeByLevel);

    const bestPercent = byLevelShape ? parseBestPercent(row[7]) : parseBestPercent(row[1]);
    const points = byLevelShape ? toNumber(row[4]) : toNumber(row[6]) ?? toNumber(row[2]);
    const highestLevel = byLevelShape ? parseDungeonLevel(row[1]) : parseDungeonLevel(row[4]);
    dungeons[slugifyRealm(name)] = {
      name,
      bestPercent,
      points,
      highestLevel,
      highestLevelPoints: byLevelShape ? points : null,
      highestLevelText: byLevelShape ? null : formatDungeonLevelText(highestLevel),
    };
  }

  return buildCharacterRecord({
    region: lookup.region,
    realm: snapshot.realm || lookup.realm,
    name: snapshot.name || lookup.name,
    score,
    parseMetric: options.parseMetric || options.metric || "playerscore",
    specName: specInfo.specName,
    className: specInfo.className,
    role: specInfo.role,
    updatedAt: formatIsoTimestamp(),
    wclCharacterId: null,
    dungeons,
  });
}

function recordNeedsWebEnrichment(record) {
  if (!record || typeof record !== "object") {
    return true;
  }

  if (toNumber(record.score) == null) {
    return true;
  }

  const dungeons = Array.isArray(record.dungeons) ? record.dungeons : [];
  if (!dungeons.length) {
    return true;
  }

  const hasAnyHighestLevel = dungeons.some((dungeon) => {
    if (!dungeon || typeof dungeon !== "object") {
      return false;
    }

    return (
      (typeof dungeon.highestLevel === "number" && Number.isFinite(dungeon.highestLevel)) ||
      (typeof dungeon.highestLevelText === "string" && dungeon.highestLevelText.trim() !== "")
    );
  });

  return !hasAnyHighestLevel;
}

function mergeMetricRecord(baseRecord, metricRecord) {
  if (!metricRecord) {
    return baseRecord;
  }
  if (!baseRecord) {
    return metricRecord;
  }

  const mergedDungeons = new Map();
  const metricHasRoleSpecificParses =
    metricRecord.parseMetric && metricRecord.parseMetric !== "playerscore";
  for (const dungeon of baseRecord.dungeons || []) {
    mergedDungeons.set(dungeon.slug, {
      ...dungeon,
      bestPercent: metricHasRoleSpecificParses ? null : dungeon.bestPercent ?? null,
      points: metricHasRoleSpecificParses ? null : dungeon.points ?? null,
    });
  }
  for (const dungeon of metricRecord.dungeons || []) {
    if (!dungeon || !dungeon.slug) {
      continue;
    }
    const existing = mergedDungeons.get(dungeon.slug) || {};
      mergedDungeons.set(dungeon.slug, {
        ...existing,
        ...dungeon,
        bestPercent: dungeon.bestPercent != null ? dungeon.bestPercent : existing.bestPercent ?? null,
        points: dungeon.points != null ? dungeon.points : existing.points ?? null,
        highestLevel: dungeon.highestLevel != null ? dungeon.highestLevel : existing.highestLevel ?? null,
        highestLevelText:
          dungeon.highestLevelText != null ? dungeon.highestLevelText : existing.highestLevelText ?? null,
        specName: dungeon.specName != null ? dungeon.specName : existing.specName ?? null,
        className: dungeon.className != null ? dungeon.className : existing.className ?? null,
        role: dungeon.role != null ? dungeon.role : existing.role ?? null,
      });
  }

  const mergedRecord = {
    ...baseRecord,
    specName: baseRecord.specName || metricRecord.specName || null,
    className: baseRecord.className || metricRecord.className || null,
    role: baseRecord.role || metricRecord.role || null,
    parseMetric: metricRecord.parseMetric || baseRecord.parseMetric || "playerscore",
    dungeons: decorateDungeonArray([...mergedDungeons.values()].sort((left, right) =>
      String(left.label || left.name || left.slug).localeCompare(
        String(right.label || right.name || right.slug),
        "en-US"
      )
    )),
  };

  return {
    ...mergedRecord,
    presentation: buildDerivedPresentation(mergedRecord),
  };
}

function mergeLevelRecord(baseRecord, levelRecord) {
  if (!levelRecord) {
    return baseRecord;
  }
  if (!baseRecord) {
    return levelRecord;
  }

  const mergedDungeons = new Map();
  for (const dungeon of baseRecord.dungeons || []) {
    mergedDungeons.set(dungeon.slug, { ...dungeon });
  }
  for (const dungeon of levelRecord.dungeons || []) {
    if (!dungeon || !dungeon.slug) {
      continue;
    }
    const existing = mergedDungeons.get(dungeon.slug) || {};
    mergedDungeons.set(dungeon.slug, {
      ...existing,
      slug: dungeon.slug,
      label: existing.label || dungeon.label || null,
      name: existing.name || dungeon.name || dungeon.slug,
      highestLevelPoints:
        dungeon.highestLevelPoints != null ? dungeon.highestLevelPoints : existing.highestLevelPoints ?? null,
      highestLevel: dungeon.highestLevel != null ? dungeon.highestLevel : existing.highestLevel ?? null,
      highestLevelText:
        dungeon.highestLevelText != null ? dungeon.highestLevelText : existing.highestLevelText ?? null,
      highestLevelColorHex:
        dungeon.highestLevelColorHex != null ? dungeon.highestLevelColorHex : existing.highestLevelColorHex ?? null,
    });
  }

  const mergedRecord = {
    ...baseRecord,
    dungeons: decorateDungeonArray([...mergedDungeons.values()].sort((left, right) =>
      String(left.label || left.name || left.slug).localeCompare(
        String(right.label || right.name || right.slug),
        "en-US"
      )
    )),
  };

  return {
    ...mergedRecord,
    presentation: buildDerivedPresentation(mergedRecord),
  };
}

function stripRoleSpecificFallbackData(baseRecord, preferredMetric) {
  if (!baseRecord || preferredMetric == null || preferredMetric === "playerscore") {
    return baseRecord;
  }

  const strippedRecord = {
    ...baseRecord,
    parseMetric: preferredMetric,
    dungeons: decorateDungeonArray((baseRecord.dungeons || []).map((dungeon) => ({
      ...dungeon,
      bestPercent: null,
      points: null,
    }))),
  };

  return {
    ...strippedRecord,
    presentation: buildDerivedPresentation(strippedRecord),
  };
}

function findBrowserExecutable(explicitPath) {
  const candidates = [explicitPath, ...DEFAULT_BROWSER_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not find Chrome or Edge for web lookups. Set WCL_WEB_BROWSER to a browser executable path.");
}

async function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Browser devtools request failed (${response.status}).`);
  }
  return response.json();
}

async function createBrowserConnection(options = {}) {
  const browserExecutable = findBrowserExecutable(options.browserPath);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcl-browser-"));
  const port = 9300 + Math.floor(Math.random() * 400);
  const browserProcess = spawn(
    browserExecutable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--start-minimized",
      "--window-position=-32000,-32000",
      "about:blank",
    ],
    {
      detached: false,
      stdio: "ignore",
    }
  );

  let webSocketDebuggerUrl = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find((entry) => entry.type === "page");
      if (page && page.webSocketDebuggerUrl) {
        webSocketDebuggerUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(1000);
  }

  if (!webSocketDebuggerUrl) {
    try {
      browserProcess.kill();
    } catch {}
    throw new Error("Could not connect to the browser devtools target.");
  }

  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let sequence = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const onMessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id !== id) {
          return;
        }
        socket.removeEventListener("message", onMessage);
        if (data.error) {
          reject(new Error(JSON.stringify(data.error)));
          return;
        }
        resolve(data.result);
      };

      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable", {});
  await send("Runtime.enable", {});

  return {
    send,
    async close() {
      try {
        socket.close();
      } catch {}
      try {
        browserProcess.kill();
      } catch {}
      await sleep(500);
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

async function readWebSnapshotFromSend(send, lookup, options = {}) {
  const normalizedLookup = normalizeLookupInput(lookup);
  const metric = options.metric == null ? null : String(options.metric);
  const url = new URL(
    `https://www.warcraftlogs.com/character/${normalizedLookup.region}/${slugifyRealm(
      normalizedLookup.realm
    )}/${encodeURIComponent(normalizedLookup.name)}`
  );
  url.searchParams.set("zone", "47");
  if (metric) {
    url.searchParams.set("metric", metric);
  }
  const timeoutMs = Math.max(
    10000,
    Number.parseInt(String(options.timeoutMs || DEFAULT_WEB_DATA_TIMEOUT_MS), 10) || DEFAULT_WEB_DATA_TIMEOUT_MS
  );
  const deadline = Date.now() + timeoutMs;

  await send("Page.navigate", {
    url: String(url),
  });

  while (Date.now() < deadline) {
    const result = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const text = document.body ? document.body.innerText : "";
          const rows = Array.from(document.querySelectorAll("tr"))
            .map((tr) => Array.from(tr.querySelectorAll("th,td")).map((cell) => cell.innerText.trim()))
            .filter((row) => row.length > 1);
          const allStarMatch = text.match(/All Star Points:\\s*([\\d,]+(?:\\.\\d+)?)/);
          const bestPerfMatch = text.match(/Best Perf\\. Avg\\s*([\\d.]+)/);
          const lastUpdateMatch = text.match(/Last Update:\\s*([^\\n]+)/);

          return {
            title: document.title,
            name: document.querySelector("h2") ? document.querySelector("h2").innerText.trim() : null,
            rows,
            allStarPoints: allStarMatch ? allStarMatch[1] : null,
            bestPerfAvg: bestPerfMatch ? bestPerfMatch[1] : null,
            lastUpdateText: lastUpdateMatch ? lastUpdateMatch[1].trim() : null,
            text,
          };
        })()
      `,
      returnByValue: true,
    });

    const value = result && result.result ? result.result.value : null;
    if (value && Array.isArray(value.rows) && value.rows.some((row) => row[0] === "Dungeon")) {
      return value;
    }

    if (value && typeof value.title === "string" && /Just a moment/i.test(value.title)) {
      await sleep(1000);
      continue;
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting ${Math.round(timeoutMs / 1000)}s for Warcraft Logs web data to load in the browser.`);
}

async function withRemoteBrowserPage(url, options, callback) {
  const connection = await createBrowserConnection(options);
  try {
    return await callback(connection.send, url);
  } finally {
    await connection.close();
  }
}

async function readWebSnapshot(lookup, options = {}) {
  return withRemoteBrowserPage("", options, async (send) =>
    readWebSnapshotFromSend(send, lookup, options)
  );
}

async function runWebCharacterPipeline(readSnapshot, lookup, options = {}) {
  const baseSnapshot = await readSnapshot(lookup, {
    ...options,
    metric: "playerscore",
  });

  const baseRecord = buildRecordFromWebSnapshot(baseSnapshot, lookup, {
    metric: "playerscore",
    parseMetric: "playerscore",
    rowMode: "points",
  });

  if (baseRecord.score == null && baseRecord.dungeons.length === 0) {
    return {
      found: false,
      record: null,
      rateLimit: null,
    };
  }

  const preferredRole = resolveRoleForCharacterContext({
    roleHint: lookup.roleHint,
    specName: baseRecord.specName,
    role: baseRecord.role,
  });
  const preferredMetric = getPreferredMetricForRole(preferredRole);
  let workingRecord = baseRecord;

  if (preferredMetric == null) {
    return {
      found: true,
      record: {
        ...baseRecord,
        parseMetric: null,
        presentation: buildDerivedPresentation({
          ...baseRecord,
          parseMetric: null,
        }),
      },
      rateLimit: null,
    };
  }

  if (preferredMetric !== "playerscore") {
    try {
      const metricSnapshot = await readSnapshot(lookup, {
        ...options,
        metric: preferredMetric,
      });
      const metricRecord = buildRecordFromWebSnapshot(metricSnapshot, lookup, {
        metric: preferredMetric,
        parseMetric: preferredMetric,
        rowMode: "points",
      });
      workingRecord = mergeMetricRecord(workingRecord, metricRecord);
    } catch {
      workingRecord = stripRoleSpecificFallbackData(baseRecord, preferredMetric);
    }
  }

  const byLevelMetric = preferredMetric === "hps" ? "points_and_healing" : null;

  try {
    const levelSnapshot = await readSnapshot(lookup, {
      ...options,
      metric: byLevelMetric,
    });
    const levelRecord = buildRecordFromWebSnapshot(levelSnapshot, lookup, {
      metric: byLevelMetric || "playerscore",
      parseMetric: workingRecord.parseMetric || preferredMetric,
      rowMode: "byLevel",
    });
    return {
      found: true,
      record: mergeLevelRecord(workingRecord, levelRecord),
      rateLimit: null,
    };
  } catch {
    return {
      found: true,
      record: workingRecord,
      rateLimit: null,
    };
  }
}

async function fetchSingleCharacterViaApiMetric(lookup, metric, options = {}) {
  const client = options.client || new WclClient();
  const collectedAt = options.collectedAt || formatIsoTimestamp();
  const response = await client.graphQlRequest(CHARACTER_QUERY, {
    name: lookup.name,
    serverSlug: slugifyRealm(lookup.realm),
    serverRegion: lookup.region.toUpperCase(),
    zoneId: 47,
    metric,
  });

  const character = response.characterData && response.characterData.character;
  if (!character) {
    return {
      found: false,
      record: null,
      rateLimit: response.rateLimitData || null,
    };
  }

  return buildApiMetricResult(lookup, character, character.zoneRankings, metric, {
    collectedAt,
    rateLimit: response.rateLimitData || null,
  });
}

function buildApiMetricResult(lookup, character, zoneRankings, metric, options = {}) {
  const collectedAt = options.collectedAt || formatIsoTimestamp();
  const zoneStats = extractZoneStats(zoneRankings, collectedAt);
  const specInfo = getSpecInfo(zoneStats.specName);
  return {
    found: true,
    record: buildCharacterRecord({
      region: lookup.region,
      realm: character.server.name,
      name: character.name,
      score: zoneStats.score,
      parseMetric: metric,
      specName: zoneStats.specName,
      className: zoneStats.className || (specInfo ? specInfo.className : null),
      role: zoneStats.role,
      updatedAt: zoneStats.updatedAt,
      wclCharacterId: character.canonicalID || character.id || null,
      dungeons: zoneStats.dungeons,
    }),
    rateLimit: options.rateLimit || null,
  };
}

async function fetchSingleCharacterViaApiDualMetric(lookup, parseMetric, options = {}) {
  const client = options.client || new WclClient();
  const collectedAt = options.collectedAt || formatIsoTimestamp();
  const response = await client.graphQlRequest(CHARACTER_DUAL_METRIC_QUERY, {
    name: lookup.name,
    serverSlug: slugifyRealm(lookup.realm),
    serverRegion: lookup.region.toUpperCase(),
    zoneId: 47,
    scoreMetric: "playerscore",
    parseMetric,
  });

  const character = response.characterData && response.characterData.character;
  const rateLimit = response.rateLimitData || null;
  if (!character) {
    return {
      found: false,
      baseResult: null,
      metricResult: null,
      rateLimit,
    };
  }

  return {
    found: true,
    baseResult: buildApiMetricResult(lookup, character, character.scoreRankings, "playerscore", {
      collectedAt,
      rateLimit,
    }),
    metricResult: buildApiMetricResult(lookup, character, character.parseRankings, parseMetric, {
      collectedAt,
      rateLimit,
    }),
    prefetchedMetric: parseMetric,
    rateLimit,
  };
}

function getHintedApiMetric(lookup) {
  const hintedRole = normalizeRoleHint(lookup.roleHint || lookup.assignedRole || lookup.role);
  const hintedMetric = getPreferredMetricForRole(hintedRole);
  return hintedMetric && hintedMetric !== "playerscore" ? hintedMetric : null;
}

function buildApiBatchMetricQuery(lookups) {
  const variables = {
    zoneId: 47,
    scoreMetric: "playerscore",
  };
  const variableDefs = [
    "$zoneId: Int!",
    "$scoreMetric: CharacterPageRankingMetricType!",
  ];
  const fields = [];
  const prefetchedMetrics = [];

  lookups.forEach((lookup, index) => {
    const prefetchedMetric = getHintedApiMetric(lookup) || "dps";
    const suffix = String(index);
    variables[`name${suffix}`] = lookup.name;
    variables[`serverSlug${suffix}`] = slugifyRealm(lookup.realm);
    variables[`serverRegion${suffix}`] = lookup.region.toUpperCase();
    variables[`parseMetric${suffix}`] = prefetchedMetric;
    variableDefs.push(
      `$name${suffix}: String!`,
      `$serverSlug${suffix}: String!`,
      `$serverRegion${suffix}: String!`,
      `$parseMetric${suffix}: CharacterPageRankingMetricType!`
    );
    prefetchedMetrics.push(prefetchedMetric);
    fields.push(`
      c${suffix}: character(
        name: $name${suffix},
        serverSlug: $serverSlug${suffix},
        serverRegion: $serverRegion${suffix}
      ) {
        id
        canonicalID
        name
        hidden
        server {
          name
          slug
          normalizedName
          region {
            name
            slug
            compactName
          }
        }
        scoreRankings: zoneRankings(
          zoneID: $zoneId,
          metric: $scoreMetric,
          timeframe: Historical,
          includePrivateLogs: false
        )
        parseRankings: zoneRankings(
          zoneID: $zoneId,
          metric: $parseMetric${suffix},
          timeframe: Historical,
          includePrivateLogs: false
        )
      }
    `);
  });

  return {
    query: `
      query CharacterLookupBatch(${variableDefs.join(", ")}) {
        characterData {
          ${fields.join("\n")}
        }
        rateLimitData {
          limitPerHour
          pointsSpentThisHour
          pointsResetIn
        }
      }
    `,
    variables,
    prefetchedMetrics,
  };
}

async function finishApiCharacterPipelineFromDualResult(lookup, dualResult, options = {}) {
  const client = options.client || new WclClient();
  const collectedAt = options.collectedAt || formatIsoTimestamp();
  if (!dualResult.found || !dualResult.baseResult) {
    return {
      found: false,
      record: null,
      rateLimit: dualResult.rateLimit || null,
    };
  }
  const baseResult = dualResult.baseResult;
  if (!baseResult.found || !baseResult.record) {
    return baseResult;
  }

  const preferredRole = resolveRoleForCharacterContext({
    roleHint: lookup.roleHint,
    specName: baseResult.record.specName,
    role: baseResult.record.role,
  });
  const preferredMetric = getPreferredMetricForRole(preferredRole);
  if (preferredMetric == null) {
    return {
      ...baseResult,
      record: {
        ...baseResult.record,
        parseMetric: null,
        presentation: buildDerivedPresentation({
          ...baseResult.record,
          parseMetric: null,
        }),
      },
    };
  }

  if (preferredMetric === "playerscore") {
    return baseResult;
  }

  const metricResult =
    preferredMetric === dualResult.prefetchedMetric
      ? dualResult.metricResult
      : await fetchSingleCharacterViaApiMetric(lookup, preferredMetric, {
          client,
          collectedAt,
        });
  if (!metricResult.found || !metricResult.record) {
    return {
      ...baseResult,
      record: stripRoleSpecificFallbackData(baseResult.record, preferredMetric),
    };
  }

  return {
    ...baseResult,
    record: mergeMetricRecord(baseResult.record, metricResult.record),
    rateLimit: metricResult.rateLimit || baseResult.rateLimit || null,
  };
}

async function runApiCharacterPipeline(lookup) {
  const client = new WclClient();
  const collectedAt = formatIsoTimestamp();
  const prefetchedMetric = getHintedApiMetric(lookup) || "dps";
  const dualResult = await fetchSingleCharacterViaApiDualMetric(lookup, prefetchedMetric, {
    client,
    collectedAt,
  });
  return finishApiCharacterPipelineFromDualResult(lookup, dualResult, {
    client,
    collectedAt,
  });
}

async function fetchCharactersViaApiBatch(rawLookups, options = {}) {
  const lookups = (rawLookups || []).map((lookup) => normalizeLookupInput(lookup));
  if (lookups.length === 0) {
    return [];
  }
  if (lookups.length === 1) {
    return [await runApiCharacterPipeline(lookups[0])];
  }

  const client = options.client || new WclClient();
  const collectedAt = options.collectedAt || formatIsoTimestamp();
  const batch = buildApiBatchMetricQuery(lookups);
  const response = await client.graphQlRequest(batch.query, batch.variables);
  const characterData = response.characterData || {};
  const rateLimit = response.rateLimitData || null;

  return Promise.all(
    lookups.map((lookup, index) => {
      const character = characterData[`c${index}`];
      const prefetchedMetric = batch.prefetchedMetrics[index];
      const dualResult = character
        ? {
            found: true,
            baseResult: buildApiMetricResult(lookup, character, character.scoreRankings, "playerscore", {
              collectedAt,
              rateLimit,
            }),
            metricResult: buildApiMetricResult(lookup, character, character.parseRankings, prefetchedMetric, {
              collectedAt,
              rateLimit,
            }),
            prefetchedMetric,
            rateLimit,
          }
        : {
            found: false,
            baseResult: null,
            metricResult: null,
            prefetchedMetric,
            rateLimit,
          };

      return finishApiCharacterPipelineFromDualResult(lookup, dualResult, {
        client,
        collectedAt,
      });
    })
  );
}

async function fetchSingleCharacterViaApi({ region, realm, name, roleHint, assignedRole, role, classNameHint, className }) {
  const lookup = normalizeLookupInput({
    region,
    realm,
    name,
    roleHint: roleHint || assignedRole || role,
    classNameHint: classNameHint || className,
  });
  return runApiCharacterPipeline(lookup);
}

async function fetchSingleCharacterViaWeb({
  region,
  realm,
  name,
  browserPath,
  roleHint,
  assignedRole,
  role,
  classNameHint,
  className,
}) {
  const lookup = normalizeLookupInput({
    region,
    realm,
    name,
    roleHint: roleHint || assignedRole || role,
    classNameHint: classNameHint || className,
  });
  return runWebCharacterPipeline(
    (nextLookup, snapshotOptions) =>
      readWebSnapshot(nextLookup, {
        browserPath,
        timeoutMs: DEFAULT_WEB_DATA_TIMEOUT_MS,
        ...snapshotOptions,
      }),
    lookup,
    {
      browserPath,
      timeoutMs: DEFAULT_WEB_DATA_TIMEOUT_MS,
    }
  );
}

async function fetchCharacterViaProvider(lookup, options = {}) {
  const provider = resolveLookupProvider(options.provider || DEFAULT_LOOKUP_PROVIDER);
  const fetchApi =
    typeof options.fetchApi === "function"
      ? options.fetchApi
      : (nextLookup) => fetchSingleCharacterViaApi(nextLookup);
  const fetchWeb =
    typeof options.fetchWeb === "function"
      ? options.fetchWeb
      : (nextLookup) =>
          fetchSingleCharacterViaWeb({
            ...nextLookup,
            browserPath: options.browserPath || null,
          });
  const shouldUseApi =
    options.hasApiCredentials == null ? hasApiCredentials() : options.hasApiCredentials === true;
  const needsWebEnrichment =
    typeof options.needsWebEnrichment === "function"
      ? options.needsWebEnrichment
      : recordNeedsWebEnrichment;

  if (provider === "off") {
    throw new Error("Live lookups are disabled for this run.");
  }

  if (provider === "web") {
    return {
      ...(await fetchWeb(lookup)),
      providerUsed: "web",
    };
  }

  if (provider === "api") {
    return {
      ...(await fetchApi(lookup)),
      providerUsed: "api",
    };
  }

  if (provider === "auto") {
    if (shouldUseApi) {
      try {
        const apiResult = await fetchApi(lookup);
        if (apiResult.found && apiResult.record && needsWebEnrichment(apiResult.record)) {
          try {
            return {
              ...(await fetchWeb(lookup)),
              providerUsed: "web",
              fallbackFrom: "api",
              fallbackReason: "API result was incomplete and was enriched from the web page.",
            };
          } catch {
            return {
              ...apiResult,
              providerUsed: "api",
              fallbackFrom: "api",
              fallbackReason: "API result was incomplete, but web enrichment failed.",
            };
          }
        }

        return {
          ...apiResult,
          providerUsed: "api",
        };
      } catch (error) {
        if (error instanceof WclRateLimitError) {
          throw error;
        }
        return {
          ...(await fetchWeb(lookup)),
          providerUsed: "web",
          fallbackFrom: "api",
          fallbackReason: error.message || "API lookup failed before web fallback.",
        };
      }
    }

    return {
      ...(await fetchWeb(lookup)),
      providerUsed: "web",
    };
  }

  throw new Error(`Unsupported provider mode for live lookup: ${provider}`);
}

async function createWebLookupSession(options = {}) {
  const connection = await createBrowserConnection(options);
  return {
    async fetchCharacter(lookup) {
      const normalizedLookup = normalizeLookupInput(lookup);
      return runWebCharacterPipeline(
        (nextLookup, snapshotOptions) =>
          readWebSnapshotFromSend(connection.send, nextLookup, {
            ...options,
            ...snapshotOptions,
          }),
        normalizedLookup,
        options
      );
    },
    async close() {
      await connection.close();
    },
  };
}

async function destroySharedWebSession(state) {
  if (!state) {
    return;
  }

  try {
    const session = await state.sessionPromise;
    await session.close();
  } catch {}
}

async function acquireReusableWebLookupSession(options = {}) {
  const browserPath = options.browserPath || null;
  const idleTimeoutMs = Math.max(
    10000,
    Number.parseInt(String(options.idleTimeoutMs || DEFAULT_SHARED_BROWSER_IDLE_MS), 10) || DEFAULT_SHARED_BROWSER_IDLE_MS
  );
  const existingState = sharedWebSessionState;

  if (
    !existingState ||
    existingState.browserPath !== browserPath
  ) {
    if (existingState && existingState.idleTimer) {
      clearTimeout(existingState.idleTimer);
    }
    sharedWebSessionState = {
      browserPath,
      idleTimeoutMs,
      refs: 0,
      idleTimer: null,
      sessionPromise: createWebLookupSession(options),
    };
    if (existingState && existingState !== sharedWebSessionState) {
      void destroySharedWebSession(existingState);
    }
  }

  const state = sharedWebSessionState;
  state.refs += 1;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  const session = await state.sessionPromise;

  return {
    session,
    async close() {
      if (!sharedWebSessionState || sharedWebSessionState !== state) {
        return;
      }

      state.refs = Math.max(0, state.refs - 1);
      if (state.refs > 0 || state.idleTimer) {
        return;
      }

      state.idleTimer = setTimeout(() => {
        if (!sharedWebSessionState || sharedWebSessionState !== state || state.refs > 0) {
          return;
        }

        sharedWebSessionState = null;
        state.idleTimer = null;
        void destroySharedWebSession(state);
      }, idleTimeoutMs);
    },
  };
}

process.on("exit", () => {
  if (sharedWebSessionState) {
    void destroySharedWebSession(sharedWebSessionState);
    sharedWebSessionState = null;
  }
});

module.exports = {
  DEFAULT_LOOKUP_PROVIDER,
  DEFAULT_WEB_DATA_TIMEOUT_MS,
  buildRecordFromWebSnapshot,
  WclRateLimitError,
  acquireReusableWebLookupSession,
  createWebLookupSession,
  fetchCharacterViaProvider,
  fetchCharactersViaApiBatch,
  fetchSingleCharacterViaApi,
  fetchSingleCharacterViaWeb,
  hasApiCredentials,
  mergeLevelRecord,
  recordNeedsWebEnrichment,
  runApiCharacterPipeline,
  runWebCharacterPipeline,
  normalizeLookupInput,
  resolveLookupProvider,
  warmWclApiAccessToken,
};
