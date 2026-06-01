"use strict";

require("dotenv").config();

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
  DEFAULT_CACHE_PATH,
  buildCacheKey,
  clearManualRequests,
  createEmptyCache,
  getCachedRecord,
  listCachedRecords,
  listManualRequests,
  listRequestStatuses,
  loadCache,
  parseCacheKey,
  removeManualRequest,
  saveCache,
  upsertRequestStatus,
  upsertManualRequest,
} = require("./cache");
const {
  buildCompanionPayload,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_WOW_ADDONS_DIR,
  installStagedAddons,
  stageAddonBundle,
} = require("./lnnrank-bridge");
const { formatIsoTimestamp } = require("../mplus-matrix/utils");
const { runAddonRequestSync } = require("./sync-service");
const { createPassiveLiveFeedMonitor } = require("./passive-live-feed");
const {
  clearLnnrankSavedVariablesQueue,
  DEFAULT_WOW_ACCOUNT_ROOT,
  loadSavedVariablesSnapshot,
  pickLatestSavedVariablesFile,
  removeLnnrankSavedVariablesQueueEntry,
} = require("./saved-variables");

const DEFAULT_PORT = Number.parseInt(process.env.WCL_DASHBOARD_PORT || "47832", 10);
const DASHBOARD_ROOT = path.join(__dirname, "dashboard");
const DASHBOARD_ASSET_PATHS = [
  path.join(DASHBOARD_ROOT, "index.html"),
  path.join(DASHBOARD_ROOT, "app.js"),
  path.join(DASHBOARD_ROOT, "styles.css"),
];

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function enrichCharacters(entries, cache) {
  return (entries || []).map((entry) => {
    const key = entry.key || buildCacheKey(entry.region, entry.realm, entry.characterName);
    const record = getCachedRecord(cache, {
      region: entry.region,
      realm: entry.realm,
      name: entry.characterName,
    });
    return {
      ...entry,
      key,
      record: record || null,
    };
  });
}

const RESOLVED_QUEUE_STATES = new Set([
  "api_cooldown",
  "cached",
  "canceled",
  "disabled",
  "error",
  "found",
  "not_found",
  "rate_limited",
  "stale_cached",
]);
const LIVE_APPLICANT_TTL_SECONDS = 5;

function toIsoFromUnix(value) {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function latestIso(left, right) {
  const leftMs = Date.parse(left || "");
  const rightMs = Date.parse(right || "");
  if (!Number.isFinite(leftMs)) {
    return right || null;
  }
  if (!Number.isFinite(rightMs)) {
    return left || null;
  }
  return rightMs >= leftMs ? right : left;
}

function normalizePassiveBridge(passiveBridge) {
  if (!passiveBridge || typeof passiveBridge !== "object") {
    return null;
  }

  const messageLog = Array.isArray(passiveBridge.messageLog)
    ? [...passiveBridge.messageLog]
        .map((entry) => ({
          ...entry,
          publishedAtIso: toIsoFromUnix(entry.publishedAt),
        }))
        .sort((left, right) => {
          const leftSequence = Number(left.sequence || 0);
          const rightSequence = Number(right.sequence || 0);
          if (leftSequence !== rightSequence) {
            return rightSequence - leftSequence;
          }
          return Number(right.publishedAt || 0) - Number(left.publishedAt || 0);
        })
    : [];

  return {
    ...passiveBridge,
    messageCount:
      typeof passiveBridge.messageCount === "number" ? passiveBridge.messageCount : messageLog.length,
    messageLog,
    lastPublishedAtIso: toIsoFromUnix(passiveBridge.lastPublishedAt),
    updatedAtIso: toIsoFromUnix(passiveBridge.updatedAt),
  };
}

function normalizePassiveSource(source) {
  const normalized = String(source || "").trim().toLocaleLowerCase("en-US");
  if (!normalized) {
    return null;
  }
  if (normalized === "chatlink") {
    return "chat-link";
  }
  return normalized;
}

function toUnixSecondsFromIso(value) {
  const parsedMs = Date.parse(value || "");
  return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : null;
}

function parseIntegerField(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDecimalField(value) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePassivePayload(payload) {
  if (typeof payload !== "string" || !payload.startsWith("LNNRANK|")) {
    return null;
  }

  const fields = {};
  for (const segment of payload.split("|").slice(1)) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = segment.slice(0, separatorIndex);
    const value = segment.slice(separatorIndex + 1);
    if (!key || !value) {
      continue;
    }
    fields[key] = value;
  }

  if (!fields.re || !fields.nm) {
    return null;
  }

  const sequence = Number.parseInt(fields.n || "", 10);
  return {
    payload,
    channelName: fields.ch || null,
    sessionId: fields.ss || null,
    sequence: Number.isFinite(sequence) ? sequence : null,
    region: fields.rg || "us",
    realm: fields.re,
    characterName: fields.nm,
    source: normalizePassiveSource(fields.sr) || "passive-live",
    applicantID: parseIntegerField(fields.ai),
    memberIndex: parseIntegerField(fields.mi),
    assignedRole: fields.ar || null,
    class: fields.cl || null,
    itemLevel: parseDecimalField(fields.il),
    level: parseIntegerField(fields.lv),
  };
}

function pickPreferredPassiveQueueEntry(existing, candidate) {
  if (!existing) {
    return candidate;
  }

  const existingSequence = Number(existing.sequence || 0);
  const candidateSequence = Number(candidate.sequence || 0);
  if (candidateSequence !== existingSequence) {
    return candidateSequence > existingSequence ? candidate : existing;
  }

  const existingMs = Date.parse(existing.updatedAt || existing.firstSeenAt || existing.lastSeenAt || "");
  const candidateMs = Date.parse(candidate.updatedAt || candidate.firstSeenAt || candidate.lastSeenAt || "");
  if (!Number.isFinite(existingMs)) {
    return candidate;
  }
  if (!Number.isFinite(candidateMs)) {
    return existing;
  }
  return candidateMs >= existingMs ? candidate : existing;
}

function buildPassiveLiveQueue(passiveLiveFeedState) {
  const liveEntries =
    passiveLiveFeedState && Array.isArray(passiveLiveFeedState.entries) ? passiveLiveFeedState.entries : [];
  const queueEntries = new Map();

  for (const liveEntry of liveEntries) {
    if (!liveEntry || liveEntry.kind !== "payload" || typeof liveEntry.preview !== "string") {
      continue;
    }

    const payload = parsePassivePayload(liveEntry.preview);
    if (!payload) {
      continue;
    }

    const updatedAt = liveEntry.firstSeenAt || liveEntry.lastSeenAt || null;
    const key = buildCacheKey(payload.region, payload.realm, payload.characterName);
    const candidate = {
      key,
      region: payload.region,
      realm: payload.realm,
      characterName: payload.characterName,
      source: payload.source,
      requestOrigin: "passive-live",
      updatedAt,
      firstSeenAt: liveEntry.firstSeenAt || null,
      lastSeenAt: toUnixSecondsFromIso(liveEntry.lastSeenAt || liveEntry.firstSeenAt),
      seenCount: Number(liveEntry.seenCount || 0) || 1,
      sequence: payload.sequence,
      channelName: payload.channelName,
      sessionId: payload.sessionId,
      payload: payload.payload,
      applicantID: payload.applicantID,
      memberIndex: payload.memberIndex,
      assignedRole: payload.assignedRole,
      class: payload.class,
      itemLevel: payload.itemLevel,
      level: payload.level,
    };

    queueEntries.set(key, pickPreferredPassiveQueueEntry(queueEntries.get(key), candidate));
  }

  return [...queueEntries.values()].sort((left, right) =>
    String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""), "en-US")
  );
}

function filterActivePassiveLiveQueue(passiveLiveQueue, nowMs) {
  const applicantCutoff = Math.floor(nowMs / 1000) - LIVE_APPLICANT_TTL_SECONDS;
  return (passiveLiveQueue || []).filter((entry) => {
    if (entry.source !== "applicant") {
      return true;
    }
    return Number(entry.lastSeenAt || 0) >= applicantCutoff;
  });
}

function shouldPreferLiveApplicants(passiveBridge, passiveLiveFeedState) {
  return Boolean(
    passiveBridge &&
      passiveBridge.enabled === true &&
      passiveLiveFeedState &&
      passiveLiveFeedState.supported !== false &&
      (passiveLiveFeedState.status === "ready" || passiveLiveFeedState.lastScannedAt)
  );
}

function mergeCharacterEntries(preferredEntries, fallbackEntries) {
  const merged = new Map();

  function upsert(entry) {
    if (!entry || !entry.region || !entry.realm || !(entry.characterName || entry.name)) {
      return;
    }

    const key = entry.key || buildCacheKey(entry.region, entry.realm, entry.characterName || entry.name);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...entry, key });
      return;
    }

    merged.set(key, {
      ...existing,
      ...entry,
      key,
      lastSeenAt: Math.max(existing.lastSeenAt || 0, entry.lastSeenAt || 0),
      seenCount: Math.max(existing.seenCount || 0, entry.seenCount || 0),
      updatedAt: latestIso(existing.updatedAt, entry.updatedAt || toIsoFromUnix(entry.lastSeenAt)),
    });
  }

  for (const entry of fallbackEntries || []) {
    upsert(entry);
  }
  for (const entry of preferredEntries || []) {
    upsert(entry);
  }

  return [...merged.values()].sort((left, right) => (right.lastSeenAt || 0) - (left.lastSeenAt || 0));
}

function buildUnifiedQueue(cache, savedQueue, passiveLiveQueue) {
  const statusEntries = new Map(
    listRequestStatuses(cache).map((entry) => [entry.key || buildCacheKey(entry.region, entry.realm, entry.name), entry])
  );
  const merged = new Map();

  function addEntry(entry, source, requestOrigin) {
    const region = entry.region || "us";
    const realm = entry.realm || "";
    const characterName = entry.characterName || entry.name || "";
    const key = entry.key || buildCacheKey(region, realm, characterName);
    const record = getCachedRecord(cache, { region, realm, name: characterName }) || null;
    const requestTimestamp =
      entry.updatedAt ||
      entry.createdAt ||
      toIsoFromUnix(entry.lastSeenAt) ||
      toIsoFromUnix(entry.queuedAt) ||
      null;
    const status = statusEntries.get(key) || null;

    const existing = merged.get(key) || {
      key,
      region,
      realm,
      characterName,
      requestTimestamp: null,
      lastSeenAt: null,
      seenCount: 0,
      sources: [],
      requestOrigins: [],
      record,
      status,
      needsSync: true,
      class: null,
      localizedClass: null,
      assignedRole: null,
      applicantID: null,
      memberIndex: null,
      unitToken: null,
      itemLevel: null,
      level: null,
    };

    existing.region = existing.region || region;
    existing.realm = existing.realm || realm;
    existing.characterName = existing.characterName || characterName;
    existing.requestTimestamp = latestIso(existing.requestTimestamp, requestTimestamp);
    existing.lastSeenAt = Math.max(existing.lastSeenAt || 0, entry.lastSeenAt || 0);
    existing.seenCount = Math.max(existing.seenCount || 0, entry.seenCount || 0);
    existing.status = existing.status || status;
    existing.record = existing.record || record;
    existing.class = existing.class || entry.class || null;
    existing.localizedClass = existing.localizedClass || entry.localizedClass || null;
    existing.assignedRole = existing.assignedRole || entry.assignedRole || null;
    existing.applicantID = existing.applicantID || entry.applicantID || null;
    existing.memberIndex = existing.memberIndex || entry.memberIndex || null;
    existing.unitToken = existing.unitToken || entry.unitToken || null;
    existing.itemLevel = existing.itemLevel || entry.itemLevel || null;
    existing.level = existing.level || entry.level || null;
    if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }
    if (requestOrigin && !existing.requestOrigins.includes(requestOrigin)) {
      existing.requestOrigins.push(requestOrigin);
    }

    const statusUpdatedAtMs = Date.parse((existing.status && existing.status.updatedAt) || "");
    const requestTimestampMs = Date.parse(existing.requestTimestamp || "");
    const wasHandled =
      existing.status &&
      RESOLVED_QUEUE_STATES.has(existing.status.state) &&
      Number.isFinite(statusUpdatedAtMs) &&
      Number.isFinite(requestTimestampMs) &&
      statusUpdatedAtMs >= requestTimestampMs;
    existing.needsSync = !wasHandled;

    merged.set(key, existing);
  }

  for (const entry of savedQueue || []) {
    addEntry(entry, entry.source || "wow", "savedvariables");
  }
  for (const entry of passiveLiveQueue || []) {
    addEntry(entry, entry.source || "passive-live", entry.requestOrigin || "passive-live");
  }
  for (const entry of listManualRequests(cache)) {
    addEntry(entry, entry.source || "manual", "manual");
  }

  return [...merged.values()]
    .filter((entry) => entry.needsSync)
    .sort((left, right) =>
      String(right.requestTimestamp || "").localeCompare(String(left.requestTimestamp || ""), "en-US")
    );
}

function buildDashboardState(options = {}) {
  const dbPath = options.dbPath
    ? path.resolve(String(options.dbPath))
    : DEFAULT_CACHE_PATH;
  const accountRoot = options.accountRoot
    ? path.resolve(String(options.accountRoot))
    : DEFAULT_WOW_ACCOUNT_ROOT;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cache = loadCache(dbPath);
  const savedVariables = loadSavedVariablesSnapshot(accountRoot);
  const passiveBridge = normalizePassiveBridge(savedVariables.parsed.passiveBridge);
  const passiveLiveQueue = filterActivePassiveLiveQueue(buildPassiveLiveQueue(options.passiveLiveFeedState), nowMs);
  const queue = buildUnifiedQueue(cache, savedVariables.parsed.requests || [], passiveLiveQueue);
  const liveApplicants = passiveLiveQueue.filter((entry) => entry.source === "applicant");
  const applicants = shouldPreferLiveApplicants(passiveBridge, options.passiveLiveFeedState)
    ? liveApplicants
    : mergeCharacterEntries(savedVariables.parsed.applicants, liveApplicants);

  return {
    meta: {
      dbPath,
      dashboardVersion: getDashboardVersion(),
      savedVariablesFile: savedVariables.file,
      savedVariablesUpdatedAt:
        savedVariables.lastModifiedMs == null
          ? null
          : new Date(savedVariables.lastModifiedMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      recordCount: listCachedRecords(cache).length,
      queueCount: queue.length,
    },
    settings: savedVariables.parsed.settings,
    providerState: cache.providerState || {},
    records: listCachedRecords(cache).map((record) => ({
      ...record,
      key: buildCacheKey(record.region, record.realm, record.name),
    })),
    requestStatuses: listRequestStatuses(cache),
    queue,
    groupMembers: enrichCharacters(savedVariables.parsed.groupMembers, cache),
    applicants: enrichCharacters(applicants, cache),
    passiveBridge,
    passiveLiveFeed: options.passiveLiveFeedState || null,
    autoSync: options.autoSyncState || {
      isRunning: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null,
      mode: "auto",
    },
  };
}

function getDashboardVersion() {
  const latestMtimeMs = DASHBOARD_ASSET_PATHS.reduce((latest, filePath) => {
    try {
      const stats = fs.statSync(filePath);
      return Math.max(latest, stats.mtimeMs || 0);
    } catch {
      return latest;
    }
  }, 0);

  return latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null;
}

function buildSyncRequestsFromQueue(queueEntries) {
  return (queueEntries || []).map((entry) => {
    const sources = Array.isArray(entry.sources) ? entry.sources.filter(Boolean) : [];
    const requestOrigins = Array.isArray(entry.requestOrigins) ? entry.requestOrigins.filter(Boolean) : [];
    const hasManualOrigin = requestOrigins.includes("manual");
    const hasPassiveOrigin = requestOrigins.includes("passive-live");
    const source = sources[0] || (hasManualOrigin ? "manual" : "savedvariables");
    const request = {
      key: entry.key,
      region: entry.region,
      realm: entry.realm,
      characterName: entry.characterName,
      requestOrigin: hasManualOrigin ? "manual" : hasPassiveOrigin ? "passive-live" : "savedvariables",
      requestSource: hasPassiveOrigin ? "passive-live" : source,
      statusSource: source,
      updatedAt: entry.requestTimestamp || null,
      lastSeenAt: entry.lastSeenAt || null,
      seenCount: entry.seenCount || 0,
    };
    if (entry.class) request.class = entry.class;
    if (entry.localizedClass) request.localizedClass = entry.localizedClass;
    if (entry.assignedRole) request.assignedRole = entry.assignedRole;
    if (entry.applicantID != null) request.applicantID = entry.applicantID;
    if (entry.memberIndex != null) request.memberIndex = entry.memberIndex;
    if (entry.unitToken) request.unitToken = entry.unitToken;
    if (entry.itemLevel != null) request.itemLevel = entry.itemLevel;
    if (entry.level != null) request.level = entry.level;
    return request;
  });
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  return "text/html; charset=utf-8";
}

async function serveStatic(response, filePath) {
  const content = await fsp.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": "no-store",
  });
  response.end(content);
}

async function createDashboardServer(options = {}) {
  const dbPath = options.dbPath ? path.resolve(String(options.dbPath)) : DEFAULT_CACHE_PATH;
  const accountRoot = options.accountRoot
    ? path.resolve(String(options.accountRoot))
    : DEFAULT_WOW_ACCOUNT_ROOT;
  const outputDir = options.outputDir
    ? path.resolve(String(options.outputDir))
    : DEFAULT_OUTPUT_DIR;
  const addonsDir = options.addonsDir ? path.resolve(String(options.addonsDir)) : null;
  const provider = options.provider || null;
  const syncRequests = options.runAddonRequestSync || runAddonRequestSync;
  const backgroundTickMs =
    options.backgroundTickMs == null ? 2000 : Number.parseInt(String(options.backgroundTickMs), 10);
  const autoSync = {
    currentPromise: null,
    isRunning: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastError: null,
    lastResult: null,
    lastUpdate: null,
    currentLookup: null,
    queueLength: 0,
    statusCount: 0,
    mode: "auto",
    scheduled: false,
    timer: null,
  };
  const passiveLiveFeedMonitor =
    options.enablePassiveLiveFeed === true ? createPassiveLiveFeedMonitor(options.passiveLiveFeedOptions) : null;

  function publishCompanionFromCache(cache) {
    const payload = buildCompanionPayload(listCachedRecords(cache), {
      builtAt: formatIsoTimestamp(),
      source: "local-db",
      statuses: listRequestStatuses(cache),
    });
    const staged = stageAddonBundle(outputDir, payload);
    if (addonsDir) {
      installStagedAddons(staged, addonsDir);
    }
    return staged;
  }

  function markCanceledStatus(cache, key, source) {
    const parsed = parseCacheKey(key);
    if (!parsed.region || !parsed.realm || !parsed.name) {
      return;
    }

    upsertRequestStatus(cache, {
      region: parsed.region,
      realm: parsed.realm,
      name: parsed.name,
      state: "canceled",
      message: "Lookup canceled locally before reload.",
      source: source || "savedvariables",
      updatedAt: formatIsoTimestamp(),
    });
  }

  function getAutoSyncState() {
    return {
      isRunning: autoSync.isRunning,
      lastStartedAt: autoSync.lastStartedAt,
      lastFinishedAt: autoSync.lastFinishedAt,
      lastError: autoSync.lastError,
      lastResult:
        autoSync.lastResult == null
          ? null
          : {
              provider: autoSync.lastResult.provider,
              requests: autoSync.lastResult.requests,
              cachedRecords: autoSync.lastResult.cachedRecords,
              statuses: Array.isArray(autoSync.lastResult.statuses)
                ? autoSync.lastResult.statuses.length
                : 0,
            },
      lastUpdate: autoSync.lastUpdate,
      currentLookup: autoSync.currentLookup,
      queueLength: autoSync.queueLength,
      statusCount: autoSync.statusCount,
      mode: autoSync.mode,
    };
  }

  function snapshotState() {
    return buildDashboardState({
      dbPath,
      accountRoot,
      autoSyncState: getAutoSyncState(),
      passiveLiveFeedState: passiveLiveFeedMonitor ? passiveLiveFeedMonitor.snapshot() : null,
    });
  }

  function scheduleAutoSync(delayMs = 750) {
    if (autoSync.timer) {
      return;
    }

    autoSync.scheduled = true;
    autoSync.timer = setTimeout(() => {
      autoSync.timer = null;
      void runAutoSync(false);
    }, delayMs);
  }

  async function runAutoSync(force) {
    if (autoSync.currentPromise) {
      return autoSync.currentPromise;
    }

    const currentRun = (async () => {
      try {
        const beforeState = snapshotState();
        if (!force && beforeState.meta.queueCount === 0) {
          autoSync.scheduled = false;
          return {
            skipped: true,
            reason: "queue-empty",
          };
        }

        autoSync.isRunning = true;
        autoSync.lastStartedAt = new Date().toISOString();
        autoSync.lastError = null;
        autoSync.currentLookup = null;
        autoSync.lastUpdate = null;
        autoSync.queueLength = beforeState.meta.queueCount;
        autoSync.statusCount = 0;

        const savedVariables = pickLatestSavedVariablesFile(accountRoot);
        const queuedRequests = buildSyncRequestsFromQueue(beforeState.queue);
        const result = await syncRequests({
          savedVariablesFile: savedVariables ? savedVariables.path : null,
          dbPath,
          outputDir,
          addonsDir,
          provider,
          requests: queuedRequests,
          workers: 1,
          installWow: true,
          onUpdate: async (update) => {
            autoSync.lastUpdate = update;
            autoSync.currentLookup = update.lookup || update.request || null;
            autoSync.queueLength = update.queueLength || autoSync.queueLength;
            autoSync.statusCount = update.statusCount || 0;
          },
        });
        autoSync.lastResult = result;
        return result;
      } catch (error) {
        autoSync.lastError = error.message || "Auto sync failed.";
        throw error;
      } finally {
        autoSync.isRunning = false;
        autoSync.lastFinishedAt = new Date().toISOString();

        const afterState = snapshotState();
        if (afterState.meta.queueCount > 0) {
          scheduleAutoSync(2500);
        } else {
          autoSync.scheduled = false;
        }
      }
    })();

    autoSync.currentPromise = currentRun;

    try {
      return await currentRun;
    } finally {
      if (autoSync.currentPromise === currentRun) {
        autoSync.currentPromise = null;
      }
    }
  }

  if (options.testHooks && typeof options.testHooks === "object") {
    options.testHooks.runAutoSync = runAutoSync;
    options.testHooks.snapshotState = snapshotState;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

      if (request.method === "GET" && requestUrl.pathname === "/api/state") {
        const state = snapshotState();
        if (state.meta.queueCount > 0) {
          scheduleAutoSync(100);
        }
        if (passiveLiveFeedMonitor && state.passiveBridge) {
          void passiveLiveFeedMonitor.refresh(state.passiveBridge);
        }
        jsonResponse(response, 200, state);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/manual-queue") {
        const body = await readRequestBody(request);
        if (!body || !body.realm || !body.name) {
          jsonResponse(response, 400, { error: "region, realm, and name are required." });
          return;
        }

        const cache = loadCache(dbPath);
        const entry = upsertManualRequest(cache, {
          region: body.region || "us",
          realm: body.realm,
          characterName: body.name,
          source: "manual",
        });
        upsertRequestStatus(cache, {
          region: entry.region,
          realm: entry.realm,
          name: entry.characterName,
          state: "queued",
          message: "Queued from the dashboard.",
          source: entry.source || "manual",
          updatedAt: entry.updatedAt,
        });
        saveCache(cache, dbPath);
        scheduleAutoSync(100);
        jsonResponse(response, 200, { ok: true, entry });
        return;
      }

      if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/manual-queue/")) {
        const key = decodeURIComponent(requestUrl.pathname.slice("/api/manual-queue/".length));
        const cache = loadCache(dbPath);
        const removed = removeManualRequest(cache, key);
        saveCache(cache, dbPath);
        scheduleAutoSync(100);
        jsonResponse(response, 200, { ok: true, removed });
        return;
      }

      if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/queue/")) {
        const key = decodeURIComponent(requestUrl.pathname.slice("/api/queue/".length));
        const beforeState = snapshotState();
        const existingQueueEntry = (beforeState.queue || []).find((entry) => entry.key === key) || null;
        const cache = loadCache(dbPath);
        const manualRemoved = removeManualRequest(cache, key);

        const savedVariables = pickLatestSavedVariablesFile(accountRoot);
        const savedVariablesRemoved = savedVariables
          ? removeLnnrankSavedVariablesQueueEntry(savedVariables.path, key)
          : { filePath: null, removed: 0 };

        if (manualRemoved || (savedVariablesRemoved && savedVariablesRemoved.removed > 0) || existingQueueEntry) {
          const source =
            existingQueueEntry && Array.isArray(existingQueueEntry.sources) && existingQueueEntry.sources.length > 0
              ? existingQueueEntry.sources[0]
              : manualRemoved && manualRemoved.source
                ? manualRemoved.source
                : "savedvariables";
          markCanceledStatus(cache, key, source);
        }

        saveCache(cache, dbPath);
        publishCompanionFromCache(cache);

        jsonResponse(response, 200, {
          ok: true,
          manualRemoved,
          savedVariablesRemoved,
          state: snapshotState(),
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/queue/clear") {
        const beforeState = snapshotState();
        const cache = loadCache(dbPath);
        const manualRemoved = clearManualRequests(cache);

        const savedVariables = pickLatestSavedVariablesFile(accountRoot);
        const savedVariablesRemoved = savedVariables
          ? clearLnnrankSavedVariablesQueue(savedVariables.path)
          : { filePath: null, cleared: false, removed: 0 };

        for (const entry of beforeState.queue || []) {
          const source =
            Array.isArray(entry.sources) && entry.sources.length > 0
              ? entry.sources[0]
              : "savedvariables";
          markCanceledStatus(cache, entry.key, source);
        }

        saveCache(cache, dbPath);
        publishCompanionFromCache(cache);

        jsonResponse(response, 200, {
          ok: true,
          manualRemoved,
          savedVariablesRemoved,
          state: snapshotState(),
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/results/clear") {
        const emptyCache = createEmptyCache();
        saveCache(emptyCache, dbPath);
        publishCompanionFromCache(emptyCache);

        jsonResponse(response, 200, {
          ok: true,
          state: snapshotState(),
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/sync") {
        await readRequestBody(request);
        const result = await runAutoSync(true);
        jsonResponse(response, 200, {
          ...result,
          state: snapshotState(),
        });
        return;
      }

      let filePath = path.join(DASHBOARD_ROOT, "index.html");
      if (requestUrl.pathname !== "/") {
        filePath = path.join(DASHBOARD_ROOT, requestUrl.pathname.replace(/^\/+/, ""));
      }

      if (!filePath.startsWith(DASHBOARD_ROOT) || !fs.existsSync(filePath)) {
        jsonResponse(response, 404, { error: "Not found" });
        return;
      }

      await serveStatic(response, filePath);
    } catch (error) {
      jsonResponse(response, 500, {
        error: error.message || "Unexpected dashboard error.",
      });
    }
  });

  const backgroundTick = options.disableBackgroundTick
    ? null
    : setInterval(() => {
        const state = snapshotState();
        if (state.meta.queueCount > 0) {
          scheduleAutoSync(100);
        }
        if (passiveLiveFeedMonitor && state.passiveBridge) {
          void passiveLiveFeedMonitor.refresh(state.passiveBridge);
        }
      }, backgroundTickMs);

  server.on("close", () => {
    if (backgroundTick) {
      clearInterval(backgroundTick);
    }
    if (autoSync.timer) {
      clearTimeout(autoSync.timer);
      autoSync.timer = null;
    }
  });

  return server;
}

async function main() {
  const server = await createDashboardServer({
    dbPath: process.env.WCL_DASHBOARD_DB_PATH || null,
    accountRoot: process.env.WCL_DASHBOARD_ACCOUNT_ROOT || null,
    outputDir: process.env.WCL_DASHBOARD_OUTPUT_DIR || null,
    addonsDir: process.env.WCL_DASHBOARD_ADDONS_DIR || DEFAULT_WOW_ADDONS_DIR,
    provider: process.env.WCL_LOOKUP_PROVIDER || null,
    enablePassiveLiveFeed: true,
  });
  server.listen(DEFAULT_PORT, "127.0.0.1", () => {
    process.stdout.write(`WCL dashboard listening on http://127.0.0.1:${DEFAULT_PORT}\n`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSyncRequestsFromQueue,
  buildUnifiedQueue,
  buildDashboardState,
  createDashboardServer,
};
