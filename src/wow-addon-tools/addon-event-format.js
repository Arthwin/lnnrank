"use strict";

const ADDON_TOKEN_PATTERN = "[A-Za-z0-9_:-]";
const ADDON_TEXT_TOKEN_PATTERN = "(?:[A-Za-z0-9_:-]|%[0-9A-Fa-f]{2})";
const ADDON_MEMBER_TOKEN_PATTERN =
  "(?:" +
  `${ADDON_TEXT_TOKEN_PATTERN}{1,96}~${ADDON_TEXT_TOKEN_PATTERN}{1,96}~g\\d{1,10}~\\d{1,3}` +
  `(?:~${ADDON_TOKEN_PATTERN}{1,16}~${ADDON_TOKEN_PATTERN}{1,16})?` +
  ")";

function normalizeAddonTransportText(value) {
  return String(value || "")
    .replace(/\|\|/gu, "|")
    .replace(/\^/gu, "|");
}

function normalizeAddonEventSource(source) {
  const normalized = String(source || "").trim().toLocaleLowerCase("en-US");
  if (!normalized) {
    return null;
  }
  if (normalized === "chatlink") {
    return "chat-link";
  }
  if (normalized === "lfgstatus") {
    return "lfg-status";
  }
  if (normalized === "groupstatus") {
    return "group-status";
  }
  return normalized;
}

function parseIntegerField(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDecimalField(value) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUnixMillisecondsField(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return rawValue.length <= 10 ? parsed * 1000 : parsed;
}

function decodeAddonTextField(value) {
  const text = String(value || "");
  if (!/%[0-9A-Fa-f]{2}/u.test(text)) {
    return text;
  }

  try {
    return decodeURIComponent(text);
  } catch (_error) {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (sequence) => {
      const bytes = sequence.match(/[0-9A-Fa-f]{2}/gu);
      if (!bytes || bytes.length === 0 || typeof Buffer === "undefined") {
        return sequence;
      }
      return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 16))).toString("utf8");
    });
  }
}

function hasAddonField(fields, key) {
  return Object.prototype.hasOwnProperty.call(fields || {}, key);
}

const PAYLOAD_FIELD_PATTERNS = {
  v: /^\d{1,2}/u,
  e: /^[A-Za-z0-9_-]{1,16}/u,
  id: /^[A-Za-z0-9_:=-]{1,32}/u,
  ch: /^[A-Za-z0-9_-]{1,30}/u,
  ss: /^[A-Za-z0-9_-]{0,20}/u,
  pk: /^[A-Za-z0-9_-]{1,24}/u,
  n: /^\d{1,10}/u,
  t: /^\d{10,13}/u,
  rg: /^[A-Za-z0-9_-]{1,8}/u,
  sr: /^[A-Za-z0-9_-]{1,16}/u,
  re: new RegExp(`^${ADDON_TEXT_TOKEN_PATTERN}{1,96}`, "u"),
  nm: new RegExp(`^${ADDON_TEXT_TOKEN_PATTERN}{1,96}`, "u"),
  ai: /^\d{1,10}/u,
  gi: /^\d{1,10}/u,
  mi: /^\d{1,3}/u,
  hb: /^[A-Za-z0-9_-]{1,24}/u,
  ix: /^\d{1,4}/u,
  tt: /^\d{1,4}/u,
  ar: /^[A-Za-z0-9_-]{1,16}/u,
  cl: /^[A-Za-z0-9_-]{1,16}/u,
  il: /^\d{1,4}(?:\.\d{1,2})?/u,
  lv: /^\d{1,3}/u,
  fo: /^[01]/u,
  m: new RegExp(`^(?:_|${ADDON_MEMBER_TOKEN_PATTERN}(?:,${ADDON_MEMBER_TOKEN_PATTERN}){0,31})`, "u"),
};

const COMMON_PAYLOAD_FIELDS = new Set(["v", "e", "id", "ch", "ss", "pk", "n", "t", "rg", "sr"]);
const SEARCH_PAYLOAD_FIELDS = new Set(["re", "nm", "ai", "gi", "mi", "ar", "cl", "il", "lv", "fo"]);
const LFG_STATUS_PAYLOAD_FIELDS = new Set(["hb", "ix", "tt", "m", "re", "nm"]);
const ROSTER_STATUS_EVENT_TYPES = new Set(["lfg_status", "group_status"]);
const MANUAL_SEARCH_EVENT_SOURCES = new Set(["unit", "world", "chat-link"]);

function normalizeAddonFields(fields = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(fields || {})) {
    normalized[key] = String(value || "").trim();
  }
  return normalized;
}

function detectAddonEventType(fields) {
  const source = normalizeAddonEventSource(fields.sr) || "unknown";
  const isLegacyClear = !fields.e && source === "appclear";
  let eventType = String(fields.e || "").trim().toLocaleLowerCase("en-US");
  if (!eventType) {
    eventType = isLegacyClear ? "lfg_status" : fields.hb ? "lfg_status" : "search";
  }
  return {
    eventType,
    source,
    isLegacyClear,
  };
}

function isAddonFieldRemainderAcceptable(key, remainder) {
  const normalizedRemainder = String(remainder || "");
  if (!normalizedRemainder) {
    return true;
  }

  if (/^(?:\.+.*|\s+.*)$/u.test(normalizedRemainder)) {
    return true;
  }

  if (key === "m") {
    return false;
  }

  return false;
}

function isFieldAllowedForCurrentPayload(fields, key) {
  if (COMMON_PAYLOAD_FIELDS.has(key)) {
    return true;
  }

  const { eventType, source } = detectAddonEventType(fields);
  if (eventType === "search") {
    return SEARCH_PAYLOAD_FIELDS.has(key);
  }

  if (ROSTER_STATUS_EVENT_TYPES.has(eventType)) {
    return LFG_STATUS_PAYLOAD_FIELDS.has(key);
  }

  if (source === "appclear") {
    return key === "re" || key === "nm";
  }

  return true;
}

function isCompleteAddonPayloadFields(fields) {
  const normalizedFields = normalizeAddonFields(fields);
  const { eventType, source, isLegacyClear } = detectAddonEventType(normalizedFields);

  if (!normalizedFields.ch || !normalizedFields.rg || !normalizedFields.sr) {
    return false;
  }

  if (parseIntegerField(normalizedFields.n) == null) {
    return false;
  }

  if (normalizedFields.v) {
    if (
      !normalizedFields.e ||
      !normalizedFields.id ||
      !normalizedFields.ss ||
      parseUnixMillisecondsField(normalizedFields.t) == null
    ) {
      return false;
    }
  }

  if (ROSTER_STATUS_EVENT_TYPES.has(eventType)) {
    if (isLegacyClear) {
      return Boolean(normalizedFields.re && normalizedFields.nm);
    }

    if (
      parseUnixMillisecondsField(normalizedFields.hb) == null ||
      parseIntegerField(normalizedFields.ix) == null ||
      parseIntegerField(normalizedFields.tt) == null
    ) {
      return false;
    }

    const batchIndex = parseIntegerField(normalizedFields.ix);
    const batchTotal = parseIntegerField(normalizedFields.tt);
    if (batchIndex === 0 && batchTotal === 0) {
      return true;
    }

    if (normalizedFields.m && normalizedFields.m !== "_") {
      return true;
    }

    return Boolean(normalizedFields.re && normalizedFields.nm);
  }

  if (eventType === "search") {
    return Boolean(normalizedFields.re && normalizedFields.nm);
  }

  if (!normalizedFields.v && source === "appclear") {
    return Boolean(normalizedFields.re && normalizedFields.nm);
  }

  return false;
}

function extractCanonicalPayload(text) {
  const raw = normalizeAddonTransportText(text);
  const startIndex = raw.indexOf("LNNRANK|");
  if (startIndex < 0) {
    return null;
  }

  const segments = raw.slice(startIndex).split("|");
  if (segments[0] !== "LNNRANK") {
    return null;
  }

  const canonicalSegments = ["LNNRANK"];
  const canonicalFields = {};
  for (const segment of segments.slice(1)) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex <= 0) {
      break;
    }

    const key = segment.slice(0, separatorIndex);
    const valuePattern = PAYLOAD_FIELD_PATTERNS[key];
    if (!valuePattern) {
      break;
    }

    if (!isFieldAllowedForCurrentPayload(canonicalFields, key)) {
      break;
    }

    const valueMatch = segment.slice(separatorIndex + 1).match(valuePattern);
    if (!valueMatch) {
      break;
    }

    const remainder = segment.slice(separatorIndex + 1 + valueMatch[0].length);
    if (!isAddonFieldRemainderAcceptable(key, remainder)) {
      return null;
    }

    canonicalSegments.push(`${key}=${valueMatch[0]}`);
    canonicalFields[key] = valueMatch[0];
  }

  if (canonicalSegments.length <= 1 || !isCompleteAddonPayloadFields(canonicalFields)) {
    return null;
  }

  return canonicalSegments.join("|");
}

function extractPayloadTimestampMs(payload) {
  const match = normalizeAddonTransportText(payload).match(/\|t=(\d{10,13})(?:\||$)/u);
  return match ? parseUnixMillisecondsField(match[1]) : null;
}

function parseLfgHeartbeatMemberToken(token) {
  const [
    rawCharacterName = "",
    rawRealm = "",
    third = "",
    fourth = "",
    fifth = "",
    sixth = "",
  ] = String(token || "").split("~", 6);
  const characterName = decodeAddonTextField(rawCharacterName);
  const realm = decodeAddonTextField(rawRealm);
  if (!characterName || !realm) {
    return null;
  }

  let groupID = null;
  let memberIndex = null;
  let className = null;
  let assignedRole = null;

  if (third.startsWith("g")) {
    groupID = parseIntegerField(third.slice(1));
    memberIndex = parseIntegerField(fourth);
    className = fifth || null;
    assignedRole = sixth || null;
  } else {
    memberIndex = parseIntegerField(third);
    className = fourth || null;
    assignedRole = fifth || null;
  }

  return {
    characterName,
    realm,
    groupID,
    memberIndex,
    class: className,
    assignedRole,
  };
}

function buildFallbackEventId(fields, eventType, payload) {
  const sessionId = String(fields.ss || fields.ch || "payload");
  const sequence = parseIntegerField(fields.n) || 0;
  const suffix = payload ? String(payload) : eventType || "event";
  return `${sessionId}:${sequence}:${suffix}`;
}

function parseAddonEventPayload(payload, options = {}) {
  if (typeof payload !== "string") {
    return null;
  }

  const canonicalPayload = extractCanonicalPayload(payload);
  const normalizedPayload = canonicalPayload || normalizeAddonTransportText(payload);
  if (!normalizedPayload.startsWith("LNNRANK|")) {
    return null;
  }

  const fields = {};
  for (const segment of normalizedPayload.split("|").slice(1)) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = segment.slice(0, separatorIndex);
    const value = segment.slice(separatorIndex + 1);
    if (!key) {
      continue;
    }
    fields[key] = value;
  }

  if (!isCompleteAddonPayloadFields(fields)) {
    return null;
  }

  const { eventType, source, isLegacyClear } = detectAddonEventType(fields);

  const sequence = parseIntegerField(fields.n);
  const capturedAtMs =
    parseUnixMillisecondsField(fields.t) ||
    (Number.isFinite(options.fallbackTimestampMs) ? options.fallbackTimestampMs : 0);
  const capturedAtIso = capturedAtMs > 0 ? new Date(capturedAtMs).toISOString() : null;
  const eventId = String(fields.id || "").trim() || buildFallbackEventId(fields, eventType, normalizedPayload);
  const common = {
    eventType,
    eventId,
    payload: normalizedPayload,
    channelName: fields.ch || null,
    sessionId: fields.ss || null,
    playerKey: fields.pk || null,
    sequence,
    capturedAtMs,
    capturedAt: capturedAtIso,
    updatedAt: capturedAtIso,
    region: fields.rg || "us",
    source,
    publisherKey: fields.pk || fields.ch || fields.ss || null,
    publisher: options.publisher || null,
  };

  if (ROSTER_STATUS_EVENT_TYPES.has(eventType)) {
    const heartbeatId = String(fields.hb || "").trim() || null;
    const batchIndex = parseIntegerField(fields.ix) ?? (isLegacyClear ? 0 : null);
    const batchTotal = parseIntegerField(fields.tt) ?? (isLegacyClear ? 0 : null);
    const groupID = parseIntegerField(fields.gi) ?? fields.gi ?? null;
    let members = [];

    if (isLegacyClear) {
      members = [];
    } else if (fields.m && fields.m !== "_") {
      members = String(fields.m)
        .split(",")
        .map(parseLfgHeartbeatMemberToken)
        .filter(Boolean);
    } else if (fields.nm && fields.re) {
      members = [
        {
          characterName: decodeAddonTextField(fields.nm),
          realm: decodeAddonTextField(fields.re),
          memberIndex: parseIntegerField(fields.mi),
          class: fields.cl || null,
          assignedRole: fields.ar || null,
        },
      ];
    }

    const firstMember = members[0] || null;
    return {
      ...common,
      heartbeatId,
      batchIndex,
      batchTotal,
      groupID,
      members,
      realm: firstMember ? firstMember.realm : fields.re ? decodeAddonTextField(fields.re) : null,
      characterName: firstMember ? firstMember.characterName : fields.nm ? decodeAddonTextField(fields.nm) : null,
      memberIndex: firstMember ? firstMember.memberIndex : parseIntegerField(fields.mi),
      class: firstMember ? firstMember.class : fields.cl || null,
      assignedRole: firstMember ? firstMember.assignedRole : fields.ar || null,
      itemLevel: parseDecimalField(fields.il),
      level: parseIntegerField(fields.lv),
    };
  }

  if (!fields.re || !fields.nm) {
    return null;
  }

  const forceRefresh = fields.fo === "1" || MANUAL_SEARCH_EVENT_SOURCES.has(source);
  return {
    ...common,
    realm: decodeAddonTextField(fields.re),
    characterName: decodeAddonTextField(fields.nm),
    applicantID: parseIntegerField(fields.ai),
    groupID: parseIntegerField(fields.gi) ?? fields.gi ?? null,
    memberIndex: parseIntegerField(fields.mi),
    assignedRole: fields.ar || null,
    class: fields.cl || null,
    itemLevel: parseDecimalField(fields.il),
    level: parseIntegerField(fields.lv),
    force: forceRefresh,
    forceRefresh,
  };
}

function compareAddonEvents(left, right) {
  const leftCapturedAtMs = Number((left && left.capturedAtMs) || 0);
  const rightCapturedAtMs = Number((right && right.capturedAtMs) || 0);
  if (leftCapturedAtMs !== rightCapturedAtMs) {
    return leftCapturedAtMs - rightCapturedAtMs;
  }

  const leftSequence = Number((left && left.sequence) || 0);
  const rightSequence = Number((right && right.sequence) || 0);
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return String((left && left.eventId) || (left && left.payload) || "").localeCompare(
    String((right && right.eventId) || (right && right.payload) || ""),
    "en-US"
  );
}

function buildAddonEventIdentity(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  return event.eventId || event.payload || null;
}

function buildAddonEventPreview(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  if (event.payload) {
    return event.payload;
  }
  if (ROSTER_STATUS_EVENT_TYPES.has(event.eventType)) {
    const memberLabel =
      Array.isArray(event.members) && event.members.length > 0
        ? event.members
            .map((member) => `${member.characterName}-${member.realm}`)
            .join(",")
        : "empty";
    return `LNNRANK|e=${event.eventType}|sr=${event.source || "status"}|hb=${event.heartbeatId || "manual"}|m=${memberLabel}`;
  }
  return `LNNRANK|e=${event.eventType || "search"}|sr=${event.source || "manual"}|re=${event.realm || ""}|nm=${
    event.characterName || ""
  }`;
}

module.exports = {
  buildAddonEventIdentity,
  buildAddonEventPreview,
  compareAddonEvents,
  extractCanonicalPayload,
  extractPayloadTimestampMs,
  normalizeAddonTransportText,
  normalizeAddonEventSource,
  parseAddonEventPayload,
};
