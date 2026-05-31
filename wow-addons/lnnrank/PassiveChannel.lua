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
local passiveSessionId = nil
local publishSequence = 0

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

local function buildPassiveChannelName()
    if not passiveSessionId then
        passiveSessionId = buildPassiveSessionId()
    end

    return string.format("lnnrank%s", passiveSessionId):sub(1, 30)
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

local function ensurePassiveChannel()
    if not addon.IsPassiveChannelEnabled() then
        return nil
    end

    ensureFiltersInstalled()

    if not passiveChannelName then
        passiveChannelName = buildPassiveChannelName()
    end

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
        hideChannelEverywhere(passiveChannelName)
        return channelNumber
    end

    return nil
end

local function buildPayload(request)
    publishSequence = publishSequence + 1

    local payload = table.concat({
        PAYLOAD_PREFIX:sub(1, #PAYLOAD_PREFIX - 1),
        "ch=" .. sanitizeSegment(passiveChannelName or "", 30),
        "ss=" .. sanitizeSegment(passiveSessionId or "", 20),
        "n=" .. tostring(publishSequence),
        "rg=" .. sanitizeSegment(request.region, 8),
        "re=" .. sanitizeSegment(request.realm, 32),
        "nm=" .. sanitizeSegment(request.characterName, 32),
        "sr=" .. sanitizeSegment(request.source, 16),
    }, "|")

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
        return
    end

    if passiveChannelName and type(LeaveChannelByName) == "function" then
        pcall(LeaveChannelByName, passiveChannelName)
    end
end

function addon.GetPassiveChannelDebugState()
    local channelName = passiveChannelName or buildPassiveChannelName()
    return {
        channelName = channelName,
        enabled = addon.IsPassiveChannelEnabled(),
        joined = getPassiveChannelNumber(channelName) ~= nil,
        lastPublishedAt = lastPublishedAt,
        lastPublishedPayload = lastPublishedPayload,
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
        hideChannelEverywhere(passiveChannelName)
    end

    return ok
end

local passiveFrame = CreateFrame("Frame")
passiveFrame:RegisterEvent("PLAYER_LOGIN")
passiveFrame:RegisterEvent("CHANNEL_UI_UPDATE")
passiveFrame:SetScript("OnEvent", function(_, event)
    if event == "CHANNEL_UI_UPDATE" and passiveChannelName then
        hideChannelEverywhere(passiveChannelName)
        return
    end

    ensureFiltersInstalled()
    if addon.IsPassiveChannelEnabled() then
        ensurePassiveChannel()
    end
end)
