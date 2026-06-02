local addonName = ...
local addon = _G.lnnrank

if not addon then
    return
end

local LIVE_LOG_LIMIT = 80
local TOGGLE_BINDING = "CTRL-F1"

local liveLogEntries = {}
local liveLogFrame
local liveLogScrollFrame
local liveLogScrollChild
local liveLogText
local copyButton
local liveLogRenderedText = ""
local copyOverlay
local copyScrollFrame
local copyScrollChild
local copyEditBox
local bindingOwner = CreateFrame("Frame")

local function clearTable(values)
    for key in pairs(values) do
        values[key] = nil
    end
end

local function getEntryTimestampMs(payload, metadata)
    if type(metadata) == "table" and type(metadata.capturedAtMs) == "number" then
        return metadata.capturedAtMs
    end

    if type(payload) == "string" then
        local timestampText = payload:match("|t=(%d+)")
        local timestampValue = tonumber(timestampText)
        if timestampValue then
            return timestampValue
        end
    end

    if type(GetTimePreciseSec) == "function" and type(time) == "function" then
        local nowSeconds = time()
        local preciseSeconds = GetTimePreciseSec()
        local fractionalMilliseconds = math.floor((preciseSeconds - math.floor(preciseSeconds)) * 1000)
        return (nowSeconds * 1000) + fractionalMilliseconds
    end

    if type(time) == "function" then
        return time() * 1000
    end

    return 0
end

local function formatEntryClock(timestampMs)
    local seconds = math.floor((tonumber(timestampMs) or 0) / 1000)
    if seconds <= 0 and type(time) == "function" then
        seconds = time()
    end
    return type(date) == "function" and date("%H:%M:%S", seconds) or tostring(seconds)
end

local function formatEntrySummary(payload, metadata)
    local parts = {
        string.format("[%s]", formatEntryClock(getEntryTimestampMs(payload, metadata))),
        string.format("#%s", tostring(type(metadata) == "table" and metadata.sequence or "?")),
        tostring(type(metadata) == "table" and metadata.eventType or "live"),
    }

    if type(metadata) == "table" and metadata.source then
        table.insert(parts, tostring(metadata.source))
    end

    if type(metadata) == "table" and metadata.characterName then
        local fullName = tostring(metadata.characterName)
        if metadata.realm and metadata.realm ~= "" then
            fullName = string.format("%s-%s", fullName, tostring(metadata.realm))
        end
        table.insert(parts, fullName)
    elseif type(metadata) == "table" and metadata.groupID ~= nil then
        table.insert(parts, string.format("group=%s", tostring(metadata.groupID)))
    end

    if type(metadata) == "table" and metadata.eventType == "lfg_status" then
        local memberCount = type(metadata.members) == "table" and #metadata.members or 0
        table.insert(parts, string.format("members=%d", memberCount))
    end

    if type(metadata) == "table" and metadata.deliveryStatus then
        table.insert(parts, string.format("[%s]", tostring(metadata.deliveryStatus)))
    end

    if type(metadata) == "table" and metadata.passiveError and metadata.passiveError ~= "" then
        table.insert(parts, string.format("{%s}", tostring(metadata.passiveError)))
    end

    return table.concat(parts, " ")
end

local function escapePayloadForDisplay(value)
    local text = tostring(value or "")
    return text:gsub("|", "||")
end

local function refreshLiveLogLayout()
    if not liveLogText or not liveLogScrollChild or not liveLogScrollFrame then
        return
    end

    local childWidth = math.max(280, liveLogScrollFrame:GetWidth() - 24)
    liveLogScrollChild:SetWidth(childWidth)
    liveLogText:SetWidth(childWidth)
    liveLogScrollChild:SetHeight(math.max(liveLogText:GetStringHeight() + 12, liveLogScrollFrame:GetHeight()))
    liveLogScrollFrame:UpdateScrollChildRect()
end

local function refreshLiveLogText()
    if not liveLogText then
        return
    end

    local lines = {}
    for index = 1, #liveLogEntries do
        local entry = liveLogEntries[index]
        lines[index] = string.format("%s\n  %s", entry.summary, escapePayloadForDisplay(entry.payload))
    end

    if #lines == 0 then
        lines[1] = "No live relay events sent yet.\n\nUse ctrl-click lookups or open the LFG applicants view to generate outbound live messages."
    end

    liveLogRenderedText = table.concat(lines, "\n\n")
    liveLogText:SetText(liveLogRenderedText)
    if copyOverlay and copyOverlay:IsShown() and copyEditBox then
        copyEditBox:SetText(liveLogRenderedText)
        refreshCopyOverlayLayout()
    end
    refreshLiveLogLayout()
end

local function estimateCopyEditBoxHeight(text, width)
    local lineCount = 1
    local cursor = 1
    while true do
        local startIndex, endIndex = string.find(text, "\n", cursor, true)
        if not startIndex then
            break
        end
        lineCount = lineCount + 1
        cursor = endIndex + 1
    end

    local estimatedCharactersPerLine = math.max(24, math.floor((width or 600) / 7))
    local wrappedLineCount = math.max(lineCount, math.ceil(math.max(#text, 1) / estimatedCharactersPerLine))
    return math.max(240, wrappedLineCount * 18 + 24)
end

local function refreshCopyOverlayLayout()
    if not copyEditBox or not copyScrollChild or not copyScrollFrame then
        return
    end

    local childWidth = math.max(280, copyScrollFrame:GetWidth() - 24)
    copyScrollChild:SetWidth(childWidth)
    copyEditBox:SetWidth(childWidth)
    copyEditBox:SetHeight(estimateCopyEditBoxHeight(copyEditBox:GetText() or "", childWidth))
    copyScrollChild:SetHeight(math.max(copyEditBox:GetHeight() + 12, copyScrollFrame:GetHeight()))
    copyScrollFrame:UpdateScrollChildRect()
end

local function hideCopyOverlay()
    if copyEditBox then
        copyEditBox:ClearFocus()
    end
    if liveLogScrollFrame then
        liveLogScrollFrame:Show()
    end
    if copyButton then
        copyButton:Enable()
    end
    if copyOverlay then
        copyOverlay:Hide()
    end
end

local function showCopyOverlay()
    if not copyOverlay or not copyEditBox then
        return
    end

    if liveLogScrollFrame then
        liveLogScrollFrame:Hide()
    end
    if copyButton then
        copyButton:Disable()
    end
    copyEditBox:SetText(liveLogRenderedText or "")
    refreshCopyOverlayLayout()
    copyOverlay:Show()
    copyScrollFrame:SetVerticalScroll(0)
    copyEditBox:SetFocus()
    copyEditBox:HighlightText(0)
end

local function ensureLiveLogFrame()
    if liveLogFrame then
        return liveLogFrame
    end

    local frame = CreateFrame("Frame", "LNNRankLiveEventLogFrame", UIParent, "BasicFrameTemplateWithInset")
    frame:SetSize(860, 360)
    frame:SetPoint("CENTER", UIParent, "CENTER", 0, 120)
    frame:SetClampedToScreen(true)
    frame:SetMovable(true)
    frame:EnableMouse(true)
    frame:RegisterForDrag("LeftButton")
    frame:SetScript("OnDragStart", function(self)
        self:StartMoving()
    end)
    frame:SetScript("OnDragStop", function(self)
        self:StopMovingOrSizing()
    end)
    frame:SetScript("OnShow", function()
        refreshLiveLogText()
        if liveLogScrollFrame then
            liveLogScrollFrame:SetVerticalScroll(0)
        end
    end)
    frame:SetScript("OnSizeChanged", function()
        refreshLiveLogLayout()
        refreshCopyOverlayLayout()
    end)
    frame:Hide()

    frame.TitleText:SetText("LNNRank Live Relay Log")

    local subtitle = frame:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
    subtitle:SetPoint("TOPLEFT", 16, -34)
    subtitle:SetPoint("TOPRIGHT", -120, -34)
    subtitle:SetJustifyH("LEFT")
    subtitle:SetText("Sent live payloads only. Toggle with Ctrl+F1.")

    local clearButton = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
    clearButton:SetSize(84, 22)
    clearButton:SetPoint("TOPRIGHT", -12, -28)
    clearButton:SetText("Clear")
    clearButton:SetScript("OnClick", function()
        clearTable(liveLogEntries)
        refreshLiveLogText()
    end)

    local copyButtonFrame = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
    copyButtonFrame:SetSize(84, 22)
    copyButtonFrame:SetPoint("RIGHT", clearButton, "LEFT", -8, 0)
    copyButtonFrame:SetText("Copy All")
    copyButtonFrame:SetScript("OnClick", function()
        showCopyOverlay()
    end)

    local scrollFrame = CreateFrame("ScrollFrame", "LNNRankLiveEventLogScrollFrame", frame, "UIPanelScrollFrameTemplate")
    scrollFrame:SetPoint("TOPLEFT", 12, -58)
    scrollFrame:SetPoint("BOTTOMRIGHT", -30, 12)

    local scrollChild = CreateFrame("Frame", nil, scrollFrame)
    scrollChild:SetSize(1, 1)
    scrollFrame:SetScrollChild(scrollChild)

    local text = scrollChild:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
    text:SetPoint("TOPLEFT", 0, 0)
    text:SetJustifyH("LEFT")
    text:SetJustifyV("TOP")
    text:SetSpacing(4)
    text:SetNonSpaceWrap(true)

    local overlay = CreateFrame("Frame", nil, frame, "InsetFrameTemplate3")
    overlay:SetPoint("TOPLEFT", 10, -56)
    overlay:SetPoint("BOTTOMRIGHT", -10, 10)
    overlay:Hide()
    overlay:SetFrameStrata(frame:GetFrameStrata())
    overlay:SetFrameLevel(frame:GetFrameLevel() + 20)

    local overlayBackground = overlay:CreateTexture(nil, "BACKGROUND")
    overlayBackground:SetAllPoints()
    overlayBackground:SetColorTexture(0.07, 0.07, 0.09, 0.98)

    local overlayLabel = overlay:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
    overlayLabel:SetPoint("TOPLEFT", 12, -10)
    overlayLabel:SetPoint("TOPRIGHT", -96, -10)
    overlayLabel:SetJustifyH("LEFT")
    overlayLabel:SetText("Copy mode. The full log is selected automatically; press Ctrl+C, then Close or Esc.")

    local closeButton = CreateFrame("Button", nil, overlay, "UIPanelButtonTemplate")
    closeButton:SetSize(72, 22)
    closeButton:SetPoint("TOPRIGHT", -10, -8)
    closeButton:SetText("Close")
    closeButton:SetScript("OnClick", function()
        hideCopyOverlay()
    end)

    local overlayScrollFrame = CreateFrame(
        "ScrollFrame",
        "LNNRankLiveEventLogCopyScrollFrame",
        overlay,
        "UIPanelScrollFrameTemplate"
    )
    overlayScrollFrame:SetPoint("TOPLEFT", 10, -34)
    overlayScrollFrame:SetPoint("BOTTOMRIGHT", -28, 10)
    overlayScrollFrame:EnableMouseWheel(true)
    overlayScrollFrame:SetScript("OnMouseWheel", function(self, delta)
        local minScroll, maxScroll = self:GetVerticalScrollRange()
        if maxScroll <= 0 then
            return
        end
        local nextValue = math.max(0, math.min(maxScroll, self:GetVerticalScroll() - (delta * 36)))
        self:SetVerticalScroll(nextValue)
    end)

    local overlayScrollChild = CreateFrame("Frame", nil, overlayScrollFrame)
    overlayScrollChild:SetSize(1, 1)
    overlayScrollFrame:SetScrollChild(overlayScrollChild)

    local overlayEditBox = CreateFrame("EditBox", nil, overlayScrollChild)
    overlayEditBox:SetMultiLine(true)
    overlayEditBox:SetAutoFocus(false)
    overlayEditBox:EnableMouse(true)
    overlayEditBox:EnableKeyboard(true)
    overlayEditBox:SetFontObject(GameFontHighlightSmall)
    overlayEditBox:SetTextInsets(4, 4, 4, 4)
    overlayEditBox:SetPoint("TOPLEFT", 0, 0)
    overlayEditBox:SetPoint("RIGHT", overlayScrollChild, "RIGHT", 0, 0)
    overlayEditBox:SetJustifyH("LEFT")
    overlayEditBox:SetJustifyV("TOP")
    overlayEditBox:SetScript("OnEscapePressed", function()
        hideCopyOverlay()
    end)
    overlayEditBox:SetScript("OnEditFocusLost", function(self)
        self:HighlightText(0, 0)
    end)
    overlayEditBox:SetScript("OnCursorChanged", function(_, _, y, _, height)
        local scrollTop = overlayScrollFrame:GetVerticalScroll()
        local scrollBottom = scrollTop + overlayScrollFrame:GetHeight()
        if y < scrollTop then
            overlayScrollFrame:SetVerticalScroll(y)
        elseif (y + height) > scrollBottom then
            overlayScrollFrame:SetVerticalScroll((y + height) - overlayScrollFrame:GetHeight())
        end
    end)
    overlay:SetScript("OnHide", function()
        overlayEditBox:ClearFocus()
    end)

    liveLogFrame = frame
    liveLogScrollFrame = scrollFrame
    liveLogScrollChild = scrollChild
    liveLogText = text
    copyButton = copyButtonFrame
    copyOverlay = overlay
    copyScrollFrame = overlayScrollFrame
    copyScrollChild = overlayScrollChild
    copyEditBox = overlayEditBox

    refreshLiveLogText()

    return frame
end

local function applyToggleBinding()
    if type(SetOverrideBindingClick) ~= "function" or type(ClearOverrideBindings) ~= "function" then
        return
    end

    local frame = ensureLiveLogFrame()
    local toggleButton = _G.LNNRankLiveEventLogToggleButton
    if not frame or not toggleButton or not toggleButton:GetName() then
        return
    end

    ClearOverrideBindings(bindingOwner)
    SetOverrideBindingClick(bindingOwner, true, TOGGLE_BINDING, toggleButton:GetName(), "LeftButton")
end

function addon.ToggleLiveEventLogWindow()
    local frame = ensureLiveLogFrame()
    if frame:IsShown() then
        frame:Hide()
        return
    end

    frame:Show()
end

function addon.AppendLiveEventLogEntry(payload, metadata)
    if type(payload) ~= "string" or payload == "" then
        return
    end

    table.insert(liveLogEntries, 1, {
        payload = payload,
        summary = formatEntrySummary(payload, metadata),
    })

    while #liveLogEntries > LIVE_LOG_LIMIT do
        table.remove(liveLogEntries)
    end

    refreshLiveLogText()
end

local toggleButton = CreateFrame("Button", "LNNRankLiveEventLogToggleButton", UIParent)
toggleButton:Hide()
toggleButton:SetScript("OnClick", function()
    addon.ToggleLiveEventLogWindow()
end)

bindingOwner:RegisterEvent("PLAYER_LOGIN")
bindingOwner:RegisterEvent("PLAYER_ENTERING_WORLD")
bindingOwner:RegisterEvent("PLAYER_REGEN_ENABLED")
bindingOwner:SetScript("OnEvent", function(_, event)
    if event == "PLAYER_REGEN_ENABLED" or not InCombatLockdown() then
        applyToggleBinding()
    end
end)
