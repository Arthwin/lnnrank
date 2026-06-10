"use strict";

const { normalizeText } = require("../mplus-matrix/normalization");

const SPEC_ENTRIES = [
  { className: "Death Knight", specName: "Blood", role: "tank" },
  { className: "Death Knight", specName: "Frost", role: "dps" },
  { className: "Death Knight", specName: "Unholy", role: "dps" },
  { className: "Demon Hunter", specName: "Havoc", role: "dps" },
  { className: "Demon Hunter", specName: "Vengeance", role: "tank" },
  { className: "Druid", specName: "Balance", role: "dps" },
  { className: "Druid", specName: "Feral", role: "dps" },
  { className: "Druid", specName: "Guardian", role: "tank" },
  { className: "Druid", specName: "Restoration", role: "healer" },
  { className: "Evoker", specName: "Augmentation", role: "dps" },
  { className: "Evoker", specName: "Devastation", role: "dps" },
  { className: "Evoker", specName: "Preservation", role: "healer" },
  { className: "Hunter", specName: "Beast Mastery", role: "dps" },
  { className: "Hunter", specName: "Marksmanship", role: "dps" },
  { className: "Hunter", specName: "Survival", role: "dps" },
  { className: "Mage", specName: "Arcane", role: "dps" },
  { className: "Mage", specName: "Fire", role: "dps" },
  { className: "Mage", specName: "Frost", role: "dps" },
  { className: "Monk", specName: "Brewmaster", role: "tank" },
  { className: "Monk", specName: "Mistweaver", role: "healer" },
  { className: "Monk", specName: "Windwalker", role: "dps" },
  { className: "Paladin", specName: "Holy", role: "healer" },
  { className: "Paladin", specName: "Protection", role: "tank" },
  { className: "Paladin", specName: "Retribution", role: "dps" },
  { className: "Priest", specName: "Discipline", role: "healer" },
  { className: "Priest", specName: "Holy", role: "healer" },
  { className: "Priest", specName: "Shadow", role: "dps" },
  { className: "Rogue", specName: "Assassination", role: "dps" },
  { className: "Rogue", specName: "Outlaw", role: "dps" },
  { className: "Rogue", specName: "Subtlety", role: "dps" },
  { className: "Shaman", specName: "Elemental", role: "dps" },
  { className: "Shaman", specName: "Enhancement", role: "dps" },
  { className: "Shaman", specName: "Restoration", role: "healer" },
  { className: "Warlock", specName: "Affliction", role: "dps" },
  { className: "Warlock", specName: "Demonology", role: "dps" },
  { className: "Warlock", specName: "Destruction", role: "dps" },
  { className: "Warrior", specName: "Arms", role: "dps" },
  { className: "Warrior", specName: "Fury", role: "dps" },
  { className: "Warrior", specName: "Protection", role: "tank" },
];

const SPEC_ENTRIES_BY_NAME = new Map();
const SPEC_ENTRIES_BY_LOOKUP_KEY = new Map();
const SPEC_NAMES = [];
const SPEC_NAMES_BY_CLASS = new Map();

function buildSpecLookupKey(value) {
  return normalizeText(value || "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z]/g, "");
}

for (const entry of SPEC_ENTRIES) {
  if (!SPEC_ENTRIES_BY_NAME.has(entry.specName)) {
    SPEC_ENTRIES_BY_NAME.set(entry.specName, []);
    SPEC_NAMES.push(entry.specName);
  }
  SPEC_ENTRIES_BY_NAME.get(entry.specName).push(entry);

  const lookupKey = buildSpecLookupKey(entry.specName);
  if (!SPEC_ENTRIES_BY_LOOKUP_KEY.has(lookupKey)) {
    SPEC_ENTRIES_BY_LOOKUP_KEY.set(lookupKey, entry.specName);
  }

  if (!SPEC_NAMES_BY_CLASS.has(entry.className)) {
    SPEC_NAMES_BY_CLASS.set(entry.className, []);
  }
  SPEC_NAMES_BY_CLASS.get(entry.className).push(entry.specName);
}

SPEC_NAMES.sort((left, right) => right.length - left.length);

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSpecName(value) {
  const normalized = normalizeText(value || "");
  if (!normalized) {
    return null;
  }

  if (SPEC_ENTRIES_BY_NAME.has(normalized)) {
    return normalized;
  }

  const lookupKey = buildSpecLookupKey(normalized);
  return SPEC_ENTRIES_BY_LOOKUP_KEY.get(lookupKey) || normalized;
}

function normalizeRoleValue(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase("en-US");
  if (!normalized) {
    return null;
  }

  if (normalized === "damager" || normalized === "damage") {
    return "dps";
  }
  if (normalized === "heal" || normalized === "heals") {
    return "healer";
  }
  if (normalized === "tank" || normalized === "dps" || normalized === "healer") {
    return normalized;
  }
  return null;
}

function getSpecCandidates(specName) {
  const normalizedSpecName = normalizeSpecName(specName);
  if (!normalizedSpecName) {
    return [];
  }
  return SPEC_ENTRIES_BY_NAME.get(normalizedSpecName) || [];
}

function getSpecInfo(specName, className) {
  const candidates = getSpecCandidates(specName);
  if (candidates.length === 0) {
    return null;
  }

  const normalizedClassName = normalizeText(className || "");
  if (normalizedClassName) {
    const match = candidates.find((entry) => entry.className === normalizedClassName);
    if (match) {
      return match;
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function getRoleForSpec(specName) {
  const candidates = getSpecCandidates(specName);
  return candidates.length > 0 ? candidates[0].role : null;
}

function getPreferredMetricForRole(roleValue) {
  const normalizedRole = normalizeRoleValue(roleValue);
  if (normalizedRole === "healer") {
    return "hps";
  }
  if (normalizedRole === "dps") {
    return "dps";
  }
  if (normalizedRole === "tank") {
    return "dps";
  }
  return null;
}

function resolveRoleForCharacterContext(context = {}) {
  const hintedRole =
    normalizeRoleValue(context.roleHint) ||
    normalizeRoleValue(context.assignedRole) ||
    null;
  if (hintedRole) {
    return hintedRole;
  }

  const specRole = getRoleForSpec(context.specName);
  if (specRole) {
    return specRole;
  }

  const explicitRole = normalizeRoleValue(context.role);
  if (explicitRole) {
    return explicitRole;
  }

  const parseMetric = String(context.parseMetric || "").trim().toLocaleLowerCase("en-US");
  if (parseMetric === "hps") {
    return "healer";
  }
  if (parseMetric === "dps") {
    return "dps";
  }

  if (context.text) {
    return inferRoleFromText(context.text);
  }

  return null;
}

function detectSelectedSpecFromText(text) {
  const normalized = normalizeText(text || "");
  if (!normalized) {
    return null;
  }

  for (const specName of SPEC_NAMES) {
    const pattern = new RegExp(`\\b${escapeRegExp(specName)}\\s+Talents\\b`, "i");
    if (pattern.test(normalized)) {
      return specName;
    }
  }

  return null;
}

function inferClassFromText(text, specName) {
  const normalized = normalizeText(text || "");
  const candidates = getSpecCandidates(specName);
  if (!normalized || candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0].className;
  }

  const matches = candidates.filter((candidate) => {
    const peerSpecs = (SPEC_NAMES_BY_CLASS.get(candidate.className) || []).filter(
      (entry) => entry !== candidate.specName
    );
    return peerSpecs.some((peerSpec) => {
      const pattern = new RegExp(`\\b${escapeRegExp(peerSpec)}\\b`, "i");
      return pattern.test(normalized);
    });
  });

  return matches.length === 1 ? matches[0].className : null;
}

function inferRoleFromText(text) {
  const normalized = normalizeText(text || "");
  if (!normalized) {
    return null;
  }

  const contextualMatch = normalized.match(/\b(Tank|DPS|Healer)\b\s+Best Perf\. Avg\b/i);
  if (contextualMatch) {
    const value = contextualMatch[1].toLocaleLowerCase("en-US");
    if (value === "dps" || value === "tank" || value === "healer") {
      return value;
    }
  }

  return null;
}

function detectSpecInfoFromText(text) {
  const specName = detectSelectedSpecFromText(text);
  if (!specName) {
    return {
      specName: null,
      className: null,
      role: inferRoleFromText(text),
    };
  }

  const className = inferClassFromText(text, specName);
  const info = getSpecInfo(specName, className);

  return {
    specName,
    className: className || (info && info.className) || null,
    role: (info && info.role) || getRoleForSpec(specName),
  };
}

module.exports = {
  SPEC_ENTRIES,
  detectSelectedSpecFromText,
  detectSpecInfoFromText,
  getPreferredMetricForRole,
  getRoleForSpec,
  getSpecInfo,
  inferRoleFromText,
  inferClassFromText,
  normalizeSpecName,
  normalizeRoleValue,
  resolveRoleForCharacterContext,
};
