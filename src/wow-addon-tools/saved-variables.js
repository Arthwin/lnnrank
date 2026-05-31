"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_WOW_ACCOUNT_ROOT =
  "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\WTF\\Account";
const REQUEST_FIELD_ORDER = [
  "characterName",
  "seenCount",
  "region",
  "queuedAt",
  "lastSeenAt",
  "realm",
  "source",
  "unitToken",
  "class",
  "localizedClass",
  "level",
  "itemLevel",
  "assignedRole",
  "applicantID",
  "memberIndex",
];

function findSavedVariablesFiles(accountRootDir = DEFAULT_WOW_ACCOUNT_ROOT) {
  if (!fs.existsSync(accountRootDir)) {
    return [];
  }

  const accountDirs = fs
    .readdirSync(accountRootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "SavedVariables");

  const files = [];
  for (const accountDir of accountDirs) {
    const candidate = path.join(accountRootDir, accountDir.name, "SavedVariables", "lnnrank.lua");
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const stats = fs.statSync(candidate);
    files.push({
      account: accountDir.name,
      path: candidate,
      lastModifiedMs: stats.mtimeMs,
    });
  }

  files.sort((left, right) => right.lastModifiedMs - left.lastModifiedMs);
  return files;
}

function findTableBlockRange(source, tableName) {
  const barePattern = new RegExp(`${tableName}\\s*=\\s*\\{`, "u");
  const bracketPattern = new RegExp(`\\["${tableName}"\\]\\s*=\\s*\\{`, "u");
  const bareMatch = barePattern.exec(source);
  const bracketMatch = bracketPattern.exec(source);
  const match =
    bareMatch && bracketMatch
      ? bareMatch.index < bracketMatch.index
        ? bareMatch
        : bracketMatch
      : bareMatch || bracketMatch;

  if (!match) {
    return null;
  }

  const bodyStart = match.index + match[0].length - 1;
  let index = bodyStart;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          start: match.index,
          bodyStart,
          bodyEnd: index,
        };
      }
    }
  }

  return null;
}

function extractTableBlock(source, tableName) {
  const range = findTableBlockRange(source, tableName);
  if (!range) {
    return null;
  }

  return source.slice(range.bodyStart + 1, range.bodyEnd);
}

function extractScalarField(block, fieldName) {
  const stringMatch = block.match(new RegExp(`(?:\\["${fieldName}"\\]|${fieldName})\\s*=\\s*"([^"]*)"`, "u"));
  if (stringMatch) {
    return stringMatch[1];
  }

  const numberMatch = block.match(new RegExp(`(?:\\["${fieldName}"\\]|${fieldName})\\s*=\\s*(\\d+)`, "u"));
  if (numberMatch) {
    return Number(numberMatch[1]);
  }

  const booleanMatch = block.match(
    new RegExp(`(?:\\["${fieldName}"\\]|${fieldName})\\s*=\\s*(true|false)`, "u")
  );
  if (booleanMatch) {
    return booleanMatch[1] === "true";
  }

  return null;
}

function parseObjectEntries(block, fieldNames) {
  const entries = [];
  const entryPattern = /\["([^"]+)"\]\s*=\s*\{/gu;
  let match;

  while ((match = entryPattern.exec(block)) !== null) {
    const key = match[1];
    const bodyStart = match.index + match[0].length - 1;
    let index = bodyStart;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (; index < block.length; index += 1) {
      const character = block[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === "\\") {
          escaped = true;
          continue;
        }
        if (character === "\"") {
          inString = false;
        }
        continue;
      }

      if (character === "\"") {
        inString = true;
        continue;
      }

      if (character === "{") {
        depth += 1;
        continue;
      }

      if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const body = block.slice(bodyStart + 1, index);
          const entry = { key };
          for (const fieldName of fieldNames) {
            entry[fieldName] = extractScalarField(body, fieldName);
          }
          entries.push(entry);
          entryPattern.lastIndex = index + 1;
          break;
        }
      }
    }
  }

  return entries.filter((entry) => entry.region && entry.realm && entry.characterName);
}

function parseRequestEntries(requestsBlock) {
  return parseObjectEntries(requestsBlock, [
    "region",
    "realm",
    "characterName",
    "queuedAt",
    "lastSeenAt",
    "seenCount",
    "source",
    "unitToken",
    "class",
    "localizedClass",
    "level",
    "itemLevel",
    "assignedRole",
    "applicantID",
    "memberIndex",
  ]);
}

function parseSnapshotEntries(block) {
  return parseObjectEntries(block, [
    "region",
    "realm",
    "characterName",
    "source",
    "unitToken",
    "fullName",
    "class",
    "localizedClass",
    "level",
    "itemLevel",
    "honorLevel",
    "assignedRole",
    "relationship",
    "tank",
    "healer",
    "damage",
    "applicantID",
    "memberIndex",
    "lastSeenAt",
  ]);
}

function parseLnnrankSavedVariables(text) {
  const rootBlock = extractTableBlock(text, "lnnrankDB");
  if (rootBlock == null) {
    return {
      settings: {},
      requests: [],
      lastImportedBuild: null,
    };
  }

  const requestsBlock = extractTableBlock(rootBlock, "requests");
  const settingsBlock = extractTableBlock(rootBlock, "settings");
  const groupMembersBlock = extractTableBlock(rootBlock, "groupMembers");
  const applicantsBlock = extractTableBlock(rootBlock, "applicants");

  return {
    settings: {
      showSearching: settingsBlock == null ? null : extractScalarField(settingsBlock, "showSearching"),
      showInCombat: settingsBlock == null ? null : extractScalarField(settingsBlock, "showInCombat"),
      scanGroupMembers: settingsBlock == null ? null : extractScalarField(settingsBlock, "scanGroupMembers"),
      scanApplicants: settingsBlock == null ? null : extractScalarField(settingsBlock, "scanApplicants"),
    },
    requests: requestsBlock == null ? [] : parseRequestEntries(requestsBlock),
    groupMembers: groupMembersBlock == null ? [] : parseSnapshotEntries(groupMembersBlock),
    applicants: applicantsBlock == null ? [] : parseSnapshotEntries(applicantsBlock),
    lastImportedBuild: extractScalarField(rootBlock, "lastImportedBuild"),
  };
}

function serializeLuaScalar(value) {
  if (typeof value === "string") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "0";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return "nil";
}

function renderRequestsTableBody(entries) {
  const sorted = [...entries].sort((left, right) =>
    String(left.key || "").localeCompare(String(right.key || ""), "en-US")
  );

  if (sorted.length === 0) {
    return "\n";
  }

  const blocks = sorted.map((entry) => {
    const lines = [`["${entry.key}"] = {`];
    for (const fieldName of REQUEST_FIELD_ORDER) {
      if (entry[fieldName] == null) {
        continue;
      }
      lines.push(`["${fieldName}"] = ${serializeLuaScalar(entry[fieldName])},`);
    }
    lines.push("},");
    return lines.map((line) => `  ${line}`).join("\n");
  });

  return `\n${blocks.join("\n")}\n`;
}

function replaceRequestsTableText(text, entries) {
  const range = findTableBlockRange(text, "requests");
  if (!range) {
    return text;
  }

  const before = text.slice(0, range.bodyStart + 1);
  const after = text.slice(range.bodyEnd);
  return `${before}${renderRequestsTableBody(entries)}${after}`;
}

function clearLnnrankSavedVariablesRequestsText(text) {
  return replaceRequestsTableText(text, []);
}

function clearLnnrankSavedVariablesQueue(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parsed = parseLnnrankSavedVariables(source);
  const clearedText = clearLnnrankSavedVariablesRequestsText(source);
  const removed = Array.isArray(parsed.requests) ? parsed.requests.length : 0;
  const changed = clearedText !== source;

  if (changed) {
    fs.writeFileSync(filePath, clearedText, "utf8");
  }

  return {
    filePath,
    cleared: changed,
    removed,
  };
}

function removeLnnrankSavedVariablesQueueEntry(filePath, requestKey) {
  const source = fs.readFileSync(filePath, "utf8");
  const parsed = parseLnnrankSavedVariables(source);
  const nextRequests = (parsed.requests || []).filter((entry) => entry.key !== requestKey);
  const removed = (parsed.requests || []).length - nextRequests.length;
  const updatedText = replaceRequestsTableText(source, nextRequests);

  if (updatedText !== source) {
    fs.writeFileSync(filePath, updatedText, "utf8");
  }

  return {
    filePath,
    removed,
  };
}

module.exports = {
  clearLnnrankSavedVariablesQueue,
  clearLnnrankSavedVariablesRequestsText,
  DEFAULT_WOW_ACCOUNT_ROOT,
  findSavedVariablesFiles,
  parseLnnrankSavedVariables,
  removeLnnrankSavedVariablesQueueEntry,
};
