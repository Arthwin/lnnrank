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
  clearLnnrankSavedVariablesApplicantsText,
  clearLnnrankSavedVariablesRequestsText,
  parseLnnrankSavedVariables,
} = require("../src/wow-addon-tools/saved-variables");
const {
  buildDashboardState,
  buildSyncRequestsFromQueue,
  buildUnifiedQueue,
  createDashboardServer,
} = require("../src/wow-addon-tools/dashboard-server");
const {
  buildPassiveDiscoveryPattern,
  extractPassiveLiveFeedEntries,
} = require("../src/wow-addon-tools/passive-live-feed");
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

test("saved variables applicant clearing preserves queue snapshot data", () => {
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

  const cleared = parseLnnrankSavedVariables(clearLnnrankSavedVariablesApplicantsText(lua));
  assert.equal(cleared.requests.length, 1);
  assert.equal(cleared.groupMembers.length, 1);
  assert.equal(cleared.applicants.length, 0);
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
        previewUtf8:
          "LNNRANK|ch=lnnrankf24cf42579|ss=f24cf42579|n=2|rg=us|re=Stormrage|nm=Target|sr=world",
        previewUtf16:
          "LNNRANK|ch=lnnrankf24cf42579|ss=f24cf42579|n=2|rg=us|re=Stormrage|nm=Target|sr=world",
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

test("live feed extraction trims noisy payload previews to the canonical envelope", () => {
  const entries = extractPassiveLiveFeedEntries({
    matches: [
      {
        address: "0xFEED",
        encoding: "window",
        previewUtf8:
          "......YU........LNNRANK|ch=lnnrankf24cf42583|ss=f24cf42583|n=1|rg=us|re=Stormrage|nm=Prepotent|sr=world.canned =PWU.....",
        previewUtf16: "",
      },
    ],
  });

  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].preview,
    "LNNRANK|ch=lnnrankf24cf42583|ss=f24cf42583|n=1|rg=us|re=Stormrage|nm=Prepotent|sr=world"
  );
});

test("live feed extraction preserves applicant metadata in canonical payloads", () => {
  const entries = extractPassiveLiveFeedEntries({
    matches: [
      {
        address: "0xBEEF",
        encoding: "window",
        previewUtf8:
          "noise....LNNRANK|ch=lnnrankf24cf42583|ss=f24cf42583|n=8|rg=us|re=Stormrage|nm=Fernlee|sr=applicant|ai=42|mi=2|ar=HEALER|cl=PRIEST|il=637.4|lv=80.more noise",
        previewUtf16: "",
      },
    ],
  });

  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].preview,
    "LNNRANK|ch=lnnrankf24cf42583|ss=f24cf42583|n=8|rg=us|re=Stormrage|nm=Fernlee|sr=applicant|ai=42|mi=2|ar=HEALER|cl=PRIEST|il=637.4|lv=80"
  );
});

test("live feed discovery pattern follows the active player channel across reload sessions", () => {
  assert.equal(
    buildPassiveDiscoveryPattern({
      channelName: "lnnrankf24cf42583",
      playerKey: "0ff24cf4",
    }),
    "LNNRANK|ch=lnnrank0ff24cf4"
  );

  assert.equal(
    buildPassiveDiscoveryPattern({
      channelName: "lnnrank0ff24cf4",
      playerKey: "0ff24cf4",
    }),
    "LNNRANK|ch=lnnrank0ff24cf4"
  );

  assert.equal(
    buildPassiveDiscoveryPattern({
      channelName: "lnnrank0ff24cf4",
      playerKey: "0ff24cf4",
    }),
    "LNNRANK|ch=lnnrank0ff24cf4"
  );
});

test("live feed extraction accepts payloads with an empty passive session id", () => {
  const entries = extractPassiveLiveFeedEntries({
    matches: [
      {
        address: "0xABCD",
        encoding: "window",
        previewUtf8:
          "noise....LNNRANK|ch=lnnrank0ff24cf4|ss=|n=75|rg=us|re=Stormrage|nm=Tskihi|sr=applicant|ai=22|mi=1|ar=DAMAGER|cl=SHAMAN|il=280.9|lv=90.more noise",
        previewUtf16: "",
      },
    ],
  });

  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].preview,
    "LNNRANK|ch=lnnrank0ff24cf4|ss=|n=75|rg=us|re=Stormrage|nm=Tskihi|sr=applicant|ai=22|mi=1|ar=DAMAGER|cl=SHAMAN|il=280.9|lv=90"
  );
});

test("dashboard state merges passive live applicant payloads into the queue and LFG view", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-passive-state-"));
  const accountRoot = path.join(tempDir, "Account");
  const savedVariablesDir = path.join(accountRoot, "TESTACCOUNT", "SavedVariables");
  const savedVariablesFile = path.join(savedVariablesDir, "lnnrank.lua");
  const dbPath = path.join(tempDir, "db.json");

  fs.mkdirSync(savedVariablesDir, { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ records: {}, requestStatuses: {}, manualRequests: {}, providerState: {} }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {},',
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrankf24cf42583",',
      '  },',
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const state = buildDashboardState({
    dbPath,
    accountRoot,
    passiveLiveFeedState: {
      status: "ready",
      entries: [
        {
          key: "payload:1",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrankf24cf42583|ss=f24cf42583|n=7|rg=us|re=Stormrage|nm=Fernlee|sr=applicant|ai=42|gi=42|mi=2|ar=HEALER|cl=PRIEST|il=637.4|lv=80",
          firstSeenAt: "2026-06-01T00:00:10.000Z",
          lastSeenAt: "2026-06-01T00:00:12.000Z",
        },
      ],
    },
    nowMs: Date.parse("2026-06-01T00:00:15.000Z"),
  });

  assert.equal(state.meta.queueCount, 1);
  assert.equal(state.queue.length, 1);
  assert.deepEqual(state.queue[0].sources, ["applicant"]);
  assert.deepEqual(state.queue[0].requestOrigins, ["passive-live"]);
  assert.equal(state.queue[0].applicantID, 42);
  assert.equal(state.queue[0].groupID, 42);
  assert.equal(state.queue[0].memberIndex, 2);
  assert.equal(state.queue[0].assignedRole, "HEALER");
  assert.equal(state.queue[0].itemLevel, 637.4);
  assert.equal(state.applicants.length, 1);
  assert.equal(state.applicants[0].characterName, "Fernlee");
  assert.equal(state.applicants[0].source, "applicant");
  assert.equal(state.applicants[0].applicantID, 42);
  assert.equal(state.applicants[0].groupID, 42);
  assert.equal(state.applicants[0].memberIndex, 2);
  assert.equal(state.applicants[0].assignedRole, "HEALER");
  assert.equal(state.applicants[0].class, "PRIEST");
  assert.equal(state.applicants[0].itemLevel, 637.4);
  assert.equal(state.applicants[0].level, 80);
  assert.equal(state.applicants[0].lastSeenAt, 1780272010);

  const requests = buildSyncRequestsFromQueue(state.queue);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestOrigin, "passive-live");
  assert.equal(requests[0].requestSource, "passive-live");
  assert.equal(requests[0].statusSource, "applicant");
  assert.equal(requests[0].applicantID, 42);
  assert.equal(requests[0].groupID, 42);
  assert.equal(requests[0].memberIndex, 2);
  assert.equal(requests[0].assignedRole, "HEALER");
  assert.equal(requests[0].itemLevel, 637.4);
  assert.equal(requests[0].level, 80);
});

test("dashboard state expires stale passive live applicants when live mode is active", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-passive-expire-"));
  const accountRoot = path.join(tempDir, "Account");
  const savedVariablesDir = path.join(accountRoot, "TESTACCOUNT", "SavedVariables");
  const savedVariablesFile = path.join(savedVariablesDir, "lnnrank.lua");
  const dbPath = path.join(tempDir, "db.json");

  fs.mkdirSync(savedVariablesDir, { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ records: {}, requestStatuses: {}, manualRequests: {}, providerState: {} }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {',
      '    ["us:stormrage:fernlee"] = {',
      '      ["region"] = "us",',
      '      ["realm"] = "Stormrage",',
      '      ["characterName"] = "Fernlee",',
      '      ["source"] = "applicant",',
      '      ["applicantID"] = 42,',
      "    },",
      "  },",
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrankf24cf42583",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const state = buildDashboardState({
    dbPath,
    accountRoot,
    passiveLiveFeedState: {
      supported: true,
      status: "ready",
      lastScannedAt: "2026-06-01T00:00:30.000Z",
      entries: [
        {
          key: "payload:1",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrankf24cf42583|ss=f24cf42583|n=7|rg=us|re=Stormrage|nm=Fernlee|sr=applicant|ai=42|mi=2",
          firstSeenAt: "2026-06-01T00:00:00.000Z",
          lastSeenAt: "2026-06-01T00:00:01.000Z",
        },
      ],
    },
    nowMs: Date.parse("2026-06-01T00:00:20.000Z"),
  });

  assert.equal(state.queue.length, 0);
  assert.equal(state.applicants.length, 0);
});

test("dashboard state keeps saved snapshot applicants when live feed only has channel hits", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-passive-fallback-"));
  const accountRoot = path.join(tempDir, "Account");
  const savedVariablesDir = path.join(accountRoot, "TESTACCOUNT", "SavedVariables");
  const savedVariablesFile = path.join(savedVariablesDir, "lnnrank.lua");
  const dbPath = path.join(tempDir, "db.json");

  fs.mkdirSync(savedVariablesDir, { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ records: {}, requestStatuses: {}, manualRequests: {}, providerState: {} }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {',
      '    ["us:sargeras:helldivers"] = {',
      '      ["region"] = "us",',
      '      ["realm"] = "Sargeras",',
      '      ["characterName"] = "Helldivers",',
      '      ["source"] = "applicant",',
      '      ["applicantID"] = 9,',
      '      ["memberIndex"] = 1,',
      '      ["assignedRole"] = "DAMAGER",',
      '      ["lastSeenAt"] = 1780278425,',
      "    },",
      "  },",
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrankf24cf48417",',
      '    ["playerKey"] = "0ff24cf4",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const state = buildDashboardState({
    dbPath,
    accountRoot,
    passiveLiveFeedState: {
      supported: true,
      status: "ready",
      entries: [
        {
          key: "lnnrankf24cf48378",
          kind: "channel",
          preview: "lnnrankf24cf48378",
          firstSeenAt: "2026-06-01T01:47:26.532Z",
          lastSeenAt: "2026-06-01T01:48:38.539Z",
        },
        {
          key: "lnnrankf24cf48417",
          kind: "channel",
          preview: "lnnrankf24cf48417",
          firstSeenAt: "2026-06-01T01:47:26.532Z",
          lastSeenAt: "2026-06-01T01:48:38.539Z",
        },
      ],
    },
    nowMs: Date.parse("2026-06-01T01:48:39.429Z"),
  });

  assert.equal(state.queue.length, 0);
  assert.equal(state.applicants.length, 1);
  assert.equal(state.applicants[0].characterName, "Helldivers");
  assert.equal(state.applicants[0].applicantID, 9);
});

test("dashboard state follows the newest passive live session instead of a stale saved session id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-passive-session-"));
  const accountRoot = path.join(tempDir, "Account");
  const savedVariablesDir = path.join(accountRoot, "TESTACCOUNT", "SavedVariables");
  const savedVariablesFile = path.join(savedVariablesDir, "lnnrank.lua");
  const dbPath = path.join(tempDir, "db.json");

  fs.mkdirSync(savedVariablesDir, { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ records: {}, requestStatuses: {}, manualRequests: {}, providerState: {} }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {',
      '    ["us:sargeras:oldsession"] = {',
      '      ["region"] = "us",',
      '      ["realm"] = "Sargeras",',
      '      ["characterName"] = "Oldsession",',
      '      ["source"] = "applicant",',
      '      ["applicantID"] = 11,',
      '      ["memberIndex"] = 1,',
      '      ["assignedRole"] = "DAMAGER",',
      '      ["lastSeenAt"] = 1780272010,',
      "    },",
      "  },",
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf42108",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const state = buildDashboardState({
    dbPath,
    accountRoot,
    passiveLiveFeedState: {
      supported: true,
      status: "ready",
      entries: [
        {
          key: "payload:old-applicant",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf42108|n=44|rg=us|re=Sargeras|nm=Oldsession|sr=applicant|ai=11|mi=1|ar=DAMAGER|cl=MAGE|il=279.4|lv=90",
          firstSeenAt: "2026-06-01T00:00:02.000Z",
          lastSeenAt: "2026-06-01T00:00:04.000Z",
        },
        {
          key: "payload:new-clear",
          kind: "payload",
          preview: "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf43629|n=120|rg=us|re=Stormrage|nm=Urmomgargles|sr=appclear",
          firstSeenAt: "2026-06-01T00:00:09.000Z",
          lastSeenAt: "2026-06-01T00:00:10.000Z",
        },
        {
          key: "payload:new-applicant",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf43629|n=121|rg=us|re=Stormrage|nm=Freshone|sr=applicant|ai=22|mi=1|ar=HEALER|cl=PRIEST|il=287.6|lv=90",
          firstSeenAt: "2026-06-01T00:00:10.000Z",
          lastSeenAt: "2026-06-01T00:00:11.000Z",
        },
      ],
    },
    nowMs: Date.parse("2026-06-01T00:00:13.000Z"),
  });

  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].characterName, "Freshone");
  assert.equal(state.queue[0].applicantID, 22);
  assert.equal(state.applicants.length, 1);
  assert.equal(state.applicants[0].characterName, "Freshone");
  assert.equal(state.applicants[0].applicantID, 22);
});

test("dashboard state drops applicants that were superseded by a newer live appclear", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-passive-appclear-"));
  const accountRoot = path.join(tempDir, "Account");
  const savedVariablesDir = path.join(accountRoot, "TESTACCOUNT", "SavedVariables");
  const savedVariablesFile = path.join(savedVariablesDir, "lnnrank.lua");
  const dbPath = path.join(tempDir, "db.json");

  fs.mkdirSync(savedVariablesDir, { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ records: {}, requestStatuses: {}, manualRequests: {}, providerState: {} }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {},',
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf43629",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const state = buildDashboardState({
    dbPath,
    accountRoot,
    passiveLiveFeedState: {
      supported: true,
      status: "ready",
      entries: [
        {
          key: "payload:applicant-before-clear",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf43629|n=77|rg=us|re=Stormrage|nm=Earlierone|sr=applicant|ai=22|mi=1|ar=HEALER|cl=PRIEST|il=287.6|lv=90",
          firstSeenAt: "2026-06-01T00:00:08.000Z",
          lastSeenAt: "2026-06-01T00:00:09.000Z",
        },
        {
          key: "payload:new-clear",
          kind: "payload",
          preview: "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf43629|n=78|rg=us|re=Stormrage|nm=Urmomgargles|sr=appclear",
          firstSeenAt: "2026-06-01T00:00:09.000Z",
          lastSeenAt: "2026-06-01T00:00:10.000Z",
        },
      ],
    },
    nowMs: Date.parse("2026-06-01T00:00:11.000Z"),
  });

  assert.equal(state.queue.length, 0);
  assert.equal(state.applicants.length, 0);
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

test("dashboard server snapshot applies live applicants from the newest passive session", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dashboard-live-session-"));
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
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {',
      '    ["us:sargeras:oldsession"] = {',
      '      ["region"] = "us",',
      '      ["realm"] = "Sargeras",',
      '      ["characterName"] = "Oldsession",',
      '      ["source"] = "applicant",',
      '      ["applicantID"] = 11,',
      "    },",
      "  },",
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf42108",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const testHooks = {};
  const server = await createDashboardServer({
    accountRoot,
    dbPath,
    outputDir,
    addonsDir,
    disableBackgroundTick: true,
    passiveEventBatchMaxAgeMs: 0,
    passiveEventBatchMaxSize: 1,
    passiveLiveFeedStateOverride: {
      supported: true,
      status: "ready",
      entries: [
        {
          key: "payload:new-clear",
          kind: "payload",
          preview: "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf43629|n=120|rg=us|re=Stormrage|nm=Urmomgargles|sr=appclear",
          firstSeenAt: "2026-06-01T00:00:09.000Z",
          lastSeenAt: "2026-06-01T00:00:10.000Z",
        },
        {
          key: "payload:new-applicant",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf43629|n=121|rg=us|re=Stormrage|nm=Freshone|sr=applicant|ai=22|mi=1|ar=HEALER|cl=PRIEST|il=287.6|lv=90",
          firstSeenAt: "2026-06-01T00:00:10.000Z",
          lastSeenAt: "2026-06-01T00:00:11.000Z",
        },
      ],
    },
    testHooks,
  });

  try {
    const state = testHooks.snapshotState();
    assert.equal(state.applicants.length, 1);
    assert.equal(state.applicants[0].characterName, "Freshone");
    assert.equal(state.applicants[0].applicantID, 22);
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

test("dashboard server clears carried LFG applicants when the passive live session rolls over", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dashboard-session-rollover-"));
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
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {},',
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf42108",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  let passiveLiveFeedState = {
    supported: true,
    status: "ready",
    entries: [
      {
        key: "payload:old-applicant",
        kind: "payload",
        preview:
          "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf42108|n=44|rg=us|re=Sargeras|nm=Oldsession|sr=applicant|ai=11|mi=1|ar=DAMAGER|cl=MAGE|il=279.4|lv=90",
        firstSeenAt: "2026-06-01T00:00:02.000Z",
        lastSeenAt: "2026-06-01T00:00:04.000Z",
      },
    ],
  };

  const testHooks = {};
  const server = await createDashboardServer({
    accountRoot,
    dbPath,
    outputDir,
    addonsDir,
    disableBackgroundTick: true,
    passiveEventBatchMaxAgeMs: 0,
    passiveEventBatchMaxSize: 1,
    passiveLiveFeedStateOverride: () => passiveLiveFeedState,
    testHooks,
  });

  try {
    const beforeRollover = testHooks.snapshotState();
    assert.equal(beforeRollover.applicants.length, 1);
    assert.equal(beforeRollover.applicants[0].characterName, "Oldsession");

    passiveLiveFeedState = {
      supported: true,
      status: "ready",
      entries: [
        {
          key: "payload:new-clear",
          kind: "payload",
          preview: "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=216|rg=us|re=Stormrage|nm=Urmomgargles|sr=appclear",
          firstSeenAt: "2026-06-01T00:00:10.000Z",
          lastSeenAt: "2026-06-01T00:00:11.000Z",
        },
      ],
    };

    const afterRollover = testHooks.snapshotState();
    assert.equal(afterRollover.applicants.length, 0);
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

test("dashboard server prefers timestamped passive events over stale memory entries", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dashboard-event-stream-"));
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
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {},',
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf44635",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const testHooks = {};
  const server = await createDashboardServer({
    accountRoot,
    dbPath,
    outputDir,
    addonsDir,
    disableBackgroundTick: true,
    passiveEventBatchMaxAgeMs: 0,
    passiveEventBatchMaxSize: 1,
    passiveLiveFeedStateOverride: {
      supported: true,
      status: "ready",
      entries: [
        {
          key: "stale-entry-1",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf43629|n=1337|rg=us|re=Area52|nm=Capsmunchin|sr=applicant|ai=46|mi=1|ar=DAMAGER|cl=WARLOCK|il=278.6|lv=90",
          firstSeenAt: "2026-06-01T00:00:01.000Z",
          lastSeenAt: "2026-06-01T00:00:30.000Z",
        },
      ],
      events: [
        {
          key: "event-clear",
          kind: "payload",
          preview: "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=216|rg=us|re=Stormrage|nm=Urmomgargles|sr=appclear",
          eventAt: "2026-06-01T00:00:10.000Z",
        },
      ],
    },
    testHooks,
  });

  try {
    const state = testHooks.snapshotState();
    assert.equal(state.applicants.length, 0);
    assert.equal(state.queue.length, 0);
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

test("dashboard server exposes the active live passive session from brokered events", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dashboard-active-passive-session-"));
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
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {},',
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf44635",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const testHooks = {};
  const server = await createDashboardServer({
    accountRoot,
    dbPath,
    outputDir,
    addonsDir,
    disableBackgroundTick: true,
    passiveEventBatchMaxAgeMs: 0,
    passiveEventBatchMaxSize: 1,
    passiveLiveFeedStateOverride: {
      supported: true,
      status: "ready",
      events: [
        {
          key: "event-appclear",
          kind: "payload",
          preview: "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf48076|n=436|rg=us|re=Stormrage|nm=Urmomgargles|sr=appclear|t=1780288333000",
          eventAt: "2026-06-01T04:32:13.000Z",
        },
        {
          key: "event-applicant",
          kind: "payload",
          preview: "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf48076|n=441|rg=us|re=Mannoroth|nm=Bizaremix|sr=applicant|ai=111|gi=111|mi=1|ar=DAMAGER|cl=DEATHKNIGHT|il=284.1|lv=90|t=1780288339000",
          eventAt: "2026-06-01T04:32:19.000Z",
        },
      ],
    },
    testHooks,
  });

  try {
    const state = testHooks.snapshotState();
    assert.equal(state.passiveBridge.sessionId, "f24cf44635");
    assert.equal(state.passiveLiveFeed.activeSessionId, "f24cf48076");
    assert.equal(state.passiveLiveFeed.events.length, 2);
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

test("clear LFG advances the passive event cursor so older live events stay ignored", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dashboard-clear-cursor-"));
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
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {},',
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf44635",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  let passiveLiveFeedState = {
    supported: true,
    status: "ready",
    events: [
      {
        key: "event-applicant-1",
        kind: "payload",
        preview:
          "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=300|rg=us|re=Stormrage|nm=Firstone|sr=applicant|ai=51|mi=1|ar=DAMAGER|cl=ROGUE|il=281.0|lv=90",
        eventAt: "2026-06-01T00:00:01.000Z",
      },
    ],
  };

  const server = await createDashboardServer({
    accountRoot,
    dbPath,
    outputDir,
    addonsDir,
    disableBackgroundTick: true,
    passiveEventBatchMaxAgeMs: 0,
    passiveEventBatchMaxSize: 1,
    passiveLiveFeedStateOverride: () => passiveLiveFeedState,
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = server.address().port;
    let response = await fetch(`http://127.0.0.1:${port}/api/state`);
    let state = await response.json();
    assert.equal(state.applicants.length, 1);
    assert.equal(state.applicants[0].characterName, "Firstone");

    await fetch(`http://127.0.0.1:${port}/api/lfg/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    response = await fetch(`http://127.0.0.1:${port}/api/state`);
    state = await response.json();
    assert.equal(state.applicants.length, 0);

    passiveLiveFeedState = {
      supported: true,
      status: "ready",
      events: [
        {
          key: "event-applicant-1",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=300|rg=us|re=Stormrage|nm=Firstone|sr=applicant|ai=51|mi=1|ar=DAMAGER|cl=ROGUE|il=281.0|lv=90",
          eventAt: "2026-06-01T00:00:01.000Z",
        },
        {
          key: "event-applicant-2",
          kind: "payload",
          preview:
            "LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=301|rg=us|re=Stormrage|nm=Secondone|sr=applicant|ai=52|mi=1|ar=HEALER|cl=PRIEST|il=283.5|lv=90",
          eventAt: new Date(Date.now() + 1000).toISOString(),
        },
      ],
    };

    response = await fetch(`http://127.0.0.1:${port}/api/state`);
    state = await response.json();
    assert.equal(state.applicants.length, 1);
    assert.equal(state.applicants[0].characterName, "Secondone");
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

test("dashboard server orders same-timestamp passive events by sequence", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dashboard-same-ts-sequence-"));
  const accountRoot = path.join(tempDir, "Account");
  const savedVariablesDir = path.join(accountRoot, "TESTACCOUNT", "SavedVariables");
  const savedVariablesFile = path.join(savedVariablesDir, "lnnrank.lua");
  const dbPath = path.join(tempDir, "db.json");
  const outputDir = path.join(tempDir, "output");
  const addonsDir = path.join(tempDir, "addons");
  const eventTimestampMs = Date.now();

  fs.mkdirSync(savedVariablesDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(addonsDir, { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ records: {}, requestStatuses: {}, manualRequests: {}, providerState: {} }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {},',
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf44635",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  let passiveLiveFeedState = {
    supported: true,
    status: "ready",
    events: [
      {
        key: "event-applicant-1",
        kind: "payload",
        preview: `LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=300|rg=us|re=Stormrage|nm=Firstone|sr=applicant|ai=51|gi=51|mi=1|ar=DAMAGER|cl=ROGUE|il=281.0|lv=90|t=${eventTimestampMs}`,
        eventAt: "2026-06-01T00:00:10.000Z",
      },
    ],
  };

  const testHooks = {};
  const server = await createDashboardServer({
    accountRoot,
    dbPath,
    outputDir,
    addonsDir,
    disableBackgroundTick: true,
    passiveEventBatchMaxAgeMs: 0,
    passiveEventBatchMaxSize: 1,
    passiveLiveFeedStateOverride: () => passiveLiveFeedState,
    testHooks,
  });

  try {
    const beforeClear = testHooks.snapshotState();
    assert.equal(beforeClear.applicants.length, 1);
    assert.equal(beforeClear.applicants[0].characterName, "Firstone");

    passiveLiveFeedState = {
      supported: true,
      status: "ready",
      events: [
        {
          key: "event-applicant-1",
          kind: "payload",
          preview: `LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=300|rg=us|re=Stormrage|nm=Firstone|sr=applicant|ai=51|gi=51|mi=1|ar=DAMAGER|cl=ROGUE|il=281.0|lv=90|t=${eventTimestampMs}`,
          eventAt: "2026-06-01T00:00:10.000Z",
        },
        {
          key: "event-appclear-2",
          kind: "payload",
          preview: `LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=301|rg=us|re=Stormrage|nm=Urmomgargles|sr=appclear|t=${eventTimestampMs}`,
          eventAt: "2026-06-01T00:00:11.000Z",
        },
        {
          key: "event-applicant-3",
          kind: "payload",
          preview: `LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=302|rg=us|re=Stormrage|nm=Secondone|sr=applicant|ai=52|gi=52|mi=1|ar=HEALER|cl=PRIEST|il=283.5|lv=90|t=${eventTimestampMs}`,
          eventAt: "2026-06-01T00:00:12.000Z",
        },
      ],
    };

    const afterClear = testHooks.snapshotState();
    assert.equal(afterClear.applicants.length, 1);
    assert.equal(afterClear.applicants[0].characterName, "Secondone");
    assert.equal(afterClear.applicants[0].groupID, 52);
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

test("dashboard broker does not redeliver identical passive events across snapshots", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-dashboard-broker-dedupe-"));
  const accountRoot = path.join(tempDir, "Account");
  const savedVariablesDir = path.join(accountRoot, "TESTACCOUNT", "SavedVariables");
  const savedVariablesFile = path.join(savedVariablesDir, "lnnrank.lua");
  const dbPath = path.join(tempDir, "db.json");
  const outputDir = path.join(tempDir, "output");
  const addonsDir = path.join(tempDir, "addons");
  const eventTimestampMs = Date.now();

  fs.mkdirSync(savedVariablesDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(addonsDir, { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ records: {}, requestStatuses: {}, manualRequests: {}, providerState: {} }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    savedVariablesFile,
    [
      "lnnrankDB = {",
      '  ["requests"] = {},',
      '  ["applicants"] = {},',
      '  ["passiveBridge"] = {',
      '    ["enabled"] = true,',
      '    ["joined"] = true,',
      '    ["channelName"] = "lnnrank0ff24cf4",',
      '    ["playerKey"] = "0ff24cf4",',
      '    ["sessionId"] = "f24cf44635",',
      "  },",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  const passiveLiveFeedState = {
    supported: true,
    status: "ready",
    events: [
      {
        key: "event-applicant-1",
        kind: "payload",
        preview: `LNNRANK|ch=lnnrank0ff24cf4|ss=f24cf44635|n=300|rg=us|re=Stormrage|nm=Firstone|sr=applicant|ai=51|gi=51|mi=1|ar=DAMAGER|cl=ROGUE|il=281.0|lv=90|t=${eventTimestampMs}`,
        eventAt: new Date(eventTimestampMs).toISOString(),
      },
    ],
  };

  const testHooks = {};
  const server = await createDashboardServer({
    accountRoot,
    dbPath,
    outputDir,
    addonsDir,
    disableBackgroundTick: true,
    passiveEventBatchMaxAgeMs: 0,
    passiveEventBatchMaxSize: 1,
    passiveLiveFeedStateOverride: () => passiveLiveFeedState,
    testHooks,
  });

  try {
    const firstSnapshot = testHooks.snapshotState();
    const secondSnapshot = testHooks.snapshotState();

    assert.equal(firstSnapshot.applicants.length, 1);
    assert.equal(secondSnapshot.applicants.length, 1);
    assert.equal(firstSnapshot.queue.length, 1);
    assert.equal(secondSnapshot.queue.length, 1);
    assert.equal(firstSnapshot.passiveLiveFeed.events.length, 1);
    assert.equal(secondSnapshot.passiveLiveFeed.events.length, 1);
    assert.equal(secondSnapshot.passiveLiveFeed.events[0].preview, firstSnapshot.passiveLiveFeed.events[0].preview);
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
