"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { normalizeText, slugifyRealm } = require("../mplus-matrix/normalization");
const { ensureDir, formatIsoTimestamp, toLua } = require("../mplus-matrix/utils");
const { CACHE_TTL_MS } = require("./cache");
const {
  buildDerivedPresentation,
  decorateDungeonArray,
  roundMetric,
} = require("../shared/wow-performance");

const MAIN_ADDON_NAME = "lnnrank";
const COMPANION_ADDON_NAME = "lnnrank_companion";
const SUPPORTED_INTERFACE = "120005, 120007";
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "output", "wow-addons");
const DEFAULT_WOW_ADDONS_DIR =
  "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Interface\\AddOns";
const MAIN_ADDON_SOURCE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "wow-addons",
  MAIN_ADDON_NAME
);

const DUNGEON_LABELS_BY_SLUG = {
  algetharacademy: "AA",
  ecdomealdani: "EDA",
  hallsofatonement: "HOA",
  magistersterrace: "MT",
  maisaracaverns: "MC",
  nexuspointxenas: "NPX",
  operationfloodgate: "FLOOD",
  pitofsaron: "POS",
  prioryofthesacredflame: "PSF",
  seatofthetriumvirate: "SEAT",
  skyreach: "SR",
  tazaveshsoleahsgambit: "GAMBIT",
  tazaveshstreetsofwonder: "STREETS",
  thedawnbreaker: "DB",
  windrunnerspire: "WS",
};

const IGNORE_WORDS = new Set(["and", "of", "the", "to", "a", "an"]);

function normalizeRealmKeyForAddon(value) {
  return normalizeText(value)
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}]+/gu, "");
}

function normalizeNameKeyForAddon(value) {
  return normalizeText(value).toLocaleLowerCase("en-US");
}

function createDungeonLabel(name) {
  const slug = slugifyRealm(name);
  if (DUNGEON_LABELS_BY_SLUG[slug]) {
    return DUNGEON_LABELS_BY_SLUG[slug];
  }

  const parts = normalizeText(name)
    .replace(/['’:,.-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => !IGNORE_WORDS.has(part.toLocaleLowerCase("en-US")));

  if (parts.length === 0) {
    return slug.toUpperCase();
  }

  return parts
    .map((part) => part[0].toUpperCase())
    .join("")
    .slice(0, 6);
}

function buildDungeonArray(dungeons) {
  return decorateDungeonArray(
    Object.entries(dungeons || {})
    .map(([slug, dungeon]) => ({
      slug,
      label: createDungeonLabel(dungeon.name || slug),
      name: dungeon.name || slug,
      bestPercent: roundMetric(dungeon.bestPercent),
      points: roundMetric(dungeon.points),
      highestLevelPoints: roundMetric(dungeon.highestLevelPoints),
      highestLevel:
        typeof dungeon.highestLevel === "number" && Number.isFinite(dungeon.highestLevel)
          ? Math.floor(dungeon.highestLevel)
          : null,
      highestLevelText: normalizeText(dungeon.highestLevelText || "") || null,
      highestLevelColorHex: normalizeText(dungeon.highestLevelColorHex || "") || null,
      specName: normalizeText(dungeon.specName || "") || null,
      className: normalizeText(dungeon.className || "") || null,
      role: normalizeText(dungeon.role || "").toLocaleLowerCase("en-US") || null,
    }))
    .filter((entry) => entry.bestPercent != null || entry.points != null)
    .sort((left, right) => left.label.localeCompare(right.label, "en-US"))
  );
}

function buildCharacterRecord(input) {
  const updatedAt = input.updatedAt || formatIsoTimestamp();
  const updatedAtUnix =
    typeof input.updatedAtUnix === "number" && Number.isFinite(input.updatedAtUnix)
      ? Math.floor(input.updatedAtUnix)
      : Math.floor(Date.parse(updatedAt) / 1000);

  const baseRecord = {
    name: normalizeText(input.name),
    realm: normalizeText(input.realm),
    region: normalizeText(input.region).toLocaleLowerCase("en-US"),
    score: roundMetric(input.score),
    parseMetric: normalizeText(input.parseMetric || "").toLocaleLowerCase("en-US") || null,
    specName: normalizeText(input.specName || "") || null,
    className: normalizeText(input.className || "") || null,
    role: normalizeText(input.role || "").toLocaleLowerCase("en-US") || null,
    updatedAt,
    updatedAtUnix: Number.isFinite(updatedAtUnix) ? updatedAtUnix : null,
    wclCharacterId:
      typeof input.wclCharacterId === "number" && Number.isFinite(input.wclCharacterId)
        ? input.wclCharacterId
        : null,
    dungeons: buildDungeonArray(input.dungeons),
  };

  return {
    ...baseRecord,
    presentation: buildDerivedPresentation(baseRecord),
  };
}

function buildStatusPayload(statusEntries) {
  const payload = {};

  for (const entry of statusEntries || []) {
    const regionKey = normalizeText(entry.region).toLocaleLowerCase("en-US");
    const realmKey = normalizeRealmKeyForAddon(entry.realm);
    const nameKey = normalizeNameKeyForAddon(entry.name);

    if (!payload[regionKey]) {
      payload[regionKey] = {};
    }
    if (!payload[regionKey][realmKey]) {
      payload[regionKey][realmKey] = {};
    }

    payload[regionKey][realmKey][nameKey] = {
      state: entry.state || "queued",
      message: entry.message || null,
      updatedAt: entry.updatedAt || formatIsoTimestamp(),
    };
  }

  return payload;
}

function buildCompanionPayload(records, options = {}) {
  const payload = {
    manifest: {
      addon: MAIN_ADDON_NAME,
      companionAddon: COMPANION_ADDON_NAME,
      builtAt: options.builtAt || formatIsoTimestamp(),
      source: options.source || "warcraftlogs",
      mode: "reload-required",
      recordCount: records.length,
      refreshAfterSeconds:
        typeof options.refreshAfterSeconds === "number" && Number.isFinite(options.refreshAfterSeconds)
          ? Math.floor(options.refreshAfterSeconds)
          : Math.floor(CACHE_TTL_MS / 1000),
      rateLimit: options.rateLimit || null,
    },
    characters: {},
    statuses: buildStatusPayload(options.statuses || []),
  };

  for (const record of records) {
    const regionKey = normalizeText(record.region).toLocaleLowerCase("en-US");
    const realmKey = normalizeRealmKeyForAddon(record.realm);
    const nameKey = normalizeNameKeyForAddon(record.name);

    if (!payload.characters[regionKey]) {
      payload.characters[regionKey] = {};
    }
    if (!payload.characters[regionKey][realmKey]) {
      payload.characters[regionKey][realmKey] = {};
    }

    payload.characters[regionKey][realmKey][nameKey] = record;
  }

  return payload;
}

function renderCompanionDataFile(payload) {
  return [
    "-- Generated automatically by the LNNRank bridge.",
    `lnnrankCompanionData = ${toLua(payload)}`,
    "",
  ].join("\n");
}

function renderCompanionToc() {
  return [
    `## Interface: ${SUPPORTED_INTERFACE}`,
    "## Title: LÑÑRank Companion",
    "## Author: lnnrank",
    "## Notes: Generated Warcraft Logs Mythic+ tooltip data for LÑÑRank.",
    "## Version: 1.0.0",
    "## LoadOnDemand: 0",
    "",
    "data.lua",
    "",
  ].join("\n");
}

function copyDirectory(sourceDir, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  ensureDir(path.dirname(targetDir));
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function stageAddonBundle(outputDir, payload) {
  if (!fs.existsSync(MAIN_ADDON_SOURCE_DIR)) {
    throw new Error(`Main addon source is missing: ${MAIN_ADDON_SOURCE_DIR}`);
  }

  ensureDir(outputDir);

  const stagedMainDir = path.join(outputDir, MAIN_ADDON_NAME);
  const stagedCompanionDir = path.join(outputDir, COMPANION_ADDON_NAME);

  copyDirectory(MAIN_ADDON_SOURCE_DIR, stagedMainDir);
  fs.rmSync(stagedCompanionDir, { recursive: true, force: true });
  ensureDir(stagedCompanionDir);
  fs.writeFileSync(
    path.join(stagedCompanionDir, `${COMPANION_ADDON_NAME}.toc`),
    renderCompanionToc(),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stagedCompanionDir, "data.lua"),
    renderCompanionDataFile(payload),
    "utf8"
  );

  return {
    stagedMainDir,
    stagedCompanionDir,
  };
}

function installStagedAddons(staged, wowAddonsDir = DEFAULT_WOW_ADDONS_DIR) {
  ensureDir(wowAddonsDir);

  const mainInstallDir = path.join(wowAddonsDir, MAIN_ADDON_NAME);
  const companionInstallDir = path.join(wowAddonsDir, COMPANION_ADDON_NAME);

  copyDirectory(staged.stagedMainDir, mainInstallDir);
  copyDirectory(staged.stagedCompanionDir, companionInstallDir);

  return {
    mainInstallDir,
    companionInstallDir,
  };
}

module.exports = {
  COMPANION_ADDON_NAME,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_WOW_ADDONS_DIR,
  MAIN_ADDON_NAME,
  buildCharacterRecord,
  buildCompanionPayload,
  buildStatusPayload,
  createDungeonLabel,
  installStagedAddons,
  normalizeNameKeyForAddon,
  normalizeRealmKeyForAddon,
  renderCompanionDataFile,
  renderCompanionToc,
  stageAddonBundle,
};
