local addonName, ns = ...
local addon = _G.lnnrank

if not addon then
    return
end

local frame = CreateFrame("Frame")
local pendingUpdate = false
local startedByAddon = false

local function getCurrentInstanceInfo()
    if type(GetInstanceInfo) == "function" then
        local ok, name, instanceType, difficultyID, difficultyName, maxPlayers, _dynamicDifficulty, _isDynamic, mapID =
            pcall(GetInstanceInfo)
        if ok then
            return {
                name = name,
                instanceType = instanceType,
                difficultyID = tonumber(difficultyID),
                difficultyName = difficultyName,
                maxPlayers = maxPlayers,
                mapID = mapID,
                fromInstanceInfo = true,
            }
        end
    end

    if type(IsInInstance) == "function" then
        local inInstance, instanceType = IsInInstance()
        if inInstance then
            return {
                instanceType = instanceType,
                fromInstanceInfo = false,
            }
        end
    end

    return nil
end

local function hasInstanceDifficulty(info)
    if type(info) ~= "table" then
        return false
    end

    if type(info.difficultyID) == "number" and info.difficultyID > 0 then
        return true
    end

    local difficultyName = tostring(info.difficultyName or "")
    return difficultyName ~= "" and difficultyName ~= "None"
end

local function shouldAutoLogCurrentInstance()
    if type(addon.ShouldAutoCombatLogInstances) == "function" and not addon.ShouldAutoCombatLogInstances() then
        return false
    end

    local info = getCurrentInstanceInfo()
    if type(info) ~= "table" or not info.instanceType then
        return false
    end

    if info.instanceType == "raid" then
        return true
    end

    if info.instanceType == "party" then
        return info.fromInstanceInfo == false or hasInstanceDifficulty(info)
    end

    if info.instanceType == "scenario" then
        return info.fromInstanceInfo == false or hasInstanceDifficulty(info)
    end

    return false
end

local function setCombatLogging(enabled)
    if type(LoggingCombat) ~= "function" then
        return false
    end

    local ok = pcall(LoggingCombat, enabled == true)
    return ok == true
end

function addon.UpdateAutoCombatLogging()
    pendingUpdate = false

    if type(LoggingCombat) ~= "function" then
        return
    end

    local currentLoggingState = LoggingCombat()
    local shouldLog = shouldAutoLogCurrentInstance()
    local isLogging = currentLoggingState == true or currentLoggingState == 1

    if shouldLog then
        if isLogging then
            return
        end

        if setCombatLogging(true) then
            startedByAddon = true
            addon.Print("WoW combat logging enabled for this instance.")
        end
        return
    end

    if startedByAddon and isLogging then
        if setCombatLogging(false) then
            addon.Print("WoW combat logging disabled after leaving the instance.")
        end
    end

    startedByAddon = false
end

local function scheduleUpdate(delaySeconds)
    if pendingUpdate then
        return
    end

    pendingUpdate = true
    local delay = delaySeconds or 0
    if type(C_Timer) == "table" and type(C_Timer.After) == "function" then
        C_Timer.After(delay, addon.UpdateAutoCombatLogging)
    else
        addon.UpdateAutoCombatLogging()
    end
end

frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("ZONE_CHANGED_NEW_AREA")
frame:RegisterEvent("PLAYER_DIFFICULTY_CHANGED")
frame:RegisterEvent("CHALLENGE_MODE_START")
frame:RegisterEvent("CHALLENGE_MODE_RESET")
frame:RegisterEvent("CHALLENGE_MODE_COMPLETED")
frame:SetScript("OnEvent", function(_, event)
    if event == "CHALLENGE_MODE_START" then
        scheduleUpdate(1)
    elseif event == "ZONE_CHANGED_NEW_AREA" then
        scheduleUpdate(0)
    elseif event == "PLAYER_LOGIN" or event == "PLAYER_ENTERING_WORLD" then
        scheduleUpdate(4)
    else
        scheduleUpdate(3)
    end
end)
