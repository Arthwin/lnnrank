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
  "groupID",
  "memberIndex",
];

function createEmptyParsedSavedVariables() {
  return {
    settings: {},
    requests: [],
    groupMembers: [],
    applicants: [],
    eventBatch: null,
    passiveBridge: null,
    lastImportedBuild: null,
  };
}

function renderEmptySavedVariablesFile() {
  return [
    "lnnrankDB = {",
    '  ["settings"] = {},',
    '  ["requests"] = {},',
    '  ["groupMembers"] = {},',
    '  ["applicants"] = {},',
    '  ["eventBridge"] = {',
    '    ["sequence"] = 0,',
    '    ["events"] = {},',
    "  },",
    '  ["passiveBridge"] = {},',
    "}",
    "",
  ].join("\n");
}

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

function pickLatestSavedVariablesFile(accountRootDir = DEFAULT_WOW_ACCOUNT_ROOT) {
  const files = findSavedVariablesFiles(accountRootDir);
  return files[0] || null;
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

function parseKeyedTableEntries(block, fieldNames) {
  const entries = [];
  const entryPattern = /\[(?:"([^"]+)"|(\d+))\]\s*=\s*\{/gu;
  let match;

  while ((match = entryPattern.exec(block)) !== null) {
    const key = match[1] ?? match[2];
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

  return entries;
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
    "groupID",
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
    "groupID",
    "memberIndex",
    "lastSeenAt",
  ]);
}

function parsePassiveBridge(block) {
  if (block == null) {
    return null;
  }

  const messageLogBlock = extractTableBlock(block, "messageLog");

  const passiveBridge = {
    enabled: extractScalarField(block, "enabled"),
    joined: extractScalarField(block, "joined"),
    channelName: extractScalarField(block, "channelName"),
    playerKey: extractScalarField(block, "playerKey"),
    playerGuid: extractScalarField(block, "playerGuid"),
    playerName: extractScalarField(block, "playerName"),
    realm: extractScalarField(block, "realm"),
    region: extractScalarField(block, "region"),
    sessionId: extractScalarField(block, "sessionId"),
    sequence: extractScalarField(block, "sequence"),
    lastPublishedAt: extractScalarField(block, "lastPublishedAt"),
    lastPublishedPayload: extractScalarField(block, "lastPublishedPayload"),
    messageCount: extractScalarField(block, "messageCount"),
    messageLog:
      messageLogBlock == null
        ? []
        : parseKeyedTableEntries(messageLogBlock, [
            "sequence",
            "publishedAt",
            "payload",
            "region",
            "realm",
            "characterName",
            "source",
          ]),
    updatedAt: extractScalarField(block, "updatedAt"),
  };

  const hasScalarFields = Object.entries(passiveBridge).some(
    ([key, value]) => key !== "messageLog" && value != null
  );
  return hasScalarFields || passiveBridge.messageLog.length > 0 ? passiveBridge : null;
}

function parseEventBatch(block) {
  if (block == null) {
    return null;
  }

  const eventsBlock = extractTableBlock(block, "events");
  const eventBatch = {
    sequence: extractScalarField(block, "sequence"),
    updatedAt: extractScalarField(block, "updatedAt"),
    events:
      eventsBlock == null
        ? []
        : parseKeyedTableEntries(eventsBlock, [
            "sequence",
            "publishedAt",
            "eventType",
            "eventId",
            "payload",
            "source",
            "region",
            "realm",
            "characterName",
            "heartbeatId",
            "batchIndex",
            "batchTotal",
            "groupID",
            "memberIndex",
          ]).sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0)),
  };

  const hasScalarFields = Object.entries(eventBatch).some(([key, value]) => key !== "events" && value != null);
  return hasScalarFields || eventBatch.events.length > 0 ? eventBatch : null;
}

function parseLnnrankSavedVariables(text) {
  const rootBlock = extractTableBlock(text, "lnnrankDB");
  if (rootBlock == null) {
    return createEmptyParsedSavedVariables();
  }

  const requestsBlock = extractTableBlock(rootBlock, "requests");
  const settingsBlock = extractTableBlock(rootBlock, "settings");
  const groupMembersBlock = extractTableBlock(rootBlock, "groupMembers");
  const applicantsBlock = extractTableBlock(rootBlock, "applicants");
  const eventBatchBlock = extractTableBlock(rootBlock, "eventBridge");
  const passiveBridgeBlock = extractTableBlock(rootBlock, "passiveBridge");

  return {
    settings: {
      showSearching: settingsBlock == null ? null : extractScalarField(settingsBlock, "showSearching"),
      showInCombat: settingsBlock == null ? null : extractScalarField(settingsBlock, "showInCombat"),
      scanGroupMembers: settingsBlock == null ? null : extractScalarField(settingsBlock, "scanGroupMembers"),
      scanApplicants: settingsBlock == null ? null : extractScalarField(settingsBlock, "scanApplicants"),
      savedEventBatchEnabled:
        settingsBlock == null ? null : extractScalarField(settingsBlock, "savedEventBatchEnabled"),
      passiveChannelEnabled: settingsBlock == null ? null : extractScalarField(settingsBlock, "passiveChannelEnabled"),
    },
    requests: requestsBlock == null ? [] : parseRequestEntries(requestsBlock),
    groupMembers: groupMembersBlock == null ? [] : parseSnapshotEntries(groupMembersBlock),
    applicants: applicantsBlock == null ? [] : parseSnapshotEntries(applicantsBlock),
    eventBatch: parseEventBatch(eventBatchBlock),
    passiveBridge: parsePassiveBridge(passiveBridgeBlock),
    lastImportedBuild: extractScalarField(rootBlock, "lastImportedBuild"),
  };
}

function loadSavedVariablesFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      file: null,
      parsed: createEmptyParsedSavedVariables(),
    };
  }

  return {
    file: filePath,
    parsed: parseLnnrankSavedVariables(fs.readFileSync(filePath, "utf8")),
  };
}

function loadSavedVariablesSnapshot(accountRootDir = DEFAULT_WOW_ACCOUNT_ROOT) {
  const latest = pickLatestSavedVariablesFile(accountRootDir);
  if (!latest) {
    return {
      file: null,
      lastModifiedMs: null,
      parsed: createEmptyParsedSavedVariables(),
    };
  }

  return {
    file: latest.path,
    lastModifiedMs: latest.lastModifiedMs,
    parsed: parseLnnrankSavedVariables(fs.readFileSync(latest.path, "utf8")),
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

function replaceApplicantsTableText(text, entries) {
  const range = findTableBlockRange(text, "applicants");
  if (!range) {
    return text;
  }

  const before = text.slice(0, range.bodyStart + 1);
  const after = text.slice(range.bodyEnd);
  return `${before}${renderRequestsTableBody(entries)}${after}`;
}

function clearLnnrankSavedVariablesApplicantsText(text) {
  return replaceApplicantsTableText(text, []);
}

function replaceEventBatchEventsTableText(text, entries) {
  const eventBridgeRange = findTableBlockRange(text, "eventBridge");
  if (!eventBridgeRange) {
    return text;
  }

  const rootBlock = text.slice(eventBridgeRange.bodyStart + 1, eventBridgeRange.bodyEnd);
  const eventsRange = findTableBlockRange(rootBlock, "events");
  if (!eventsRange) {
    return text;
  }

  const absoluteBodyStart = eventBridgeRange.bodyStart + 1 + eventsRange.bodyStart;
  const absoluteBodyEnd = eventBridgeRange.bodyStart + 1 + eventsRange.bodyEnd;
  const before = text.slice(0, absoluteBodyStart + 1);
  const after = text.slice(absoluteBodyEnd);
  return `${before}${renderRequestsTableBody(entries)}${after}`;
}

function clearLnnrankSavedVariablesEventBatchText(text) {
  return replaceEventBatchEventsTableText(text, []);
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

function clearLnnrankSavedVariablesApplicants(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parsed = parseLnnrankSavedVariables(source);
  const clearedText = clearLnnrankSavedVariablesApplicantsText(source);
  const removed = Array.isArray(parsed.applicants) ? parsed.applicants.length : 0;
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

function clearLnnrankSavedVariablesEventBatch(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parsed = parseLnnrankSavedVariables(source);
  const clearedText = clearLnnrankSavedVariablesEventBatchText(source);
  const removed = parsed.eventBatch && Array.isArray(parsed.eventBatch.events) ? parsed.eventBatch.events.length : 0;
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

module.exports = {
  clearLnnrankSavedVariablesApplicants,
  clearLnnrankSavedVariablesApplicantsText,
  clearLnnrankSavedVariablesEventBatch,
  clearLnnrankSavedVariablesEventBatchText,
  clearLnnrankSavedVariablesQueue,
  clearLnnrankSavedVariablesRequestsText,
  createEmptyParsedSavedVariables,
  DEFAULT_WOW_ACCOUNT_ROOT,
  findSavedVariablesFiles,
  loadSavedVariablesFile,
  loadSavedVariablesSnapshot,
  parseLnnrankSavedVariables,
  pickLatestSavedVariablesFile,
  renderEmptySavedVariablesFile,
  removeLnnrankSavedVariablesQueueEntry,
};
