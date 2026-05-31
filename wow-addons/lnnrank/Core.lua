local addonName, ns = ...

local addon = _G.lnnrank or {}
_G.lnnrank = addon

ns.runtime = ns.runtime or {}
ns.runtime.data = ns.runtime.data or { characters = {} }

local defaults = {
    settings = {
        showSearching = true,
        showInCombat = true,
        scanGroupMembers = true,
        scanApplicants = true,
        minimapAngle = 225,
        passiveChannelEnabled = false,
    },
    requests = {},
    groupMembers = {},
    applicants = {},
    lastImportedBuild = nil,
    pendingOpenLfgOnLogin = false,
}

local regionFallbackById = {
    [1] = "us",
    [2] = "kr",
    [3] = "eu",
    [4] = "tw",
    [5] = "cn",
}

local function copyDefaults(target, source)
    for key, value in pairs(source) do
        if type(value) == "table" then
            if type(target[key]) ~= "table" then
                target[key] = {}
            end
            copyDefaults(target[key], value)
        elseif target[key] == nil then
            target[key] = value
        end
    end
end

local function getDb()
    if type(_G.lnnrankDB) ~= "table" then
        _G.lnnrankDB = {}
    end
    copyDefaults(_G.lnnrankDB, defaults)
    return _G.lnnrankDB
end

function addon.GetDb()
    return getDb()
end

local function getNowUnix()
    if type(time) == "function" then
        return time()
    end
    return 0
end

function addon.GetCurrentRegionSlug()
    if type(GetCurrentRegionName) == "function" then
        local regionName = GetCurrentRegionName()
        if type(regionName) == "string" and regionName ~= "" then
            return string.lower(regionName)
        end
    end

    if type(GetCurrentRegion) == "function" then
        local regionId = GetCurrentRegion()
        if regionFallbackById[regionId] then
            return regionFallbackById[regionId]
        end
    end

    return "us"
end

function addon.NormalizeRealmKey(value)
    local normalized = string.lower(tostring(value or ""))
    normalized = normalized:gsub("%s+", "")
    normalized = normalized:gsub("[%p]", "")
    return normalized
end

function addon.NormalizeNameKey(value)
    return string.lower(tostring(value or ""))
end

function addon.FormatMetric(value)
    if type(value) ~= "number" then
        return "-"
    end

    if math.floor(value) == value then
        return tostring(value)
    end

    return string.format("%.1f", value)
end

local function parseIsoTimestamp(value)
    if type(value) ~= "string" then
        return nil
    end

    local year, month, day, hour, minute, second = string.match(
        value,
        "^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)"
    )
    if not year then
        return nil
    end

    return time({
        year = tonumber(year),
        month = tonumber(month),
        day = tonumber(day),
        hour = tonumber(hour),
        min = tonumber(minute),
        sec = tonumber(second),
    })
end

function addon.GetRefreshAfterSeconds()
    local manifest = ns.runtime.data and ns.runtime.data.manifest or nil
    if manifest and type(manifest.refreshAfterSeconds) == "number" then
        return manifest.refreshAfterSeconds
    end

    return 86400
end

function addon.GetRecordUpdatedAtUnix(record)
    if type(record) ~= "table" then
        return nil
    end

    if type(record.updatedAtUnix) == "number" then
        return record.updatedAtUnix
    end

    return parseIsoTimestamp(record.updatedAt)
end

function addon.IsRecordStale(record)
    local updatedAtUnix = addon.GetRecordUpdatedAtUnix(record)
    if type(updatedAtUnix) ~= "number" then
        return true
    end

    return (getNowUnix() - updatedAtUnix) > addon.GetRefreshAfterSeconds()
end

function addon.FormatLastUpdated(record)
    local updatedAtUnix = addon.GetRecordUpdatedAtUnix(record)
    if type(updatedAtUnix) ~= "number" then
        return record and record.updatedAt or "Unknown"
    end

    local formatted = date("%Y-%m-%d %H:%M", updatedAtUnix)
    if addon.IsRecordStale(record) then
        return string.format("%s (stale)", formatted)
    end

    return formatted
end

function addon.ImportCompanionData(data)
    if type(data) ~= "table" or type(data.characters) ~= "table" then
        return false
    end

    ns.runtime.data = data
    local db = getDb()
    db.lastImportedBuild = data.manifest and data.manifest.builtAt or nil
    addon.PruneSatisfiedRequests()
    addon.NotifyStateChanged()
    return true
end

function addon.LookupCharacter(region, realmKey, characterName)
    local data = ns.runtime.data
    if type(data) ~= "table" or type(data.characters) ~= "table" then
        return nil
    end

    local regionBucket = data.characters[addon.NormalizeNameKey(region)]
    if type(regionBucket) ~= "table" then
        return nil
    end

    local realmBucket = regionBucket[addon.NormalizeRealmKey(realmKey)]
    if type(realmBucket) ~= "table" then
        return nil
    end

    return realmBucket[addon.NormalizeNameKey(characterName)]
end

function addon.LookupCharacterStatus(region, realmKey, characterName)
    local data = ns.runtime.data
    if type(data) ~= "table" or type(data.statuses) ~= "table" then
        return nil
    end

    local regionBucket = data.statuses[addon.NormalizeNameKey(region)]
    if type(regionBucket) ~= "table" then
        return nil
    end

    local realmBucket = regionBucket[addon.NormalizeRealmKey(realmKey)]
    if type(realmBucket) ~= "table" then
        return nil
    end

    return realmBucket[addon.NormalizeNameKey(characterName)]
end

function addon.BuildRequestKey(region, realmKey, characterName)
    return table.concat({
        addon.NormalizeNameKey(region),
        addon.NormalizeRealmKey(realmKey),
        addon.NormalizeNameKey(characterName),
    }, ":")
end

function addon.HasQueuedRequest(region, realmKey, characterName)
    local requestKey = addon.BuildRequestKey(region, realmKey, characterName)
    return getDb().requests[requestKey] ~= nil
end

function addon.GetStatusUpdatedAtUnix(status)
    if type(status) ~= "table" then
        return nil
    end

    return parseIsoTimestamp(status.updatedAt)
end

function addon.IsStatusStale(status)
    local updatedAtUnix = addon.GetStatusUpdatedAtUnix(status)
    if type(updatedAtUnix) ~= "number" then
        return true
    end

    return (getNowUnix() - updatedAtUnix) > addon.GetRefreshAfterSeconds()
end

function addon.ShouldAutoQueueLookup(region, realmKey, characterName)
    if not region or not realmKey or not characterName then
        return false
    end

    if addon.HasQueuedRequest(region, realmKey, characterName) then
        return false
    end

    local record = addon.LookupCharacter(region, realmKey, characterName)
    if type(record) == "table" and not addon.IsRecordStale(record) then
        return false
    end

    local status = addon.LookupCharacterStatus(region, realmKey, characterName)
    if type(status) ~= "table" then
        return true
    end

    return addon.IsStatusStale(status)
end

function addon.QueueRequest(region, realmKey, characterName)
    local db = getDb()
    local requestKey = addon.BuildRequestKey(region, realmKey, characterName)

    local existing = db.requests[requestKey] or {}
    existing.region = region
    existing.realm = realmKey
    existing.characterName = characterName
    existing.queuedAt = existing.queuedAt or getNowUnix()
    existing.lastSeenAt = getNowUnix()
    existing.seenCount = (existing.seenCount or 0) + 1
    db.requests[requestKey] = existing
    addon.NotifyStateChanged()

    return existing
end

function addon.GetQueuedRequest(region, realmKey, characterName)
    local requestKey = addon.BuildRequestKey(region, realmKey, characterName)
    return getDb().requests[requestKey]
end

function addon.PruneSatisfiedRequests()
    local db = getDb()
    local removed = 0

    for requestKey, request in pairs(db.requests) do
        if addon.LookupCharacter(request.region, request.realm, request.characterName) or
            addon.LookupCharacterStatus(request.region, request.realm, request.characterName) then
            db.requests[requestKey] = nil
            removed = removed + 1
        end
    end

    return removed
end

function addon.GetQueuedRequestCount()
    local queued = 0
    for _ in pairs(getDb().requests) do
        queued = queued + 1
    end
    return queued
end

function addon.PruneQueuedRequestsBySource(source, activeEntries)
    local db = getDb()
    local active = type(activeEntries) == "table" and activeEntries or {}
    local removed = 0

    for requestKey, request in pairs(db.requests) do
        if request and request.source == source and not active[requestKey] then
            db.requests[requestKey] = nil
            removed = removed + 1
        end
    end

    if removed > 0 then
        addon.NotifyStateChanged()
    end

    return removed
end

function addon.NotifyStateChanged()
    if type(addon.UpdateMinimapButtonState) == "function" then
        addon.UpdateMinimapButtonState()
    end
end

function addon.ReplaceSnapshotBucket(bucketName, entries)
    local db = getDb()
    db[bucketName] = type(entries) == "table" and entries or {}
    addon.NotifyStateChanged()
end

function addon.GetSnapshotBucket(bucketName)
    local db = getDb()
    if type(db[bucketName]) ~= "table" then
        db[bucketName] = {}
    end
    return db[bucketName]
end

function addon.ShouldShowSearching()
    return getDb().settings.showSearching == true
end

function addon.ShouldShowInCombat()
    return getDb().settings.showInCombat == true
end

function addon.ShouldScanGroupMembers()
    return getDb().settings.scanGroupMembers == true
end

function addon.ShouldScanApplicants()
    return getDb().settings.scanApplicants == true
end

function addon.GetStatusSummary()
    local db = getDb()
    local manifest = ns.runtime.data and ns.runtime.data.manifest or nil
    return {
        queued = addon.GetQueuedRequestCount(),
        build = db.lastImportedBuild or (manifest and manifest.builtAt) or "none",
        mode = manifest and manifest.mode or "reload-required",
    }
end

function addon.FlagOpenLfgOnNextLogin(restoreMode)
    local db = getDb()
    if restoreMode == "search" or
        restoreMode == "applications" or
        restoreMode == "entry" or
        restoreMode == "activity" or
        restoreMode == "category" then
        db.pendingOpenLfgOnLogin = restoreMode
    else
        db.pendingOpenLfgOnLogin = false
    end
end

local function restoreSpecificLfgPanel(panelKey)
    if type(LFGListFrame_SetActivePanel) == "function" and LFGListFrame then
        if panelKey == "applications" and LFGListFrame.ApplicationViewer then
            LFGListFrame_SetActivePanel(LFGListFrame.ApplicationViewer)
            return true
        end
        if panelKey == "search" and LFGListFrame.SearchPanel then
            LFGListFrame_SetActivePanel(LFGListFrame.SearchPanel)
            return true
        end
        if panelKey == "entry" and LFGListFrame.EntryCreation then
            LFGListFrame_SetActivePanel(LFGListFrame.EntryCreation)
            return true
        end
        if panelKey == "activity" and LFGListFrame.EntryCreationActivityFinder then
            LFGListFrame_SetActivePanel(LFGListFrame.EntryCreationActivityFinder)
            return true
        end
        if panelKey == "category" and LFGListFrame.CategorySelection then
            LFGListFrame_SetActivePanel(LFGListFrame.CategorySelection)
            return true
        end
    end

    if panelKey == "applications" and type(GroupFinderFrame_ShowGroupFrame) == "function" then
        GroupFinderFrame_ShowGroupFrame()
        return true
    end

    return false
end

local function openLfgFrameNow(panelKey)
    if InCombatLockdown() then
        return false
    end

    local opened = false

    if type(PVEFrame_ShowFrame) == "function" then
        if LFGListPVEStub then
            PVEFrame_ShowFrame("GroupFinderFrame", LFGListPVEStub)
            opened = true
        elseif LFGListFrame then
            PVEFrame_ShowFrame("GroupFinderFrame", LFGListFrame)
            opened = true
        end
    end

    if not opened and type(PVEFrame_ToggleFrame) == "function" then
        if LFGListPVEStub then
            PVEFrame_ToggleFrame("GroupFinderFrame", nil, LFGListPVEStub)
        elseif LFGListFrame then
            PVEFrame_ToggleFrame("GroupFinderFrame", nil, LFGListFrame)
        else
            PVEFrame_ToggleFrame("GroupFinderFrame")
        end
        opened = true
    end

    restoreSpecificLfgPanel(panelKey)

    return opened
end

function addon.RestoreLfgAfterReload()
    local db = getDb()
    local panelKey = db.pendingOpenLfgOnLogin
    if panelKey ~= "search" and
        panelKey ~= "applications" and
        panelKey ~= "entry" and
        panelKey ~= "activity" and
        panelKey ~= "category" then
        return
    end

    db.pendingOpenLfgOnLogin = false

    local attempts = 0
    local function tryOpen()
        attempts = attempts + 1
        if openLfgFrameNow(panelKey) or attempts >= 6 then
            return
        end

        if type(C_Timer) == "table" and type(C_Timer.After) == "function" then
            C_Timer.After(0.5, tryOpen)
        end
    end

    if type(C_Timer) == "table" and type(C_Timer.After) == "function" then
        C_Timer.After(0.75, tryOpen)
    else
        tryOpen()
    end
end

function addon.Print(message)
    print(string.format("|cff6ad6ff%s|r %s", addonName, tostring(message)))
end

local function handleSlashCommand(message)
    local command, value = string.match(message or "", "^(%S*)%s*(.-)$")
    command = string.lower(command or "")
    value = string.lower(value or "")

    if command == "status" then
        local status = addon.GetStatusSummary()
        addon.Print(string.format("build=%s, queued=%d, mode=%s", status.build, status.queued, status.mode))
        return
    end

    if command == "searching" then
        local db = getDb()
        db.settings.showSearching = value ~= "off"
        addon.Print(string.format("searching lines %s", db.settings.showSearching and "enabled" or "disabled"))
        return
    end

    if command == "combat" then
        local db = getDb()
        db.settings.showInCombat = value ~= "off"
        addon.Print(string.format("combat tooltips %s", db.settings.showInCombat and "enabled" or "disabled"))
        return
    end

    if command == "group" then
        local db = getDb()
        db.settings.scanGroupMembers = value ~= "off"
        addon.Print(string.format("group and raid snapshot scans %s", db.settings.scanGroupMembers and "enabled" or "disabled"))
        if type(addon.ScheduleCollectors) == "function" then
            addon.ScheduleCollectors(0.1)
        end
        return
    end

    if command == "applicants" then
        local db = getDb()
        db.settings.scanApplicants = value ~= "off"
        addon.Print(string.format("LFG applicant snapshot scans %s", db.settings.scanApplicants and "enabled" or "disabled"))
        if type(addon.ScheduleCollectors) == "function" then
            addon.ScheduleCollectors(0.1)
        end
        return
    end

    if command == "rescan" then
        if type(addon.ScheduleCollectors) == "function" then
            addon.ScheduleCollectors(0.1)
        end
        addon.Print("Scheduled a group and applicant rescan.")
        return
    end

    if command == "passive" then
        if value == "on" and type(addon.SetPassiveChannelEnabled) == "function" then
            addon.SetPassiveChannelEnabled(true)
            addon.Print("Passive self-channel bridge enabled.")
            return
        end

        if value == "off" and type(addon.SetPassiveChannelEnabled) == "function" then
            addon.SetPassiveChannelEnabled(false)
            addon.Print("Passive self-channel bridge disabled.")
            return
        end

        if type(addon.GetPassiveChannelDebugState) == "function" then
            local passive = addon.GetPassiveChannelDebugState()
            addon.Print(string.format(
                "passive=%s joined=%s channel=%s seq=%d",
                passive.enabled and "on" or "off",
                passive.joined and "yes" or "no",
                passive.channelName or "none",
                passive.sequence or 0
            ))
            return
        end
    end

    addon.Print("commands: /lnnrank status | searching on/off | combat on/off | group on/off | applicants on/off | passive on/off/status | rescan")
end

SLASH_LNNRANK1 = "/lnnrank"
SlashCmdList.LNNRANK = handleSlashCommand

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent", function(_, event, arg1)
    if event == "ADDON_LOADED" then
        if arg1 == addonName then
            getDb()
            if type(_G.lnnrankCompanionData) == "table" then
                addon.ImportCompanionData(_G.lnnrankCompanionData)
            end
        elseif arg1 == "lnnrank_companion" then
            addon.ImportCompanionData(_G.lnnrankCompanionData)
        end
    elseif event == "PLAYER_LOGIN" then
        if type(_G.lnnrankCompanionData) == "table" then
            addon.ImportCompanionData(_G.lnnrankCompanionData)
        end
        addon.RestoreLfgAfterReload()
    end
end)
