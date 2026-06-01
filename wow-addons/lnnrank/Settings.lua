local addonName, ns = ...
local addon = _G.lnnrank

if not addon then
    return
end

local settingsPanel
local settingsCategory

local function getDb()
    if type(addon.GetDb) == "function" then
        return addon.GetDb()
    end
    return nil
end

local function notifySettingsChanged()
    if type(addon.NotifyStateChanged) == "function" then
        addon.NotifyStateChanged()
    end
end

local function scheduleCollectors()
    if type(addon.ScheduleCollectors) == "function" then
        addon.ScheduleCollectors(0.1)
    end
end

local function createCheckbox(parent, label, description, anchor, offsetY, getter, setter)
    local checkbox = CreateFrame("CheckButton", nil, parent, "InterfaceOptionsCheckButtonTemplate")
    checkbox:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, offsetY)
    checkbox.Text:SetText(label)

    if description and description ~= "" then
        checkbox.tooltipText = label
        checkbox.tooltipRequirement = description
    end

    checkbox:SetScript("OnClick", function(self)
        setter(self:GetChecked() == true)
    end)

    checkbox.Refresh = function(self)
        self:SetChecked(getter() == true)
    end

    return checkbox
end

local function ensureSettingsPanel()
    if settingsPanel then
        return settingsPanel
    end

    local panel = CreateFrame("Frame", addonName .. "SettingsPanel", UIParent)
    panel.name = "LÑÑRank"

    local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
    title:SetPoint("TOPLEFT", 16, -16)
    title:SetText("LÑÑRank")

    local subtitle = panel:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
    subtitle:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
    subtitle:SetText("Tooltip and collection settings for the LÑÑRank companion addon.")

    local showSearching = createCheckbox(
        panel,
        "Show queued/searching tooltip lines",
        "Show queued or not-found helper text when no cached record is available.",
        subtitle,
        -20,
        function()
            local db = getDb()
            return db and db.settings and db.settings.showSearching
        end,
        function(value)
            local db = getDb()
            if not db or not db.settings then
                return
            end
            db.settings.showSearching = value
            notifySettingsChanged()
        end
    )

    local showInCombat = createCheckbox(
        panel,
        "Show tooltip in combat",
        "Allow the addon tooltip block to render while you are in combat.",
        showSearching,
        -10,
        function()
            local db = getDb()
            return db and db.settings and db.settings.showInCombat
        end,
        function(value)
            local db = getDb()
            if not db or not db.settings then
                return
            end
            db.settings.showInCombat = value
            notifySettingsChanged()
        end
    )

    local scanGroupMembers = createCheckbox(
        panel,
        "Scan group and raid snapshots",
        "Keep the group and raid snapshot data updated in SavedVariables.",
        showInCombat,
        -10,
        function()
            local db = getDb()
            return db and db.settings and db.settings.scanGroupMembers
        end,
        function(value)
            local db = getDb()
            if not db or not db.settings then
                return
            end
            db.settings.scanGroupMembers = value
            scheduleCollectors()
            notifySettingsChanged()
        end
    )

    local scanApplicants = createCheckbox(
        panel,
        "Scan LFG applicants",
        "Auto-queue applicants and keep the LFG snapshot current.",
        scanGroupMembers,
        -10,
        function()
            local db = getDb()
            return db and db.settings and db.settings.scanApplicants
        end,
        function(value)
            local db = getDb()
            if not db or not db.settings then
                return
            end
            db.settings.scanApplicants = value
            scheduleCollectors()
            notifySettingsChanged()
        end
    )

    local savedEventBatch = createCheckbox(
        panel,
        "Write reload event batch",
        "Store outbound lookup events in SavedVariables so the app can import them after /reload.",
        scanApplicants,
        -10,
        function()
            local db = getDb()
            return db and db.settings and db.settings.savedEventBatchEnabled
        end,
        function(value)
            local db = getDb()
            if not db or not db.settings then
                return
            end
            db.settings.savedEventBatchEnabled = value
            notifySettingsChanged()
        end
    )

    local passiveChannel = createCheckbox(
        panel,
        "Write live private channel events",
        "Publish outbound lookup events into the hidden self-channel for live app pickup.",
        savedEventBatch,
        -10,
        function()
            local db = getDb()
            return db and db.settings and db.settings.passiveChannelEnabled
        end,
        function(value)
            if type(addon.SetPassiveChannelEnabled) == "function" then
                addon.SetPassiveChannelEnabled(value)
            else
                local db = getDb()
                if not db or not db.settings then
                    return
                end
                db.settings.passiveChannelEnabled = value
            end
            scheduleCollectors()
            notifySettingsChanged()
        end
    )

    panel.refresh = function()
        showSearching:Refresh()
        showInCombat:Refresh()
        scanGroupMembers:Refresh()
        scanApplicants:Refresh()
        savedEventBatch:Refresh()
        passiveChannel:Refresh()
    end

    if Settings and type(Settings.RegisterCanvasLayoutCategory) == "function" and
        type(Settings.RegisterAddOnCategory) == "function" then
        settingsCategory = Settings.RegisterCanvasLayoutCategory(panel, panel.name, panel.name)
        Settings.RegisterAddOnCategory(settingsCategory)
    elseif type(InterfaceOptions_AddCategory) == "function" then
        InterfaceOptions_AddCategory(panel)
        settingsCategory = panel
    end

    settingsPanel = panel
    return panel
end

function addon.OpenSettingsPanel()
    local panel = ensureSettingsPanel()
    if panel.refresh then
        panel:refresh()
    end

    if Settings and settingsCategory and type(Settings.OpenToCategory) == "function" then
        if type(settingsCategory.GetID) == "function" then
            Settings.OpenToCategory(settingsCategory:GetID())
            return
        end
        if settingsCategory.ID then
            Settings.OpenToCategory(settingsCategory.ID)
            return
        end
    end

    if type(InterfaceOptionsFrame_OpenToCategory) == "function" then
        InterfaceOptionsFrame_OpenToCategory(panel)
        InterfaceOptionsFrame_OpenToCategory(panel)
    end
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("PLAYER_LOGIN")
loader:SetScript("OnEvent", function()
    ensureSettingsPanel()
end)
