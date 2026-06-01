"use strict";

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

const PAYLOAD_FIELD_PATTERNS = {
  v: /^\d{1,2}/u,
  e: /^[A-Za-z0-9_-]{1,16}/u,
  id: /^[A-Za-z0-9_:=-]{1,32}/u,
  ch: /^[A-Za-z0-9_:=.]{1,30}/u,
  ss: /^[A-Za-z0-9_:=.]{0,20}/u,
  pk: /^[A-Za-z0-9_:=.]{1,24}/u,
  n: /^\d{1,10}/u,
  t: /^\d{10,13}/u,
  rg: /^[A-Za-z0-9_:=.]{1,8}/u,
  sr: /^[A-Za-z0-9_-]{1,16}/u,
  re: /^[A-Za-z0-9_:=.]{1,32}/u,
  nm: /^[A-Za-z0-9_:=.]{1,32}/u,
  ai: /^\d{1,10}/u,
  gi: /^\d{1,10}/u,
  mi: /^\d{1,3}/u,
  hb: /^[A-Za-z0-9_:=.-]{1,24}/u,
  ix: /^\d{1,4}/u,
  tt: /^\d{1,4}/u,
  ar: /^[A-Za-z0-9_:=.-]{1,16}/u,
  cl: /^[A-Za-z0-9_:=.-]{1,16}/u,
  il: /^\d{1,4}(?:\.\d{1,2})?/u,
  lv: /^\d{1,3}/u,
  m: /^(?:_|[A-Za-z0-9_:=.,~-]{1,180})/u,
};

function extractCanonicalPayload(text) {
  const raw = String(text || "");
  const startIndex = raw.indexOf("LNNRANK|");
  if (startIndex < 0) {
    return null;
  }

  const segments = raw.slice(startIndex).split("|");
  if (segments[0] !== "LNNRANK") {
    return null;
  }

  const canonicalSegments = ["LNNRANK"];
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

    const valueMatch = segment.slice(separatorIndex + 1).match(valuePattern);
    if (!valueMatch) {
      break;
    }

    canonicalSegments.push(`${key}=${valueMatch[0]}`);
  }

  return canonicalSegments.length > 1 ? canonicalSegments.join("|") : null;
}

function extractPayloadTimestampMs(payload) {
  const match = String(payload || "").match(/\|t=(\d{10,13})(?:\||$)/u);
  return match ? parseUnixMillisecondsField(match[1]) : null;
}

function parseLfgHeartbeatMemberToken(token) {
  const [characterName = "", realm = "", memberIndex = "", className = "", assignedRole = ""] = String(
    token || ""
  ).split("~", 5);
  if (!characterName || !realm) {
    return null;
  }

  return {
    characterName,
    realm,
    memberIndex: parseIntegerField(memberIndex),
    class: className || null,
    assignedRole: assignedRole || null,
  };
}

function buildFallbackEventId(fields, eventType, payload) {
  const sessionId = String(fields.ss || fields.ch || "payload");
  const sequence = parseIntegerField(fields.n) || 0;
  const suffix = payload ? String(payload) : eventType || "event";
  return `${sessionId}:${sequence}:${suffix}`;
}

function parseAddonEventPayload(payload, options = {}) {
  if (typeof payload !== "string" || !payload.startsWith("LNNRANK|")) {
    return null;
  }

  const fields = {};
  for (const segment of payload.split("|").slice(1)) {
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

  const source = normalizeAddonEventSource(fields.sr) || "unknown";
  const isLegacyClear = !fields.e && source === "appclear";
  let eventType = String(fields.e || "").trim().toLocaleLowerCase("en-US");
  if (!eventType) {
    eventType = isLegacyClear ? "lfg_status" : fields.hb ? "lfg_status" : "search";
  }

  const sequence = parseIntegerField(fields.n);
  const capturedAtMs =
    parseUnixMillisecondsField(fields.t) ||
    (Number.isFinite(options.fallbackTimestampMs) ? options.fallbackTimestampMs : 0);
  const capturedAtIso = capturedAtMs > 0 ? new Date(capturedAtMs).toISOString() : null;
  const eventId = String(fields.id || "").trim() || buildFallbackEventId(fields, eventType, payload);
  const common = {
    eventType,
    eventId,
    payload,
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

  if (eventType === "lfg_status") {
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
          characterName: fields.nm,
          realm: fields.re,
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
      realm: firstMember ? firstMember.realm : fields.re || null,
      characterName: firstMember ? firstMember.characterName : fields.nm || null,
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

  return {
    ...common,
    realm: fields.re,
    characterName: fields.nm,
    applicantID: parseIntegerField(fields.ai),
    groupID: parseIntegerField(fields.gi) ?? fields.gi ?? null,
    memberIndex: parseIntegerField(fields.mi),
    assignedRole: fields.ar || null,
    class: fields.cl || null,
    itemLevel: parseDecimalField(fields.il),
    level: parseIntegerField(fields.lv),
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
  if (event.eventType === "lfg_status") {
    const memberLabel =
      Array.isArray(event.members) && event.members.length > 0
        ? event.members
            .map((member) => `${member.characterName}-${member.realm}`)
            .join(",")
        : "empty";
    return `LNNRANK|e=lfg_status|sr=${event.source || "lfg-status"}|hb=${event.heartbeatId || "manual"}|m=${memberLabel}`;
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
  normalizeAddonEventSource,
  parseAddonEventPayload,
};
