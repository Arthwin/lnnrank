local addon = _G.lnnrank

if not addon then
    return
end

local PAYLOAD_PREFIX = "LNNRANK|"
local FILTER_EVENTS = {
    "CHAT_MSG_CHANNEL",
    "CHAT_MSG_CHANNEL_JOIN",
    "CHAT_MSG_CHANNEL_LEAVE",
    "CHAT_MSG_CHANNEL_NOTICE",
    "CHAT_MSG_CHANNEL_NOTICE_USER",
}

local filtersInstalled = false
local lastPublishedAt = nil
local lastPublishedPayload = nil
local passiveChannelName = nil
local passivePlayerKey = nil
local passiveSessionId = nil
local publishSequence = 0
local PASSIVE_LOG_LIMIT = 40

local function sanitizeSegment(value, maxLength)
    local text = tostring(value or "")
    text = text:gsub("[%c|]", "")
    text = text:gsub("%s+", "_")
    text = text:gsub("[^%w_:=%.]", "")
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

local function buildPassiveSessionId()
    local guid = sanitizeSegment(UnitGUID("player") or "noguid", 20):lower()
    local now = tostring(getNowUnix())
    return string.format("%s%s", guid:sub(-6), now:sub(-4))
end

local function buildPassivePlayerKey()
    if passivePlayerKey then
        return passivePlayerKey
    end

    local guid = type(UnitGUID) == "function" and UnitGUID("player") or nil
    local guidSuffix = type(guid) == "string" and guid:match("Player%-%x+%-(%x+)$") or nil
    local fallbackName = type(UnitName) == "function" and UnitName("player") or "player"
    local fallbackRealm = type(GetRealmName) == "function" and GetRealmName() or "realm"
    local rawKey = guidSuffix or guid or string.format("%s_%s", fallbackRealm or "realm", fallbackName or "player")

    passivePlayerKey = sanitizeSegment(rawKey, 24):lower()
    if passivePlayerKey == "" then
        passivePlayerKey = "unknown"
    end

    return passivePlayerKey
end

local function buildPassiveChannelName()
    return string.format("lnnrank%s", buildPassivePlayerKey()):sub(1, 30)
end

local function hideChannelEverywhere(channelName)
    if not channelName or type(ChatFrame_RemoveChannel) ~= "function" then
        return
    end

    for index = 1, NUM_CHAT_WINDOWS or 10 do
        local chatFrame = _G["ChatFrame" .. index]
        if chatFrame then
            pcall(ChatFrame_RemoveChannel, chatFrame, channelName)
        end
    end
end

local function passiveChannelFilter(_, _, message, ...)
    if not passiveChannelName then
        return false
    end

    if type(message) == "string" then
        if message:find(PAYLOAD_PREFIX, 1, true) then
            return true
        end
        if message:find(passiveChannelName, 1, true) then
            return true
        end
    end

    for index = 1, select("#", ...) do
        local value = select(index, ...)
        if type(value) == "string" and value == passiveChannelName then
            return true
        end
    end

    return false
end

local function ensureFiltersInstalled()
    if filtersInstalled or type(ChatFrame_AddMessageEventFilter) ~= "function" then
        return
    end

    filtersInstalled = true
    for _, eventName in ipairs(FILTER_EVENTS) do
        ChatFrame_AddMessageEventFilter(eventName, passiveChannelFilter)
    end
end

local function getPassiveChannelNumber(channelName)
    if type(GetChannelName) ~= "function" then
        return nil
    end

    local channelNumber = select(1, GetChannelName(channelName))
    if type(channelNumber) == "number" and channelNumber > 0 then
        return channelNumber
    end

    return nil
end

local function leaveStalePassiveChannels(activeChannelName)
    if type(GetChannelList) ~= "function" or type(LeaveChannelByName) ~= "function" then
        return
    end

    local channelList = {GetChannelList()}
    for index = 1, #channelList, 3 do
        local channelName = channelList[index + 1]
        if type(channelName) == "string" and channelName:match("^lnnrank") and channelName ~= activeChannelName then
            pcall(LeaveChannelByName, channelName)
        end
    end
end

local function ensurePassiveChannel()
    if not addon.IsPassiveChannelEnabled() then
        return nil
    end

    ensureFiltersInstalled()

    if not passiveChannelName then
        passiveChannelName = buildPassiveChannelName()
    end

    leaveStalePassiveChannels(passiveChannelName)

    local channelNumber = getPassiveChannelNumber(passiveChannelName)
    if channelNumber then
        hideChannelEverywhere(passiveChannelName)
        return channelNumber
    end

    if type(JoinTemporaryChannel) == "function" then
        local frameId = DEFAULT_CHAT_FRAME and type(DEFAULT_CHAT_FRAME.GetID) == "function"
            and DEFAULT_CHAT_FRAME:GetID()
            or 1
        pcall(JoinTemporaryChannel, passiveChannelName, nil, frameId, false)
    end

    channelNumber = getPassiveChannelNumber(passiveChannelName)
    if channelNumber then
        leaveStalePassiveChannels(passiveChannelName)
        hideChannelEverywhere(passiveChannelName)
        return channelNumber
    end

    return nil
end

local function getPassiveBridgeTable()
    local db = addon.GetDb()
    if type(db.passiveBridge) ~= "table" then
        db.passiveBridge = {}
    end
    return db.passiveBridge
end

local function getPassiveMessageLog()
    local bridge = getPassiveBridgeTable()
    if type(bridge.messageLog) ~= "table" then
        bridge.messageLog = {}
    end
    return bridge.messageLog
end

local function appendPassiveMessageLogEntry(request, payload)
    local messageLog = getPassiveMessageLog()
    local sequence = publishSequence
    local entryKey = tostring(sequence)

    messageLog[entryKey] = {
        sequence = sequence,
        publishedAt = getNowUnix(),
        payload = payload,
        region = request.region,
        realm = request.realm,
        characterName = request.characterName,
        source = request.source,
    }

    local keys = {}
    for key, value in pairs(messageLog) do
        if type(value) == "table" and type(value.sequence) == "number" then
            table.insert(keys, key)
        end
    end

    table.sort(keys, function(left, right)
        local leftSeq = type(messageLog[left]) == "table" and messageLog[left].sequence or 0
        local rightSeq = type(messageLog[right]) == "table" and messageLog[right].sequence or 0
        return leftSeq > rightSeq
    end)

    for index = PASSIVE_LOG_LIMIT + 1, #keys do
        messageLog[keys[index]] = nil
    end
end

local function syncPassiveBridgeState()
    local channelName = passiveChannelName or buildPassiveChannelName()
    local bridge = getPassiveBridgeTable()

    bridge.enabled = addon.IsPassiveChannelEnabled()
    bridge.joined = getPassiveChannelNumber(channelName) ~= nil
    bridge.channelName = channelName
    bridge.playerKey = buildPassivePlayerKey()
    bridge.playerGuid = type(UnitGUID) == "function" and UnitGUID("player") or nil
    bridge.playerName = type(UnitName) == "function" and UnitName("player") or nil
    bridge.realm = type(GetRealmName) == "function" and GetRealmName() or nil
    bridge.region = type(addon.GetCurrentRegionSlug) == "function" and addon.GetCurrentRegionSlug() or "us"
    bridge.sessionId = passiveSessionId or buildPassiveSessionId()
    bridge.sequence = publishSequence
    bridge.lastPublishedAt = lastPublishedAt
    bridge.lastPublishedPayload = lastPublishedPayload
    bridge.messageCount = 0
    for _ in pairs(getPassiveMessageLog()) do
        bridge.messageCount = bridge.messageCount + 1
    end
    bridge.updatedAt = getNowUnix()
end

local function buildPayload(request)
    publishSequence = publishSequence + 1

    local segments = {
        PAYLOAD_PREFIX:sub(1, #PAYLOAD_PREFIX - 1),
        "ch=" .. sanitizeSegment(passiveChannelName or "", 30),
        "ss=" .. sanitizeSegment(passiveSessionId or "", 20),
        "n=" .. tostring(publishSequence),
        "rg=" .. sanitizeSegment(request.region, 8),
        "re=" .. sanitizeSegment(request.realm, 32),
        "nm=" .. sanitizeSegment(request.characterName, 32),
        "sr=" .. sanitizeSegment(request.source, 16),
    }

    if request.source == "applicant" then
        if request.applicantID ~= nil then
            table.insert(segments, "ai=" .. sanitizeSegment(request.applicantID, 10))
        end
        if request.memberIndex ~= nil then
            table.insert(segments, "mi=" .. sanitizeSegment(request.memberIndex, 3))
        end
        if request.assignedRole ~= nil then
            table.insert(segments, "ar=" .. sanitizeSegment(request.assignedRole, 16))
        end
        if request.class ~= nil then
            table.insert(segments, "cl=" .. sanitizeSegment(request.class, 16))
        end
        if type(request.itemLevel) == "number" then
            table.insert(segments, "il=" .. sanitizeSegment(string.format("%.1f", request.itemLevel), 8))
        end
        if request.level ~= nil then
            table.insert(segments, "lv=" .. sanitizeSegment(request.level, 3))
        end
    end

    local payload = table.concat(segments, "|")

    if #payload > 240 then
        payload = payload:sub(1, 240)
    end

    return payload
end

function addon.IsPassiveChannelEnabled()
    return addon.GetDb().settings.passiveChannelEnabled == true
end

function addon.SetPassiveChannelEnabled(enabled)
    addon.GetDb().settings.passiveChannelEnabled = enabled == true
    if enabled == true then
        ensurePassiveChannel()
        syncPassiveBridgeState()
        return
    end

    if passiveChannelName and type(LeaveChannelByName) == "function" then
        pcall(LeaveChannelByName, passiveChannelName)
    end
    leaveStalePassiveChannels(nil)
    syncPassiveBridgeState()
end

function addon.GetPassiveChannelDebugState()
    local channelName = passiveChannelName or buildPassiveChannelName()
    syncPassiveBridgeState()
    return {
        channelName = channelName,
        enabled = addon.IsPassiveChannelEnabled(),
        joined = getPassiveChannelNumber(channelName) ~= nil,
        lastPublishedAt = lastPublishedAt,
        lastPublishedPayload = lastPublishedPayload,
        playerKey = buildPassivePlayerKey(),
        sequence = publishSequence,
        sessionId = passiveSessionId or buildPassiveSessionId(),
    }
end

function addon.TryPublishRequestToPassiveChannel(request)
    if not addon.IsPassiveChannelEnabled() or type(request) ~= "table" then
        return false
    end

    local channelNumber = ensurePassiveChannel()
    if not channelNumber or type(SendChatMessage) ~= "function" then
        return false
    end

    local payload = buildPayload(request)
    local ok = pcall(SendChatMessage, payload, "CHANNEL", nil, channelNumber)
    if ok then
        lastPublishedAt = getNowUnix()
        lastPublishedPayload = payload
        appendPassiveMessageLogEntry(request, payload)
        hideChannelEverywhere(passiveChannelName)
    end
    syncPassiveBridgeState()

    return ok
end

local passiveFrame = CreateFrame("Frame")
passiveFrame:RegisterEvent("PLAYER_LOGIN")
passiveFrame:RegisterEvent("PLAYER_ENTERING_WORLD")
passiveFrame:RegisterEvent("CHANNEL_UI_UPDATE")
passiveFrame:SetScript("OnEvent", function(_, event)
    if event == "CHANNEL_UI_UPDATE" and passiveChannelName then
        hideChannelEverywhere(passiveChannelName)
        syncPassiveBridgeState()
        return
    end

    ensureFiltersInstalled()
    if addon.IsPassiveChannelEnabled() then
        ensurePassiveChannel()
        if event == "PLAYER_ENTERING_WORLD" and type(C_Timer) == "table" and type(C_Timer.After) == "function" then
            C_Timer.After(1, function()
                if addon.IsPassiveChannelEnabled() then
                    ensurePassiveChannel()
                    syncPassiveBridgeState()
                end
            end)
        end
    end
    syncPassiveBridgeState()
end)
