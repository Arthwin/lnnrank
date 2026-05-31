"use strict";

const { normalizeText, slugifyRealm } = require("./normalization");
const { getRoleForSpec, normalizeSpecName } = require("../shared/wow-specs");

const DUNGEON_KEYS = [
  "Ara-Kara, City of Echoes",
  "Eco-Dome Al'dani",
  "Halls of Atonement",
  "Operation: Floodgate",
  "Priory of the Sacred Flame",
  "Tazavesh: So'leah's Gambit",
  "Tazavesh: Streets of Wonder",
  "The Dawnbreaker",
];

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractNestedNumber(object, keys) {
  if (!object || typeof object !== "object") {
    return null;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      const value = toNumber(object[key]);
      if (value != null) {
        return value;
      }
    }
  }
  return null;
}

function extractTimestamp(object) {
  if (!object || typeof object !== "object") {
    return null;
  }

  const candidates = [
    object.updatedAt,
    object.updateTime,
    object.lastUpdated,
    object.lastUpdate,
    object.startTime,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return new Date(candidate).toISOString();
    }
  }

  return null;
}

function extractOverallScore(zoneRankingsJson) {
  if (!zoneRankingsJson || typeof zoneRankingsJson !== "object") {
    return null;
  }

  const direct = extractNestedNumber(zoneRankingsJson, [
    "score",
    "points",
    "total",
    "allStars",
    "allStarPoints",
    "zonePoints",
  ]);
  if (direct != null) {
    return direct;
  }

  const containers = [
    zoneRankingsJson.allStars,
    zoneRankingsJson.summary,
    zoneRankingsJson.overall,
  ];
  for (const container of containers) {
    const nested = extractNestedNumber(container, ["points", "score", "total", "amount"]);
    if (nested != null) {
      return nested;
    }
  }

  const dungeonEntries = collectDungeonEntries(zoneRankingsJson);
  const pointValues = dungeonEntries
    .map((entry) => toNumber(entry.points))
    .filter((entry) => entry != null);
  if (pointValues.length > 0) {
    return pointValues.reduce((sum, entry) => sum + entry, 0);
  }

  return null;
}

function collectDungeonEntries(zoneRankingsJson) {
  if (!zoneRankingsJson || typeof zoneRankingsJson !== "object") {
    return [];
  }

  const arrays = [];
  for (const value of Object.values(zoneRankingsJson)) {
    if (Array.isArray(value)) {
      arrays.push(value);
    }
  }

  if (Array.isArray(zoneRankingsJson.rankings)) {
    arrays.unshift(zoneRankingsJson.rankings);
  }

  const entries = [];
  for (const arrayValue of arrays) {
    for (const item of arrayValue) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const encounter = item.encounter && typeof item.encounter === "object" ? item.encounter : null;
      const name = normalizeText(
        item.name ||
          item.encounterName ||
          item.label ||
          (encounter ? encounter.name : "")
      );
      if (!name) {
        continue;
      }

      const directBestPercent = extractNestedNumber(item, [
        "rankPercent",
        "rankPercentile",
        "rankingPercent",
        "percent",
        "percentile",
      ]);
      const nestedBestPercent = extractNestedNumber(item.score, [
        "rankPercent",
        "rankPercentile",
        "rankingPercent",
        "percent",
        "percentile",
      ]);
      const bestPercent = directBestPercent != null ? directBestPercent : nestedBestPercent;

      const directPoints = extractNestedNumber(item, ["amount", "total", "score", "points"]);
      const nestedPoints = extractNestedNumber(item.score, ["amount", "total", "score", "points"]);
      const points = directPoints != null ? directPoints : nestedPoints;
      const specName = normalizeSpecName(item.bestSpec || item.spec || "");
      const role = getRoleForSpec(specName);

      entries.push({
        name,
        slug: slugifyRealm(name),
        points,
        bestPercent,
        specName,
        role,
      });
    }
  }

  return entries;
}

function selectPrimarySpec(entries) {
  const candidates = (entries || [])
    .filter((entry) => entry && entry.specName)
    .sort((left, right) => {
      const pointDelta = (right.points || -1) - (left.points || -1);
      if (pointDelta !== 0) {
        return pointDelta;
      }
      return (right.bestPercent || -1) - (left.bestPercent || -1);
    });

  return candidates[0] || null;
}

function extractZoneStats(zoneRankingsJson, collectedAt) {
  const entries = collectDungeonEntries(zoneRankingsJson);
  const dungeons = {};
  for (const entry of entries) {
    if (entry.bestPercent == null && entry.points == null) {
      continue;
    }
    dungeons[entry.slug] = {
      name: entry.name,
      bestPercent: entry.bestPercent,
      points: entry.points,
      specName: entry.specName,
      role: entry.role,
    };
  }

  const score = extractOverallScore(zoneRankingsJson);
  const updatedAt = extractTimestamp(zoneRankingsJson) || collectedAt;
  const primarySpec = selectPrimarySpec(entries);

  return {
    score,
    dungeons,
    updatedAt,
    specName: primarySpec && primarySpec.specName || null,
    role: primarySpec && primarySpec.role || null,
    rawDungeonCount: entries.length,
  };
}

module.exports = {
  DUNGEON_KEYS,
  extractZoneStats,
};
