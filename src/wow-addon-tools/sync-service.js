"use strict";

const path = require("node:path");

const { formatIsoTimestamp } = require("../mplus-matrix/utils");
const {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_WOW_ADDONS_DIR,
  buildCompanionPayload,
  installStagedAddons,
  stageAddonBundle,
} = require("./lnnrank-bridge");
const {
  API_ATTEMPT_COOLDOWN_MS,
  DEFAULT_CACHE_PATH,
  ProviderCooldownError,
  getCachedRecord,
  getFreshCachedRecord,
  getProviderCooldown,
  listCachedRecords,
  listManualRequests,
  listRequestStatuses,
  loadCache,
  markProviderAttempt,
  removeManualRequest,
  saveCache,
  upsertCachedRecord,
  upsertRequestStatus,
} = require("./cache");
const {
  DEFAULT_LOOKUP_PROVIDER,
  WclRateLimitError,
  acquireReusableWebLookupSession,
  createWebLookupSession,
  fetchCharacterViaProvider,
  recordNeedsWebEnrichment,
  resolveLookupProvider,
} = require("./live-provider");
const { getPreferredMetricForRole, normalizeRoleValue } = require("../shared/wow-specs");
const { LookupQueue, buildLookupQueueKey, runLookupWorkers } = require("./lookup-queue");
const { loadSavedVariablesFile } = require("./saved-variables");

const DEFAULT_SYNC_WORKERS = Math.max(
  1,
  Number.parseInt(process.env.WCL_SYNC_WORKERS || "1", 10) || 1
);

function normalizeRoleHint(value) {
  return normalizeRoleValue(value);
}

function getExpectedParseMetricForRole(roleValue) {
  return getPreferredMetricForRole(roleValue);
}

function resolveSyncWorkerCount(provider, options = {}) {
  if (provider === "api") {
    return 1;
  }

  const rawValue = options.workers == null ? DEFAULT_SYNC_WORKERS : options.workers;
  return Math.max(1, Number.parseInt(String(rawValue), 10) || 1);
}

function parseTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 100000000000 ? value : value * 1000;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsedIso = Date.parse(value);
    if (Number.isFinite(parsedIso)) {
      return parsedIso;
    }

    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber)) {
      return parsedNumber > 100000000000 ? parsedNumber : parsedNumber * 1000;
    }
  }

  return null;
}

function getRequestQueuedAtMs(request) {
  return (
    parseTimestampMs(request.updatedAt) ??
    parseTimestampMs(request.createdAt) ??
    parseTimestampMs(request.requestTimestamp) ??
    parseTimestampMs(request.queuedAt) ??
    parseTimestampMs(request.lastSeenAt)
  );
}

function buildStatusTiming(request, timing = {}) {
  const queuedAtMs = getRequestQueuedAtMs(request);
  const startedAtMs = parseTimestampMs(timing.startedAtMs ?? timing.startedAt);
  const finishedAtMs = parseTimestampMs(timing.finishedAtMs ?? timing.finishedAt);
  const statusTiming = {};

  if (queuedAtMs != null) {
    statusTiming.queuedAt = new Date(queuedAtMs).toISOString();
  }
  if (startedAtMs != null) {
    statusTiming.startedAt = new Date(startedAtMs).toISOString();
  }
  if (finishedAtMs != null) {
    statusTiming.finishedAt = new Date(finishedAtMs).toISOString();
  }
  if (queuedAtMs != null && startedAtMs != null) {
    statusTiming.queueWaitMs = Math.max(0, startedAtMs - queuedAtMs);
  }
  if (startedAtMs != null && finishedAtMs != null) {
    statusTiming.lookupDurationMs = Math.max(0, finishedAtMs - startedAtMs);
  }
  if (queuedAtMs != null && finishedAtMs != null) {
    statusTiming.totalDurationMs = Math.max(0, finishedAtMs - queuedAtMs);
  }
  if (Number.isFinite(Number(timing.workerIndex))) {
    statusTiming.workerIndex = Number(timing.workerIndex);
  }

  return statusTiming;
}

function pushStatus(cache, statusEntries, request, state, message, timing = {}) {
  const statusTiming = buildStatusTiming(request, timing);
  const status = {
    region: request.region,
    realm: request.realm,
    name: request.characterName,
    state,
    message,
    source: request.statusSource || request.requestSource || "savedvariables",
    updatedAt: statusTiming.finishedAt || statusTiming.startedAt || formatIsoTimestamp(),
    force: request.force === true || request.forceRefresh === true,
    retryCount:
      state === "error" || request.force === true || request.forceRefresh === true
        ? Math.max(0, Number.isFinite(Number(request.retryCount)) ? Number(request.retryCount) : 0)
        : null,
    ...statusTiming,
  };
  statusEntries.push(status);
  upsertRequestStatus(cache, status);
  return status;
}

async function runAddonRequestSync(options = {}) {
  const savedVariablesState = loadSavedVariablesFile(options.savedVariablesFile || null);
  const maxRequests =
    options.maxRequests == null ? null : Number.parseInt(String(options.maxRequests), 10);
  const cachePath = options.cachePath
    ? path.resolve(String(options.cachePath))
    : options.dbPath
      ? path.resolve(String(options.dbPath))
      : DEFAULT_CACHE_PATH;
  const cache = loadCache(cachePath);
  const provider = resolveLookupProvider(options.provider || DEFAULT_LOOKUP_PROVIDER);
  const browserPath = options.browserPath ? path.resolve(String(options.browserPath)) : null;
  const outputDir = options.outputDir
    ? path.resolve(String(options.outputDir))
    : DEFAULT_OUTPUT_DIR;
  const addonsDir = options.addonsDir
    ? path.resolve(String(options.addonsDir))
    : DEFAULT_WOW_ADDONS_DIR;
  const workerCount = resolveSyncWorkerCount(provider, options);
  const reuseBrowserSession = options.reuseBrowserSession !== false && workerCount === 1;

  const manualRequests = listManualRequests(cache).map((request) => ({
    ...request,
    requestOrigin: "manual",
    requestSource: "manual",
    statusSource: request.source || "manual",
  }));
  const savedVariableRequests = (savedVariablesState.parsed.requests || []).map((request) => ({
    ...request,
    requestOrigin: "savedvariables",
    requestSource: "savedvariables",
    statusSource: request.source || "savedvariables",
  }));

  const explicitRequests = Array.isArray(options.requests)
    ? options.requests.map((request) => ({
        ...request,
        requestOrigin: request.requestOrigin || (request.requestSource === "manual" ? "manual" : "savedvariables"),
        requestSource: request.requestSource || (request.requestOrigin === "manual" ? "manual" : "savedvariables"),
        statusSource:
          request.statusSource ||
          request.source ||
          (request.requestOrigin === "manual" ? "manual" : "savedvariables"),
      }))
    : null;
  const allRequests = explicitRequests || [...savedVariableRequests, ...manualRequests];
  const requests = Number.isFinite(maxRequests) ? allRequests.slice(0, maxRequests) : allRequests;

  if (requests.length === 0) {
    if (!savedVariablesState.file && manualRequests.length === 0) {
      throw new Error("Could not find lnnrank SavedVariables and no manual dashboard queue exists.");
    }
  }

  const statusEntries = [];
  let rateLimit = null;
  let providerCooldown = provider === "api" ? getProviderCooldown(cache, "api") : null;
  const lookupQueue = new LookupQueue();
  const requestGroups = new Map();
  const queuedLookupByKey = new Map();
  const lookupTimingsByKey = new Map();
  const providersUsed = new Set();
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;

  function resolveCompanionPayloadSource() {
    return provider === "web"
      ? "warcraftlogs-web"
      : provider === "api"
        ? "warcraftlogs-api"
        : provider === "off"
          ? "cache-only"
          : providersUsed.size === 1 && providersUsed.has("api")
            ? "warcraftlogs-api"
            : providersUsed.size === 1 && providersUsed.has("web")
              ? "warcraftlogs-web"
              : "warcraftlogs-auto";
  }

  function publishCompanionFromCache() {
    const payload = buildCompanionPayload(listCachedRecords(cache), {
      builtAt: formatIsoTimestamp(),
      source: resolveCompanionPayloadSource(),
      rateLimit,
      statuses: listRequestStatuses(cache),
    });
    const staged = stageAddonBundle(outputDir, payload);
    const installed = options.installWow ? installStagedAddons(staged, addonsDir) : null;
    return {
      staged,
      installed,
    };
  }

  async function persistProgress(update) {
    saveCache(cache, cachePath);
    const companion = publishCompanionFromCache();
    if (onUpdate) {
      await onUpdate({
        ...update,
        provider,
        queueLength: requests.length,
        statusCount: statusEntries.length,
        companion,
      });
    }
  }

  for (const request of requests) {
    const lookup = {
      region: request.region,
      realm: request.realm,
      name: request.characterName,
      roleHint: normalizeRoleHint(request.assignedRole || request.role || null),
      classNameHint: request.localizedClass || request.class || null,
    };
    const forceLookup = request.force === true || request.forceRefresh === true;
    const freshCached = forceLookup ? null : getFreshCachedRecord(cache, lookup);
    const needsWebEnrichment = freshCached && recordNeedsWebEnrichment(freshCached);
    const needsWclMetadataBackfill =
      freshCached &&
      (!freshCached.specName || !freshCached.role);
    const expectedParseMetric = getExpectedParseMetricForRole(lookup.roleHint);
    const needsRoleMetricBackfill =
      freshCached &&
      expectedParseMetric != null &&
      freshCached.parseMetric !== expectedParseMetric;

    if (freshCached && !needsWebEnrichment && !needsWclMetadataBackfill && !needsRoleMetricBackfill) {
      const startedAtMs = Date.now();
      const finishedAtMs = Date.now();
      const timing = buildStatusTiming(request, { startedAtMs, finishedAtMs });
      pushStatus(
        cache,
        statusEntries,
        request,
        "cached",
        "Using cached Warcraft Logs data from the last 24 hours.",
        { startedAtMs, finishedAtMs }
      );
      if (request.requestOrigin === "manual") {
        removeManualRequest(cache, request.key || lookup);
      }
      await persistProgress({
        phase: "status",
        state: "cached",
        request,
        ...timing,
      });
      continue;
    }

    if (provider === "off") {
      const startedAtMs = Date.now();
      const finishedAtMs = Date.now();
      const timing = buildStatusTiming(request, { startedAtMs, finishedAtMs });
      const staleRecord = getCachedRecord(cache, lookup);
      if (staleRecord) {
        pushStatus(
          cache,
          statusEntries,
          request,
          "stale_cached",
          "Lookup provider is off. Using stale cached data.",
          { startedAtMs, finishedAtMs }
        );
      } else {
        pushStatus(
          cache,
          statusEntries,
          request,
          "disabled",
          "Lookup provider is off. No live request was made.",
          { startedAtMs, finishedAtMs }
        );
      }
      await persistProgress({
        phase: "status",
        state: staleRecord ? "stale_cached" : "disabled",
        request,
        ...timing,
      });
      continue;
    }

    const key = buildLookupQueueKey(lookup);
    if (!requestGroups.has(key)) {
      requestGroups.set(key, []);
      queuedLookupByKey.set(key, lookup);
      lookupQueue.enqueue({
        key,
        lookup,
      });
    } else {
      const queuedLookup = queuedLookupByKey.get(key);
      if (queuedLookup) {
        queuedLookup.roleHint = queuedLookup.roleHint || lookup.roleHint || null;
        queuedLookup.classNameHint = queuedLookup.classNameHint || lookup.classNameHint || null;
      }
    }
    requestGroups.get(key).push(request);
  }

  lookupQueue.close();

  await runLookupWorkers({
    queue: lookupQueue,
    workerCount,
    createWorker: async () => {
      let webSessionHandle = null;
      async function fetchWithWeb(lookup) {
        if (!webSessionHandle) {
          if (reuseBrowserSession) {
            webSessionHandle = await acquireReusableWebLookupSession({
              browserPath,
            });
          } else {
            const session = await createWebLookupSession({
              browserPath,
            });
            webSessionHandle = {
              session,
              close: async () => {
                await session.close();
              },
            };
          }
        }
        providersUsed.add("web");
        return {
          ...(await webSessionHandle.session.fetchCharacter(lookup)),
          providerUsed: "web",
        };
      }

      async function fetchWithApi(lookup) {
        providerCooldown = getProviderCooldown(cache, "api");
        if (providerCooldown.isCoolingDown) {
          throw new ProviderCooldownError("api", providerCooldown);
        }
        providerCooldown = markProviderAttempt(cache, "api", {
          cooldownMs: API_ATTEMPT_COOLDOWN_MS,
        });
        saveCache(cache, cachePath);
        providersUsed.add("api");
        return {
          ...(await fetchSingleCharacterViaApi(lookup)),
          providerUsed: "api",
        };
      }

      return {
        async fetch(lookup) {
          return fetchCharacterViaProvider(lookup, {
            provider,
            fetchApi: fetchWithApi,
            fetchWeb: fetchWithWeb,
            needsWebEnrichment: recordNeedsWebEnrichment,
          });
        },
        async close() {
          if (webSessionHandle) {
            await webSessionHandle.close();
            webSessionHandle = null;
          }
        },
      };
    },
    handleStart: async (entry, workerIndex) => {
      const startedAtMs = Date.now();
      const groupedRequests = requestGroups.get(entry.key) || [];
      lookupTimingsByKey.set(entry.key, { startedAtMs, workerIndex });

      for (const request of groupedRequests) {
        pushStatus(
          cache,
          statusEntries,
          request,
          "searching",
          `Searching Warcraft Logs with worker ${workerIndex + 1}.`,
          { startedAtMs, workerIndex }
        );
      }
      await persistProgress({
        phase: "lookup-start",
        state: "searching",
        provider,
        lookup: entry.lookup,
        startedAt: new Date(startedAtMs).toISOString(),
        workerIndex,
      });
    },
    handleResult: async (entry, result, workerIndex) => {
      const groupedRequests = requestGroups.get(entry.key) || [];
      const finishedAtMs = Date.now();
      const startedTiming = lookupTimingsByKey.get(entry.key) || {
        startedAtMs: finishedAtMs,
        workerIndex,
      };
      const timingInput = {
        startedAtMs: startedTiming.startedAtMs,
        finishedAtMs,
        workerIndex: startedTiming.workerIndex ?? workerIndex,
      };
      const updateTiming = buildStatusTiming(groupedRequests[0] || entry.lookup, timingInput);
      rateLimit = result.rateLimit || rateLimit;
      const providerUsed = result.providerUsed || provider;

      if (result.found && result.record) {
        upsertCachedRecord(cache, result.record);
        for (const request of groupedRequests) {
          pushStatus(
            cache,
            statusEntries,
            request,
            "found",
            providerUsed === "api"
              ? "Live Warcraft Logs API data imported."
              : result.fallbackFrom === "api"
                ? "Warcraft Logs page imported after API fallback."
                : "Live Warcraft Logs page imported.",
            timingInput
          );
          if (request.requestOrigin === "manual") {
            removeManualRequest(cache, request.key || request);
          }
        }
        lookupTimingsByKey.delete(entry.key);
        await persistProgress({
          phase: "status",
          state: "found",
          lookup: entry.lookup,
          ...updateTiming,
        });
        return;
      }

      for (const request of groupedRequests) {
        pushStatus(
          cache,
          statusEntries,
          request,
          "not_found",
          "No public Warcraft Logs Mythic+ data found.",
          timingInput
        );
        if (request.requestOrigin === "manual") {
          removeManualRequest(cache, request.key || request);
        }
      }
      lookupTimingsByKey.delete(entry.key);
      await persistProgress({
        phase: "status",
        state: "not_found",
        lookup: entry.lookup,
        ...updateTiming,
      });
    },
    handleError: async (entry, error, workerIndex) => {
      const groupedRequests = requestGroups.get(entry.key) || [];
      const finishedAtMs = Date.now();
      const startedTiming = lookupTimingsByKey.get(entry.key) || {
        startedAtMs: finishedAtMs,
        workerIndex,
      };
      const timingInput = {
        startedAtMs: startedTiming.startedAtMs,
        finishedAtMs,
        workerIndex: startedTiming.workerIndex ?? workerIndex,
      };
      const updateTiming = buildStatusTiming(groupedRequests[0] || entry.lookup, timingInput);
      const staleRecord = getCachedRecord(cache, entry.lookup);
      let state = "error";

      for (const request of groupedRequests) {
        if (error instanceof ProviderCooldownError) {
          if (staleRecord) {
            pushStatus(
              cache,
              statusEntries,
              request,
              "api_cooldown",
              "Using stale cached data because API lookups are cooling down for 30 minutes.",
              timingInput
            );
          } else {
            pushStatus(
              cache,
              statusEntries,
              request,
              "api_cooldown",
              "API lookups are cooling down for 30 minutes after the last try.",
              timingInput
            );
          }
          state = "api_cooldown";
        } else if (error instanceof WclRateLimitError) {
          if (staleRecord) {
            pushStatus(
              cache,
              statusEntries,
              request,
              "stale_cached",
              "Using stale cached data because the Warcraft Logs API is rate limited.",
              timingInput
            );
            state = "stale_cached";
          } else {
            pushStatus(
              cache,
              statusEntries,
              request,
              "rate_limited",
              "Warcraft Logs API rate limit reached. Try again after the hourly reset.",
              timingInput
            );
            state = "rate_limited";
          }
        } else if (staleRecord) {
          pushStatus(
            cache,
            statusEntries,
            request,
            "stale_cached",
            "Using stale cached data because the live web lookup failed.",
            timingInput
          );
          state = "stale_cached";
        } else {
          pushStatus(
            cache,
            statusEntries,
            request,
            "error",
            error.message || "Warcraft Logs lookup failed.",
            timingInput
          );
          state = "error";
        }

        if (request.requestOrigin === "manual") {
          removeManualRequest(cache, request.key || request);
        }
      }
      lookupTimingsByKey.delete(entry.key);
      await persistProgress({
        phase: "status",
        state,
        lookup: entry.lookup,
        ...updateTiming,
      });
    },
  });

  saveCache(cache, cachePath);
  const { staged, installed } = publishCompanionFromCache();

  return {
    savedVariablesFile: savedVariablesState.file,
    parsedSavedVariables: savedVariablesState.parsed,
    dbPath: cachePath,
    cachePath,
    requests: requests.length,
    manualRequests: manualRequests.length,
    cachedRecords: listCachedRecords(cache).length,
    provider,
    workers: workerCount,
    providerCooldown,
    statuses: statusEntries,
    staged,
    installed,
    rateLimit,
  };
}

module.exports = {
  runAddonRequestSync,
};
