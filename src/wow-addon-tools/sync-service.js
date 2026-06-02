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

function normalizeRoleHint(value) {
  return normalizeRoleValue(value);
}

function getExpectedParseMetricForRole(roleValue) {
  return getPreferredMetricForRole(roleValue);
}

function pushStatus(cache, statusEntries, request, state, message) {
  const status = {
    region: request.region,
    realm: request.realm,
    name: request.characterName,
    state,
    message,
    source: request.statusSource || request.requestSource || "savedvariables",
    updatedAt: formatIsoTimestamp(),
    retryCount:
      state === "error"
        ? Math.max(0, Number.isFinite(Number(request.retryCount)) ? Number(request.retryCount) : 0)
        : null,
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
  const workerCount =
    provider === "api"
      ? 1
      : options.workers == null
        ? 1
        : Math.max(1, Number.parseInt(String(options.workers), 10) || 1);
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
  const providersUsed = new Set();
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;

  async function persistProgress(update) {
    saveCache(cache, cachePath);
    if (onUpdate) {
      await onUpdate({
        ...update,
        provider,
        queueLength: requests.length,
        statusCount: statusEntries.length,
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
      pushStatus(cache, statusEntries, request, "cached", "Using cached Warcraft Logs data from the last 24 hours.");
      if (request.requestOrigin === "manual") {
        removeManualRequest(cache, request.key || lookup);
      }
      await persistProgress({
        phase: "status",
        state: "cached",
        request,
      });
      continue;
    }

    if (provider === "off") {
      const staleRecord = getCachedRecord(cache, lookup);
      if (staleRecord) {
        pushStatus(cache, statusEntries, request, "stale_cached", "Lookup provider is off. Using stale cached data.");
      } else {
        pushStatus(cache, statusEntries, request, "disabled", "Lookup provider is off. No live request was made.");
      }
      await persistProgress({
        phase: "status",
        state: staleRecord ? "stale_cached" : "disabled",
        request,
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
    handleStart: async (entry) => {
      if (onUpdate) {
        await onUpdate({
          phase: "lookup-start",
          provider,
          lookup: entry.lookup,
          queueLength: requests.length,
          statusCount: statusEntries.length,
        });
      }
    },
    handleResult: async (entry, result) => {
      const groupedRequests = requestGroups.get(entry.key) || [];
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
                : "Live Warcraft Logs page imported."
          );
          if (request.requestOrigin === "manual") {
            removeManualRequest(cache, request.key || request);
          }
        }
        await persistProgress({
          phase: "status",
          state: "found",
          lookup: entry.lookup,
        });
        return;
      }

      for (const request of groupedRequests) {
        pushStatus(cache, statusEntries, request, "not_found", "No public Warcraft Logs Mythic+ data found.");
        if (request.requestOrigin === "manual") {
          removeManualRequest(cache, request.key || request);
        }
      }
      await persistProgress({
        phase: "status",
        state: "not_found",
        lookup: entry.lookup,
      });
    },
    handleError: async (entry, error) => {
      const groupedRequests = requestGroups.get(entry.key) || [];
      const staleRecord = getCachedRecord(cache, entry.lookup);
      let state = "error";

      for (const request of groupedRequests) {
        if (error instanceof ProviderCooldownError) {
          if (staleRecord) {
            pushStatus(cache, statusEntries, request, "api_cooldown", "Using stale cached data because API lookups are cooling down for 30 minutes.");
          } else {
            pushStatus(cache, statusEntries, request, "api_cooldown", "API lookups are cooling down for 30 minutes after the last try.");
          }
          state = "api_cooldown";
        } else if (error instanceof WclRateLimitError) {
          if (staleRecord) {
            pushStatus(cache, statusEntries, request, "stale_cached", "Using stale cached data because the Warcraft Logs API is rate limited.");
            state = "stale_cached";
          } else {
            pushStatus(cache, statusEntries, request, "rate_limited", "Warcraft Logs API rate limit reached. Try again after the hourly reset.");
            state = "rate_limited";
          }
        } else if (staleRecord) {
          pushStatus(cache, statusEntries, request, "stale_cached", "Using stale cached data because the live web lookup failed.");
          state = "stale_cached";
        } else {
          pushStatus(cache, statusEntries, request, "error", error.message || "Warcraft Logs lookup failed.");
          state = "error";
        }

        if (request.requestOrigin === "manual") {
          removeManualRequest(cache, request.key || request);
        }
      }
      await persistProgress({
        phase: "status",
        state,
        lookup: entry.lookup,
      });
    },
  });

  saveCache(cache, cachePath);

  const payload = buildCompanionPayload(listCachedRecords(cache), {
    builtAt: formatIsoTimestamp(),
    source:
      provider === "web"
        ? "warcraftlogs-web"
        : provider === "api"
          ? "warcraftlogs-api"
          : provider === "off"
            ? "cache-only"
            : providersUsed.size === 1 && providersUsed.has("api")
              ? "warcraftlogs-api"
              : providersUsed.size === 1 && providersUsed.has("web")
                ? "warcraftlogs-web"
                : "warcraftlogs-auto",
    rateLimit,
    statuses: listRequestStatuses(cache),
  });
  const staged = stageAddonBundle(outputDir, payload);

  let installed = null;
  if (options.installWow) {
    installed = installStagedAddons(staged, addonsDir);
  }

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
