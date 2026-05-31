local addon = _G.lnnrank

if not addon then
    return
end

local button
local SOLID_TEXTURE = "Interface\\Buttons\\WHITE8X8"

local minimapShapes = {
    ["ROUND"] = { true, true, true, true },
    ["SQUARE"] = { false, false, false, false },
    ["CORNER-TOPLEFT"] = { true, false, false, false },
    ["CORNER-TOPRIGHT"] = { false, false, true, false },
    ["CORNER-BOTTOMLEFT"] = { false, true, false, false },
    ["CORNER-BOTTOMRIGHT"] = { false, false, false, true },
    ["SIDE-LEFT"] = { true, true, false, false },
    ["SIDE-RIGHT"] = { false, false, true, true },
    ["SIDE-TOP"] = { true, false, true, false },
    ["SIDE-BOTTOM"] = { false, true, false, true },
    ["TRICORNER-TOPLEFT"] = { true, true, true, false },
    ["TRICORNER-TOPRIGHT"] = { true, false, true, true },
    ["TRICORNER-BOTTOMLEFT"] = { true, true, false, true },
    ["TRICORNER-BOTTOMRIGHT"] = { false, true, true, true },
}

local function reloadUi()
    if C_UI and type(C_UI.Reload) == "function" then
        C_UI.Reload()
        return
    end

    if type(ReloadUI) == "function" then
        ReloadUI()
    end
end

local function getDb()
    if type(addon.GetDb) == "function" then
        return addon.GetDb()
    end
    return nil
end

local function getQueuedRequestCount()
    if type(addon.GetQueuedRequestCount) == "function" then
        return addon.GetQueuedRequestCount()
    end
    return 0
end

local function needsRefresh()
    return getQueuedRequestCount() > 0
end

local function getLfgRestoreMode()
    if not GroupFinderFrame or type(GroupFinderFrame.IsVisible) ~= "function" or not GroupFinderFrame:IsVisible() then
        return false
    end

    if not LFGListFrame then
        return false
    end

    if LFGListFrame.activePanel == LFGListFrame.SearchPanel then
        return "search"
    end
    if LFGListFrame.activePanel == LFGListFrame.ApplicationViewer then
        return "applications"
    end
    if LFGListFrame.activePanel == LFGListFrame.EntryCreation then
        return "entry"
    end
    if LFGListFrame.activePanel == LFGListFrame.EntryCreationActivityFinder then
        return "activity"
    end
    if LFGListFrame.activePanel == LFGListFrame.CategorySelection then
        return "category"
    end

    local function isShown(frame)
        return frame and type(frame.IsShown) == "function" and frame:IsShown()
    end

    if isShown(LFGListFrame.SearchPanel) then
        return "search"
    end
    if isShown(LFGListFrame.ApplicationViewer) then
        return "applications"
    end
    if isShown(LFGListFrame.EntryCreation) then
        return "entry"
    end
    if isShown(LFGListFrame.EntryCreationActivityFinder) then
        return "activity"
    end
    if isShown(LFGListFrame.CategorySelection) then
        return "category"
    end

    return false
end

local function openSettings()
    if type(addon.OpenSettingsPanel) == "function" then
        addon.OpenSettingsPanel()
        return
    end

    addon.Print("Settings panel is not available.")
end

local function getStoredAngle()
    local db = getDb()
    if type(db) ~= "table" or type(db.settings) ~= "table" then
        return 225
    end

    local angle = tonumber(db.settings.minimapAngle)
    if not angle then
        db.settings.minimapAngle = 225
        return 225
    end

    return angle % 360
end

local function setStoredAngle(angle)
    local db = getDb()
    if type(db) ~= "table" then
        return
    end

    db.settings = db.settings or {}
    db.settings.minimapAngle = angle % 360
end

local function updateTooltip()
    if not button or not GameTooltip:IsOwned(button) then
        return
    end

    local queued = getQueuedRequestCount()
    local statusText
    local statusColor

    if needsRefresh() then
        statusText = string.format("Refresh needed (%d queued lookup%s)", queued, queued == 1 and "" or "s")
        statusColor = "|cffff7f7f"
    else
        statusText = "Up to date"
        statusColor = "|cff7fff7f"
    end

    GameTooltip:SetOwner(button, "ANCHOR_LEFT")
    GameTooltip:ClearLines()
    GameTooltip:AddLine("LÑÑRank")
    GameTooltip:AddLine(statusColor .. statusText .. "|r")
    GameTooltip:AddLine("Left-click to reload and import new data.", 1, 1, 1, true)
    GameTooltip:AddLine("If LFG was open when you clicked, it will reopen after the reload.", 1, 1, 1, true)
    GameTooltip:AddLine("Right-click to open settings.", 1, 1, 1, true)
    GameTooltip:AddLine("Left-drag to move this icon.", 1, 1, 1, true)
    GameTooltip:Show()
end

local function updateButtonVisuals()
    if not button then
        return
    end

    if needsRefresh() then
        button.Background:SetVertexColor(0.86, 0.18, 0.18, 0.95)
        button.IconText:SetText("!")
        button.IconTextShadow:SetText("!")
    else
        button.Background:SetVertexColor(0.18, 0.72, 0.26, 0.95)
        button.IconText:SetText("W")
        button.IconTextShadow:SetText("W")
    end

    updateTooltip()
end

local function getButtonOffset(angle)
    local radians = math.rad(angle)
    local x = math.cos(radians)
    local y = math.sin(radians)
    local quadrant = 1
    local halfWidth = (Minimap:GetWidth() / 2) + 5
    local halfHeight = (Minimap:GetHeight() / 2) + 5

    if x < 0 then
        quadrant = quadrant + 1
    end
    if y > 0 then
        quadrant = quadrant + 2
    end

    local shape = "ROUND"
    if type(GetMinimapShape) == "function" then
        shape = GetMinimapShape() or shape
    end
    local quadrantMask = minimapShapes[shape] or minimapShapes["ROUND"]

    if quadrantMask[quadrant] then
        x = x * halfWidth
        y = y * halfHeight
    else
        local diagonalWidth = math.sqrt(2 * halfWidth * halfWidth) - 10
        local diagonalHeight = math.sqrt(2 * halfHeight * halfHeight) - 10
        x = math.max(-halfWidth, math.min(x * diagonalWidth, halfWidth))
        y = math.max(-halfHeight, math.min(y * diagonalHeight, halfHeight))
    end

    return x, y
end

local function updateButtonPosition(angle)
    if not button then
        return
    end

    local x, y = getButtonOffset(angle or getStoredAngle())
    button:ClearAllPoints()
    button:SetPoint("CENTER", Minimap, "CENTER", x, y)
end

local function updateDragPosition()
    if not button then
        return
    end

    local mx, my = Minimap:GetCenter()
    local scale = Minimap:GetEffectiveScale()
    local cursorX, cursorY = GetCursorPosition()
    local deltaX = cursorX / scale - mx
    local deltaY = cursorY / scale - my
    local angle = math.deg(math.atan2(deltaY, deltaX))

    if angle < 0 then
        angle = angle + 360
    end

    setStoredAngle(angle)
    updateButtonPosition(angle)
end

local function startDragging()
    if not button then
        return
    end

    button.isDragging = true
    button:SetScript("OnUpdate", updateDragPosition)
    updateDragPosition()
end

local function stopDragging()
    if not button then
        return
    end

    button.isDragging = false
    button.suppressClickUntil = GetTime() + 0.2
    button:SetScript("OnUpdate", nil)
    updateTooltip()
end

local function createMinimapButton()
    if button then
        return button
    end

    button = CreateFrame("Button", "LNNRankMinimapButton", Minimap)
    button:SetSize(31, 31)
    button:SetFrameStrata("MEDIUM")
    button:SetFrameLevel(Minimap:GetFrameLevel() + 8)
    button:RegisterForClicks("LeftButtonUp", "RightButtonUp")
    button:RegisterForDrag("LeftButton")

    local background = button:CreateTexture(nil, "ARTWORK")
    background:SetPoint("TOPLEFT", button, "TOPLEFT", 3, -3)
    background:SetPoint("BOTTOMRIGHT", button, "BOTTOMRIGHT", -3, 3)
    background:SetTexture(SOLID_TEXTURE)
    background:SetMask("Interface\\Minimap\\UI-Minimap-Background")
    background:SetBlendMode("BLEND")
    background:SetAlpha(0.95)
    button.Background = background

    local overlay = button:CreateTexture(nil, "OVERLAY")
    overlay:SetSize(53, 53)
    overlay:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
    overlay:SetPoint("TOPLEFT", button, "TOPLEFT")
    button.Overlay = overlay

    local iconTextShadow = button:CreateFontString(nil, "BORDER", "GameFontNormalSmall")
    iconTextShadow:SetPoint("CENTER", button, "CENTER", 1, -1)
    iconTextShadow:SetTextColor(0, 0, 0, 0.9)
    iconTextShadow:SetText("W")
    button.IconTextShadow = iconTextShadow

    local iconText = button:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
    iconText:SetPoint("CENTER", button, "CENTER")
    iconText:SetTextColor(1, 1, 1)
    iconText:SetText("W")
    button.IconText = iconText

    button:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight", "ADD")
    button:SetScript("OnEnter", updateTooltip)
    button:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    button:SetScript("OnClick", function(_, mouseButton)
        if button.isDragging or (button.suppressClickUntil and GetTime() < button.suppressClickUntil) then
            return
        end

        if mouseButton == "RightButton" then
            openSettings()
            return
        end

        if type(addon.FlagOpenLfgOnNextLogin) == "function" then
            addon.FlagOpenLfgOnNextLogin(getLfgRestoreMode())
        end
        addon.Print("Reloading UI to import the latest companion data.")
        reloadUi()
    end)
    button:SetScript("OnDragStart", startDragging)
    button:SetScript("OnDragStop", stopDragging)

    addon.UpdateMinimapButtonState = updateButtonVisuals
    updateButtonVisuals()
    updateButtonPosition()

    return button
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent", function()
    createMinimapButton()
end)
