"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const {
  API_ATTEMPT_COOLDOWN_MS,
  ProviderCooldownError,
  buildCacheKey,
  getFreshCachedRecord,
  getProviderCooldown,
  getCachedRecord,
  listManualRequests,
  loadCache,
  markProviderAttempt,
  removeManualRequest,
  upsertManualRequest,
  upsertCachedRecord,
} = require("../src/wow-addon-tools/cache");
const { LookupQueue, buildLookupQueueKey } = require("../src/wow-addon-tools/lookup-queue");
const { buildCompanionPayload } = require("../src/wow-addon-tools/lnnrank-bridge");
const {
  clearLnnrankSavedVariablesRequestsText,
  parseLnnrankSavedVariables,
} = require("../src/wow-addon-tools/saved-variables");
const {
  buildSyncRequestsFromQueue,
  buildUnifiedQueue,
  createDashboardServer,
} = require("../src/wow-addon-tools/dashboard-server");
const { extractPassiveLiveFeedEntries } = require("../src/wow-addon-tools/passive-live-feed");
const {
  buildDevRuntimePaths,
  ensureDevRuntime,
} = require("../src/wow-addon-tools/dev-run");

test("saved variables parser extracts queued WCL requests", () => {
  const lua = `
lnnrankDB = {
  ["settings"] = {
    ["showSearching"] = true,
    ["showInCombat"] = true,
    ["scanGroupMembers"] = true,
    ["scanApplicants"] = true,
    ["passiveChannelEnabled"] = true,
  },
  ["requests"] = {
    ["us:stormrage:urmomgargles"] = {
      ["region"] = "us",
      ["realm"] = "Stormrage",
      ["characterName"] = "Urmomgargles",
      ["queuedAt"] = 1748650000,
      ["lastSeenAt"] = 1748650100,
      ["seenCount"] = 2,
    },
  },
  ["groupMembers"] = {
    ["us:stormrage:charby"] = {
      ["region"] = "us",
      ["realm"] = "Stormrage",
      ["characterName"] = "Charby",
      ["source"] = "raid",
      ["unitToken"] = "raid3",
      ["lastSeenAt"] = 1748650200,
    },
  },
  ["applicants"] = {
    ["us:stormrage:redsolo"] = {
      ["region"] = "us",
      ["realm"] = "Stormrage",
      ["characterName"] = "Redsolo",
      ["source"] = "applicant",
      ["applicantID"] = 42,
      ["memberIndex"] = 1,
      ["itemLevel"] = 689,
      ["assignedRole"] = "DAMAGER",
      ["lastSeenAt"] = 1748650300,
    },
  },
  ["passiveBridge"] = {
    ["enabled"] = true,
    ["joined"] = true,
    ["channelName"] = "lnnrankf24cf41109",
    ["playerKey"] = "0f24cf41",
    ["playerGuid"] = "Player-3676-0F24CF41",
    ["playerName"] = "Urmomgargles",
    ["realm"] = "Stormrage",
    ["region"] = "us",
    ["sessionId"] = "f24cf41109",
    ["sequence"] = 4,
    ["lastPublishedAt"] = 1748650400,
    ["lastPublishedPayload"] = "LNNRANK|ch=lnnrankf24cf41109|ss=f24cf41109|n=4|rg=us|re=Stormrage|nm=Urmomgargles|sr=unit",
    ["messageCount"] = 2,
    ["messageLog"] = {
      [3] = {
        ["sequence"] = 3,
        ["publishedAt"] = 1748650390,
        ["payload"] = "LNNRANK|ch=lnnrankf24cf41109|ss=f24cf41109|n=3|rg=us|re=Stormrage|nm=Earlier|sr=unit",
        ["region"] = "us",
        ["realm"] = "Stormrage",
        ["characterName"] = "Earlier",
        ["source"] = "unit",
      },
      [4] = {
        ["sequence"] = 4,
        ["publishedAt"] = 1748650400,
        ["payload"] = "LNNRANK|ch=lnnrankf24cf41109|ss=f24cf41109|n=4|rg=us|re=Stormrage|nm=Urmomgargles|sr=unit",
        ["region"] = "us",
        ["realm"] = "Stormrage",
        ["characterName"] = "Urmomgargles",
        ["source"] = "unit",
      },
    },
    ["updatedAt"] = 1748650401,
  },
  ["lastImportedBuild"] = "2026-05-31T00:00:00.000Z",
}
`;

  const parsed = parseLnnrankSavedVariables(lua);
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].region, "us");
  assert.equal(parsed.requests[0].realm, "Stormrage");
  assert.equal(parsed.requests[0].characterName, "Urmomgargles");
  assert.equal(parsed.requests[0].seenCount, 2);
  assert.equal(parsed.settings.scanGroupMembers, true);
  assert.equal(parsed.settings.scanApplicants, true);
  assert.equal(parsed.settings.passiveChannelEnabled, true);
  assert.equal(parsed.groupMembers[0].characterName, "Charby");
  assert.equal(parsed.groupMembers[0].unitToken, "raid3");
  assert.equal(parsed.applicants[0].characterName, "Redsolo");
  assert.equal(parsed.applicants[0].applicantID, 42);
  assert.equal(parsed.passiveBridge.channelName, "lnnrankf24cf41109");
  assert.equal(parsed.passiveBridge.playerKey, "0f24cf41");
  assert.equal(parsed.passiveBridge.sequence, 4);
  assert.equal(parsed.passiveBridge.messageCount, 2);
  assert.equal(parsed.passiveBridge.messageLog.length, 2);
  assert.equal(parsed.passiveBridge.messageLog[1].sequence, 4);
});

test("saved variables queue clearing preserves non-queue snapshot data", () => {
  const lua = `
lnnrankDB = {
  ["requests"] = {
    ["us:stormrage:urmomgargles"] = {
      ["region"] = "us",
      ["realm"] = "Stormrage",
      ["characterName"] = "Urmomgargles",
      ["queuedAt"] = 1748650000,
    },
  },
  ["groupMembers"] = {
    ["us:stormrage:charby"] = {
      ["region"] = "us",
      ["realm"] = "Stormrage",
      ["characterName"] = "Charby",
      ["lastSeenAt"] = 1748650200,
    },
  },
  ["applicants"] = {
    ["us:stormrage:redsolo"] = {
      ["region"] = "us",
      ["realm"] = "Stormrage",
      ["characterName"] = "Redsolo",
      ["lastSeenAt"] = 1748650300,
    },
  },
}
`;

  const cleared = parseLnnrankSavedVariables(clearLnnrankSavedVariablesRequestsText(lua));
  assert.equal(cleared.requests.length, 0);
  assert.equal(cleared.groupMembers.length, 1);
  assert.equal(cleared.applicants.length, 1);
});

test("cache returns fresh records only within 24 hours", () => {
  const cache = { records: {} };
  const freshRecord = {
    region: "us",
    realm: "Stormrage",
    name: "Urmomgargles",
    updatedAt: "2026-05-31T00:00:00.000Z",
    score: 2489.37,
    dungeons: [],
  };

  upsertCachedRecord(cache, freshRecord);

  assert.equal(
    getFreshCachedRecord(cache, freshRecord, Date.parse("2026-06-01T00:00:00.000Z")).name,
    "Urmomgargles"
  );
  assert.equal(
    getFreshCachedRecord(cache, freshRecord, Date.parse("2026-06-03T00:00:00.001Z")),
    null
  );
});

test("api cooldown state persists the last attempt for thirty minutes", () => {
  const cache = { records: {}, providerState: {} };
  const startedAt = Date.parse("2026-05-31T00:00:00.000Z");

  markProviderAttempt(cache, "api", {
    now: startedAt,
    cooldownMs: API_ATTEMPT_COOLDOWN_MS,
  });

  const active = getProviderCooldown(cache, "api", startedAt + 5 * 60 * 1000);
  assert.equal(active.isCoolingDown, true);
  assert.equal(active.lastAttemptAt, "2026-05-31T00:00:00.000Z");

  const expired = getProviderCooldown(cache, "api", startedAt + API_ATTEMPT_COOLDOWN_MS + 1);
  assert.equal(expired.isCoolingDown, false);

  const error = new ProviderCooldownError("api", active);
  assert.match(error.message, /cooling down/i);
});

test("cached records keep richer existing data when a later refresh is partial", () => {
  const cache = { records: {}, providerState: {} };
  const lookup = {
    region: "us",
    realm: "Stormrage",
    name: "Urmomgargles",
  };

  upsertCachedRecord(cache, {
    ...lookup,
    score: 2850.85,
    specName: "Brewmaster",
    className: "Monk",
    role: "tank",
    updatedAt: "2026-05-31T00:00:00.000Z",
    updatedAtUnix: 1780185600,
    wclCharacterId: 110047506,
    dungeons: [
      {
        slug: "algetharacademy",
        label: "AA",
        bestPercent: 71,
        points: 382.82,
        specName: "Brewmaster",
        className: "Monk",
        role: "tank",
      },
    ],
  });

  upsertCachedRecord(cache, {
    ...lookup,
    score: null,
    updatedAt: "2026-05-31T01:00:00.000Z",
    updatedAtUnix: 1780189200,
    dungeons: [
      {
        slug: "algetharacademy",
        label: "AA",
        bestPercent: 71,
        points: null,
      },
    ],
  });

  const merged = getCachedRecord(cache, lookup);
  assert.equal(merged.score, 2850.85);
  assert.equal(merged.updatedAt, "2026-05-31T01:00:00.000Z");
  assert.equal(merged.updatedAtUnix, 1780189200);
  assert.equal(merged.wclCharacterId, 110047506);
  assert.equal(merged.specName, "Brewmaster");
  assert.equal(merged.className, "Monk");
  assert.equal(merged.role, "tank");
  assert.equal(merged.dungeons[0].points, 382.82);
  assert.equal(merged.dungeons[0].specName, "Brewmaster");
  assert.equal(merged.dungeons[0].className, "Monk");
  assert.equal(merged.dungeons[0].role, "tank");
});

test("manual queue entries are deduped and removable in the local db", () => {
  const cache = { records: {}, manualRequests: {}, requestStatuses: {}, providerState: {} };

  upsertManualRequest(cache, {
    region: "us",
    realm: "Stormrage",
    characterName: "Urmomgargles",
  });
  upsertManualRequest(cache, {
    region: "US",
    realm: "Stormrage",
    characterName: "urmomgargles",
  });

  const manualQueue = listManualRequests(cache);
  assert.equal(manualQueue.length, 1);
  assert.equal(manualQueue[0].characterName, "urmomgargles");

  removeManualRequest(cache, manualQueue[0].key);
  assert.equal(listManualRequests(cache).length, 0);
});

test("companion payload can store per-character live search statuses", () => {
  const payload = buildCompanionPayload([], {
    source: "warcraftlogs-api",
    statuses: [
      {
        region: "us",
        realm: "Stormrage",
        name: "Urmomgargles",
        state: "rate_limited",
        message: "Warcraft Logs API rate limit reached.",
        updatedAt: "2026-05-31T00:00:00.000Z",
      },
    ],
  });

  assert.equal(payload.statuses.us.stormrage.urmomgargles.state, "rate_limited");
  assert.equal(
    payload.statuses.us.stormrage.urmomgargles.message,
    "Warcraft Logs API rate limit reached."
  );
});

test("lookup queue dedupes repeated character requests by normalized key", () => {
  const queue = new LookupQueue();
  const lookup = {
    region: "US",
    realm: "Stormrage",
    name: "Urmomgargles",
  };

  assert.equal(queue.enqueue({ lookup }), true);
  assert.equal(
    queue.enqueue({
      lookup: {
        region: "us",
        realm: "stormrage",
        name: "urmomgargles",
      },
    }),
    false
  );
  assert.equal(buildLookupQueueKey(lookup), "us:stormrage:urmomgargles");
  assert.equal(buildLookupQueueKey({ region: "us", realm: "Anub'arak", name: "Romanov" }), "us:anubarak:romanov");
});

test("queue builder treats error statuses as handled until a new request arrives", () => {
  const cache = {
    records: {},
    manualRequests: {
      "us:stormrage:browserreusetestone": {
        key: "us:stormrage:browserreusetestone",
        region: "us",
        realm: "Stormrage",
        characterName: "Browserreusetestone",
        updatedAt: "2026-05-31T03:00:00.000Z",
      },
    },
    requestStatuses: {
      "us:stormrage:browserreusetestone": {
        key: "us:stormrage:browserreusetestone",
        region: "us",
        realm: "Stormrage",
        name: "Browserreusetestone",
        state: "error",
        updatedAt: "2026-05-31T03:00:05.000Z",
      },
    },
    providerState: {},
  };

  const hidden = buildUnifiedQueue(cache, []);
  assert.equal(hidden.length, 0);

  cache.manualRequests["us:stormrage:browserreusetestone"].updatedAt = "2026-05-31T03:01:00.000Z";
  const resurfaced = buildUnifiedQueue(cache, []);
  assert.equal(resurfaced.length, 1);
  assert.equal(resurfaced[0].characterName, "Browserreusetestone");
});

test("cache loader canonicalizes legacy punctuation keys and queue builder preserves raw event source", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-cache-"));
  const cachePath = path.join(tempDir, "db.json");

  fs.writeFileSync(
    cachePath,
    JSON.stringify(
      {
        records: {
          "us:anub'arak:romanov": {
            region: "us",
            realm: "Anub'arak",
            name: "Romanov",
            updatedAt: "2026-05-31T03:20:34.920Z",
            dungeons: [],
          },
        },
        requestStatuses: {
          "us:anub'arak:romanov": {
            region: "us",
            realm: "Anub'arak",
            name: "Romanov",
            state: "cached",
            source: "world",
            updatedAt: "2026-05-31T03:25:38.268Z",
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );

  const cache = loadCache(cachePath);
  assert.deepEqual(Object.keys(cache.records), ["us:anubarak:romanov"]);
  assert.deepEqual(Object.keys(cache.requestStatuses), ["us:anubarak:romanov"]);
  assert.equal(buildCacheKey("us", "Anub'arak", "Romanov"), "us:anubarak:romanov");

  const hidden = buildUnifiedQueue(cache, [
    {
      key: "us:anubarak:romanov",
      region: "us",
      realm: "Anub'arak",
      characterName: "Romanov",
      source: "world",
      queuedAt: 1780197452,
      lastSeenAt: 1780197452,
      seenCount: 1,
    },
  ]);
  assert.equal(hidden.length, 0);

  const visible = buildUnifiedQueue(cache, [
    {
      key: "us:anubarak:romanov",
      region: "us",
      realm: "Anub'arak",
      characterName: "Romanov",
      source: "world",
      queuedAt: 1780199000,
      lastSeenAt: 1780199000,
      seenCount: 1,
    },
  ]);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].sources, ["world"]);
});

test("sync request builder reuses the exact queue snapshot shown in the app", () => {
  const requests = buildSyncRequestsFromQueue([
    {
      key: "us:tichondrius:tristy",
      region: "us",
      realm: "Tichondrius",
      characterName: "Tristy",
      requestTimestamp: "2026-05-31T04:53:45.000Z",
      lastSeenAt: 1780203225,
      seenCount: 1,
      sources: ["applicant"],
    },
    {
      key: "us:stormrage:urmomgargles",
      region: "us",
      realm: "Stormrage",
      characterName: "Urmomgargles",
      requestTimestamp: "2026-05-31T04:54:00.000Z",
      lastSeenAt: 1780203240,
      seenCount: 2,
      sources: ["world"],
      requestOrigins: ["manual"],
    },
  ]);

  assert.deepEqual(requests[0], {
    key: "us:tichondrius:tristy",
    region: "us",
    realm: "Tichondrius",
    characterName: "Tristy",
    requestOrigin: "savedvariables",
    requestSource: "applicant",
    statusSource: "applicant",
    updatedAt: "2026-05-31T04:53:45.000Z",
    lastSeenAt: 1780203225,
    seenCount: 1,
  });
  assert.deepEqual(requests[1], {
    key: "us:stormrage:urmomgargles",
    region: "us",
    realm: "Stormrage",
    characterName: "Urmomgargles",
    requestOrigin: "manual",
    requestSource: "world",
    statusSource: "world",
    updatedAt: "2026-05-31T04:54:00.000Z",
    lastSeenAt: 1780203240,
    seenCount: 2,
  });
});

test("live feed extraction keeps unique relevant memory previews", () => {
  const entries = extractPassiveLiveFeedEntries({
    matches: [
      {
        address: "0xABC",
        encoding: "utf8",
        previewUtf8: "lnnrankf24cf42579 hello there",
        previewUtf16: "",
      },
      {
        address: "0xDEF",
        encoding: "utf16",
        previewUtf8: "LNNRANK|ch=lnnrankf24cf42579|n=2|nm=Target",
        previewUtf16: "LNNRANK|ch=lnnrankf24cf42579|n=2|nm=Target",
      },
      {
        address: "0xFED",
        encoding: "utf16",
        previewUtf8: "nothing useful",
        previewUtf16: "",
      },
    ],
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "channel");
  assert.equal(entries[1].kind, "payload");
});

test("dev runtime bootstraps an isolated dashboard sandbox inside the chosen root", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dev-run-"));
  const runtimePaths = buildDevRuntimePaths(tempDir);

  ensureDevRuntime(runtimePaths, {
    resetState: true,
  });

  assert.equal(runtimePaths.dbPath.startsWith(tempDir), true);
  assert.equal(runtimePaths.savedVariablesFile.startsWith(tempDir), true);
  assert.equal(runtimePaths.addonsDir.startsWith(tempDir), true);
  assert.equal(fs.existsSync(runtimePaths.dbPath), true);
  assert.equal(fs.existsSync(runtimePaths.savedVariablesFile), true);

  const parsedSavedVariables = parseLnnrankSavedVariables(
    fs.readFileSync(runtimePaths.savedVariablesFile, "utf8")
  );
  assert.deepEqual(parsedSavedVariables.requests, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtimePaths.dbPath, "utf8")).records, {});
});

test("dashboard auto sync recovers after an earlier queue-empty skip", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dashboard-"));
  const accountRoot = path.join(tempDir, "Account");
  const savedVariablesDir = path.join(accountRoot, "TESTACCOUNT", "SavedVariables");
  const savedVariablesFile = path.join(savedVariablesDir, "lnnrank.lua");
  const dbPath = path.join(tempDir, "db.json");
  const outputDir = path.join(tempDir, "output");
  const addonsDir = path.join(tempDir, "addons");

  fs.mkdirSync(savedVariablesDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(addonsDir, { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ records: {}, requestStatuses: {}, manualRequests: {}, providerState: {} }, null, 2),
    "utf8"
  );

  function writeSavedVariables(requestBlock, passiveBridgeBlock = "") {
    fs.writeFileSync(
      savedVariablesFile,
      `lnnrankDB = {\n  ["requests"] = {\n${requestBlock}\n  },\n  ["passiveBridge"] = {\n${passiveBridgeBlock}\n  },\n}\n`,
      "utf8"
    );
  }

  writeSavedVariables("");

  let syncCalls = 0;
  let lastSyncOptions = null;
  const testHooks = {};
  const server = await createDashboardServer({
    accountRoot,
    dbPath,
    outputDir,
    addonsDir,
    provider: "api",
    disableBackgroundTick: true,
    testHooks,
    runAddonRequestSync: async (options) => {
      syncCalls += 1;
      lastSyncOptions = options;
      return {
        provider: "auto",
        requests: 1,
        cachedRecords: 0,
        statuses: [],
      };
    },
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = server.address().port;

    const firstResult = await testHooks.runAutoSync(false);
    assert.equal(firstResult.skipped, true);
    assert.equal(firstResult.reason, "queue-empty");
    assert.equal(syncCalls, 0);

    writeSavedVariables(
      '    ["us:stormrage:urmomgargles"] = {\n' +
        '      ["region"] = "us",\n' +
        '      ["realm"] = "Stormrage",\n' +
        '      ["characterName"] = "Urmomgargles",\n' +
        '      ["source"] = "applicant",\n' +
        '      ["queuedAt"] = 1748650000,\n' +
        "    },"
    );

    const secondResponse = await fetch(`http://127.0.0.1:${port}/api/sync`, {
      method: "POST",
    });
    const secondResult = await secondResponse.json();
    assert.equal(secondResult.skipped, undefined);
    assert.equal(syncCalls, 1);
    assert.equal(lastSyncOptions.requests.length, 1);
    assert.equal(lastSyncOptions.provider, "api");
    assert.equal(lastSyncOptions.requests[0].statusSource, "applicant");
    assert.equal(lastSyncOptions.requests[0].characterName, "Urmomgargles");

    writeSavedVariables(
      "",
      '    ["enabled"] = true,\n' +
        '    ["joined"] = true,\n' +
        '    ["channelName"] = "lnnrankf24cf41109",\n' +
        '    ["playerKey"] = "0f24cf41",\n' +
        '    ["sessionId"] = "f24cf41109",\n' +
        '    ["sequence"] = 4,\n' +
        '    ["messageCount"] = 2,\n' +
        '    ["messageLog"] = {\n' +
        '      [3] = {\n' +
        '        ["sequence"] = 3,\n' +
        '        ["publishedAt"] = 1748650390,\n' +
        '        ["payload"] = "LNNRANK|ch=lnnrankf24cf41109|n=3",\n' +
        '        ["region"] = "us",\n' +
        '        ["realm"] = "Stormrage",\n' +
        '        ["characterName"] = "Earlier",\n' +
        '        ["source"] = "unit",\n' +
        '      },\n' +
        '      [4] = {\n' +
        '        ["sequence"] = 4,\n' +
        '        ["publishedAt"] = 1748650400,\n' +
        '        ["payload"] = "LNNRANK|ch=lnnrankf24cf41109|n=4",\n' +
        '        ["region"] = "us",\n' +
        '        ["realm"] = "Stormrage",\n' +
        '        ["characterName"] = "Urmomgargles",\n' +
        '        ["source"] = "unit",\n' +
        '      },\n' +
        '    },\n' +
        '    ["lastPublishedPayload"] = "LNNRANK|ch=lnnrankf24cf41109",\n' +
        '    ["updatedAt"] = 1748650401,'
    );

    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
    const statePayload = await stateResponse.json();
    assert.equal(statePayload.passiveBridge.channelName, "lnnrankf24cf41109");
    assert.equal(statePayload.passiveBridge.playerKey, "0f24cf41");
    assert.equal(statePayload.passiveBridge.updatedAtIso, "2025-05-31T00:13:21.000Z");
    assert.equal(statePayload.passiveBridge.messageCount, 2);
    assert.equal(statePayload.passiveBridge.messageLog.length, 2);
    assert.equal(statePayload.passiveBridge.messageLog[0].sequence, 4);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }
});
