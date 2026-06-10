local addon = _G.lnnrank

if not addon then
    return
end

local lastQueuedKey
local lastQueuedAt = 0
local lastMouseoverPlayer
local directFrameHookPending = false

local CLICK_BUTTONS = {
    LeftButton = true,
    RightButton = true,
    MiddleButton = true,
    Button4 = true,
    Button5 = true,
}

local function isCtrlQueueClick(button)
    return button == "LeftButton" and IsControlKeyDown()
end

local function isMouseButtonToken(value)
    return type(value) == "string" and CLICK_BUTTONS[value] == true
end

local function splitFullName(fullName)
    if type(fullName) ~= "string" or fullName == "" then
        return nil, nil
    end

    local name, realm = strsplit("-", fullName, 2)
    if not realm or realm == "" then
        realm = GetRealmName()
    end

    return name, realm
end

local function getUnitNameRealm(unitToken)
    local name, realm

    if type(UnitFullName) == "function" then
        name, realm = UnitFullName(unitToken)
    end

    if not name then
        name, realm = UnitName(unitToken)
    end

    if not name then
        return nil, nil
    end

    if not realm or realm == "" then
        realm = GetRealmName()
    end

    return name, realm
end

local function shouldSuppressDuplicate(requestKey)
    local now = type(GetTime) == "function" and GetTime() or 0
    if lastQueuedKey == requestKey and (now - lastQueuedAt) < 0.25 then
        return true
    end

    lastQueuedKey = requestKey
    lastQueuedAt = now
    return false
end

local function updateLastMouseoverPlayer()
    if not UnitExists("mouseover") or not UnitIsPlayer("mouseover") then
        lastMouseoverPlayer = nil
        return
    end

    local characterName, realm = getUnitNameRealm("mouseover")
    if not characterName or not realm then
        lastMouseoverPlayer = nil
        return
    end

    lastMouseoverPlayer = {
        region = addon.GetCurrentRegionSlug(),
        realm = realm,
        characterName = characterName,
        observedAt = type(GetTime) == "function" and GetTime() or 0,
    }
end

local function queueCharacter(region, realm, characterName, source, extra)
    if not region or not realm or not characterName then
        return false
    end

    if type(addon.IsSuppressedInCurrentInstance) == "function" and addon.IsSuppressedInCurrentInstance() then
        return false
    end

    local requestKey = addon.BuildRequestKey(region, realm, characterName)
    if shouldSuppressDuplicate(requestKey) then
        return false
    end

    local request = addon.QueueRequest(region, realm, characterName)
    request.source = source
    request.userQueued = true
    request.force = true

    if type(extra) == "table" then
        for key, value in pairs(extra) do
            request[key] = value
        end
    end

    if type(addon.PublishSearchEvent) == "function" then
        addon.PublishSearchEvent(request)
    end

    addon.Print(string.format("Queued a lookup for %s-%s.", characterName, realm))
    return true
end

local function queueUnitToken(unitToken, source)
    if not unitToken or not UnitExists(unitToken) or not UnitIsPlayer(unitToken) then
        return false
    end

    local characterName, realm = getUnitNameRealm(unitToken)
    if not characterName or not realm then
        return false
    end

    return queueCharacter(addon.GetCurrentRegionSlug(), realm, characterName, source, {
        unitToken = unitToken,
    })
end

local function getUnitTokenFromFrame(frame)
    if type(frame) ~= "table" then
        return nil
    end

    if type(frame.GetAttribute) == "function" then
        local unit = frame:GetAttribute("unit")
        if type(unit) == "string" and unit ~= "" then
            return unit
        end
    end

    if type(frame.unit) == "string" and frame.unit ~= "" then
        return frame.unit
    end

    if type(frame.displayedUnit) == "string" and frame.displayedUnit ~= "" then
        return frame.displayedUnit
    end

    return nil
end

local function normalizeUnitClickArgs(frameOrUnit, secondArg, thirdArg)
    local frame = type(frameOrUnit) == "table" and frameOrUnit or nil
    local unitToken = type(frameOrUnit) == "string" and frameOrUnit or nil
    local button = nil

    if isMouseButtonToken(secondArg) then
        button = secondArg
    elseif isMouseButtonToken(thirdArg) then
        button = thirdArg
    end

    if not unitToken and type(secondArg) == "string" and not isMouseButtonToken(secondArg) then
        unitToken = secondArg
    end

    if not unitToken and frame then
        unitToken = getUnitTokenFromFrame(frame)
    end

    return frame, unitToken, button
end

local function onUnitFrameClick(frameOrUnit, secondArg, thirdArg)
    local _, unitToken, button = normalizeUnitClickArgs(frameOrUnit, secondArg, thirdArg)
    if not isCtrlQueueClick(button) then
        return
    end

    queueUnitToken(unitToken, "unit")
end

local function onDirectUnitFrameMouseUp(frame, button)
    if not isCtrlQueueClick(button) then
        return
    end

    queueUnitToken(getUnitTokenFromFrame(frame), "unit")
end

local function onDirectUnitFramePostClick(frame, button)
    if not isCtrlQueueClick(button) then
        return
    end

    queueUnitToken(getUnitTokenFromFrame(frame), "unit")
end

local function tryHookDirectUnitFrame(frame)
    if type(frame) ~= "table" or frame.LNNRankDirectUnitHooked or type(frame.HookScript) ~= "function" then
        return false
    end

    local unitToken = getUnitTokenFromFrame(frame)
    if type(unitToken) ~= "string" or unitToken == "" then
        return false
    end

    frame:HookScript("OnMouseUp", onDirectUnitFrameMouseUp)
    if type(frame.IsObjectType) == "function" and frame:IsObjectType("Button") then
        frame:HookScript("PostClick", onDirectUnitFramePostClick)
    end
    frame.LNNRankDirectUnitHooked = true
    return true
end

local function scanForDirectUnitFrames()
    if directFrameHookPending then
        return
    end

    if InCombatLockdown() then
        directFrameHookPending = true
        return
    end

    local frame = EnumerateFrames and EnumerateFrames() or nil
    while frame do
        tryHookDirectUnitFrame(frame)
        frame = EnumerateFrames(frame)
    end
end

local function flushPendingDirectFrameHooks()
    if not directFrameHookPending or InCombatLockdown() then
        return
    end

    directFrameHookPending = false
    scanForDirectUnitFrames()
end

local function onWorldFrameMouseDown(_, button)
    if not isCtrlQueueClick(button) then
        return
    end

    updateLastMouseoverPlayer()

    if queueUnitToken("mouseover", "world") then
        lastMouseoverPlayer = nil
        return
    end

    if type(lastMouseoverPlayer) ~= "table" then
        return
    end

    local now = type(GetTime) == "function" and GetTime() or 0
    if (now - (lastMouseoverPlayer.observedAt or 0)) > 0.2 then
        return
    end

    if queueCharacter(
        lastMouseoverPlayer.region,
        lastMouseoverPlayer.realm,
        lastMouseoverPlayer.characterName,
        "world",
        {
            unitToken = "mouseover",
        }
    ) then
        lastMouseoverPlayer = nil
    end
end

local function onSetItemRef(link, _, button)
    if not isCtrlQueueClick(button or GetMouseButtonClicked() or "LeftButton") then
        return
    end

    local linkType, payload = string.match(link or "", "^(%a+):(.+)$")
    if linkType ~= "player" then
        return
    end

    local fullName = string.match(payload, "^([^:]+)")
    local name, realm = splitFullName(fullName)
    if not name or not realm then
        return
    end

    queueCharacter(addon.GetCurrentRegionSlug(), realm, name, "chat-link")
end

if WorldFrame and type(WorldFrame.HookScript) == "function" then
    WorldFrame:HookScript("OnMouseDown", onWorldFrameMouseDown)
end

if type(UnitFrame_OnClick) == "function" then
    hooksecurefunc("UnitFrame_OnClick", onUnitFrameClick)
end

if type(SecureUnitButton_OnClick) == "function" then
    hooksecurefunc("SecureUnitButton_OnClick", onUnitFrameClick)
end

hooksecurefunc("SetItemRef", onSetItemRef)

local mouseoverFrame = CreateFrame("Frame")
mouseoverFrame:RegisterEvent("UPDATE_MOUSEOVER_UNIT")
mouseoverFrame:RegisterEvent("PLAYER_LOGIN")
mouseoverFrame:RegisterEvent("PLAYER_TARGET_CHANGED")
mouseoverFrame:RegisterEvent("PLAYER_FOCUS_CHANGED")
mouseoverFrame:RegisterEvent("GROUP_ROSTER_UPDATE")
mouseoverFrame:RegisterEvent("NAME_PLATE_UNIT_ADDED")
mouseoverFrame:RegisterEvent("PLAYER_REGEN_ENABLED")
mouseoverFrame:SetScript("OnEvent", updateLastMouseoverPlayer)

local previousMouseoverHandler = mouseoverFrame:GetScript("OnEvent")
mouseoverFrame:SetScript("OnEvent", function(_, event, ...)
    if event == "UPDATE_MOUSEOVER_UNIT" then
        updateLastMouseoverPlayer()
        return
    end

    if event == "PLAYER_REGEN_ENABLED" then
        flushPendingDirectFrameHooks()
        return
    end

    scanForDirectUnitFrames()
    if event == "NAME_PLATE_UNIT_ADDED" then
        updateLastMouseoverPlayer(...)
    end
end)
