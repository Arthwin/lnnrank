"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createMockCharacterInput,
  findLatestWowCharacter,
} = require("../src/wow-addon-tools/mock-data");

test("mock character generation is deterministic for the same region/realm/name", () => {
  const first = createMockCharacterInput({
    region: "us",
    realm: "Stormrage",
    name: "Urmomgargles",
    updatedAt: "2026-05-31T00:00:00.000Z",
  });
  const second = createMockCharacterInput({
    region: "us",
    realm: "Stormrage",
    name: "Urmomgargles",
    updatedAt: "2026-05-31T00:00:00.000Z",
  });

  assert.equal(first.score, second.score);
  assert.deepEqual(first.dungeons, second.dungeons);
});

test("latest WoW character detection prefers the most recently modified character directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnnrank-wtf-"));
  const alphaCharacterDir = path.join(tempDir, "ACCOUNT", "Stormrage", "Alpha");
  const betaCharacterDir = path.join(tempDir, "ACCOUNT", "Stormrage", "Beta");

  fs.mkdirSync(alphaCharacterDir, { recursive: true });
  fs.mkdirSync(betaCharacterDir, { recursive: true });

  const older = new Date("2026-05-30T12:00:00.000Z");
  const newer = new Date("2026-05-31T12:00:00.000Z");
  fs.utimesSync(alphaCharacterDir, older, older);
  fs.utimesSync(betaCharacterDir, newer, newer);

  const latest = findLatestWowCharacter(tempDir);
  assert.equal(latest.realm, "Stormrage");
  assert.equal(latest.name, "Beta");
});
