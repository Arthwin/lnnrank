local addon = _G.lnnrank

if not addon then
    return
end

local PAYLOAD_PREFIX = "LNNRANK"
local EVENT_BATCH_LIMIT = 300
local MAX_PASSIVE_PAYLOAD_LENGTH = 230

local function sanitizeSegment(value, maxLength)
    local text = tostring(value or "")
    text = text:gsub("[%c|]", "")
    text = text:gsub("%s+", "_")
    text = text:gsub("[^%w_:=%.,~-]", "")
    if maxLength and #text > maxLength then
        text = text:sub(1, maxLength)
    end
    return text
end

local function getNowUnix()
    if type(time) == "function" then
        return time()
    end
    return 0
end

local function getNowUnixMs()
    local seconds = getNowUnix()
    local preciseSeconds = type(GetTimePreciseSec) == "function" and GetTimePreciseSec() or nil
    if type(preciseSeconds) == "number" then
        local fractionalMilliseconds = math.floor((preciseSeconds - math.floor(preciseSeconds)) * 1000)
        return (seconds * 1000) + fractionalMilliseconds
    end
    return seconds * 1000
end

local function getPlayerKey()
    if type(addon.GetPassivePlayerKey) == "function" then
        return addon.GetPassivePlayerKey()
    end
    local playerName = type(UnitName) == "function" and UnitName("player") or "player"
    return sanitizeSegment(playerName, 24):lower()
end

local function getSessionId()
    if type(addon.GetPassiveSessionId) == "function" then
        return addon.GetPassiveSessionId()
    end
    return string.format("%s%d", sanitizeSegment(getPlayerKey(), 10), getNowUnix())
end

local function getChannelName()
    if type(addon.GetPassiveChannelName) == "function" then
        return addon.GetPassiveChannelName()
    end
    return string.format("lnnrank%s", getPlayerKey()):sub(1, 30)
end

local function shouldPublishAnyRelay()
    return addon.IsSavedEventBatchEnabled() or
        (type(addon.IsPassiveChannelEnabled) == "function" and addon.IsPassiveChannelEnabled())
end

local function getEventBridgeTable()
    local db = addon.GetDb()
    if type(db.eventBridge) ~= "table" then
        db.eventBridge = {}
    end
    if type(db.eventBridge.events) ~= "table" then
        db.eventBridge.events = {}
    end
    if type(db.eventBridge.sequence) ~= "number" then
        db.eventBridge.sequence = 0
    end
    return db.eventBridge
end

local function nextEventSequence()
    local bridge = getEventBridgeTable()
    bridge.sequence = bridge.sequence + 1
    bridge.updatedAt = getNowUnix()
    return bridge.sequence
end

local function buildEventId(sessionId, sequence)
    return string.format("%s-%d", sanitizeSegment(sessionId, 20), sequence)
end

local function buildBaseEvent(eventType, source, region)
    local sessionId = getSessionId()
    local sequence = nextEventSequence()
    local capturedAtMs = getNowUnixMs()
    return {
        eventType = eventType,
        source = source,
        region = region or (type(addon.GetCurrentRegionSlug) == "function" and addon.GetCurrentRegionSlug() or "us"),
        sessionId = sessionId,
        channelName = getChannelName(),
        sequence = sequence,
        capturedAtMs = capturedAtMs,
        eventId = buildEventId(sessionId, sequence),
    }
end

local function buildSearchEvent(lookup)
    local event = buildBaseEvent("search", lookup.source or "manual", lookup.region)
    event.realm = lookup.realm
    event.characterName = lookup.characterName
    event.groupID = lookup.groupID
    event.memberIndex = lookup.memberIndex
    event.assignedRole = lookup.assignedRole
    event.class = lookup.class
    event.itemLevel = lookup.itemLevel
    event.level = lookup.level
    return event
end

local function buildLfgStatusEvent(region, heartbeatId, batchIndex, batchTotal, member)
    local event = buildBaseEvent("lfg_status", "lfg-status", region)
    event.heartbeatId = heartbeatId
    event.batchIndex = batchIndex
    event.batchTotal = batchTotal
    if type(member) == "table" and type(member[1]) == "table" then
        event.members = member
    elseif type(member) == "table" then
        event.members = {member}
        event.groupID = member.groupID
        event.realm = member.realm
        event.characterName = member.characterName
        event.memberIndex = member.memberIndex
        event.assignedRole = member.assignedRole
        event.class = member.class
        event.itemLevel = member.itemLevel
        event.level = member.level
    end
    return event
end

local function buildHeartbeatMemberToken(member)
    if type(member) ~= "table" or not member.characterName or not member.realm then
        return nil
    end

    return table.concat({
        sanitizeSegment(member.characterName, 32),
        sanitizeSegment(member.realm, 32),
        "g" .. sanitizeSegment(member.groupID or 0, 10),
        sanitizeSegment(member.memberIndex or 0, 3),
    }, "~")
end

local function cloneArray(values)
    local result = {}
    if type(values) ~= "table" then
        return result
    end

    for index = 1, #values do
        result[index] = values[index]
    end

    return result
end

local function estimateLfgStatusPayloadLength(region, heartbeatId, batchIndex, batchTotal, members)
    local bridge = getEventBridgeTable()
    local sequence = (type(bridge.sequence) == "number" and bridge.sequence or 0) + 1
    local sessionId = sanitizeSegment(getSessionId(), 20)
    local channelName = sanitizeSegment(getChannelName(), 30)
    local sequenceText = tostring(sequence)
    local eventId = sanitizeSegment(buildEventId(sessionId, sequence), 32)
    local timestampText = tostring(getNowUnixMs())
    local heartbeatText = sanitizeSegment(heartbeatId, 24)
    local regionText = sanitizeSegment(region or "us", 8)
    local batchIndexText = tostring(batchIndex or 0)
    local batchTotalText = tostring(batchTotal or 0)

    local length = #PAYLOAD_PREFIX
    local function addSegment(key, value)
        if value == nil or value == "" then
            return
        end
        length = length + 1 + #key + 1 + #tostring(value)
    end

    addSegment("v", "2")
    addSegment("e", "lfg_status")
    addSegment("id", eventId)
    addSegment("ch", channelName)
    addSegment("ss", sessionId)
    addSegment("n", sequenceText)
    addSegment("t", timestampText)
    addSegment("rg", regionText)
    addSegment("sr", "lfg-status")
    addSegment("hb", heartbeatText)
    addSegment("ix", batchIndexText)
    addSegment("tt", batchTotalText)

    local memberLength = 0
    if type(members) == "table" and #members > 0 then
        for index = 1, #members do
            local token = buildHeartbeatMemberToken(members[index])
            if token and token ~= "" then
                if memberLength > 0 then
                    memberLength = memberLength + 1
                end
                memberLength = memberLength + #token
            end
        end
        addSegment("m", memberLength > 0 and string.rep("x", memberLength) or "_")
    else
        addSegment("m", "_")
    end

    return length
end

local function encodeEventPayload(event)
    local segments = {
        PAYLOAD_PREFIX,
        "v=2",
        "e=" .. sanitizeSegment(event.eventType, 16),
        "id=" .. sanitizeSegment(event.eventId, 32),
        "ch=" .. sanitizeSegment(event.channelName, 30),
        "ss=" .. sanitizeSegment(event.sessionId, 20),
        "n=" .. tostring(event.sequence),
        "t=" .. tostring(event.capturedAtMs),
        "rg=" .. sanitizeSegment(event.region, 8),
        "sr=" .. sanitizeSegment(event.source, 16),
    }

    if event.eventType == "search" then
        table.insert(segments, "re=" .. sanitizeSegment(event.realm, 32))
        table.insert(segments, "nm=" .. sanitizeSegment(event.characterName, 32))
    elseif event.eventType == "lfg_status" then
        table.insert(segments, "hb=" .. sanitizeSegment(event.heartbeatId, 24))
        table.insert(segments, "ix=" .. tostring(event.batchIndex or 0))
        table.insert(segments, "tt=" .. tostring(event.batchTotal or 0))
        if type(event.members) == "table" and #event.members > 0 then
            local memberTokens = {}
            for index = 1, #event.members do
                local token = buildHeartbeatMemberToken(event.members[index])
                if token and token ~= "" then
                    table.insert(memberTokens, token)
                end
            end
            table.insert(segments, "m=" .. (#memberTokens > 0 and table.concat(memberTokens, ",") or "_"))
        elseif event.realm then
            table.insert(segments, "re=" .. sanitizeSegment(event.realm, 32))
            if event.characterName then
                table.insert(segments, "nm=" .. sanitizeSegment(event.characterName, 32))
            end
        end
    end

    if event.groupID ~= nil then
        table.insert(segments, "gi=" .. sanitizeSegment(event.groupID, 10))
    end
    if event.memberIndex ~= nil then
        table.insert(segments, "mi=" .. sanitizeSegment(event.memberIndex, 3))
    end
    if event.assignedRole ~= nil then
        table.insert(segments, "ar=" .. sanitizeSegment(event.assignedRole, 16))
    end
    if event.class ~= nil then
        table.insert(segments, "cl=" .. sanitizeSegment(event.class, 16))
    end
    if type(event.itemLevel) == "number" then
        table.insert(segments, "il=" .. sanitizeSegment(string.format("%.1f", event.itemLevel), 8))
    end
    if event.level ~= nil then
        table.insert(segments, "lv=" .. sanitizeSegment(event.level, 3))
    end

    return table.concat(segments, "|")
end

local function pruneEventBatch(bridge)
    local keys = {}
    for key, value in pairs(bridge.events) do
        if type(value) == "table" and type(value.sequence) == "number" then
            table.insert(keys, key)
        end
    end

    table.sort(keys, function(left, right)
        local leftSequence = type(bridge.events[left]) == "table" and bridge.events[left].sequence or 0
        local rightSequence = type(bridge.events[right]) == "table" and bridge.events[right].sequence or 0
        return leftSequence > rightSequence
    end)

    for index = EVENT_BATCH_LIMIT + 1, #keys do
        bridge.events[keys[index]] = nil
    end
end

local function clearSavedLfgStatusEvents()
    local bridge = getEventBridgeTable()
    for key, value in pairs(bridge.events) do
        if type(value) == "table" and value.eventType == "lfg_status" then
            bridge.events[key] = nil
        end
    end
end

local function appendSavedBatchEvent(event, payload)
    if not addon.IsSavedEventBatchEnabled() then
        return
    end

    local bridge = getEventBridgeTable()
    local eventKey = tostring(event.sequence)
    bridge.events[eventKey] = {
        sequence = event.sequence,
        publishedAt = getNowUnix(),
        eventType = event.eventType,
        eventId = event.eventId,
        payload = payload,
        source = event.source,
        region = event.region,
        realm = event.realm,
        characterName = event.characterName,
        heartbeatId = event.heartbeatId,
        batchIndex = event.batchIndex,
        batchTotal = event.batchTotal,
        groupID = event.groupID,
        memberIndex = event.memberIndex,
    }
    bridge.updatedAt = getNowUnix()
    pruneEventBatch(bridge)
end

local function publishEvent(event)
    if type(event) ~= "table" or not shouldPublishAnyRelay() then
        return false
    end

    local payload = encodeEventPayload(event)
    if #payload > MAX_PASSIVE_PAYLOAD_LENGTH then
        return false
    end
    appendSavedBatchEvent(event, payload)
    if type(addon.PublishPassivePayload) == "function" and type(addon.IsPassiveChannelEnabled) == "function" and
        addon.IsPassiveChannelEnabled() then
        addon.PublishPassivePayload(payload, event)
    end
    if type(addon.NotifyStateChanged) == "function" then
        addon.NotifyStateChanged()
    end
    return true
end

function addon.IsSavedEventBatchEnabled()
    return addon.GetDb().settings.savedEventBatchEnabled ~= false
end

function addon.SetSavedEventBatchEnabled(enabled)
    addon.GetDb().settings.savedEventBatchEnabled = enabled == true
    if type(addon.NotifyStateChanged) == "function" then
        addon.NotifyStateChanged()
    end
end

function addon.ResetSavedEventBatchForSession()
    local bridge = getEventBridgeTable()
    bridge.events = {}
    bridge.updatedAt = getNowUnix()
end

function addon.PublishSearchEvent(lookup)
    if addon.IsSuppressedInCurrentInstance() or type(lookup) ~= "table" then
        return false
    end

    if not lookup.region or not lookup.realm or not lookup.characterName then
        return false
    end

    return publishEvent(buildSearchEvent(lookup))
end

function addon.PublishLfgStatusSnapshot(region, members)
    if addon.IsSuppressedInCurrentInstance() then
        return false
    end

    local memberEntries = type(members) == "table" and members or {}
    local heartbeatId = tostring(getNowUnixMs())

    if addon.IsSavedEventBatchEnabled() then
        clearSavedLfgStatusEvents()
    end

    if #memberEntries <= 0 then
        return publishEvent(buildLfgStatusEvent(region, heartbeatId, 0, 0, nil))
    end

    local chunks = {}
    local currentChunk = {}
    for index = 1, #memberEntries do
        local candidateChunk = cloneArray(currentChunk)
        table.insert(candidateChunk, memberEntries[index])
        local candidatePayloadLength = estimateLfgStatusPayloadLength(region, heartbeatId, 1, 1, candidateChunk)
        if candidatePayloadLength > MAX_PASSIVE_PAYLOAD_LENGTH and #currentChunk > 0 then
            table.insert(chunks, currentChunk)
            currentChunk = {memberEntries[index]}
        else
            currentChunk = candidateChunk
        end
    end

    if #currentChunk > 0 then
        table.insert(chunks, currentChunk)
    end

    for index = 1, #chunks do
        publishEvent(buildLfgStatusEvent(region, heartbeatId, index, #chunks, chunks[index]))
    end

    return true
end
