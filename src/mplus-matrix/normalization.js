"use strict";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFC")
    .trim();
}

function normalizeCasefold(value) {
  return normalizeText(value).toLocaleLowerCase("en-US");
}

function stripDiacritics(value) {
  return normalizeText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function slugifyRealm(value) {
  return stripDiacritics(value)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "");
}

function buildCharacterKey(region, realmKey, characterName) {
  return [
    normalizeCasefold(region),
    slugifyRealm(realmKey),
    normalizeCasefold(characterName),
  ].join(":");
}

module.exports = {
  buildCharacterKey,
  normalizeCasefold,
  normalizeText,
  slugifyRealm,
  stripDiacritics,
};
