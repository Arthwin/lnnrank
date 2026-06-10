"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { normalizeText } = require("../mplus-matrix/normalization");
const { buildDerivedPresentation } = require("../shared/wow-performance");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const API_ATTEMPT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_DB_PATH = path.join(process.cwd(), "output", "wow-addons", "lnnrank-db.json");
// Backward-compatible fallback for older local dev data before the repo rename.
const LEGACY_CACHE_PATH = path.join(process.cwd(), "output", "wow-addons", "wclmplus-cache.json");
const DEFAULT_CACHE_PATH = DEFAULT_DB_PATH;

class ProviderCooldownError extends Error {
  constructor(provider, details = {}) {
    const untilText = details.nextAllowedAt ? ` until ${details.nextAllowedAt}` : "";
    super(`${provider} lookups are cooling down${untilText}.`);
    this.name = "ProviderCooldownError";
    this.provider = provider;
    this.details = details;
  }
}

function normalizeRegionKey(value) {
  return normalizeText(value).toLocaleLowerCase("en-US");
}

function normalizeRealmKey(value) {
  return normalizeText(value)
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}]+/gu, "");
}

function normalizeCharacterKey(value) {
  return normalizeText(value).toLocaleLowerCase("en-US");
}

function buildCacheKey(region, realm, name) {
  return [
    normalizeRegionKey(region),
    normalizeRealmKey(realm),
    normalizeCharacterKey(name),
  ].join(":");
}

function parseCacheKey(key) {
  const [region = "", realm = "", name = ""] = String(key || "").split(":", 3);
  return { region, realm, name };
}

function preferLatestTimestamp(existingValue, incomingValue) {
  const existingMs = Date.parse(existingValue || "");
  const incomingMs = Date.parse(incomingValue || "");

  if (!Number.isFinite(existingMs)) {
    return incomingValue || existingValue || null;
  }
  if (!Number.isFinite(incomingMs)) {
    return existingValue || incomingValue || null;
  }

  return incomingMs >= existingMs ? incomingValue : existingValue;
}

function normalizeLoadedRecord(record, fallbackKey) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const fallback = parseCacheKey(fallbackKey);
  return {
    region: normalizeRegionKey(record.region || fallback.region || "us"),
    realm: normalizeText(record.realm || fallback.realm || ""),
    name: normalizeText(record.name || record.characterName || fallback.name || ""),
    score: record.score ?? null,
    parseMetric: record.parseMetric ?? null,
    specName: record.specName ?? null,
    className: record.className ?? null,
    role: record.role ?? null,
    updatedAt: record.updatedAt ?? null,
    updatedAtUnix: record.updatedAtUnix ?? null,
    wclCharacterId: record.wclCharacterId ?? null,
    dungeons: Array.isArray(record.dungeons) ? record.dungeons : [],
    presentation: record.presentation && typeof record.presentation === "object" ? record.presentation : null,
  };
}

function normalizeLoadedRequest(request, fallbackKey) {
  if (!request || typeof request !== "object") {
    return null;
  }

  const fallback = parseCacheKey(fallbackKey);
  const region = normalizeRegionKey(request.region || fallback.region || "us");
  const realm = normalizeText(request.realm || fallback.realm || "");
  const characterName = normalizeText(request.characterName || request.name || fallback.name || "");
  return {
    ...request,
    region,
    realm,
    characterName,
    key: buildCacheKey(region, realm, characterName),
  };
}

function normalizeLoadedStatus(status, fallbackKey) {
  if (!status || typeof status !== "object") {
    return null;
  }

  const fallback = parseCacheKey(fallbackKey);
  const region = normalizeRegionKey(status.region || fallback.region || "us");
  const realm = normalizeText(status.realm || fallback.realm || "");
  const name = normalizeText(status.name || status.characterName || fallback.name || "");
  return {
    ...status,
    region,
    realm,
    name,
    key: buildCacheKey(region, realm, name),
  };
}

function mergeManualRequestEntries(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    source: incoming.source || existing.source || "manual",
    createdAt: existing.createdAt || incoming.createdAt || null,
    updatedAt: preferLatestTimestamp(existing.updatedAt, incoming.updatedAt),
  };
}

function mergeRequestStatusEntries(existing, incoming) {
  const existingMs = Date.parse(existing.updatedAt || "");
  const incomingMs = Date.parse(incoming.updatedAt || "");
  if (Number.isFinite(incomingMs) && (!Number.isFinite(existingMs) || incomingMs >= existingMs)) {
    return {
      ...existing,
      ...incoming,
      key: incoming.key,
    };
  }

  return {
    ...incoming,
    ...existing,
    key: existing.key,
  };
}

function normalizeLoadedCache(parsed) {
  const records = {};
  for (const [rawKey, rawRecord] of Object.entries(parsed && parsed.records ? parsed.records : {})) {
    const record = normalizeLoadedRecord(rawRecord, rawKey);
    if (!record || !record.name) {
      continue;
    }
    const key = buildCacheKey(record.region, record.realm, record.name);
    records[key] = mergeCharacterRecords(records[key] || null, record);
  }

  const manualRequests = {};
  for (const [rawKey, rawRequest] of Object.entries(parsed && parsed.manualRequests ? parsed.manualRequests : {})) {
    const request = normalizeLoadedRequest(rawRequest, rawKey);
    if (!request || !request.characterName) {
      continue;
    }
    manualRequests[request.key] = manualRequests[request.key]
      ? mergeManualRequestEntries(manualRequests[request.key], request)
      : request;
  }

  const requestStatuses = {};
  for (const [rawKey, rawStatus] of Object.entries(parsed && parsed.requestStatuses ? parsed.requestStatuses : {})) {
    const status = normalizeLoadedStatus(rawStatus, rawKey);
    if (!status || !status.name) {
      continue;
    }
    requestStatuses[status.key] = requestStatuses[status.key]
      ? mergeRequestStatusEntries(requestStatuses[status.key], status)
      : status;
  }

  return {
    records,
    manualRequests,
    requestStatuses,
    providerState:
      parsed && typeof parsed.providerState === "object" && parsed.providerState
        ? parsed.providerState
        : {},
  };
}

function loadCache(cachePath = DEFAULT_CACHE_PATH) {
  let resolvedPath = cachePath;
  if (cachePath === DEFAULT_DB_PATH && !fs.existsSync(resolvedPath) && fs.existsSync(LEGACY_CACHE_PATH)) {
    resolvedPath = LEGACY_CACHE_PATH;
  }

  if (!fs.existsSync(resolvedPath)) {
    return createEmptyCache();
  }

  const raw = fs.readFileSync(resolvedPath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  return normalizeLoadedCache(parsed);
}

function saveCache(cache, cachePath = DEFAULT_CACHE_PATH) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function getCachedRecord(cache, { region, realm, name }) {
  return cache.records[buildCacheKey(region, realm, name)] || null;
}

function getFreshCachedRecord(cache, lookup, now = Date.now()) {
  const record = getCachedRecord(cache, lookup);
  if (!record || !record.updatedAt) {
    return null;
  }

  const updatedAtMs = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return null;
  }

  if (now - updatedAtMs > CACHE_TTL_MS) {
    return null;
  }

  return record;
}

function isRoleSpecificParseMetric(value) {
  const metric = String(value || "").trim().toLocaleLowerCase("en-US");
  return metric === "dps" || metric === "hps";
}

function mergeDungeonArrays(existingDungeons, incomingDungeons, options = {}) {
  const merged = new Map();
  const replaceParseStats = Boolean(options.replaceParseStats);

  for (const dungeon of existingDungeons || []) {
    if (!dungeon || !dungeon.slug) {
      continue;
    }
    merged.set(dungeon.slug, {
      ...dungeon,
      bestPercent: replaceParseStats ? null : dungeon.bestPercent ?? null,
      points: replaceParseStats ? null : dungeon.points ?? null,
    });
  }

  for (const dungeon of incomingDungeons || []) {
    if (!dungeon || !dungeon.slug) {
      continue;
    }

    const existing = merged.get(dungeon.slug) || {};
    merged.set(dungeon.slug, {
      ...existing,
      ...dungeon,
      bestPercent: replaceParseStats
        ? dungeon.bestPercent ?? null
        : dungeon.bestPercent != null ? dungeon.bestPercent : existing.bestPercent ?? null,
      points: replaceParseStats
        ? dungeon.points ?? null
        : dungeon.points != null ? dungeon.points : existing.points ?? null,
      highestLevelPoints:
        dungeon.highestLevelPoints != null ? dungeon.highestLevelPoints : existing.highestLevelPoints ?? null,
      highestLevel: dungeon.highestLevel != null ? dungeon.highestLevel : existing.highestLevel ?? null,
      highestLevelText:
        dungeon.highestLevelText != null ? dungeon.highestLevelText : existing.highestLevelText ?? null,
      highestLevelColorHex:
        dungeon.highestLevelColorHex != null ? dungeon.highestLevelColorHex : existing.highestLevelColorHex ?? null,
      specName: dungeon.specName != null ? dungeon.specName : existing.specName ?? null,
      className: dungeon.className != null ? dungeon.className : existing.className ?? null,
      role: dungeon.role != null ? dungeon.role : existing.role ?? null,
    });
  }

  return [...merged.values()].sort((left, right) =>
    String(left.label || left.name || left.slug).localeCompare(
      String(right.label || right.name || right.slug),
      "en-US"
    )
  );
}

function mergeCharacterRecords(existingRecord, incomingRecord) {
  if (!existingRecord) {
    if (!incomingRecord) {
      return incomingRecord;
    }
    return {
      ...incomingRecord,
      presentation: buildDerivedPresentation(incomingRecord),
    };
  }

  if (!incomingRecord) {
    return {
      ...existingRecord,
      presentation: buildDerivedPresentation(existingRecord),
    };
  }

  const mergedRecord = {
    ...existingRecord,
    ...incomingRecord,
    score: incomingRecord.score != null ? incomingRecord.score : existingRecord.score ?? null,
    updatedAt: incomingRecord.updatedAt || existingRecord.updatedAt || null,
    updatedAtUnix:
      incomingRecord.updatedAtUnix != null
        ? incomingRecord.updatedAtUnix
        : existingRecord.updatedAtUnix ?? null,
    parseMetric:
      incomingRecord.parseMetric != null
        ? incomingRecord.parseMetric
        : existingRecord.parseMetric ?? null,
    specName:
      incomingRecord.specName != null
        ? incomingRecord.specName
        : existingRecord.specName ?? null,
    className:
      incomingRecord.className != null
        ? incomingRecord.className
        : existingRecord.className ?? null,
    role:
      incomingRecord.role != null
        ? incomingRecord.role
        : existingRecord.role ?? null,
    wclCharacterId:
      incomingRecord.wclCharacterId != null
        ? incomingRecord.wclCharacterId
        : existingRecord.wclCharacterId ?? null,
    dungeons: mergeDungeonArrays(existingRecord.dungeons, incomingRecord.dungeons, {
      replaceParseStats: isRoleSpecificParseMetric(incomingRecord.parseMetric),
    }),
  };

  return {
    ...mergedRecord,
    presentation: buildDerivedPresentation(mergedRecord),
  };
}

function upsertCachedRecord(cache, record) {
  const key = buildCacheKey(record.region, record.realm, record.name);
  cache.records[key] = mergeCharacterRecords(cache.records[key] || null, record);
}

function listCachedRecords(cache) {
  return Object.values(cache.records || {});
}

function createEmptyCache() {
  return {
    records: {},
    manualRequests: {},
    requestStatuses: {},
    providerState: {},
  };
}

function normalizeRequestEntry(input = {}) {
  const region = normalizeText(input.region || "us").toLocaleLowerCase("en-US");
  const realm = normalizeText(input.realm || "");
  const characterName = normalizeText(input.characterName || input.name || "");
  const key = buildCacheKey(region, realm, characterName);
  const entry = {
    key,
    region,
    realm,
    characterName,
    source: input.source || "manual",
    force: input.force === true || input.forceRefresh === true,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
  if (input.eventId) {
    entry.eventId = String(input.eventId);
  }
  return entry;
}

function getManualRequest(cache, lookup) {
  return cache.manualRequests[buildCacheKey(lookup.region, lookup.realm, lookup.characterName || lookup.name)] || null;
}

function upsertManualRequest(cache, request) {
  if (!cache.manualRequests || typeof cache.manualRequests !== "object") {
    cache.manualRequests = {};
  }

  const normalized = normalizeRequestEntry(request);
  const existing = cache.manualRequests[normalized.key] || {};
  cache.manualRequests[normalized.key] = {
    ...existing,
    ...normalized,
    createdAt: existing.createdAt || normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
  return cache.manualRequests[normalized.key];
}

function removeManualRequest(cache, requestKeyOrLookup) {
  if (!cache.manualRequests || typeof cache.manualRequests !== "object") {
    cache.manualRequests = {};
  }

  const key =
    typeof requestKeyOrLookup === "string"
      ? requestKeyOrLookup
      : buildCacheKey(
          requestKeyOrLookup.region,
          requestKeyOrLookup.realm,
          requestKeyOrLookup.characterName || requestKeyOrLookup.name
        );
  const existing = cache.manualRequests[key] || null;
  delete cache.manualRequests[key];
  return existing;
}

function listManualRequests(cache) {
  return Object.values(cache.manualRequests || {}).sort((left, right) =>
    String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""), "en-US")
  );
}

function clearManualRequests(cache) {
  const removed = Object.keys(cache.manualRequests || {}).length;
  cache.manualRequests = {};
  return removed;
}

function upsertRequestStatus(cache, status) {
  if (!cache.requestStatuses || typeof cache.requestStatuses !== "object") {
    cache.requestStatuses = {};
  }

  const key = buildCacheKey(status.region, status.realm, status.name || status.characterName);
  cache.requestStatuses[key] = {
    ...cache.requestStatuses[key],
    ...status,
    key,
  };
  return cache.requestStatuses[key];
}

function listRequestStatuses(cache) {
  return Object.values(cache.requestStatuses || {}).sort((left, right) =>
    String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""), "en-US")
  );
}

function getProviderState(cache, provider) {
  if (!cache.providerState || typeof cache.providerState !== "object") {
    cache.providerState = {};
  }
  if (!cache.providerState[provider] || typeof cache.providerState[provider] !== "object") {
    cache.providerState[provider] = {};
  }
  return cache.providerState[provider];
}

function getProviderCooldown(cache, provider, now = Date.now()) {
  const state = getProviderState(cache, provider);
  const nextAllowedAtMs = Date.parse(state.nextAllowedAt || "");
  return {
    lastAttemptAt: state.lastAttemptAt || null,
    nextAllowedAt: state.nextAllowedAt || null,
    isCoolingDown: Number.isFinite(nextAllowedAtMs) && now < nextAllowedAtMs,
  };
}

function markProviderAttempt(cache, provider, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const cooldownMs =
    options.cooldownMs == null
      ? provider === "api"
        ? API_ATTEMPT_COOLDOWN_MS
        : 0
      : options.cooldownMs;
  const state = getProviderState(cache, provider);
  state.lastAttemptAt = new Date(now).toISOString();
  state.nextAllowedAt = cooldownMs > 0 ? new Date(now + cooldownMs).toISOString() : null;
  return {
    lastAttemptAt: state.lastAttemptAt,
    nextAllowedAt: state.nextAllowedAt,
    isCoolingDown: cooldownMs > 0,
  };
}

module.exports = {
  API_ATTEMPT_COOLDOWN_MS,
  CACHE_TTL_MS,
  DEFAULT_CACHE_PATH,
  DEFAULT_DB_PATH,
  LEGACY_CACHE_PATH,
  ProviderCooldownError,
  buildCacheKey,
  clearManualRequests,
  createEmptyCache,
  getCachedRecord,
  getFreshCachedRecord,
  getManualRequest,
  getProviderCooldown,
  getProviderState,
  listCachedRecords,
  listManualRequests,
  listRequestStatuses,
  loadCache,
  markProviderAttempt,
  mergeCharacterRecords,
  normalizeRequestEntry,
  parseCacheKey,
  removeManualRequest,
  saveCache,
  upsertManualRequest,
  upsertCachedRecord,
  upsertRequestStatus,
};
