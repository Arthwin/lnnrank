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
  getFreshCachedRecord,
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
  clearLnnrankSavedVariablesApplicants,
  clearLnnrankSavedVariablesEventBatch,
  clearLnnrankSavedVariablesQueue,
  DEFAULT_WOW_ACCOUNT_ROOT,
  loadSavedVariablesSnapshot,
  pickLatestSavedVariablesFile,
  removeLnnrankSavedVariablesQueueEntry,
} = require("./saved-variables");
const {
  buildAddonEventIdentity,
  buildAddonEventPreview,
  compareAddonEvents,
  parseAddonEventPayload,
} = require("./addon-event-format");

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
const PASSIVE_EVENT_BATCH_MAX_AGE_MS = 1000;
const PASSIVE_EVENT_BATCH_MAX_SIZE = 5;
const PASSIVE_BROKER_EVENT_LIMIT = 400;

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

function parseUnixMillisecondsField(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return rawValue.length <= 10 ? parsed * 1000 : parsed;
}

function parsePassivePayload(payload) {
  const event = parseAddonEventPayload(payload);
  if (!event || event.eventType !== "search" || !event.realm || !event.characterName) {
    return null;
  }
  return {
    payload,
    channelName: event.channelName || null,
    sessionId: event.sessionId || null,
    sequence: event.sequence,
    timestampMs: event.capturedAtMs || null,
    region: event.region || "us",
    realm: event.realm,
    characterName: event.characterName,
    source: normalizePassiveSource(event.source) || "passive-live",
    applicantID: event.applicantID != null ? event.applicantID : null,
    groupID: event.groupID,
    memberIndex: event.memberIndex,
    assignedRole: event.assignedRole || null,
    class: event.class || null,
    itemLevel: event.itemLevel,
    level: event.level,
  };
}

function getPassiveLiveSourceEntries(passiveLiveFeedState) {
  if (passiveLiveFeedState && Array.isArray(passiveLiveFeedState.entries) && passiveLiveFeedState.entries.length > 0) {
    return passiveLiveFeedState.entries;
  }
  return passiveLiveFeedState && Array.isArray(passiveLiveFeedState.events) ? passiveLiveFeedState.events : [];
}

function parsePassiveLiveEntries(passiveLiveFeedState) {
  const liveEntries = getPassiveLiveSourceEntries(passiveLiveFeedState);

  return liveEntries
    .filter((entry) => entry && entry.kind === "payload" && typeof entry.preview === "string")
    .map((entry) => {
      const payload = parsePassivePayload(entry.preview);
      if (!payload) {
        return null;
      }
      const eventAt = entry.eventAt || entry.firstSeenAt || entry.lastSeenAt || null;
      const payloadEventAtMs = payload.timestampMs || null;
      const discoveredEventAtMs = Date.parse(eventAt || "");
      const eventAtMs = payloadEventAtMs || (Number.isFinite(discoveredEventAtMs) ? discoveredEventAtMs : 0);
      return {
        ...payload,
        eventAt: eventAtMs > 0 ? new Date(eventAtMs).toISOString() : eventAt,
        eventAtMs,
        updatedAt: eventAtMs > 0 ? new Date(eventAtMs).toISOString() : eventAt,
        lastSeenAt: eventAtMs > 0 ? Math.floor(eventAtMs / 1000) : toUnixSecondsFromIso(eventAt),
      };
    })
    .filter(Boolean);
}

function parsePassiveLiveEnvelopeEvents(passiveLiveFeedState) {
  const liveEntries = getPassiveLiveSourceEntries(passiveLiveFeedState);

  return liveEntries
    .filter((entry) => entry && entry.kind === "payload" && typeof entry.preview === "string")
    .map((entry) => {
      const event = parseAddonEventPayload(entry.preview, {
        fallbackTimestampMs: Date.parse(entry.eventAt || entry.firstSeenAt || entry.lastSeenAt || "") || 0,
      });
      if (!event) {
        return null;
      }

      const eventAtMs = Number(event.capturedAtMs || 0);
      const lastSeenAt =
        eventAtMs > 0
          ? Math.floor(eventAtMs / 1000)
          : toUnixSecondsFromIso(entry.eventAt || entry.firstSeenAt || entry.lastSeenAt || "");
      return {
        ...event,
        eventAtMs,
        eventAt: event.capturedAt || entry.eventAt || entry.firstSeenAt || entry.lastSeenAt || null,
        updatedAt: event.capturedAt || entry.eventAt || entry.firstSeenAt || entry.lastSeenAt || null,
        lastSeenAt,
      };
    })
    .filter(Boolean);
}

function comparePassiveLiveEntryRecency(left, right) {
  const leftEventAtMs = Number((left && left.eventAtMs) || 0);
  const rightEventAtMs = Number((right && right.eventAtMs) || 0);
  if (leftEventAtMs !== rightEventAtMs) {
    return rightEventAtMs - leftEventAtMs;
  }

  const leftSequence = Number((left && left.sequence) || 0);
  const rightSequence = Number((right && right.sequence) || 0);
  if (leftSequence !== rightSequence) {
    return rightSequence - leftSequence;
  }

  return String((right && right.payload) || "").localeCompare(String((left && left.payload) || ""), "en-US");
}

function resolveActivePassiveSessionId(entries, fallbackSessionId) {
  const actionableEntries = (entries || []).filter((entry) => entry && entry.sessionId);
  const appclearEntry = actionableEntries
    .filter((entry) => entry.source === "appclear")
    .sort(comparePassiveLiveEntryRecency)[0];
  if (appclearEntry) {
    return appclearEntry.sessionId;
  }

  const applicantEntry = actionableEntries
    .filter((entry) => entry.source === "applicant")
    .sort(comparePassiveLiveEntryRecency)[0];
  if (applicantEntry) {
    return applicantEntry.sessionId;
  }

  const recentEntry = actionableEntries.sort(comparePassiveLiveEntryRecency)[0];
  return (recentEntry && recentEntry.sessionId) || fallbackSessionId || null;
}

function buildPassiveLiveScope(passiveBridge, passiveLiveFeedState) {
  const parsedEntries = parsePassiveLiveEnvelopeEvents(passiveLiveFeedState);
  const preferredChannelName = passiveBridge && passiveBridge.channelName ? passiveBridge.channelName : null;
  const fallbackSessionId = passiveBridge && passiveBridge.sessionId;

  if (!preferredChannelName) {
    const sessionId = resolveActivePassiveSessionId(parsedEntries, fallbackSessionId);
    const sessionEntries = sessionId ? parsedEntries.filter((entry) => entry.sessionId === sessionId) : parsedEntries;
    const latestApplicantClearSequence = sessionEntries
      .filter((entry) => entry.source === "appclear")
      .reduce((latest, entry) => Math.max(latest, Number(entry.sequence || 0) || 0), 0);
    return {
      channelName: null,
      sessionId,
      latestApplicantClearSequence,
      entries: parsedEntries,
    };
  }

  const channelEntries = parsedEntries.filter((entry) => entry.channelName === preferredChannelName);
  const scopedEntries = channelEntries.length ? channelEntries : parsedEntries;
  const sessionId = resolveActivePassiveSessionId(scopedEntries, fallbackSessionId);
  const sessionEntries = sessionId ? scopedEntries.filter((entry) => entry.sessionId === sessionId) : scopedEntries;
  const latestApplicantClearSequence = sessionEntries
    .filter((entry) => entry.source === "appclear")
    .reduce((latest, entry) => Math.max(latest, Number(entry.sequence || 0) || 0), 0);
  return {
    channelName: preferredChannelName,
    sessionId,
    latestApplicantClearSequence,
    entries: scopedEntries,
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
  const liveEntries = getPassiveLiveSourceEntries(passiveLiveFeedState);
  const queueEntries = new Map();

  for (const liveEntry of liveEntries) {
    if (!liveEntry || liveEntry.kind !== "payload" || typeof liveEntry.preview !== "string") {
      continue;
    }

    const payload = parsePassivePayload(liveEntry.preview);
    if (!payload) {
      continue;
    }

    if (payload.source === "appclear") {
      continue;
    }

    const updatedAt = liveEntry.eventAt || liveEntry.firstSeenAt || liveEntry.lastSeenAt || null;
    const key = buildCacheKey(payload.region, payload.realm, payload.characterName);
    const candidate = {
      key,
      region: payload.region,
      realm: payload.realm,
      characterName: payload.characterName,
      source: payload.source,
      requestOrigin: "passive-live",
      updatedAt,
      firstSeenAt: updatedAt,
      lastSeenAt: toUnixSecondsFromIso(updatedAt),
      seenCount: Number(liveEntry.seenCount || 0) || 1,
      sequence: payload.sequence,
      channelName: payload.channelName,
      sessionId: payload.sessionId,
      payload: payload.payload,
      applicantID: payload.applicantID,
      groupID: payload.groupID,
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

function filterActivePassiveLiveQueue(passiveLiveQueue, nowMs, passiveLiveScope) {
  const applicantCutoff = Math.floor(nowMs / 1000) - LIVE_APPLICANT_TTL_SECONDS;
  const scopedEntries = (passiveLiveQueue || []).filter((entry) => {
    if (!passiveLiveScope || !passiveLiveScope.channelName) {
      return true;
    }
    if (entry.channelName != null && entry.channelName !== passiveLiveScope.channelName) {
      return false;
    }
    return !passiveLiveScope.sessionId || entry.sessionId === passiveLiveScope.sessionId;
  });
  return scopedEntries.filter((entry) => {
    if (entry.source !== "applicant") {
      return true;
    }
    const clearSequence = Number((passiveLiveScope && passiveLiveScope.latestApplicantClearSequence) || 0);
    const sequence = Number(entry.sequence || 0);
    if (clearSequence > 0 && sequence <= clearSequence) {
      return false;
    }
    return Number(entry.lastSeenAt || 0) >= applicantCutoff;
  });
}

function shouldPreferLiveApplicants(passiveBridge, passiveLiveFeedState) {
  const passiveLiveScope = buildPassiveLiveScope(passiveBridge, passiveLiveFeedState);
  const clearSequence = Number(passiveLiveScope.latestApplicantClearSequence || 0);
  const hasApplicantPayload = passiveLiveScope.entries.some((entry) => {
    if (entry.source !== "applicant") {
      return false;
    }
    return clearSequence <= 0 || Number(entry.sequence || 0) > clearSequence;
  });

  return Boolean(
    passiveBridge &&
      passiveBridge.enabled === true &&
      passiveLiveFeedState &&
      passiveLiveFeedState.supported !== false &&
      hasApplicantPayload
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
      groupID: null,
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
    existing.groupID = existing.groupID || entry.groupID || null;
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
  const cache = options.cacheOverride || loadCache(dbPath);
  const savedVariables = options.savedVariablesOverride || loadSavedVariablesSnapshot(accountRoot);
  const passiveBridge = normalizePassiveBridge(savedVariables.parsed.passiveBridge);
  const passiveLiveScope = buildPassiveLiveScope(passiveBridge, options.passiveLiveFeedState);
  const passiveLiveQueue = Array.isArray(options.passiveLiveQueueOverride)
    ? [...options.passiveLiveQueueOverride]
    : filterActivePassiveLiveQueue(buildPassiveLiveQueue(options.passiveLiveFeedState), nowMs, passiveLiveScope);
  const queue = Array.isArray(options.queueOverride)
    ? [...options.queueOverride]
    : buildUnifiedQueue(cache, savedVariables.parsed.requests || [], passiveLiveQueue);
  const liveApplicants = passiveLiveQueue.filter((entry) => entry.source === "applicant");
  const applicants = Array.isArray(options.applicantsOverride)
    ? options.applicantsOverride
    : shouldPreferLiveApplicants(passiveBridge, options.passiveLiveFeedState)
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
    if (entry.groupID != null) request.groupID = entry.groupID;
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
  const passiveLiveFeedStateOverride = options.passiveLiveFeedStateOverride;
  const passiveEventBatchMaxAgeMs = Math.max(
    0,
    Number.parseInt(String(options.passiveEventBatchMaxAgeMs ?? PASSIVE_EVENT_BATCH_MAX_AGE_MS), 10) ||
      PASSIVE_EVENT_BATCH_MAX_AGE_MS
  );
  const passiveEventBatchMaxSize = Math.max(
    1,
    Number.parseInt(String(options.passiveEventBatchMaxSize ?? PASSIVE_EVENT_BATCH_MAX_SIZE), 10) ||
      PASSIVE_EVENT_BATCH_MAX_SIZE
  );
  const passiveBrokerRuntime = {
    sessionKey: null,
    lastEventSequence: 0,
    lastEventAtMs: 0,
    pendingEvents: [],
    events: [],
    seenEventIds: new Map(),
  };
  const passiveQueueRuntime = {
    entries: new Map(),
  };
  const lfgRuntime = {
    entries: new Map(),
    publishers: new Map(),
    lastSavedVariablesModifiedMs: null,
    passiveSessionKey: null,
    latestLiveEventAtMs: 0,
    ignoreBeforeMs: 0,
  };

  function buildLfgRuntimeKey(entry) {
    if (entry.applicantID != null) {
      return `applicant:${entry.applicantID}:${entry.memberIndex || 0}`;
    }
    return entry.key || buildCacheKey(entry.region, entry.realm, entry.characterName || entry.name);
  }

  function resetLfgRuntimeState() {
    lfgRuntime.entries.clear();
    if (lfgRuntime.publishers && typeof lfgRuntime.publishers.clear === "function") {
      lfgRuntime.publishers.clear();
    }
  }

  function resetPassiveBrokerCursor(sessionKey = null) {
    passiveBrokerRuntime.sessionKey = sessionKey;
    passiveBrokerRuntime.lastEventSequence = 0;
    passiveBrokerRuntime.lastEventAtMs = 0;
    passiveBrokerRuntime.pendingEvents = [];
    passiveBrokerRuntime.events = [];
    clearPassiveQueueRuntime();
  }

  function buildPassiveLogEvent(entry) {
    const eventAt =
      entry && entry.eventAtMs > 0
        ? new Date(entry.eventAtMs).toISOString()
        : entry && entry.eventAt
          ? entry.eventAt
          : entry && entry.updatedAt
            ? entry.updatedAt
            : null;
    return {
      key: `payload:${entry.payload}`,
      kind: "payload",
      preview: entry.payload,
      eventAt,
      firstSeenAt: eventAt,
      lastSeenAt: eventAt,
      seenCount: 1,
    };
  }

  function listPassiveQueueRuntimeEntries() {
    return [...passiveQueueRuntime.entries.values()].sort((left, right) =>
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""), "en-US")
    );
  }

  function removePassiveQueueRuntimeEntry(key) {
    if (!key) {
      return false;
    }
    return passiveQueueRuntime.entries.delete(key);
  }

  function clearPassiveQueueRuntime() {
    passiveQueueRuntime.entries.clear();
  }

  function buildPassiveQueueEntryFromEvent(entry) {
    const updatedAt =
      entry && entry.eventAtMs > 0
        ? new Date(entry.eventAtMs).toISOString()
        : entry && entry.eventAt
          ? entry.eventAt
          : entry && entry.updatedAt
            ? entry.updatedAt
            : null;
    return {
      key: buildCacheKey(entry.region, entry.realm, entry.characterName),
      region: entry.region,
      realm: entry.realm,
      characterName: entry.characterName,
      source: entry.source,
      requestOrigin: "passive-live",
      updatedAt,
      firstSeenAt: updatedAt,
      lastSeenAt: entry.eventAtMs > 0 ? Math.floor(entry.eventAtMs / 1000) : toUnixSecondsFromIso(updatedAt),
      seenCount: 1,
      sequence: entry.sequence,
      channelName: entry.channelName,
      sessionId: entry.sessionId,
      payload: entry.payload,
      applicantID: entry.applicantID,
      groupID: entry.groupID,
      memberIndex: entry.memberIndex,
      assignedRole: entry.assignedRole,
      class: entry.class,
      itemLevel: entry.itemLevel,
      level: entry.level,
    };
  }

  function upsertPassiveQueueRuntimeEntry(entry) {
    const candidate = buildPassiveQueueEntryFromEvent(entry);
    passiveQueueRuntime.entries.set(
      candidate.key,
      pickPreferredPassiveQueueEntry(passiveQueueRuntime.entries.get(candidate.key), candidate)
    );
  }

  function buildBrokeredPassiveLiveFeedState(rawState, passiveLiveScope) {
    if (!rawState) {
      return null;
    }

    return {
      ...rawState,
      activeSessionId: passiveLiveScope && passiveLiveScope.sessionId ? passiveLiveScope.sessionId : null,
      events: [...passiveBrokerRuntime.events],
      eventCount: passiveBrokerRuntime.events.length,
    };
  }

  function buildPassiveEventIdentity(entry) {
    return [
      Number((entry && entry.eventAtMs) || 0),
      Number((entry && entry.sequence) || 0),
      String((entry && entry.payload) || ""),
    ].join(":");
  }

  function comparePassiveEventOrder(left, right) {
    const leftEventAtMs = Number((left && left.eventAtMs) || 0);
    const rightEventAtMs = Number((right && right.eventAtMs) || 0);
    if (leftEventAtMs !== rightEventAtMs) {
      return leftEventAtMs - rightEventAtMs;
    }

    const leftSequence = Number((left && left.sequence) || 0);
    const rightSequence = Number((right && right.sequence) || 0);
    if (leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }

    return String((left && left.payload) || "").localeCompare(String((right && right.payload) || ""), "en-US");
  }

  function isAfterPassiveCursor(entry) {
    const eventAtMs = Number((entry && entry.eventAtMs) || 0);
    const sequence = Number((entry && entry.sequence) || 0);
    const cursorEventAtMs = Number(passiveBrokerRuntime.lastEventAtMs || 0);
    const cursorSequence = Number(passiveBrokerRuntime.lastEventSequence || 0);
    if (eventAtMs !== cursorEventAtMs) {
      return eventAtMs > cursorEventAtMs;
    }
    return sequence > cursorSequence;
  }

  function queuePendingPassiveEvent(entry, queuedAtMs) {
    if (!entry || !isAfterPassiveCursor(entry)) {
      return false;
    }

    const key = buildPassiveEventIdentity(entry);
    if (passiveBrokerRuntime.pendingEvents.some((pendingEntry) => pendingEntry.key === key)) {
      return false;
    }

    passiveBrokerRuntime.pendingEvents.push({
      key,
      event: entry,
      queuedAtMs,
    });
    return true;
  }

  function advancePassiveCursor(entry) {
    passiveBrokerRuntime.lastEventAtMs = Number((entry && entry.eventAtMs) || 0);
    passiveBrokerRuntime.lastEventSequence = Number((entry && entry.sequence) || 0);
  }

  function flushPendingPassiveEvents(nowMs, force = false) {
    if (!Array.isArray(passiveBrokerRuntime.pendingEvents) || passiveBrokerRuntime.pendingEvents.length === 0) {
      return [];
    }

    const oldestQueuedAtMs = Number(passiveBrokerRuntime.pendingEvents[0].queuedAtMs || 0);
    const shouldFlush =
      force ||
      passiveBrokerRuntime.pendingEvents.length >= passiveEventBatchMaxSize ||
      (oldestQueuedAtMs > 0 && nowMs - oldestQueuedAtMs >= passiveEventBatchMaxAgeMs);
    if (!shouldFlush) {
      return [];
    }

    const pendingEvents = [...passiveBrokerRuntime.pendingEvents]
      .map((entry) => entry.event)
      .sort(comparePassiveEventOrder);
    passiveBrokerRuntime.pendingEvents = [];
    const flushedEvents = [];

    for (const entry of pendingEvents) {
      const sequence = Number(entry.sequence || 0);
      if (!Number.isFinite(sequence) || !isAfterPassiveCursor(entry)) {
        continue;
      }

      advancePassiveCursor(entry);
      passiveBrokerRuntime.events = [...passiveBrokerRuntime.events, buildPassiveLogEvent(entry)].slice(
        -PASSIVE_BROKER_EVENT_LIMIT
      );
      if (entry.source !== "appclear") {
        upsertPassiveQueueRuntimeEntry(entry);
      }
      flushedEvents.push(entry);
    }

    return flushedEvents;
  }

  function normalizeLfgRuntimeEntry(entry, origin) {
    if (!entry || !entry.region || !entry.realm || !(entry.characterName || entry.name)) {
      return null;
    }

    const characterName = entry.characterName || entry.name;
    return {
      ...entry,
      key: buildCacheKey(entry.region, entry.realm, characterName),
      characterName,
      source: entry.source || "applicant",
      requestOrigin: origin || entry.requestOrigin || "savedvariables",
    };
  }

  function upsertLfgRuntimeEntry(entry, origin) {
    const normalized = normalizeLfgRuntimeEntry(entry, origin);
    if (!normalized) {
      return;
    }

    const key = buildLfgRuntimeKey(normalized);
    const existing = lfgRuntime.entries.get(key);
    if (existing) {
      const existingRecency = {
        eventAtMs:
          Number(existing.eventAtMs || 0) ||
          Date.parse(existing.updatedAt || "") ||
          Number(existing.lastSeenAt || 0) * 1000,
        sequence: Number(existing.sequence || 0),
        payload: existing.payload || `${existing.characterName}:${existing.realm}`,
      };
      const candidateRecency = {
        eventAtMs:
          Number(normalized.eventAtMs || 0) ||
          Date.parse(normalized.updatedAt || "") ||
          Number(normalized.lastSeenAt || 0) * 1000,
        sequence: Number(normalized.sequence || 0),
        payload: normalized.payload || `${normalized.characterName}:${normalized.realm}`,
      };
      if (comparePassiveEventOrder(candidateRecency, existingRecency) < 0) {
        return;
      }
    }

    lfgRuntime.entries.set(key, normalized);
  }

  function listLfgRuntimeEntries() {
    return [...lfgRuntime.entries.values()].sort((left, right) => {
      const leftSeenAt = Number(left.lastSeenAt || 0);
      const rightSeenAt = Number(right.lastSeenAt || 0);
      if (leftSeenAt !== rightSeenAt) {
        return rightSeenAt - leftSeenAt;
      }
      return String(left.characterName || "").localeCompare(String(right.characterName || ""), "en-US");
    });
  }

  function buildPassiveSessionKey(passiveBridge, passiveLiveScope) {
    const channelName =
      (passiveLiveScope && passiveLiveScope.channelName) || (passiveBridge && passiveBridge.channelName) || null;
    if (!passiveBridge || passiveBridge.enabled !== true || !channelName) {
      return null;
    }
    const sessionId =
      (passiveLiveScope && passiveLiveScope.sessionId) || (passiveBridge && passiveBridge.sessionId) || "";
    return `${channelName}::${sessionId}`;
  }

  function selectPassiveLiveEvents(passiveBridge, passiveLiveFeedState) {
    const passiveLiveScope = buildPassiveLiveScope(passiveBridge, passiveLiveFeedState);
    const sessionEntries = passiveLiveScope.sessionId
      ? passiveLiveScope.entries.filter((entry) => entry.sessionId === passiveLiveScope.sessionId)
      : passiveLiveScope.entries;
    const clearSequence = Number(passiveLiveScope.latestApplicantClearSequence || 0);
    if (clearSequence <= 0) {
      return sessionEntries;
    }

    return sessionEntries.filter((entry) => {
      if (entry.source === "appclear") {
        return Number(entry.sequence || 0) === clearSequence;
      }
      if (entry.source === "applicant") {
        return Number(entry.sequence || 0) > clearSequence;
      }
      return true;
    });
  }

  function syncPassiveEventBroker(passiveBridge, passiveLiveFeedState) {
    if (!passiveBridge || passiveBridge.enabled !== true) {
      return {
        sessionKey: null,
        events: [],
        passiveLiveFeedState: buildBrokeredPassiveLiveFeedState(passiveLiveFeedState, null),
        passiveLiveQueue: listPassiveQueueRuntimeEntries(),
      };
    }

    const passiveLiveScope = buildPassiveLiveScope(passiveBridge, passiveLiveFeedState);
    const passiveSessionKey = buildPassiveSessionKey(passiveBridge, passiveLiveScope);
    if (passiveSessionKey !== passiveBrokerRuntime.sessionKey) {
      resetPassiveBrokerCursor(passiveSessionKey);
    }

    const nowMs = Date.now();
    const liveEvents = selectPassiveLiveEvents(passiveBridge, passiveLiveFeedState).sort(comparePassiveEventOrder);

    let sawNewEvent = false;
    for (const entry of liveEvents) {
      sawNewEvent = queuePendingPassiveEvent(entry, nowMs) || sawNewEvent;
    }

    const shouldForceFlush =
      liveEvents.some((entry) => entry.source === "appclear") ||
      passiveBrokerRuntime.pendingEvents.length >= passiveEventBatchMaxSize;
    const flushedEvents =
      sawNewEvent || passiveBrokerRuntime.pendingEvents.length > 0
        ? flushPendingPassiveEvents(nowMs, shouldForceFlush)
        : [];

    return {
      sessionKey: passiveSessionKey,
      events: flushedEvents,
      passiveLiveFeedState: buildBrokeredPassiveLiveFeedState(passiveLiveFeedState, passiveLiveScope),
      passiveLiveQueue: listPassiveQueueRuntimeEntries(),
    };
  }

  function syncLfgRuntimeFromSavedVariables(savedVariablesSnapshot) {
    if (!savedVariablesSnapshot || savedVariablesSnapshot.lastModifiedMs == null) {
      return;
    }

    if (
      Number.isFinite(lfgRuntime.latestLiveEventAtMs) &&
      lfgRuntime.latestLiveEventAtMs > 0 &&
      savedVariablesSnapshot.lastModifiedMs < lfgRuntime.latestLiveEventAtMs
    ) {
      if (savedVariablesSnapshot.file) {
        clearLnnrankSavedVariablesApplicants(savedVariablesSnapshot.file);
      }
      lfgRuntime.lastSavedVariablesModifiedMs = savedVariablesSnapshot.lastModifiedMs;
      return;
    }

    if (savedVariablesSnapshot.lastModifiedMs === lfgRuntime.lastSavedVariablesModifiedMs) {
      return;
    }

    lfgRuntime.lastSavedVariablesModifiedMs = savedVariablesSnapshot.lastModifiedMs;
    resetLfgRuntimeState();
    for (const entry of savedVariablesSnapshot.parsed.applicants || []) {
      upsertLfgRuntimeEntry(entry, "savedvariables");
    }
  }

  function syncLfgRuntimeFromPassiveBroker(passiveBridge, brokerSnapshot) {
    if (!passiveBridge || passiveBridge.enabled !== true || !brokerSnapshot) {
      return;
    }

    const passiveSessionKey = brokerSnapshot.sessionKey || null;
    if (passiveSessionKey !== lfgRuntime.passiveSessionKey) {
      resetLfgRuntimeState();
      lfgRuntime.passiveSessionKey = passiveSessionKey;
    }

    for (const entry of brokerSnapshot.events || []) {
      if (entry.source !== "applicant" && entry.source !== "appclear") {
        continue;
      }

      if (entry.source === "appclear") {
        lfgRuntime.entries.clear();
      } else {
        upsertLfgRuntimeEntry(entry, "passive-live");
      }

      lfgRuntime.latestLiveEventAtMs = Math.max(
        lfgRuntime.latestLiveEventAtMs,
        Number(entry.eventAtMs || 0),
        Date.parse(entry.updatedAt || "") || 0
      );
    }
  }

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

  function pruneSeenBrokerEvents(nowMs = Date.now()) {
    const maxAgeMs = 6 * 60 * 60 * 1000;
    const maxEntries = 6000;
    for (const [eventId, seenAtMs] of passiveBrokerRuntime.seenEventIds.entries()) {
      if (nowMs - Number(seenAtMs || 0) > maxAgeMs) {
        passiveBrokerRuntime.seenEventIds.delete(eventId);
      }
    }

    const overflow = passiveBrokerRuntime.seenEventIds.size - maxEntries;
    if (overflow <= 0) {
      return;
    }

    const sorted = [...passiveBrokerRuntime.seenEventIds.entries()].sort((left, right) => left[1] - right[1]);
    for (let index = 0; index < overflow; index += 1) {
      passiveBrokerRuntime.seenEventIds.delete(sorted[index][0]);
    }
  }

  function buildBrokerLogEvent(event) {
    const eventAt =
      Number(event && event.capturedAtMs) > 0
        ? new Date(event.capturedAtMs).toISOString()
        : event && event.capturedAt
          ? event.capturedAt
          : null;
    return {
      id: buildAddonEventIdentity(event),
      key: `event:${buildAddonEventIdentity(event) || buildAddonEventPreview(event)}`,
      kind: "payload",
      preview: buildAddonEventPreview(event),
      payload: event && event.payload ? event.payload : buildAddonEventPreview(event),
      eventAt,
      firstSeenAt: eventAt,
      lastSeenAt: eventAt,
      seenCount: 1,
      source: event && event.source ? event.source : null,
      eventType: event && event.eventType ? event.eventType : null,
      sessionId: event && event.sessionId ? event.sessionId : null,
      channelName: event && event.channelName ? event.channelName : null,
      characterName: event && event.characterName ? event.characterName : null,
      realm: event && event.realm ? event.realm : null,
      groupID: event && event.groupID != null ? event.groupID : null,
    };
  }

  function normalizeSearchRuntimeEntry(event) {
    if (!event || event.eventType !== "search" || !event.region || !event.realm || !event.characterName) {
      return null;
    }

    const updatedAt =
      Number(event.capturedAtMs) > 0 ? new Date(event.capturedAtMs).toISOString() : event.capturedAt || null;
    return {
      key: buildCacheKey(event.region, event.realm, event.characterName),
      region: event.region,
      realm: event.realm,
      characterName: event.characterName,
      requestTimestamp: updatedAt,
      updatedAt,
      lastSeenAt: Number(event.capturedAtMs) > 0 ? Math.floor(event.capturedAtMs / 1000) : null,
      seenCount: 1,
      sources: [event.source || "unknown"],
      requestOrigins: [event.publisher || "unknown"],
      channelName: event.channelName || null,
      sessionId: event.sessionId || null,
      payload: event.payload || null,
      eventId: event.eventId || null,
      sequence: event.sequence || null,
      assignedRole: event.assignedRole || null,
      class: event.class || null,
      groupID: event.groupID != null ? event.groupID : null,
      memberIndex: event.memberIndex != null ? event.memberIndex : null,
      itemLevel: event.itemLevel != null ? event.itemLevel : null,
      level: event.level != null ? event.level : null,
    };
  }

  function upsertSearchRuntimeEntry(event) {
    const candidate = normalizeSearchRuntimeEntry(event);
    if (!candidate) {
      return;
    }

    const existing = passiveQueueRuntime.entries.get(candidate.key);
    if (!existing) {
      passiveQueueRuntime.entries.set(candidate.key, candidate);
      return;
    }

    const existingMs = Date.parse(existing.updatedAt || "");
    const candidateMs = Date.parse(candidate.updatedAt || "");
    const shouldReplace =
      !Number.isFinite(existingMs) ||
      (Number.isFinite(candidateMs) && candidateMs > existingMs) ||
      (candidateMs === existingMs && Number(candidate.sequence || 0) >= Number(existing.sequence || 0));

    const mergedSources = [...new Set([...(existing.sources || []), ...(candidate.sources || [])])];
    const mergedOrigins = [...new Set([...(existing.requestOrigins || []), ...(candidate.requestOrigins || [])])];
    passiveQueueRuntime.entries.set(candidate.key, {
      ...(shouldReplace ? existing : candidate),
      ...(shouldReplace ? candidate : existing),
      key: candidate.key,
      requestTimestamp: shouldReplace ? candidate.requestTimestamp : existing.requestTimestamp,
      updatedAt: shouldReplace ? candidate.updatedAt : existing.updatedAt,
      lastSeenAt: Math.max(Number(existing.lastSeenAt || 0), Number(candidate.lastSeenAt || 0)) || null,
      seenCount: Math.max(Number(existing.seenCount || 0), Number(candidate.seenCount || 0)),
      sources: mergedSources,
      requestOrigins: mergedOrigins,
    });
  }

  function getResolvedQueueStatus(cache, queueEntry) {
    const statuses = new Map(
      listRequestStatuses(cache).map((status) => [
        status.key || buildCacheKey(status.region, status.realm, status.name || status.characterName),
        status,
      ])
    );
    return statuses.get(queueEntry.key) || null;
  }

  function listBrokerQueueEntries(cache) {
    const queueEntries = [];
    const requestStatuses = new Map(
      listRequestStatuses(cache).map((status) => [
        status.key || buildCacheKey(status.region, status.realm, status.name || status.characterName),
        status,
      ])
    );

    for (const entry of passiveQueueRuntime.entries.values()) {
      const record = getFreshCachedRecord(cache, {
        region: entry.region,
        realm: entry.realm,
        name: entry.characterName,
      });
      if (record) {
        continue;
      }

      const status = requestStatuses.get(entry.key) || null;
      const statusUpdatedAtMs = Date.parse((status && status.updatedAt) || "");
      const requestUpdatedAtMs = Date.parse(entry.updatedAt || entry.requestTimestamp || "");
      const isResolved =
        status &&
        RESOLVED_QUEUE_STATES.has(status.state) &&
        Number.isFinite(statusUpdatedAtMs) &&
        Number.isFinite(requestUpdatedAtMs) &&
        statusUpdatedAtMs >= requestUpdatedAtMs;
      if (isResolved) {
        continue;
      }

      queueEntries.push({
        ...entry,
        record: null,
        status: status || null,
      });
    }

    return queueEntries.sort((left, right) =>
      String(right.updatedAt || right.requestTimestamp || "").localeCompare(
        String(left.updatedAt || left.requestTimestamp || ""),
        "en-US"
      )
    );
  }

  function getLfgPublisherState(publisherKey) {
    const key = publisherKey || "default";
    if (!lfgRuntime.publishers.has(key)) {
      lfgRuntime.publishers.set(key, {
        activeGroups: new Map(),
        pendingHeartbeats: new Map(),
        latestAppliedAtMs: 0,
        lastHeartbeatAtMs: 0,
        transport: null,
      });
    }
    return lfgRuntime.publishers.get(key);
  }

  function rebuildLfgRuntimeEntries() {
    lfgRuntime.entries.clear();
    for (const [publisherKey, publisherState] of lfgRuntime.publishers.entries()) {
      for (const group of publisherState.activeGroups.values()) {
        for (const member of group.members || []) {
          const normalized = normalizeLfgRuntimeEntry(
            {
              ...member,
              source: "applicant",
              requestOrigin: "lfg-status",
              publisherKey,
              lastSeenAt: Math.floor(Number(group.capturedAtMs || 0) / 1000),
              updatedAt: Number(group.capturedAtMs || 0) > 0 ? new Date(group.capturedAtMs).toISOString() : null,
            },
            "lfg-status"
          );
          if (!normalized) {
            continue;
          }
          lfgRuntime.entries.set(buildLfgRuntimeKey(normalized), normalized);
        }
      }
    }
  }

  function applyLfgHeartbeatBatch(publisherKey, heartbeatId) {
    const publisherState = getLfgPublisherState(publisherKey);
    const batch = publisherState.pendingHeartbeats.get(heartbeatId);
    if (!batch) {
      return;
    }

    const ignoreBeforeMs = Math.max(Number(lfgRuntime.ignoreBeforeMs || 0), Number(publisherState.latestAppliedAtMs || 0));
    if (Number(batch.capturedAtMs || 0) < ignoreBeforeMs) {
      publisherState.pendingHeartbeats.delete(heartbeatId);
      return;
    }

    publisherState.activeGroups = new Map(batch.groups.entries());
    publisherState.latestAppliedAtMs = Number(batch.capturedAtMs || 0);
    publisherState.lastHeartbeatAtMs = Number(batch.capturedAtMs || 0);
    publisherState.transport = batch.transport || publisherState.transport || null;
    publisherState.pendingHeartbeats.clear();
    lfgRuntime.latestLiveEventAtMs = Math.max(lfgRuntime.latestLiveEventAtMs, publisherState.latestAppliedAtMs);
    rebuildLfgRuntimeEntries();
  }

  function mergeLfgHeartbeatBatchIntoActiveGroups(publisherKey, heartbeatId) {
    const publisherState = getLfgPublisherState(publisherKey);
    const batch = publisherState.pendingHeartbeats.get(heartbeatId);
    if (!batch) {
      return;
    }

    const ignoreBeforeMs = Math.max(Number(lfgRuntime.ignoreBeforeMs || 0), Number(publisherState.latestAppliedAtMs || 0));
    if (Number(batch.capturedAtMs || 0) < ignoreBeforeMs) {
      return;
    }

    let changed = false;
    for (const [groupKey, group] of batch.groups.entries()) {
      const currentGroup = publisherState.activeGroups.get(groupKey);
      if (!currentGroup || Number(currentGroup.capturedAtMs || 0) <= Number(group.capturedAtMs || 0)) {
        publisherState.activeGroups.set(groupKey, {
          groupID: group.groupID,
          capturedAtMs: group.capturedAtMs,
          members: Array.isArray(group.members) ? [...group.members] : [],
        });
        changed = true;
      }
    }

    publisherState.latestAppliedAtMs = Math.max(Number(publisherState.latestAppliedAtMs || 0), Number(batch.capturedAtMs || 0));
    publisherState.lastHeartbeatAtMs = Math.max(Number(publisherState.lastHeartbeatAtMs || 0), Number(batch.capturedAtMs || 0));
    publisherState.transport = batch.transport || publisherState.transport || null;
    lfgRuntime.latestLiveEventAtMs = Math.max(lfgRuntime.latestLiveEventAtMs, publisherState.latestAppliedAtMs);

    if (changed) {
      rebuildLfgRuntimeEntries();
    }
  }

  function processLfgStatusEvent(event) {
    if (!event || event.eventType !== "lfg_status" || Number(event.capturedAtMs || 0) < Number(lfgRuntime.ignoreBeforeMs || 0)) {
      return;
    }

    const publisherKey = event.publisherKey || event.channelName || event.publisher || "default";
    const publisherState = getLfgPublisherState(publisherKey);
    const eventCapturedAtMs = Number(event.capturedAtMs || 0);
    if (eventCapturedAtMs < Number(publisherState.latestAppliedAtMs || 0)) {
      return;
    }

    publisherState.lastHeartbeatAtMs = Math.max(Number(publisherState.lastHeartbeatAtMs || 0), eventCapturedAtMs);
    const batchTotal = Number(event.batchTotal || 0);
    if (batchTotal <= 0) {
      publisherState.activeGroups.clear();
      publisherState.pendingHeartbeats.clear();
      publisherState.latestAppliedAtMs = eventCapturedAtMs;
      publisherState.transport = event.publisher || publisherState.transport || null;
      rebuildLfgRuntimeEntries();
      return;
    }

    const heartbeatId = event.heartbeatId || event.eventId || `${publisherKey}:${eventCapturedAtMs}`;
    const batch = publisherState.pendingHeartbeats.get(heartbeatId) || {
      capturedAtMs: eventCapturedAtMs,
      totalParts: batchTotal,
      parts: new Set(),
      groups: new Map(),
      transport: event.publisher || null,
    };
    batch.capturedAtMs = Math.max(Number(batch.capturedAtMs || 0), eventCapturedAtMs);
    batch.totalParts = Math.max(Number(batch.totalParts || 0), batchTotal);
    batch.parts.add(Number(event.batchIndex || 0));

    if (Array.isArray(event.members)) {
      for (const member of event.members) {
        if (!member || !member.characterName || !member.realm) {
          continue;
        }
        const resolvedGroupId = member.groupID != null ? member.groupID : event.groupID != null ? event.groupID : null;
        const groupKey =
          resolvedGroupId != null
            ? String(resolvedGroupId)
            : `solo:${member.characterName}:${member.realm}:${member.memberIndex || 0}`;
        const group = batch.groups.get(groupKey) || {
          groupID: resolvedGroupId,
          capturedAtMs: batch.capturedAtMs,
          members: [],
        };
        group.capturedAtMs = batch.capturedAtMs;
        group.groupID = resolvedGroupId;
        const memberKey = `${member.characterName}:${member.realm}:${member.memberIndex || 0}`;
        const withoutExisting = group.members.filter(
          (existingMember) =>
            `${existingMember.characterName}:${existingMember.realm}:${existingMember.memberIndex || 0}` !== memberKey
        );
        group.members = [
          ...withoutExisting,
          {
            region: event.region || "us",
            realm: member.realm,
            characterName: member.characterName,
            groupID: resolvedGroupId,
            memberIndex: member.memberIndex != null ? member.memberIndex : event.memberIndex || null,
            class: member.class || event.class || null,
            assignedRole: member.assignedRole || event.assignedRole || null,
            itemLevel: event.itemLevel != null ? event.itemLevel : null,
            level: event.level != null ? event.level : null,
          },
        ];
        batch.groups.set(groupKey, group);
      }
    }

    publisherState.pendingHeartbeats.set(heartbeatId, batch);
    mergeLfgHeartbeatBatchIntoActiveGroups(publisherKey, heartbeatId);
    if (batch.parts.size >= batch.totalParts) {
      applyLfgHeartbeatBatch(publisherKey, heartbeatId);
    }
  }

  function isLegacyApplicantSearchEvent(event) {
    return (
      event &&
      event.eventType === "search" &&
      event.source === "applicant" &&
      typeof event.payload === "string" &&
      !event.payload.includes("|e=")
    );
  }

  function processLegacyApplicantLfgEvent(event) {
    if (Number(event && event.capturedAtMs || 0) < Number(lfgRuntime.ignoreBeforeMs || 0)) {
      return;
    }

    const normalized = normalizeLfgRuntimeEntry(
      {
        ...event,
        applicantID: event.applicantID != null ? event.applicantID : null,
        source: "applicant",
        requestOrigin: "passive-live",
        lastSeenAt: Number(event.capturedAtMs || 0) > 0 ? Math.floor(event.capturedAtMs / 1000) : null,
        updatedAt: Number(event.capturedAtMs || 0) > 0 ? new Date(event.capturedAtMs).toISOString() : event.capturedAt,
      },
      "passive-live"
    );
    if (!normalized) {
      return;
    }

    upsertLfgRuntimeEntry(normalized, "passive-live");
    lfgRuntime.latestLiveEventAtMs = Math.max(lfgRuntime.latestLiveEventAtMs, Number(event.capturedAtMs || 0));
  }

  function expireStaleLfgState(nowMs = Date.now()) {
    const pendingHeartbeatTtlMs = 15000;
    let changed = false;
    for (const publisherState of lfgRuntime.publishers.values()) {
      for (const [heartbeatId, batch] of publisherState.pendingHeartbeats.entries()) {
        if (nowMs - Number(batch && batch.capturedAtMs || 0) > pendingHeartbeatTtlMs) {
          publisherState.pendingHeartbeats.delete(heartbeatId);
          changed = true;
        }
      }
    }

    if (changed) {
      rebuildLfgRuntimeEntries();
    }
  }

  function rebuildLiveLfgRuntimeFromCurrentEvents(events, passiveSessionId = null) {
    if (!Array.isArray(events) || events.length <= 0) {
      return;
    }

    resetLfgRuntimeState();
    if (passiveSessionId != null) {
      lfgRuntime.passiveSessionKey = passiveSessionId;
    }

    for (const event of [...events].sort(compareAddonEvents)) {
      if (event.eventType === "lfg_status") {
        processLfgStatusEvent(event);
        continue;
      }

      if (isLegacyApplicantSearchEvent(event)) {
        processLegacyApplicantLfgEvent(event);
      }
    }
  }

  function parseSavedBatchEvents(savedVariablesSnapshot) {
    const savedEvents =
      savedVariablesSnapshot &&
      savedVariablesSnapshot.parsed &&
      savedVariablesSnapshot.parsed.eventBatch &&
      Array.isArray(savedVariablesSnapshot.parsed.eventBatch.events)
        ? savedVariablesSnapshot.parsed.eventBatch.events
        : [];

    return savedEvents
      .map((entry) => {
        if (!entry || typeof entry.payload !== "string") {
          return null;
        }
        return parseAddonEventPayload(entry.payload, {
          fallbackTimestampMs: Number(entry.publishedAt || 0) > 0 ? Number(entry.publishedAt) * 1000 : 0,
          publisher: "savedvariables",
        });
      })
      .filter(Boolean)
      .sort(compareAddonEvents);
  }

  function parseLegacySavedRequestEvents(savedVariablesSnapshot) {
    const savedRequests =
      savedVariablesSnapshot && savedVariablesSnapshot.parsed && Array.isArray(savedVariablesSnapshot.parsed.requests)
        ? savedVariablesSnapshot.parsed.requests
        : [];

    return savedRequests
      .map((entry) => {
        if (!entry || !entry.region || !entry.realm || !entry.characterName) {
          return null;
        }
        const capturedAtMs =
          Number(entry.lastSeenAt || 0) > 0
            ? Number(entry.lastSeenAt) * 1000
            : Number(entry.queuedAt || 0) > 0
              ? Number(entry.queuedAt) * 1000
              : 0;
        return {
          eventType: "search",
          eventId: `legacy-request:${entry.key || buildCacheKey(entry.region, entry.realm, entry.characterName)}:${
            capturedAtMs || 0
          }`,
          region: entry.region,
          realm: entry.realm,
          characterName: entry.characterName,
          source: entry.source || "savedvariables",
          publisher: "savedvariables",
          sequence: null,
          capturedAtMs,
          capturedAt: capturedAtMs > 0 ? new Date(capturedAtMs).toISOString() : null,
          updatedAt: capturedAtMs > 0 ? new Date(capturedAtMs).toISOString() : null,
          payload: null,
          channelName: null,
          sessionId: null,
          publisherKey: "savedvariables",
          groupID: entry.groupID != null ? entry.groupID : null,
          memberIndex: entry.memberIndex != null ? entry.memberIndex : null,
          assignedRole: entry.assignedRole || null,
          class: entry.class || null,
          itemLevel: entry.itemLevel != null ? entry.itemLevel : null,
          level: entry.level != null ? entry.level : null,
        };
      })
      .filter(Boolean)
      .sort(compareAddonEvents);
  }

  function parseManualPublisherEvents(cache) {
    return listManualRequests(cache)
      .map((entry) => {
        if (!entry || !entry.region || !entry.realm || !entry.characterName) {
          return null;
        }
        const capturedAtMs = Date.parse(entry.updatedAt || entry.createdAt || "");
        return {
          eventType: "search",
          eventId:
            entry.eventId ||
            `manual:${buildCacheKey(entry.region, entry.realm, entry.characterName)}:${capturedAtMs || 0}`,
          region: entry.region,
          realm: entry.realm,
          characterName: entry.characterName,
          source: entry.source || "manual",
          publisher: "manual",
          sequence: null,
          capturedAtMs: Number.isFinite(capturedAtMs) ? capturedAtMs : Date.now(),
          capturedAt:
            Number.isFinite(capturedAtMs) ? new Date(capturedAtMs).toISOString() : new Date().toISOString(),
          updatedAt:
            Number.isFinite(capturedAtMs) ? new Date(capturedAtMs).toISOString() : new Date().toISOString(),
          payload: null,
          channelName: null,
          sessionId: null,
          publisherKey: "manual",
        };
      })
      .filter(Boolean)
      .sort(compareAddonEvents);
  }

  function buildPassiveLogicalEventKey(event) {
    if (!event || typeof event !== "object") {
      return null;
    }

    if (event.eventType === "lfg_status") {
      return [
        "lfg_status",
        event.publisherKey || event.channelName || event.publisher || "default",
        event.sessionId || "session",
        event.heartbeatId || event.capturedAtMs || "heartbeat",
        event.batchIndex != null ? event.batchIndex : "batch",
      ].join(":");
    }

    return buildAddonEventIdentity(event);
  }

  function getPassiveLogicalEventScore(event) {
    if (!event || typeof event !== "object") {
      return [0, 0, 0, 0, 0];
    }

    if (event.eventType === "lfg_status") {
      return [
        Number(event.batchTotal || 0),
        Array.isArray(event.members) ? event.members.length : 0,
        String(event.payload || "").length,
        Number(event.sequence || 0),
        Number(event.capturedAtMs || 0),
      ];
    }

    return [
      String(event.payload || "").length,
      Number(event.sequence || 0),
      Number(event.capturedAtMs || 0),
      0,
      0,
    ];
  }

  function comparePassiveLogicalEventScore(left, right) {
    const leftScore = getPassiveLogicalEventScore(left);
    const rightScore = getPassiveLogicalEventScore(right);
    const length = Math.max(leftScore.length, rightScore.length);
    for (let index = 0; index < length; index += 1) {
      const delta = Number(rightScore[index] || 0) - Number(leftScore[index] || 0);
      if (delta !== 0) {
        return delta;
      }
    }

    return compareAddonEvents(left, right);
  }

  function collapsePassiveLogicalEvents(events) {
    const collapsed = new Map();
    for (const event of events || []) {
      const key = buildPassiveLogicalEventKey(event);
      if (!key) {
        continue;
      }

      const existing = collapsed.get(key);
      if (!existing || comparePassiveLogicalEventScore(existing, event) > 0) {
        collapsed.set(key, event);
      }
    }

    return [...collapsed.values()].sort(compareAddonEvents);
  }

  function parsePassiveLiveBrokerEvents(passiveBridge, passiveLiveFeedState) {
    if (!passiveBridge || passiveBridge.enabled !== true || !passiveLiveFeedState) {
      return {
        activeSessionId: passiveBridge && passiveBridge.sessionId ? passiveBridge.sessionId : null,
        events: [],
      };
    }

    const parsePassivePayloadList = (items) =>
      (items || [])
      .filter((entry) => entry && entry.kind === "payload" && typeof entry.preview === "string")
      .map((entry) =>
        parseAddonEventPayload(entry.preview, {
          fallbackTimestampMs:
            Date.parse(entry.eventAt || entry.firstSeenAt || entry.lastSeenAt || "") || Date.now(),
          publisher: "passive-live",
        })
      )
      .filter(Boolean);

    const parsedEntryEvents = parsePassivePayloadList(
      passiveLiveFeedState && Array.isArray(passiveLiveFeedState.entries) ? passiveLiveFeedState.entries : []
    );
    const parsedHistoryEvents = parsePassivePayloadList(
      passiveLiveFeedState && Array.isArray(passiveLiveFeedState.events) ? passiveLiveFeedState.events : []
    );

    const channelName = passiveBridge.channelName || null;
    const channelScopedEntryEvents = channelName
      ? parsedEntryEvents.filter((event) => event.channelName === channelName)
      : parsedEntryEvents;
    const channelScopedHistoryEvents = channelName
      ? parsedHistoryEvents.filter((event) => event.channelName === channelName)
      : parsedHistoryEvents;
    const preferredSessionId = passiveBridge.sessionId || null;

    const latestEventForSession = (events, sessionId) => {
      if (!sessionId) {
        return null;
      }
      const sessionEvents = (events || []).filter((event) => event.sessionId === sessionId);
      return sessionEvents.length > 0 ? [...sessionEvents].sort(compareAddonEvents)[sessionEvents.length - 1] : null;
    };

    const latestEventOverall = (events) =>
      events && events.length > 0 ? [...events].sort(compareAddonEvents)[events.length - 1] : null;

    let selectedEvents = channelScopedEntryEvents;
    let activeSessionId = null;

    const preferredEntryEvent = latestEventForSession(channelScopedEntryEvents, preferredSessionId);
    const preferredHistoryEvent = latestEventForSession(channelScopedHistoryEvents, preferredSessionId);
    const latestEntryEvent = latestEventOverall(channelScopedEntryEvents);
    const latestHistoryEvent = latestEventOverall(channelScopedHistoryEvents);

    if (preferredEntryEvent) {
      const preferredEntryEventAtMs = Number(preferredEntryEvent.capturedAtMs || 0);
      const latestEntryEventAtMs = Number((latestEntryEvent && latestEntryEvent.capturedAtMs) || 0);
      const shouldPreferLatestEntrySession =
        latestEntryEvent &&
        latestEntryEvent.sessionId !== preferredSessionId &&
        latestEntryEventAtMs - preferredEntryEventAtMs > 60 * 1000;

      if (shouldPreferLatestEntrySession) {
        activeSessionId = latestEntryEvent.sessionId || preferredSessionId;
        selectedEvents = channelScopedEntryEvents;
      } else {
        activeSessionId = preferredSessionId;
        selectedEvents = channelScopedEntryEvents;
      }
    } else if (latestEntryEvent) {
      const latestEntryEventAtMs = Number(latestEntryEvent.capturedAtMs || 0);
      const preferredHistoryEventAtMs = Number((preferredHistoryEvent && preferredHistoryEvent.capturedAtMs) || 0);
      const shouldPreferHistorySession =
        preferredHistoryEvent &&
        latestEntryEvent.sessionId !== preferredSessionId &&
        preferredHistoryEventAtMs > 0 &&
        latestEntryEventAtMs - preferredHistoryEventAtMs <= 60 * 1000;

      if (shouldPreferHistorySession) {
        activeSessionId = preferredSessionId;
        selectedEvents = channelScopedHistoryEvents;
      } else {
        activeSessionId = latestEntryEvent.sessionId || preferredSessionId;
        selectedEvents = channelScopedEntryEvents;
      }
    } else if (preferredHistoryEvent) {
      activeSessionId = preferredSessionId;
      selectedEvents = channelScopedHistoryEvents;
    } else {
      activeSessionId = (latestHistoryEvent && latestHistoryEvent.sessionId) || preferredSessionId;
      selectedEvents = channelScopedHistoryEvents;
    }

    const sessionScopedEvents = activeSessionId
      ? selectedEvents.filter((event) => event.sessionId === activeSessionId)
      : selectedEvents;

    return {
      activeSessionId,
      events: collapsePassiveLogicalEvents(sessionScopedEvents),
    };
  }

  function publishBrokerEvents(events) {
    const delivered = [];
    for (const event of [...(events || [])].sort(compareAddonEvents)) {
      const identity = buildAddonEventIdentity(event);
      if (!identity || passiveBrokerRuntime.seenEventIds.has(identity)) {
        continue;
      }

      passiveBrokerRuntime.seenEventIds.set(identity, Number(event.capturedAtMs || Date.now()));
      passiveBrokerRuntime.events = [...passiveBrokerRuntime.events, buildBrokerLogEvent(event)].slice(
        -PASSIVE_BROKER_EVENT_LIMIT
      );
      if (event.eventType === "search") {
        upsertSearchRuntimeEntry(event);
        if (isLegacyApplicantSearchEvent(event)) {
          processLegacyApplicantLfgEvent(event);
        }
      } else if (event.eventType === "lfg_status") {
        processLfgStatusEvent(event);
      }
      delivered.push(event);
    }

    pruneSeenBrokerEvents();
    return delivered;
  }

  function syncBrokerState(cache, savedVariablesSnapshot, passiveBridge, passiveLiveFeedState) {
    const savedBatchEvents = parseSavedBatchEvents(savedVariablesSnapshot);
    const legacySavedRequestEvents = parseLegacySavedRequestEvents(savedVariablesSnapshot);
    const manualEvents = parseManualPublisherEvents(cache);
    const passiveLiveScope = parsePassiveLiveBrokerEvents(passiveBridge, passiveLiveFeedState);
    const deliveredEvents = publishBrokerEvents([
      ...savedBatchEvents,
      ...legacySavedRequestEvents,
      ...manualEvents,
      ...passiveLiveScope.events,
    ]);

    if (savedBatchEvents.length > 0 && savedVariablesSnapshot && savedVariablesSnapshot.file) {
      clearLnnrankSavedVariablesEventBatch(savedVariablesSnapshot.file);
    }

    rebuildLiveLfgRuntimeFromCurrentEvents(passiveLiveScope.events, passiveLiveScope.activeSessionId || null);
    expireStaleLfgState();

    return {
      deliveredEvents,
      queue: listBrokerQueueEntries(cache),
      applicants: listLfgRuntimeEntries(),
      passiveLiveFeedState: passiveLiveFeedState
        ? {
            ...passiveLiveFeedState,
            activeSessionId: passiveLiveScope.activeSessionId || null,
            events: [...passiveBrokerRuntime.events],
            eventCount: passiveBrokerRuntime.events.length,
          }
        : null,
    };
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
    const cache = loadCache(dbPath);
    const savedVariables = loadSavedVariablesSnapshot(accountRoot);
    const passiveBridge = normalizePassiveBridge(savedVariables.parsed.passiveBridge);
    const rawPassiveLiveFeedState =
      typeof passiveLiveFeedStateOverride === "function"
        ? passiveLiveFeedStateOverride()
        : passiveLiveFeedStateOverride || (passiveLiveFeedMonitor ? passiveLiveFeedMonitor.snapshot() : null);
    const brokerSnapshot = syncBrokerState(cache, savedVariables, passiveBridge, rawPassiveLiveFeedState);

    return buildDashboardState({
      dbPath,
      accountRoot,
      cacheOverride: cache,
      savedVariablesOverride: savedVariables,
      queueOverride: brokerSnapshot.queue,
      applicantsOverride: brokerSnapshot.applicants,
      autoSyncState: getAutoSyncState(),
      passiveLiveFeedState: brokerSnapshot.passiveLiveFeedState,
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
          autoSync.currentLookup = null;
          autoSync.queueLength = 0;
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
            autoSync.currentLookup =
              Object.prototype.hasOwnProperty.call(update, "lookup") ||
              Object.prototype.hasOwnProperty.call(update, "request")
                ? update.lookup || update.request || null
                : autoSync.currentLookup;
            if (Object.prototype.hasOwnProperty.call(update, "queueLength")) {
              autoSync.queueLength = update.queueLength;
            }
            if (Object.prototype.hasOwnProperty.call(update, "statusCount")) {
              autoSync.statusCount = update.statusCount;
            }
          },
        });
        autoSync.lastResult = result;
        autoSync.currentLookup = null;
        return result;
      } catch (error) {
        autoSync.lastError = error.message || "Auto sync failed.";
        throw error;
      } finally {
        autoSync.isRunning = false;
        autoSync.lastFinishedAt = new Date().toISOString();

        const afterState = snapshotState();
        autoSync.currentLookup = null;
        autoSync.queueLength = afterState.meta.queueCount;
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
        if (!passiveLiveFeedStateOverride && passiveLiveFeedMonitor && state.passiveBridge) {
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
        const updatedAt = formatIsoTimestamp();
        const manualEventId = `manual:${buildCacheKey(body.region || "us", body.realm, body.name)}:${Date.now()}`;
        const entry = upsertManualRequest(cache, {
          region: body.region || "us",
          realm: body.realm,
          characterName: body.name,
          source: "manual",
          updatedAt,
          eventId: manualEventId,
        });
        upsertRequestStatus(cache, {
          region: entry.region,
          realm: entry.realm,
          name: entry.characterName,
          state: "queued",
          message: "Queued from the dashboard.",
          source: entry.source || "manual",
          updatedAt,
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
        removePassiveQueueRuntimeEntry(key);

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
        clearPassiveQueueRuntime();

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

      if (request.method === "POST" && requestUrl.pathname === "/api/lfg/clear") {
        const savedVariables = loadSavedVariablesSnapshot(accountRoot);
        if (savedVariables && savedVariables.file) {
          clearLnnrankSavedVariablesApplicants(savedVariables.file);
          lfgRuntime.lastSavedVariablesModifiedMs = fs.statSync(savedVariables.file).mtimeMs;
        } else if (savedVariables && savedVariables.lastModifiedMs != null) {
          lfgRuntime.lastSavedVariablesModifiedMs = savedVariables.lastModifiedMs;
        }

        resetLfgRuntimeState();
        lfgRuntime.ignoreBeforeMs = Date.now();
        lfgRuntime.latestLiveEventAtMs = Math.max(lfgRuntime.latestLiveEventAtMs, lfgRuntime.ignoreBeforeMs);

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
        if (!passiveLiveFeedStateOverride && passiveLiveFeedMonitor && state.passiveBridge) {
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
