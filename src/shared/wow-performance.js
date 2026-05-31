"use strict";

const TONE_HEX_BY_RANK = [
  "9d9d9d",
  "1eff00",
  "0070dd",
  "a335ee",
  "ff8000",
  "e268ff",
  "e5cc80",
];

const WCL_SCORE_PERCENT_ANCHORS = [
  [0, 0],
  [900, 20],
  [1600, 35],
  [2200, 50],
  [2800, 70],
  [3200, 85],
  [3600, 100],
];

const CURRENT_SEASON_DUNGEON_COUNT = 8;
const CURRENT_SEASON_KEY_SCORE_STEP = 15;
const CURRENT_SEASON_BASE_SCORE_BY_LEVEL = new Map([
  [2, 155],
  [3, 170],
  [4, 200],
  [5, 215],
  [6, 230],
  [7, 260],
  [8, 275],
  [9, 290],
  [10, 320],
  [11, 335],
  [12, 365],
]);

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) {
      return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundMetric(value) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return null;
  }
  return Number(numeric.toFixed(2));
}

function getParseToneRank(value) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return null;
  }
  if (numeric >= 100) {
    return 6;
  }
  if (numeric >= 99) {
    return 5;
  }
  if (numeric >= 95) {
    return 4;
  }
  if (numeric >= 75) {
    return 3;
  }
  if (numeric >= 50) {
    return 2;
  }
  if (numeric >= 25) {
    return 1;
  }
  return 0;
}

function getWclToneRank(value) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return null;
  }
  if (numeric >= 3600) {
    return 6;
  }
  if (numeric >= 3400) {
    return 5;
  }
  if (numeric >= 3200) {
    return 4;
  }
  if (numeric >= 3000) {
    return 3;
  }
  if (numeric >= 2400) {
    return 2;
  }
  if (numeric >= 1400) {
    return 1;
  }
  return 0;
}

function getToneHexFromRank(value) {
  if (value == null) {
    return null;
  }
  const rank = Math.max(0, Math.min(TONE_HEX_BY_RANK.length - 1, Math.round(Number(value) || 0)));
  return TONE_HEX_BY_RANK[rank];
}

function getToneHexFromPercent(value) {
  const rank = getParseToneRank(value);
  if (rank == null) {
    return null;
  }
  return getToneHexFromRank(rank);
}

function interpolateAnchoredPercent(value, anchors) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return null;
  }

  if (!Array.isArray(anchors) || anchors.length === 0) {
    return null;
  }

  if (numeric <= anchors[0][0]) {
    return anchors[0][1];
  }

  for (let index = 1; index < anchors.length; index += 1) {
    const [rightScore, rightPercent] = anchors[index];
    const [leftScore, leftPercent] = anchors[index - 1];
    if (numeric <= rightScore) {
      const span = rightScore - leftScore;
      if (span <= 0) {
        return rightPercent;
      }
      const ratio = (numeric - leftScore) / span;
      return leftPercent + (rightPercent - leftPercent) * ratio;
    }
  }

  return anchors[anchors.length - 1][1];
}

function getWclPerformancePercent(value) {
  return interpolateAnchoredPercent(value, WCL_SCORE_PERCENT_ANCHORS);
}

function getCurrentSeasonDungeonBaseScore(level) {
  const numeric = toNumber(level);
  if (numeric == null) {
    return null;
  }

  const keyLevel = Math.floor(numeric);
  if (keyLevel < 2) {
    return null;
  }

  if (CURRENT_SEASON_BASE_SCORE_BY_LEVEL.has(keyLevel)) {
    return CURRENT_SEASON_BASE_SCORE_BY_LEVEL.get(keyLevel);
  }

  const levelTwelveBase = CURRENT_SEASON_BASE_SCORE_BY_LEVEL.get(12);
  return levelTwelveBase + ((keyLevel - 12) * CURRENT_SEASON_KEY_SCORE_STEP);
}

function getDungeonScorePerformancePercent(levelPoints) {
  const numeric = toNumber(levelPoints);
  if (numeric == null) {
    return null;
  }

  return getWclPerformancePercent(numeric * CURRENT_SEASON_DUNGEON_COUNT);
}

function getDungeonScoreColorHex(levelPoints) {
  const performancePercent = getDungeonScorePerformancePercent(levelPoints);
  if (performancePercent == null) {
    return null;
  }
  return getToneHexFromPercent(performancePercent);
}

function getTimedKeyUpgradeCount(level, levelPoints) {
  const keyLevel = toNumber(level);
  const numericPoints = toNumber(levelPoints);
  const baseScore = getCurrentSeasonDungeonBaseScore(keyLevel);
  if (keyLevel == null || numericPoints == null || baseScore == null) {
    return null;
  }

  const delta = numericPoints - baseScore;
  if (delta < 0) {
    return 0;
  }
  if (delta >= CURRENT_SEASON_KEY_SCORE_STEP - 0.01) {
    return 3;
  }
  if (delta >= (CURRENT_SEASON_KEY_SCORE_STEP / 2) - 0.01) {
    return 2;
  }
  return 1;
}

function formatTimedKeyDisplay(level, levelPoints) {
  const keyLevel = toNumber(level);
  if (keyLevel == null) {
    return null;
  }

  const upgradeCount = getTimedKeyUpgradeCount(keyLevel, levelPoints);
  if (upgradeCount == null) {
    return `+${Math.floor(keyLevel)}`;
  }

  const suffix = upgradeCount > 0 ? "+".repeat(upgradeCount) : "";
  return `${Math.floor(keyLevel)}${suffix}`;
}

function decorateDungeonPresentation(dungeon) {
  if (!dungeon || typeof dungeon !== "object") {
    return dungeon;
  }

  const highestLevelPoints =
    dungeon.highestLevelPoints != null ? roundMetric(dungeon.highestLevelPoints) : null;
  const highestLevel = toNumber(dungeon.highestLevel);

  return {
    ...dungeon,
    highestLevelPoints,
    highestLevelText:
      dungeon.highestLevelText ||
      formatTimedKeyDisplay(highestLevel, highestLevelPoints) ||
      null,
    highestLevelColorHex:
      dungeon.highestLevelColorHex ||
      getDungeonScoreColorHex(highestLevelPoints) ||
      null,
  };
}

function decorateDungeonArray(dungeons) {
  return (Array.isArray(dungeons) ? dungeons : []).map((dungeon) =>
    decorateDungeonPresentation(dungeon)
  );
}

function averageDefinedValues(values) {
  const filtered = values.filter((value) => value != null);
  if (!filtered.length) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function bestParsePercent(record) {
  const dungeons = Array.isArray(record && record.dungeons) ? record.dungeons : [];
  let best = null;
  for (const dungeon of dungeons) {
    const value = toNumber(dungeon && dungeon.bestPercent);
    if (value == null) {
      continue;
    }
    if (best == null || value > best) {
      best = value;
    }
  }
  if (best == null) {
    return null;
  }
  return best;
}

function averageParsePercent(record) {
  const dungeons = Array.isArray(record && record.dungeons) ? record.dungeons : [];
  return averageDefinedValues(
    dungeons.map((dungeon) => toNumber(dungeon && dungeon.bestPercent))
  );
}

function buildDerivedPresentation(record) {
  const normalizedRecord = {
    ...record,
    dungeons: decorateDungeonArray(record && record.dungeons),
  };
  const bestParse = bestParsePercent(normalizedRecord);
  const averageParse = averageParsePercent(normalizedRecord);
  const bestParseRank = getParseToneRank(bestParse);
  const averageParseRank = getParseToneRank(averageParse);
  const wclPerformancePercent = getWclPerformancePercent(normalizedRecord && normalizedRecord.score);
  const wclRank = getWclToneRank(normalizedRecord && normalizedRecord.score);
  const blendedPercent =
    averageDefinedValues([averageParse, wclPerformancePercent]) ??
    roundMetric(wclPerformancePercent);
  const blendedColorHex =
    getToneHexFromPercent(blendedPercent) ?? getToneHexFromRank(wclRank);

  return {
    bestParsePercent: roundMetric(bestParse),
    bestParseColorHex: getToneHexFromRank(bestParseRank),
    averageParsePercent: roundMetric(averageParse),
    averageParseColorHex: getToneHexFromRank(averageParseRank),
    blendedPercent: roundMetric(blendedPercent),
    blendedPercentColorHex: blendedColorHex,
    nameColorHex: blendedColorHex,
  };
}

module.exports = {
  averageParsePercent,
  bestParsePercent,
  averageDefinedValues,
  buildDerivedPresentation,
  decorateDungeonArray,
  decorateDungeonPresentation,
  formatTimedKeyDisplay,
  getCurrentSeasonDungeonBaseScore,
  getDungeonScoreColorHex,
  getDungeonScorePerformancePercent,
  getParseToneRank,
  getToneHexFromPercent,
  getToneHexFromRank,
  getTimedKeyUpgradeCount,
  getWclPerformancePercent,
  getWclToneRank,
  interpolateAnchoredPercent,
  roundMetric,
  toNumber,
};
