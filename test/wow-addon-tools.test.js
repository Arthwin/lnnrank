"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildCharacterRecord,
  buildCompanionPayload,
  createDungeonLabel,
  normalizeNameKeyForAddon,
  normalizeRealmKeyForAddon,
  renderCompanionDataFile,
  stageAddonBundle,
} = require("../src/wow-addon-tools/lnnrank-bridge");
const {
  WclRateLimitError,
  buildRecordFromWebSnapshot,
  fetchCharacterViaProvider,
  normalizeLookupInput,
  runWebCharacterPipeline,
} = require("../src/wow-addon-tools/live-provider");
const {
  decorateDungeonPresentation,
  formatTimedKeyDisplay,
  getDungeonScoreColorHex,
} = require("../src/shared/wow-performance");
const { getPreferredMetricForRole } = require("../src/shared/wow-specs");
const { extractZoneStats } = require("../src/mplus-matrix/zone-rankings");
const { createPassiveLiveFeedMonitor } = require("../src/wow-addon-tools/passive-live-feed");

test("tank role hints prefer damage parses instead of points", () => {
  assert.equal(getPreferredMetricForRole("tank"), "dps");
});

test("addon bridge normalization matches the Lua-side lookup rules", () => {
  assert.equal(normalizeRealmKeyForAddon("Shattered Hand"), "shatteredhand");
  assert.equal(normalizeRealmKeyForAddon("Aggra(Português)"), "aggraportuguês");
  assert.equal(normalizeNameKeyForAddon("Urmomgargles"), "urmomgargles");
});

test("dungeon labels prefer known shorthand and fallback to initials", () => {
  assert.equal(createDungeonLabel("Algeth'ar Academy"), "AA");
  assert.equal(createDungeonLabel("Seat of the Triumvirate"), "SEAT");
  assert.equal(createDungeonLabel("Operation: Floodgate"), "FLOOD");
});

test("zone rankings parser extracts WCL API all-star score and highest key data", () => {
  const stats = extractZoneStats(
    {
      allStars: [
        { spec: "Arms", points: 2965.31, rankPercent: 85.05 },
        { spec: "Fury", points: 2923.63, rankPercent: 83.37 },
      ],
      rankings: [
        {
          encounter: {
            name: "Algeth'ar Academy",
          },
          rankPercent: 67.41,
          allStars: {
            points: 78.32,
          },
          bestSpec: "Fury",
          bestRank: {
            ilvl: 12,
            score: 374.11,
          },
        },
      ],
    },
    "2026-06-02T00:00:00.000Z"
  );

  assert.equal(stats.score, 2965.31);
  assert.equal(stats.specName, "Fury");
  assert.equal(stats.className, "Warrior");
  assert.equal(stats.role, "dps");
  assert.equal(stats.dungeons.algetharacademy.bestPercent, 67.41);
  assert.equal(stats.dungeons.algetharacademy.points, 78.32);
  assert.equal(stats.dungeons.algetharacademy.highestLevel, 12);
  assert.equal(stats.dungeons.algetharacademy.highestLevelPoints, 374.11);
});

test("companion payload groups records by normalized region, realm, and character keys", () => {
  const record = buildCharacterRecord({
    region: "US",
    realm: "Stormrage",
    name: "Urmomgargles",
    score: 2850.85,
    updatedAt: "2026-05-31T00:00:00.000Z",
    dungeons: {
      algetharacademy: {
        name: "Algeth'ar Academy",
        bestPercent: 71.8013,
        points: 382.8223,
      },
    },
  });

  const payload = buildCompanionPayload([record], {
    builtAt: "2026-05-31T00:00:00.000Z",
  });

  assert.equal(payload.characters.us.stormrage.urmomgargles.name, "Urmomgargles");
  assert.equal(payload.characters.us.stormrage.urmomgargles.dungeons[0].label, "AA");
  assert.equal(payload.characters.us.stormrage.urmomgargles.updatedAtUnix, 1780185600);
  assert.equal(payload.manifest.refreshAfterSeconds, 86400);
});

test("character records preserve WCL spec and role metadata", () => {
  const record = buildCharacterRecord({
    region: "us",
    realm: "Stormrage",
    name: "Urmomgargles",
    score: 2850.85,
    specName: "Brewmaster",
    className: "Monk",
    role: "tank",
    updatedAt: "2026-05-31T00:00:00.000Z",
    dungeons: {
      algetharacademy: {
        name: "Algeth'ar Academy",
        bestPercent: 71.8,
        points: 382.82,
        highestLevel: 13,
        highestLevelText: "+13",
        specName: "Brewmaster",
        className: "Monk",
        role: "tank",
      },
    },
  });

  assert.equal(record.specName, "Brewmaster");
  assert.equal(record.className, "Monk");
  assert.equal(record.role, "tank");
  assert.equal(record.dungeons[0].specName, "Brewmaster");
  assert.equal(record.dungeons[0].className, "Monk");
  assert.equal(record.dungeons[0].role, "tank");
  assert.equal(record.dungeons[0].highestLevel, 13);
  assert.equal(record.dungeons[0].highestLevelText, "+13");
});

test("character records derive average parse and blended name color presentation data", () => {
  const record = buildCharacterRecord({
    region: "us",
    realm: "Stormrage",
    name: "Urmomgargles",
    score: 2850.85,
    updatedAt: "2026-05-31T00:00:00.000Z",
    dungeons: {
      algetharacademy: {
        name: "Algeth'ar Academy",
        bestPercent: 71.8,
      },
      magistersterrace: {
        name: "Magister's Terrace",
        bestPercent: 67.2,
      },
    },
  });

  assert.equal(record.presentation.bestParsePercent, 71.8);
  assert.equal(record.presentation.bestParseColorHex, "0070dd");
  assert.equal(record.presentation.averageParsePercent, 69.5);
  assert.equal(record.presentation.averageParseColorHex, "0070dd");
  assert.equal(record.presentation.blendedPercent, 70.7);
  assert.equal(record.presentation.blendedPercentColorHex, "0070dd");
  assert.equal(record.presentation.nameColorHex, "0070dd");
});

test("staging writes the main addon and generated companion data", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-addon-"));
  const record = buildCharacterRecord({
    region: "us",
    realm: "Stormrage",
    name: "Urmomgargles",
    score: 2850.85,
    updatedAt: "2026-05-31T00:00:00.000Z",
    dungeons: {},
  });

  const payload = buildCompanionPayload([record], {
    builtAt: "2026-05-31T00:00:00.000Z",
  });

  const staged = stageAddonBundle(tempDir, payload);

  assert.equal(fs.existsSync(path.join(staged.stagedMainDir, "lnnrank.toc")), true);
  assert.equal(fs.existsSync(path.join(staged.stagedMainDir, "AutoCombatLog.lua")), true);
  assert.match(
    fs.readFileSync(path.join(staged.stagedMainDir, "lnnrank.toc"), "utf8"),
    /AutoCombatLog\.lua/
  );
  assert.match(
    fs.readFileSync(path.join(staged.stagedMainDir, "Core.lua"), "utf8"),
    /autoCombatLogInstances = true/
  );
  assert.equal(
    fs.existsSync(path.join(staged.stagedCompanionDir, "lnnrank_companion.toc")),
    true
  );
  assert.match(
    fs.readFileSync(path.join(staged.stagedCompanionDir, "data.lua"), "utf8"),
    /lnnrankCompanionData/
  );
});

test("passive live feed monitor exposes pause and resume controls", () => {
  const monitor = createPassiveLiveFeedMonitor();

  let snapshot = monitor.pause();
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.status, "paused");
  assert.equal(typeof snapshot.pausedAt, "string");

  snapshot = monitor.resume();
  assert.equal(snapshot.paused, false);
  assert.equal(snapshot.status, "waiting");
  assert.equal(typeof snapshot.resumedAt, "string");
});

test("rendered companion data file exports a global table assignment", () => {
  const payload = buildCompanionPayload([
    buildCharacterRecord({
      region: "us",
      realm: "Stormrage",
      name: "Urmomgargles",
      score: 2850.85,
      updatedAt: "2026-05-31T00:00:00.000Z",
      dungeons: {},
    }),
  ]);

  const lua = renderCompanionDataFile(payload);
  assert.match(lua, /lnnrankCompanionData =/);
  assert.match(lua, /Urmomgargles/);
});

test("live lookup normalization canonicalizes pasted Unicode names before fetching", () => {
  const normalized = normalizeLookupInput({
    region: "US",
    realm: "Thunderhorn",
    name: "Sto\u0308ut",
  });

  assert.deepEqual(normalized, {
    region: "us",
    realm: "Thunderhorn",
    name: "St\u00f6ut",
  });
});

test("web snapshots infer spec metadata from the selected WCL spec tab", () => {
  const record = buildRecordFromWebSnapshot(
    {
      name: "Urmomgargles",
      realm: "Stormrage",
      allStarPoints: "2850.85",
      rows: [
        ["Dungeon", "Best %", "Median %", "Kills Logged", "Speed", "All Stars", "Points"],
        ["Algeth'ar Academy", "71", "43", "14", "28:40 (+13)", "0", "382.82"],
      ],
      text: "All Specs Brewmaster Mistweaver Windwalker Brewmaster Talents",
    },
    {
      region: "us",
      realm: "Stormrage",
      name: "Urmomgargles",
    }
  );

  assert.equal(record.specName, "Brewmaster");
  assert.equal(record.className, "Monk");
  assert.equal(record.role, "tank");
  assert.equal(record.dungeons[0].highestLevelText, "+13");
});

test("web snapshots parse dungeon level from by-level WCL rows", () => {
  const record = buildRecordFromWebSnapshot(
    {
      name: "Damagefriend",
      realm: "Stormrage",
      allStarPoints: "3100.12",
      rows: [
        ["Dungeon", "Level", "Time", "Runs", "Points", "Rank", "Best DPS", "Best %", "Median %"],
        ["Algeth'ar Academy", "14", "28:40", "4", "382", "369313", "46.87K Level +14", "71", "13"],
      ],
      text: "All Specs Havoc Vengeance Havoc Talents",
    },
    {
      region: "us",
      realm: "Stormrage",
      name: "Damagefriend",
    },
    {
      parseMetric: "dps",
    }
  );

  assert.equal(record.parseMetric, "dps");
  assert.equal(record.dungeons[0].highestLevel, 14);
  assert.equal(record.dungeons[0].highestLevelText, "14");
  assert.equal(record.dungeons[0].bestPercent, 71);
});

test("dungeon level presentation derives timed suffixes and score color from independent level-page points", () => {
  const dungeon = decorateDungeonPresentation({
    label: "AA",
    highestLevel: 13,
    highestLevelPoints: 382.82,
  });

  assert.equal(formatTimedKeyDisplay(13, 382.82), "13+");
  assert.equal(dungeon.highestLevelText, "13+");
  assert.equal(dungeon.highestLevelColorHex, getDungeonScoreColorHex(382.82));
});

test("shared web pipeline merges score, role parse, and by-level snapshots consistently", async () => {
  const lookup = {
    region: "us",
    realm: "Stormrage",
    name: "Atiezh",
    roleHint: "dps",
  };

  const calls = [];
  const result = await runWebCharacterPipeline(async (_lookup, options) => {
    calls.push(options.metric == null ? null : options.metric);
    if (options.metric === "playerscore") {
      return {
        name: "Atiezh",
        realm: "Stormrage",
        allStarPoints: "2882.62",
        rows: [
          ["Dungeon", "Best %", "Highest Points", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "71", "382.8", "4", "28:40 (+13)", "38", "382.82", "369313"],
        ],
        text: "All Specs Havoc Vengeance Havoc Talents",
      };
    }
    if (options.metric === "dps") {
      return {
        name: "Atiezh",
        realm: "Stormrage",
        allStarPoints: "2882.62",
        rows: [
          ["Dungeon", "Best %", "Highest DPS", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "64", "82467.8", "1", "28:40 (+13)", "64", "73.34", "59281"],
        ],
        text: "All Specs Havoc Vengeance Havoc Talents",
      };
    }
    return {
      name: "Atiezh",
      realm: "Stormrage",
      allStarPoints: "2882.62",
      rows: [
        ["Dungeon", "Level", "Time", "Runs", "Points", "Rank", "Best DPS", "Best %", "Median %"],
        ["Algeth'ar Academy", "13", "28:40", "4", "382", "369313", "46.87K Level +13", "64", "13"],
      ],
      text: "All Specs Havoc Vengeance Havoc Talents",
    };
  }, lookup, {});

  assert.deepEqual(calls, ["playerscore", "dps", null]);
  assert.equal(result.found, true);
  assert.equal(result.record.parseMetric, "dps");
  assert.equal(result.record.dungeons[0].bestPercent, 64);
  assert.equal(result.record.dungeons[0].highestLevelText, "13+");
});

test("shared web pipeline keeps role-specific parse rows authoritative while by-level data only fills key levels", async () => {
  const lookup = {
    region: "eu",
    realm: "Tarren Mill",
    name: "Terapeuten",
    roleHint: "healer",
  };

  const result = await runWebCharacterPipeline(async (_lookup, options) => {
    if (options.metric === "playerscore") {
      return {
        name: "Terapeuten",
        realm: "Tarren Mill",
        allStarPoints: "3190.83",
        rows: [
          ["Dungeon", "Best %", "Highest Points", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "69", "372.4", "2", "28:40 (+12)", "50", "372.46", "12345"],
          ["Magisters' Terrace", "75", "378.6", "4", "18:56 (+13)", "65", "378.67", "12345"],
        ],
        text: "All Specs Mistweaver Windwalker Brewmaster Mistweaver Talents",
      };
    }
    if (options.metric === "hps") {
      return {
        name: "Terapeuten",
        realm: "Tarren Mill",
        allStarPoints: "339.99",
        rows: [
          ["Dungeon", "Best %", "Highest HPS", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "-", "-", "0", "-", "-", "-", "-"],
          ["Magisters' Terrace", "65", "77,955.4", "1", "18:56 (+13)", "65", "72.47", "36537"],
        ],
        text: "All Specs Mistweaver Windwalker Brewmaster Mistweaver Talents",
      };
    }
    return {
      name: "Terapeuten",
      realm: "Tarren Mill",
      allStarPoints: "3190.83",
      rows: [
        ["Dungeon", "Level", "Time", "Runs", "Points", "Rank", "Best HPS", "Best %", "Median %"],
        ["Algeth'ar Academy", "12", "28:40", "2", "372", "12345", "55.1K Level +12", "69", "50"],
        ["Magisters' Terrace", "13", "18:56", "1", "378", "12345", "77.9K Level +13", "65", "65"],
      ],
      text: "All Specs Mistweaver Windwalker Brewmaster Mistweaver Talents",
    };
  }, lookup, {});

  assert.equal(result.found, true);
  assert.equal(result.record.parseMetric, "hps");

  const aa = result.record.dungeons.find((dungeon) => dungeon.label === "AA");
  const mt = result.record.dungeons.find((dungeon) => dungeon.label === "MT");

  assert.equal(aa.bestPercent, null);
  assert.equal(aa.highestLevelText, "12+");
  assert.equal(mt.bestPercent, 65);
  assert.equal(mt.highestLevelText, "13");
  assert.equal(result.record.presentation.averageParsePercent, 65);
});

test("shared web pipeline infers dps from the base WCL page when no role hint is provided", async () => {
  const lookup = {
    region: "us",
    realm: "Stormrage",
    name: "Atiezh",
  };

  const calls = [];
  const result = await runWebCharacterPipeline(async (_lookup, options) => {
    calls.push(options.metric == null ? null : options.metric);
    if (options.metric === "playerscore") {
      return {
        name: "Atiezh",
        realm: "Stormrage",
        allStarPoints: "2882.62",
        rows: [
          ["Dungeon", "Best %", "Highest Points", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "74", "382.8", "3", "28:40 (+13)", "58", "382.82", "95383"],
        ],
        text: "Night Elf Demon Hunter All Specs Havoc Vengeance Devourer DPS Best Perf. Avg 65.9",
      };
    }
    if (options.metric === "dps") {
      return {
        name: "Atiezh",
        realm: "Stormrage",
        allStarPoints: "447.17",
        rows: [
          ["Dungeon", "Best %", "Highest DPS", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "64", "82,467.8", "1", "28:40 (+13)", "64", "73.34", "59281"],
        ],
        text: "Night Elf Demon Hunter All Specs Havoc Vengeance Devourer DPS Best Perf. Avg 65.9",
      };
    }
    return {
      name: "Atiezh",
      realm: "Stormrage",
      allStarPoints: "2882.62",
      rows: [
        ["Dungeon", "Level", "Time", "Runs", "Points", "Rank", "Best DPS", "Best %", "Median %"],
        ["Algeth'ar Academy", "13", "28:40", "3", "382", "95383", "82.4K Level +13", "64", "58"],
      ],
      text: "Night Elf Demon Hunter All Specs Havoc Vengeance Devourer DPS Best Perf. Avg 65.9",
    };
  }, lookup, {});

  assert.deepEqual(calls, ["playerscore", "dps", null]);
  assert.equal(result.record.parseMetric, "dps");
  assert.equal(result.record.role, "dps");
  assert.equal(result.record.dungeons[0].bestPercent, 64);
});

test("shared web pipeline prefers explicit WoW role hints over conflicting WCL base-page spec selection", async () => {
  const lookup = {
    region: "eu",
    realm: "Tarren Mill",
    name: "HealerExample",
    roleHint: "healer",
  };

  const calls = [];
  const result = await runWebCharacterPipeline(async (_lookup, options) => {
    calls.push(options.metric == null ? null : options.metric);
    if (options.metric === "playerscore") {
      return {
        name: "HealerExample",
        realm: "Tarren Mill",
        allStarPoints: "3190.83",
        rows: [
          ["Dungeon", "Best %", "Highest Points", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "69", "372.4", "2", "28:40 (+12)", "50", "372.46", "12345"],
        ],
        text: "Pandaren Monk All Specs Mistweaver Windwalker Brewmaster Windwalker Talents",
      };
    }
    if (options.metric === "hps") {
      return {
        name: "HealerExample",
        realm: "Tarren Mill",
        allStarPoints: "339.99",
        rows: [
          ["Dungeon", "Best %", "Highest HPS", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "61", "61,955.4", "1", "18:56 (+13)", "61", "72.47", "36537"],
        ],
        text: "Pandaren Monk All Specs Mistweaver Windwalker Brewmaster Windwalker Talents",
      };
    }
    return {
      name: "HealerExample",
      realm: "Tarren Mill",
      allStarPoints: "3190.83",
      rows: [
        ["Dungeon", "Level", "Time", "Runs", "Points", "Rank", "Best HPS", "Best %", "Median %"],
        ["Algeth'ar Academy", "12", "28:40", "2", "372", "12345", "55.1K Level +12", "61", "50"],
      ],
      text: "Pandaren Monk All Specs Mistweaver Windwalker Brewmaster Windwalker Talents",
    };
  }, lookup, {});

  assert.deepEqual(calls, ["playerscore", "hps", "points_and_healing"]);
  assert.equal(result.record.parseMetric, "hps");
  assert.equal(result.record.dungeons[0].bestPercent, 61);
});

test("shared web pipeline never falls back to points parses when a role-specific page fails", async () => {
  const lookup = {
    region: "eu",
    realm: "Tarren Mill",
    name: "Terapeuten",
  };

  const result = await runWebCharacterPipeline(async (_lookup, options) => {
    if (options.metric === "playerscore") {
      return {
        name: "Terapeuten",
        realm: "Tarren Mill",
        allStarPoints: "3190.83",
        rows: [
          ["Dungeon", "Best %", "Highest Points", "Runs", "Fastest", "Med", "All Stars", "Points"],
          ["Algeth'ar Academy", "69", "372.4", "2", "28:40 (+12)", "50", "372.46", "12345"],
          ["Magisters' Terrace", "75", "378.6", "4", "18:56 (+13)", "65", "378.67", "12345"],
        ],
        text: "Pandaren Monk All Specs Mistweaver Windwalker Brewmaster Healer Best Perf. Avg 61.5",
      };
    }

    if (options.metric === "hps") {
      throw new Error("Simulated HPS page failure");
    }

    return {
      name: "Terapeuten",
      realm: "Tarren Mill",
      allStarPoints: "3190.83",
      rows: [
        ["Dungeon", "Level", "Time", "Runs", "Points", "Rank", "Best HPS", "Best %", "Median %"],
        ["Algeth'ar Academy", "12", "28:40", "2", "372", "12345", "55.1K Level +12", "69", "50"],
        ["Magisters' Terrace", "13", "18:56", "1", "378", "12345", "77.9K Level +13", "65", "65"],
      ],
      text: "Pandaren Monk All Specs Mistweaver Windwalker Brewmaster Healer Best Perf. Avg 61.5",
    };
  }, lookup, {});

  assert.equal(result.found, true);
  assert.equal(result.record.parseMetric, "hps");
  assert.equal(result.record.role, "healer");
  assert.equal(result.record.dungeons[0].bestPercent, null);
  assert.equal(result.record.dungeons[0].highestLevelText, "12+");
  assert.equal(result.record.dungeons[1].bestPercent, null);
  assert.equal(result.record.dungeons[1].highestLevelText, "13");
});

test("shared provider helper upgrades incomplete auto API results with a web fetch", async () => {
  const calls = [];
  const result = await fetchCharacterViaProvider(
    {
      region: "us",
      realm: "Stormrage",
      name: "Atiezh",
    },
    {
      provider: "auto",
      hasApiCredentials: true,
      fetchApi: async () => {
        calls.push("api");
        return {
          found: true,
          record: {
            score: 2882.62,
            dungeons: [],
          },
        };
      },
      fetchWeb: async () => {
        calls.push("web");
        return {
          found: true,
          record: {
            score: 2882.62,
            dungeons: [
              {
                slug: "algetharacademy",
                highestLevel: 13,
              },
            ],
          },
        };
      },
    }
  );

  assert.deepEqual(calls, ["api", "web"]);
  assert.equal(result.providerUsed, "web");
  assert.equal(result.fallbackFrom, "api");
});

test("shared provider helper preserves WCL rate-limit errors instead of web fan-out", async () => {
  const calls = [];

  await assert.rejects(
    () =>
      fetchCharacterViaProvider(
        {
          region: "us",
          realm: "Stormrage",
          name: "Atiezh",
        },
        {
          provider: "auto",
          hasApiCredentials: true,
          fetchApi: async () => {
            calls.push("api");
            throw new WclRateLimitError("rate limited", {
              retryAfterSeconds: 60,
            });
          },
          fetchWeb: async () => {
            calls.push("web");
            return {
              found: true,
              record: {
                score: 2882.62,
                dungeons: [],
              },
            };
          },
        }
      ),
    WclRateLimitError
  );

  assert.deepEqual(calls, ["api"]);
});
