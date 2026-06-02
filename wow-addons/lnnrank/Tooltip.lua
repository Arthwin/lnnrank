local addon = _G.lnnrank

local ROLE_ICONS = {
    dps = "|T2202478:14:16:0:0:128:32:0:32:2:30|t",
    healer = "|T2202478:14:16:0:0:128:32:33:65:2:30|t",
    tank = "|T2202478:14:16:0:0:128:32:67:99:2:30|t",
}

local SPEC_ROLE_BY_NAME = {
    ["Affliction"] = "dps",
    ["Arcane"] = "dps",
    ["Arms"] = "dps",
    ["Assassination"] = "dps",
    ["Augmentation"] = "dps",
    ["Balance"] = "dps",
    ["Beast Mastery"] = "dps",
    ["Blood"] = "tank",
    ["Brewmaster"] = "tank",
    ["Demonology"] = "dps",
    ["Destruction"] = "dps",
    ["Devastation"] = "dps",
    ["Discipline"] = "healer",
    ["Elemental"] = "dps",
    ["Enhancement"] = "dps",
    ["Feral"] = "dps",
    ["Fire"] = "dps",
    ["Frost"] = "dps",
    ["Fury"] = "dps",
    ["Guardian"] = "tank",
    ["Havoc"] = "dps",
    ["Holy"] = "healer",
    ["Marksmanship"] = "dps",
    ["Mistweaver"] = "healer",
    ["Outlaw"] = "dps",
    ["Preservation"] = "healer",
    ["Protection"] = "tank",
    ["Restoration"] = "healer",
    ["Retribution"] = "dps",
    ["Shadow"] = "dps",
    ["Subtlety"] = "dps",
    ["Survival"] = "dps",
    ["Unholy"] = "dps",
    ["Vengeance"] = "tank",
    ["Windwalker"] = "dps",
}

local SPEC_VISUALS_BY_CLASS = {
    ["Death Knight"] = {
        ["Blood"] = {role = "tank", icon = "Interface\\Icons\\spell_deathknight_bloodpresence"},
        ["Frost"] = {role = "dps", icon = "Interface\\Icons\\spell_deathknight_frostpresence"},
        ["Unholy"] = {role = "dps", icon = "Interface\\Icons\\spell_deathknight_unholypresence"},
    },
    ["Demon Hunter"] = {
        ["Havoc"] = {role = "dps", icon = "Interface\\Icons\\ability_demonhunter_specdps"},
        ["Vengeance"] = {role = "tank", icon = "Interface\\Icons\\ability_demonhunter_spectank"},
    },
    ["Druid"] = {
        ["Balance"] = {role = "dps", icon = "Interface\\Icons\\spell_nature_starfall"},
        ["Feral"] = {role = "dps", icon = "Interface\\Icons\\ability_druid_catform"},
        ["Guardian"] = {role = "tank", icon = "Interface\\Icons\\ability_racial_bearform"},
        ["Restoration"] = {role = "healer", icon = "Interface\\Icons\\spell_nature_healingtouch"},
    },
    ["Evoker"] = {
        ["Augmentation"] = {role = "dps", icon = "Interface\\Icons\\classicon_evoker_augmentation"},
        ["Devastation"] = {role = "dps", icon = "Interface\\Icons\\classicon_evoker_devastation"},
        ["Preservation"] = {role = "healer", icon = "Interface\\Icons\\classicon_evoker_preservation"},
    },
    ["Hunter"] = {
        ["Beast Mastery"] = {role = "dps", icon = "Interface\\Icons\\ability_hunter_bestialdiscipline"},
        ["Marksmanship"] = {role = "dps", icon = "Interface\\Icons\\ability_hunter_focusedaim"},
        ["Survival"] = {role = "dps", icon = "Interface\\Icons\\ability_hunter_camouflage"},
    },
    ["Mage"] = {
        ["Arcane"] = {role = "dps", icon = "Interface\\Icons\\spell_holy_magicalsentry"},
        ["Fire"] = {role = "dps", icon = "Interface\\Icons\\spell_fire_firebolt02"},
        ["Frost"] = {role = "dps", icon = "Interface\\Icons\\spell_frost_frostbolt02"},
    },
    ["Monk"] = {
        ["Brewmaster"] = {role = "tank", icon = "Interface\\Icons\\spell_monk_brewmaster_spec"},
        ["Mistweaver"] = {role = "healer", icon = "Interface\\Icons\\spell_monk_mistweaver_spec"},
        ["Windwalker"] = {role = "dps", icon = "Interface\\Icons\\spell_monk_windwalker_spec"},
    },
    ["Paladin"] = {
        ["Holy"] = {role = "healer", icon = "Interface\\Icons\\spell_holy_holybolt"},
        ["Protection"] = {role = "tank", icon = "Interface\\Icons\\ability_paladin_shieldofthetemplar"},
        ["Retribution"] = {role = "dps", icon = "Interface\\Icons\\spell_holy_auraoflight"},
    },
    ["Priest"] = {
        ["Discipline"] = {role = "healer", icon = "Interface\\Icons\\spell_holy_powerwordshield"},
        ["Holy"] = {role = "healer", icon = "Interface\\Icons\\spell_holy_guardianspirit"},
        ["Shadow"] = {role = "dps", icon = "Interface\\Icons\\spell_shadow_shadowwordpain"},
    },
    ["Rogue"] = {
        ["Assassination"] = {role = "dps", icon = "Interface\\Icons\\ability_rogue_eviscerate"},
        ["Outlaw"] = {role = "dps", icon = "Interface\\Icons\\ability_rogue_waylay"},
        ["Subtlety"] = {role = "dps", icon = "Interface\\Icons\\ability_stealth"},
    },
    ["Shaman"] = {
        ["Elemental"] = {role = "dps", icon = "Interface\\Icons\\spell_nature_lightning"},
        ["Enhancement"] = {role = "dps", icon = "Interface\\Icons\\spell_shaman_improvedstormstrike"},
        ["Restoration"] = {role = "healer", icon = "Interface\\Icons\\spell_nature_magicimmunity"},
    },
    ["Warlock"] = {
        ["Affliction"] = {role = "dps", icon = "Interface\\Icons\\spell_shadow_deathcoil"},
        ["Demonology"] = {role = "dps", icon = "Interface\\Icons\\spell_shadow_metamorphosis"},
        ["Destruction"] = {role = "dps", icon = "Interface\\Icons\\spell_shadow_rainoffire"},
    },
    ["Warrior"] = {
        ["Arms"] = {role = "dps", icon = "Interface\\Icons\\ability_warrior_savageblow"},
        ["Fury"] = {role = "dps", icon = "Interface\\Icons\\ability_warrior_innerrage"},
        ["Protection"] = {role = "tank", icon = "Interface\\Icons\\ability_warrior_defensivestance"},
    },
}

local UNIQUE_SPEC_VISUALS = {
    ["Affliction"] = SPEC_VISUALS_BY_CLASS["Warlock"]["Affliction"],
    ["Arcane"] = SPEC_VISUALS_BY_CLASS["Mage"]["Arcane"],
    ["Arms"] = SPEC_VISUALS_BY_CLASS["Warrior"]["Arms"],
    ["Assassination"] = SPEC_VISUALS_BY_CLASS["Rogue"]["Assassination"],
    ["Augmentation"] = SPEC_VISUALS_BY_CLASS["Evoker"]["Augmentation"],
    ["Balance"] = SPEC_VISUALS_BY_CLASS["Druid"]["Balance"],
    ["Beast Mastery"] = SPEC_VISUALS_BY_CLASS["Hunter"]["Beast Mastery"],
    ["Blood"] = SPEC_VISUALS_BY_CLASS["Death Knight"]["Blood"],
    ["Brewmaster"] = SPEC_VISUALS_BY_CLASS["Monk"]["Brewmaster"],
    ["Demonology"] = SPEC_VISUALS_BY_CLASS["Warlock"]["Demonology"],
    ["Destruction"] = SPEC_VISUALS_BY_CLASS["Warlock"]["Destruction"],
    ["Devastation"] = SPEC_VISUALS_BY_CLASS["Evoker"]["Devastation"],
    ["Discipline"] = SPEC_VISUALS_BY_CLASS["Priest"]["Discipline"],
    ["Elemental"] = SPEC_VISUALS_BY_CLASS["Shaman"]["Elemental"],
    ["Enhancement"] = SPEC_VISUALS_BY_CLASS["Shaman"]["Enhancement"],
    ["Feral"] = SPEC_VISUALS_BY_CLASS["Druid"]["Feral"],
    ["Fire"] = SPEC_VISUALS_BY_CLASS["Mage"]["Fire"],
    ["Fury"] = SPEC_VISUALS_BY_CLASS["Warrior"]["Fury"],
    ["Guardian"] = SPEC_VISUALS_BY_CLASS["Druid"]["Guardian"],
    ["Havoc"] = SPEC_VISUALS_BY_CLASS["Demon Hunter"]["Havoc"],
    ["Marksmanship"] = SPEC_VISUALS_BY_CLASS["Hunter"]["Marksmanship"],
    ["Mistweaver"] = SPEC_VISUALS_BY_CLASS["Monk"]["Mistweaver"],
    ["Outlaw"] = SPEC_VISUALS_BY_CLASS["Rogue"]["Outlaw"],
    ["Preservation"] = SPEC_VISUALS_BY_CLASS["Evoker"]["Preservation"],
    ["Retribution"] = SPEC_VISUALS_BY_CLASS["Paladin"]["Retribution"],
    ["Shadow"] = SPEC_VISUALS_BY_CLASS["Priest"]["Shadow"],
    ["Subtlety"] = SPEC_VISUALS_BY_CLASS["Rogue"]["Subtlety"],
    ["Survival"] = SPEC_VISUALS_BY_CLASS["Hunter"]["Survival"],
    ["Unholy"] = SPEC_VISUALS_BY_CLASS["Death Knight"]["Unholy"],
    ["Vengeance"] = SPEC_VISUALS_BY_CLASS["Demon Hunter"]["Vengeance"],
    ["Windwalker"] = SPEC_VISUALS_BY_CLASS["Monk"]["Windwalker"],
}

local function toColorHex(red, green, blue)
    local r = math.floor((red or 1) * 255 + 0.5)
    local g = math.floor((green or 1) * 255 + 0.5)
    local b = math.floor((blue or 1) * 255 + 0.5)
    return string.format("%02x%02x%02x", r, g, b)
end

local function colorHexToRgb(colorHex)
    if type(colorHex) ~= "string" or string.len(colorHex) ~= 6 then
        return 1, 1, 1
    end

    local red = tonumber(string.sub(colorHex, 1, 2), 16)
    local green = tonumber(string.sub(colorHex, 3, 4), 16)
    local blue = tonumber(string.sub(colorHex, 5, 6), 16)

    if not red or not green or not blue then
        return 1, 1, 1
    end

    return red / 255, green / 255, blue / 255
end

local function colorize(colorHex, text)
    if not text or text == "" then
        return text
    end
    return string.format("|cff%s%s|r", colorHex or "ffffff", text)
end

local function compactParts(parts)
    local compacted = {}
    for _, part in ipairs(parts or {}) do
        if type(part) == "string" and part ~= "" then
            table.insert(compacted, part)
        end
    end
    return table.concat(compacted, " ")
end

local function getRoleIcon(role)
    return ROLE_ICONS[string.lower(tostring(role or ""))]
end

local function resolveDisplayRole(record)
    if type(record) ~= "table" then
        return nil
    end

    local explicitRole = string.lower(tostring(record.role or ""))
    if ROLE_ICONS[explicitRole] then
        return explicitRole
    end

    if type(record.specName) == "string" and SPEC_ROLE_BY_NAME[record.specName] then
        return SPEC_ROLE_BY_NAME[record.specName]
    end

    return nil
end

local function getSpecVisual(specName, className)
    if type(className) == "string" then
        local classBucket = SPEC_VISUALS_BY_CLASS[className]
        if classBucket and classBucket[specName] then
            return classBucket[specName]
        end
    end

    return UNIQUE_SPEC_VISUALS[specName]
end

local function buildSpecIcon(specName, className, role)
    local visual = getSpecVisual(specName, className)
    if visual and visual.icon then
        return string.format("|T%s:14:14:0:0|t", visual.icon)
    end

    return getRoleIcon(role)
end

local function getHighestLevelText(dungeon)
    if type(dungeon) ~= "table" then
        return nil
    end

    if type(dungeon.highestLevelText) == "string" and dungeon.highestLevelText ~= "" then
        return dungeon.highestLevelText
    end

    if type(dungeon.highestLevel) == "number" then
        return string.format("+%d", dungeon.highestLevel)
    end

    return nil
end

local function getWarcraftLogsPercentColor(percent)
    if type(percent) ~= "number" then
        return "ffffff"
    end
    if percent >= 100 then
        return "e5cc80"
    end
    if percent >= 99 then
        return "e268ff"
    end
    if percent >= 95 then
        return "ff8000"
    end
    if percent >= 75 then
        return "a335ee"
    end
    if percent >= 50 then
        return "0070dd"
    end
    if percent >= 25 then
        return "1eff00"
    end
    return "9d9d9d"
end

local function getWarcraftLogsScoreColor(score)
    if type(score) ~= "number" then
        return "9d9d9d"
    end
    if score >= 3600 then
        return "e5cc80"
    end
    if score >= 3400 then
        return "e268ff"
    end
    if score >= 3200 then
        return "ff8000"
    end
    if score >= 3000 then
        return "a335ee"
    end
    if score >= 2400 then
        return "0070dd"
    end
    if score >= 1400 then
        return "1eff00"
    end
    return "9d9d9d"
end

local function getWarcraftLogsScoreRgb(score)
    return colorHexToRgb(getWarcraftLogsScoreColor(score))
end

local WCL_SCORE_PERCENT_ANCHORS = {
    {0, 0},
    {900, 20},
    {1600, 35},
    {2200, 50},
    {2800, 70},
    {3200, 85},
    {3600, 100},
}

local CURRENT_SEASON_DUNGEON_COUNT = 8

local TONE_HEX_BY_RANK = {
    [0] = "9d9d9d",
    [1] = "1eff00",
    [2] = "0070dd",
    [3] = "a335ee",
    [4] = "ff8000",
    [5] = "e268ff",
    [6] = "e5cc80",
}

local function clampToneRank(rank)
    local numeric = tonumber(rank)
    if type(numeric) ~= "number" then
        return nil
    end

    local rounded = math.floor(numeric + 0.5)
    if rounded < 0 then
        return 0
    end
    if rounded > 6 then
        return 6
    end
    return rounded
end

local function getToneHexFromRank(rank)
    local clamped = clampToneRank(rank)
    if clamped == nil then
        return nil
    end

    return TONE_HEX_BY_RANK[clamped]
end

local function interpolateAnchoredPercent(value, anchors)
    if type(value) ~= "number" or type(anchors) ~= "table" or #anchors == 0 then
        return nil
    end

    if value <= anchors[1][1] then
        return anchors[1][2]
    end

    for index = 2, #anchors do
        local left = anchors[index - 1]
        local right = anchors[index]
        local leftScore = left[1]
        local leftPercent = left[2]
        local rightScore = right[1]
        local rightPercent = right[2]
        if value <= rightScore then
            local span = rightScore - leftScore
            if span <= 0 then
                return rightPercent
            end
            local ratio = (value - leftScore) / span
            return leftPercent + (rightPercent - leftPercent) * ratio
        end
    end

    return anchors[#anchors][2]
end

local function averageDefinedValues(values)
    local total = 0
    local count = 0

    for _, value in ipairs(values or {}) do
        if type(value) == "number" then
            total = total + value
            count = count + 1
        end
    end

    if count == 0 then
        return nil
    end

    return total / count
end

local function getWarcraftLogsPercentRank(percent)
    if type(percent) ~= "number" then
        return nil
    end
    if percent >= 100 then
        return 6
    end
    if percent >= 99 then
        return 5
    end
    if percent >= 95 then
        return 4
    end
    if percent >= 75 then
        return 3
    end
    if percent >= 50 then
        return 2
    end
    if percent >= 25 then
        return 1
    end
    return 0
end

local function getWarcraftLogsScoreRank(score)
    if type(score) ~= "number" then
        return nil
    end
    if score >= 3600 then
        return 6
    end
    if score >= 3400 then
        return 5
    end
    if score >= 3200 then
        return 4
    end
    if score >= 3000 then
        return 3
    end
    if score >= 2400 then
        return 2
    end
    if score >= 1400 then
        return 1
    end
    return 0
end

local function getWarcraftLogsScorePerformancePercent(score)
    return interpolateAnchoredPercent(score, WCL_SCORE_PERCENT_ANCHORS)
end

local function getHighestLevelColorHex(dungeon)
    if type(dungeon) ~= "table" then
        return nil
    end

    if type(dungeon.highestLevelColorHex) == "string" and dungeon.highestLevelColorHex ~= "" then
        return dungeon.highestLevelColorHex
    end

    if type(dungeon.highestLevelPoints) == "number" then
        return getWarcraftLogsPercentColor(
            getWarcraftLogsScorePerformancePercent(dungeon.highestLevelPoints * CURRENT_SEASON_DUNGEON_COUNT)
        )
    end

    return "d7d7d7"
end

local function getAverageParsePercent(record)
    local presentation = type(record) == "table" and record.presentation or nil
    if type(presentation) == "table" and type(presentation.averageParsePercent) == "number" then
        return presentation.averageParsePercent
    end

    local dungeons = type(record) == "table" and record.dungeons or nil
    if type(dungeons) ~= "table" then
        return nil
    end

    local total = 0
    local count = 0
    for _, dungeon in ipairs(dungeons) do
        if type(dungeon) == "table" and type(dungeon.bestPercent) == "number" then
            total = total + dungeon.bestPercent
            count = count + 1
        end
    end

    if count == 0 then
        return nil
    end

    return total / count
end

local function getAverageParseColorHex(record, averageParse)
    local presentation = type(record) == "table" and record.presentation or nil
    if type(presentation) == "table" and type(presentation.averageParseColorHex) == "string" and
        presentation.averageParseColorHex ~= "" then
        return presentation.averageParseColorHex
    end

    return getWarcraftLogsPercentColor(averageParse)
end

local getBlendedPercent

local function getNameColorHex(record, averageParse)
    local presentation = type(record) == "table" and record.presentation or nil
    if type(presentation) == "table" and type(presentation.nameColorHex) == "string" and
        presentation.nameColorHex ~= "" then
        return presentation.nameColorHex
    end

    local blendedPercent = getBlendedPercent(record, averageParse)
    local blendedHex = getWarcraftLogsPercentColor(blendedPercent)
    if blendedHex and blendedHex ~= "" then
        return blendedHex
    end

    return getAverageParseColorHex(record, averageParse)
end

getBlendedPercent = function(record, averageParse)
    local presentation = type(record) == "table" and record.presentation or nil
    if type(presentation) == "table" and type(presentation.blendedPercent) == "number" then
        return presentation.blendedPercent
    end

    local blendedPercent = averageDefinedValues({
        averageParse,
        getWarcraftLogsScorePerformancePercent(type(record) == "table" and record.score or nil),
    })

    if blendedPercent ~= nil then
        return blendedPercent
    end

    return getWarcraftLogsScorePerformancePercent(type(record) == "table" and record.score or nil)
end

local function getBlendedPercentColorHex(record, averageParse)
    local presentation = type(record) == "table" and record.presentation or nil
    if type(presentation) == "table" and type(presentation.blendedPercentColorHex) == "string" and
        presentation.blendedPercentColorHex ~= "" then
        return presentation.blendedPercentColorHex
    end

    return getWarcraftLogsPercentColor(getBlendedPercent(record, averageParse))
end

local function addBlankLine(tooltip)
    if tooltip and type(tooltip.NumLines) == "function" and tooltip:NumLines() > 0 then
        tooltip:AddLine(" ")
    end
end

local function resolveUnitToken(data)
    if type(data) == "table" and type(data.lines) == "table" then
        for _, line in pairs(data.lines) do
            if line.type == Enum.TooltipDataLineType.UnitName and line.unitToken then
                return line.unitToken
            end
        end
    end

    if type(data) == "table" and data.guid and type(UnitTokenFromGUID) == "function" then
        return UnitTokenFromGUID(data.guid)
    end

    return nil
end

local function renderHeader(tooltip)
    tooltip:AddLine("|cffffd100LÑÑRank|r")
end

local function renderStatus(tooltip, status, queuedLocally)
    renderHeader(tooltip)
    if type(status) ~= "table" or status.state == nil then
        if queuedLocally then
            tooltip:AddLine("|cffffcc66Lookup queued locally.|r")
            tooltip:AddLine("|cffd7d7d7Let the desktop app sync, then reload WoW to import the result.|r")
        else
            tooltip:AddLine("|cffffff99No data found.|r")
            tooltip:AddLine("|cffd7d7d7Ctrl-click to search.|r")
        end
        return
    end

    if status.state == "not_found" then
        tooltip:AddLine("|cffffff99No data found.|r")
        tooltip:AddLine("|cffd7d7d7Ctrl-click to search.|r")
        return
    end

    if status.state == "cached" then
        tooltip:AddLine("|cff99ff99Using cached data.|r")
    elseif status.state == "canceled" then
        tooltip:AddLine("|cffffff99Lookup canceled locally.|r")
    elseif status.state == "disabled" then
        tooltip:AddLine("|cffffff99Live lookup disabled.|r")
    elseif status.state == "api_cooldown" then
        tooltip:AddLine("|cffffff99API cooldown active.|r")
    elseif status.state == "stale_cached" then
        tooltip:AddLine("|cffffff99Using stale cached data.|r")
    elseif status.state == "found" then
        tooltip:AddLine("|cff99ff99Live data imported. Reload if needed.|r")
    elseif status.state == "not_found" then
        tooltip:AddLine("|cffff9999No LÑÑRank data found.|r")
    elseif status.state == "rate_limited" then
        tooltip:AddLine("|cffff9999Warcraft Logs API rate limited.|r")
    elseif status.state == "error" then
        tooltip:AddLine("|cffff9999Live search failed.|r")
    else
        tooltip:AddLine("|cffffcc66Searching...|r")
    end

    if type(status.message) == "string" and status.message ~= "" then
        tooltip:AddLine(status.message)
    end
end

local function renderRecord(tooltip, record)
    renderHeader(tooltip)
    local averageParse = getAverageParsePercent(record)
    local averageParseText = averageParse and string.format("%.1f%%", averageParse) or nil
    local averageParseColorHex = getAverageParseColorHex(record, averageParse)
    local blendedPercent = getBlendedPercent(record, averageParse)
    local blendedPercentText = blendedPercent and string.format("%.1f%%", blendedPercent) or nil
    local nameColorHex = getNameColorHex(record, averageParse)
    local blendedPercentColorHex = getBlendedPercentColorHex(record, averageParse)
    local characterName = type(record.name) == "string" and record.name or "Character"
    local roleIcon = getRoleIcon(resolveDisplayRole(record))
    tooltip:AddDoubleLine(
        colorize(nameColorHex, characterName),
        compactParts({
            roleIcon,
            blendedPercentText and colorize(blendedPercentColorHex, blendedPercentText) or nil,
        })
    )

    local summaryText = compactParts({
        averageParseText and colorize(averageParseColorHex, averageParseText) or colorize("9d9d9d", "-"),
        "|cffd7d7d7-|r",
        type(record.score) == "number" and colorize(getWarcraftLogsScoreColor(record.score), addon.FormatMetric(record.score)) or
            colorize("9d9d9d", "-"),
    })
    tooltip:AddDoubleLine(colorize("f2f2f2", "Summary"), summaryText)

    if type(record.dungeons) == "table" then
        for _, dungeon in ipairs(record.dungeons) do
            local label = dungeon.label or dungeon.name or "Dungeon"
            local bestPercent = dungeon.bestPercent and string.format("%.1f%%", dungeon.bestPercent) or "-"
            local highestLevelText = getHighestLevelText(dungeon)
            local highestLevelColorHex = getHighestLevelColorHex(dungeon)
            local dungeonText = compactParts({
                colorize(getWarcraftLogsPercentColor(dungeon.bestPercent), bestPercent),
                highestLevelText and "|cffd7d7d7-|r" or nil,
                highestLevelText and colorize(highestLevelColorHex, highestLevelText) or nil,
            })
            tooltip:AddDoubleLine(colorize("f2f2f2", label), dungeonText ~= "" and dungeonText or bestPercent)
        end
    end

    tooltip:AddLine("|cffd7d7d7Ctrl-click to refresh.|r")
end

function addon.AppendCharacterTooltip(tooltip, region, realmName, characterName)
    if not tooltip or not region or not realmName or not characterName then
        return false
    end

    if InCombatLockdown() and not addon.ShouldShowInCombat() then
        return false
    end

    local record = addon.LookupCharacter(region, realmName, characterName)
    local status = addon.LookupCharacterStatus(region, realmName, characterName)
    local queuedLocally = type(addon.HasQueuedRequest) == "function" and
        addon.HasQueuedRequest(region, realmName, characterName)

    if not record and not addon.ShouldShowSearching() and not queuedLocally then
        return false
    end

    addBlankLine(tooltip)
    if record then
        renderRecord(tooltip, record)
    else
        renderStatus(tooltip, status, queuedLocally)
    end

    tooltip:Show()
    return true
end

local function onTooltipUnit(tooltip, data)
    if tooltip ~= GameTooltip or (InCombatLockdown() and not addon.ShouldShowInCombat()) then
        return
    end

    local unitToken = resolveUnitToken(data)
    if not unitToken or not UnitIsPlayer(unitToken) then
        return
    end

    local characterName, realmName = UnitName(unitToken)
    if not characterName then
        return
    end

    if not realmName or realmName == "" then
        realmName = GetNormalizedRealmName() or GetRealmName()
    end

    local region = addon.GetCurrentRegionSlug()
    addon.AppendCharacterTooltip(tooltip, region, realmName, characterName)
end
TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Unit, onTooltipUnit)
