"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { formatIsoTimestamp } = require("../mplus-matrix/utils");

const DEFAULT_WOW_WTF_ACCOUNT_DIR =
  "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\WTF\\Account";

const MOCK_DUNGEONS = [
  { slug: "algetharacademy", name: "Algeth'ar Academy" },
  { slug: "magistersterrace", name: "Magisters' Terrace" },
  { slug: "maisaracaverns", name: "Maisara Caverns" },
  { slug: "nexuspointxenas", name: "Nexus-Point Xenas" },
  { slug: "pitofsaron", name: "Pit of Saron" },
  { slug: "seatofthetriumvirate", name: "Seat of the Triumvirate" },
  { slug: "skyreach", name: "Skyreach" },
  { slug: "windrunnerspire", name: "Windrunner Spire" },
];

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededNumber(seed, index, min, max, decimals = 1) {
  const mixed = Math.imul(seed ^ (index * 0x45d9f3b), 0x27d4eb2d) >>> 0;
  const fraction = mixed / 0xffffffff;
  const raw = min + (max - min) * fraction;
  return Number(raw.toFixed(decimals));
}

function buildMockDungeonMap(seed) {
  const dungeons = {};
  for (let index = 0; index < MOCK_DUNGEONS.length; index += 1) {
    const dungeon = MOCK_DUNGEONS[index];
    dungeons[dungeon.slug] = {
      name: dungeon.name,
      bestPercent: createSeededNumber(seed, index + 1, 42, 97.5, 1),
      points: createSeededNumber(seed, index + 101, 315, 418, 2),
    };
  }
  return dungeons;
}

function createMockCharacterInput({ region = "us", realm, name, updatedAt, score } = {}) {
  if (!realm || !name) {
    throw new Error("Mock character generation requires both realm and name.");
  }

  const seed = hashString(`${region}:${realm}:${name}`);
  return {
    region,
    realm,
    name,
    score:
      typeof score === "number" && Number.isFinite(score)
        ? Number(score.toFixed(2))
        : createSeededNumber(seed, 0, 2200, 3350, 2),
    updatedAt: updatedAt || formatIsoTimestamp(),
    wclCharacterId: null,
    dungeons: buildMockDungeonMap(seed),
  };
}

function getCharacterDirectories(accountRootDir = DEFAULT_WOW_WTF_ACCOUNT_DIR) {
  if (!fs.existsSync(accountRootDir)) {
    return [];
  }

  const accountDirs = fs
    .readdirSync(accountRootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "SavedVariables");

  const directories = [];
  for (const accountDir of accountDirs) {
    const accountPath = path.join(accountRootDir, accountDir.name);
    const realmDirs = fs
      .readdirSync(accountPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "SavedVariables");

    for (const realmDir of realmDirs) {
      const realmPath = path.join(accountPath, realmDir.name);
      const characterDirs = fs
        .readdirSync(realmPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "SavedVariables");

      for (const characterDir of characterDirs) {
        const characterPath = path.join(realmPath, characterDir.name);
        const stats = fs.statSync(characterPath);
        directories.push({
          account: accountDir.name,
          realm: realmDir.name,
          name: characterDir.name,
          path: characterPath,
          lastModifiedMs: stats.mtimeMs,
        });
      }
    }
  }

  directories.sort((left, right) => right.lastModifiedMs - left.lastModifiedMs);
  return directories;
}

function findLatestWowCharacter(accountRootDir = DEFAULT_WOW_WTF_ACCOUNT_DIR) {
  const characters = getCharacterDirectories(accountRootDir);
  return characters[0] || null;
}

module.exports = {
  DEFAULT_WOW_WTF_ACCOUNT_DIR,
  MOCK_DUNGEONS,
  createMockCharacterInput,
  findLatestWowCharacter,
  getCharacterDirectories,
};
