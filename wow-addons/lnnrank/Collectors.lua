local addon = _G.lnnrank

if not addon then
    return
end

local scanFrame = CreateFrame("Frame")
local scanScheduled = false
local APPLICANT_POLL_SECONDS = 1
local lastApplicantRelayStateKey = nil
local lastGroupRelayStateKey = nil
local refreshApplicantFrameBindings
local ACTIVE_APPLICANT_STATUSES = {
    applied = true,
}

local function isFrameShown(frame)
    return frame and type(frame.IsShown) == "function" and frame:IsShown()
end

local function isApplicantHeartbeatContextActive()
    if not isFrameShown(GroupFinderFrame) or not LFGListFrame or not LFGListFrame.ApplicationViewer then
        return false
    end

    if LFGListFrame.activePanel == LFGListFrame.ApplicationViewer then
        return true
    end

    return isFrameShown(LFGListFrame.ApplicationViewer)
end

local function hasActiveLfgEntry()
    return type(C_LFGList) == "table" and
        type(C_LFGList.HasActiveEntryInfo) == "function" and
        C_LFGList.HasActiveEntryInfo() == true
end

local function resetApplicantRelayState()
    lastApplicantRelayStateKey = nil
end

local function resetGroupRelayState()
    lastGroupRelayStateKey = nil
end

local function buildApplicantRelayMemberToken(member)
    if type(member) ~= "table" or not member.characterName or not member.realm then
        return nil
    end

    return table.concat({
        tostring(member.groupID or 0),
        tostring(member.memberIndex or 0),
        tostring(member.characterName),
        tostring(member.realm),
        tostring(member.class or ""),
        tostring(member.assignedRole or ""),
    }, "~")
end

local function buildApplicantRelayStateKey(region, members)
    local tokens = {}
    if type(members) == "table" then
        for index = 1, #members do
            local token = buildApplicantRelayMemberToken(members[index])
            if token and token ~= "" then
                table.insert(tokens, token)
            end
        end
    end

    table.sort(tokens)

    return table.concat({
        tostring(region or "us"),
        tostring(#tokens),
        #tokens > 0 and table.concat(tokens, "|") or "empty",
    }, "::")
end

local function buildGroupRelayStateKey(region, members)
    local tokens = {}
    if type(members) == "table" then
        for index = 1, #members do
            local member = members[index]
            if type(member) == "table" and member.characterName and member.realm then
                table.insert(tokens, table.concat({
                    tostring(member.groupID or 0),
                    tostring(member.memberIndex or 0),
                    tostring(member.characterName),
                    tostring(member.realm),
                    tostring(member.class or ""),
                    tostring(member.assignedRole or ""),
                    tostring(member.unitToken or ""),
                }, "~"))
            end
        end
    end

    table.sort(tokens)

    return table.concat({
        tostring(region or "us"),
        tostring(#tokens),
        #tokens > 0 and table.concat(tokens, "|") or "empty",
    }, "::")
end

local function maybePublishGroupRelaySnapshot(region, members)
    if type(addon.PublishGroupStatusSnapshot) ~= "function" then
        return
    end

    local stateKey = buildGroupRelayStateKey(region, members)
    if stateKey == lastGroupRelayStateKey then
        return
    end

    if addon.PublishGroupStatusSnapshot(region, members) then
        lastGroupRelayStateKey = stateKey
        return
    end

    resetGroupRelayState()
end

local function normalizeApplicantStatusValue(value)
    if type(value) ~= "string" then
        return nil
    end

    local normalized = value:lower()
    if normalized == "" then
        return nil
    end

    return normalized
end

local function shouldIncludeApplicantInfo(applicantInfo)
    if type(applicantInfo) ~= "table" then
        return false
    end

    local applicationStatus = normalizeApplicantStatusValue(applicantInfo.applicationStatus)
    local pendingStatus = normalizeApplicantStatusValue(applicantInfo.pendingApplicationStatus)

    if pendingStatus and not ACTIVE_APPLICANT_STATUSES[pendingStatus] then
        return false
    end

    if applicationStatus and not ACTIVE_APPLICANT_STATUSES[applicationStatus] then
        return false
    end

    return applicationStatus == nil or ACTIVE_APPLICANT_STATUSES[applicationStatus] == true
end

local function maybePublishApplicantRelaySnapshot(region, members, contextActive, options)
    if type(addon.PublishLfgStatusSnapshot) ~= "function" then
        return
    end

    local forceClearWithoutContext = type(options) == "table" and options.forceClearWithoutContext == true
    if not contextActive and not forceClearWithoutContext then
        resetApplicantRelayState()
        return
    end

    local stateKey = buildApplicantRelayStateKey(region, members)
    if stateKey == lastApplicantRelayStateKey then
        return
    end

    if addon.PublishLfgStatusSnapshot(region, members) then
        lastApplicantRelayStateKey = stateKey
        return
    end

    resetApplicantRelayState()
end

local function clearApplicantState(region, options)
    local applicantGroups = {}
    local applicantGroupsById = {}
    maybePublishApplicantRelaySnapshot(
        region,
        {},
        type(options) == "table" and options.contextActive == true or isApplicantHeartbeatContextActive(),
        {
            forceClearWithoutContext = type(options) == "table" and options.forceClearWithoutContext == true,
        }
    )
    addon.PruneQueuedRequestsBySource("applicant", {})
    addon.ReplaceSnapshotBucket("applicants", {})
    refreshApplicantFrameBindings(applicantGroups, applicantGroupsById)
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

local function queueLookup(region, realm, characterName, source, extra)
    if type(addon.IsSuppressedInCurrentInstance) == "function" and addon.IsSuppressedInCurrentInstance() then
        return nil
    end

    local request = addon.QueueRequest(region, realm, characterName)
    request.source = source

    if type(extra) == "table" then
        for key, value in pairs(extra) do
            request[key] = value
        end
    end

    return request
end

local function isQueueModifierHeld()
    return IsControlKeyDown()
end

local function queueLookupPayload(lookup, source)
    if type(lookup) ~= "table" or not lookup.region or not lookup.realm or not lookup.characterName then
        return nil
    end

    return queueLookup(lookup.region, lookup.realm, lookup.characterName, source or lookup.source or "manual", lookup)
end

local function getFrameElementData(frame)
    if not frame or type(frame.GetElementData) ~= "function" then
        return nil
    end

    local ok, data = pcall(frame.GetElementData, frame)
    if ok and type(data) == "table" then
        return data
    end

    return nil
end

local function resolveApplicantId(frame)
    local current = frame
    for _ = 1, 10 do
        if not current then
            break
        end

        local candidate = current.applicantID or current.ApplicantID or current.wclApplicantID
        if candidate and not (type(issecretvalue) == "function" and issecretvalue(candidate)) then
            return candidate
        end

        local elementData = getFrameElementData(current)
        if type(elementData) == "table" then
            local elementCandidate = elementData.applicantID or elementData.ApplicantID or elementData.id
            if elementCandidate and not (type(issecretvalue) == "function" and issecretvalue(elementCandidate)) then
                return elementCandidate
            end
        end

        current = type(current.GetParent) == "function" and current:GetParent() or nil
    end

    return nil
end

local function buildApplicantLookup(applicantID, memberIndex)
    if not applicantID or not memberIndex or type(C_LFGList) ~= "table" or type(C_LFGList.GetApplicantMemberInfo) ~= "function" then
        return nil
    end

    local fullName, class, localizedClass, level, itemLevel, honorLevel, tank, healer, damage, assignedRole =
        C_LFGList.GetApplicantMemberInfo(applicantID, memberIndex)
    local name, realm = splitFullName(fullName)
    if not name or not realm then
        return nil
    end

    return {
        region = addon.GetCurrentRegionSlug(),
        realm = realm,
        characterName = name,
        source = "applicant",
        applicantID = applicantID,
        groupID = applicantID,
        memberIndex = memberIndex,
        class = class,
        localizedClass = localizedClass,
        level = level,
        itemLevel = itemLevel,
        honorLevel = honorLevel,
        assignedRole = assignedRole,
        tank = tank == true,
        healer = healer == true,
        damage = damage == true,
    }
end

local function resolveApplicantLookup(frame)
    if frame and type(frame.wclLookup) == "table" then
        return frame.wclLookup
    end

    local current = frame
    for _ = 1, 10 do
        if not current then
            break
        end

        if type(current.wclLookup) == "table" then
            return current.wclLookup
        end

        current = type(current.GetParent) == "function" and current:GetParent() or nil
    end

    local applicantID = resolveApplicantId(frame)
    local memberIndex = frame and (frame.wclMemberIndex or frame.memberIndex or frame.MemberIndex) or nil
    if not memberIndex and frame and type(frame.GetParent) == "function" then
        local parent = frame:GetParent()
        memberIndex = parent and (parent.wclMemberIndex or parent.memberIndex or parent.MemberIndex) or nil
    end

    return buildApplicantLookup(applicantID, memberIndex)
end

local function assignLookupToFrameTree(frame, lookup, memberIndex)
    if not frame then
        return
    end

    frame.wclLookup = lookup
    frame.wclMemberIndex = memberIndex
    frame.wclApplicantID = type(lookup) == "table" and lookup.applicantID or nil

    if type(frame.GetChildren) ~= "function" then
        return
    end

    for _, child in ipairs({frame:GetChildren()}) do
        assignLookupToFrameTree(child, lookup, memberIndex)
    end
end

local function onApplicantMemberMouseUp(self, button)
    if button ~= "LeftButton" or not isQueueModifierHeld() then
        return
    end

    local lookup = resolveApplicantLookup(self)
    if type(lookup) == "table" then
        lookup.userQueued = true
    end
    local request = queueLookupPayload(lookup, "applicant")
    if request then
        if type(addon.PublishSearchEvent) == "function" then
            addon.PublishSearchEvent(request)
        end
        addon.Print(string.format("Queued applicant lookup for %s-%s.", lookup.characterName, lookup.realm))
    end
end

local function onApplicantRowMouseUp(self, button)
    if button ~= "LeftButton" or not isQueueModifierHeld() then
        return
    end

    local queued = 0
    for _, lookup in ipairs(self.wclApplicantLookups or {}) do
        if type(lookup) == "table" then
            lookup.userQueued = true
        end
        local request = queueLookupPayload(lookup, "applicant")
        if request then
            if type(addon.PublishSearchEvent) == "function" then
                addon.PublishSearchEvent(request)
            end
            queued = queued + 1
        end
    end

    if queued > 0 then
        addon.Print(string.format("Queued %d applicant lookup%s from this LFG row.", queued, queued == 1 and "" or "s"))
    end
end

local function onApplicantMemberEnter(self)
    local lookup = resolveApplicantLookup(self)
    if type(lookup) ~= "table" or type(addon.AppendCharacterTooltip) ~= "function" then
        return
    end

    if not GameTooltip:IsOwned(self) then
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        self.LNNRankOwnedTooltip = true
    else
        self.LNNRankOwnedTooltip = false
    end

    if not addon.AppendCharacterTooltip(GameTooltip, lookup.region, lookup.realm, lookup.characterName) and
        self.LNNRankOwnedTooltip then
        GameTooltip:Hide()
        self.LNNRankOwnedTooltip = false
    end
end

local function onApplicantMemberLeave(self)
    if self and self.LNNRankOwnedTooltip and GameTooltip:IsOwned(self) then
        GameTooltip:Hide()
    end

    if self then
        self.LNNRankOwnedTooltip = false
    end
end

local function hookApplicantMemberFrameTree(frame)
    if not frame then
        return
    end

    if not frame.LNNRankApplicantMemberHooked and type(frame.HookScript) == "function" then
        if type(frame.EnableMouse) == "function" then
            frame:EnableMouse(true)
        end
        frame:HookScript("OnEnter", onApplicantMemberEnter)
        frame:HookScript("OnLeave", onApplicantMemberLeave)
        frame:HookScript("OnMouseUp", onApplicantMemberMouseUp)
        frame.LNNRankApplicantMemberHooked = true
    end

    if type(frame.GetChildren) ~= "function" then
        return
    end

    for _, child in ipairs({frame:GetChildren()}) do
        hookApplicantMemberFrameTree(child)
    end
end

local function onSearchResultEnter(self)
    if type(addon.AppendCharacterTooltip) ~= "function" or
        type(C_LFGList) ~= "table" or
        type(C_LFGList.GetSearchResultInfo) ~= "function" then
        return
    end

    local resultID = self and self.resultID
    if not resultID or (type(issecretvalue) == "function" and issecretvalue(resultID)) then
        return
    end

    local resultInfo = C_LFGList.GetSearchResultInfo(resultID)
    if not resultInfo or
        (type(issecretvaluekey) == "function" and issecretvaluekey(resultInfo, "leaderName")) or
        not resultInfo.leaderName then
        return
    end

    local name, realm = splitFullName(resultInfo.leaderName)
    if not name or not realm then
        return
    end

    if not GameTooltip:IsOwned(self) then
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        self.LNNRankOwnedTooltip = true
    else
        self.LNNRankOwnedTooltip = false
    end

    if not addon.AppendCharacterTooltip(GameTooltip, addon.GetCurrentRegionSlug(), realm, name) and
        self.LNNRankOwnedTooltip then
        GameTooltip:Hide()
        self.LNNRankOwnedTooltip = false
    end
end

local function onSearchResultLeave(self)
    if self and self.LNNRankOwnedTooltip and GameTooltip:IsOwned(self) then
        GameTooltip:Hide()
    end

    if self then
        self.LNNRankOwnedTooltip = false
    end
end

local function refreshSearchResultFrameBindings()
    if not LFGListFrame or
        not LFGListFrame.SearchPanel or
        not LFGListFrame.SearchPanel.ScrollBox or
        not LFGListFrame.SearchPanel.ScrollBox.ScrollTarget then
        return
    end

    local resultFrames = {LFGListFrame.SearchPanel.ScrollBox.ScrollTarget:GetChildren()}
    for _, resultFrame in ipairs(resultFrames) do
        if not resultFrame.LNNRankSearchResultHooked and type(resultFrame.HookScript) == "function" then
            if type(resultFrame.EnableMouse) == "function" then
                resultFrame:EnableMouse(true)
            end
            resultFrame:HookScript("OnEnter", onSearchResultEnter)
            resultFrame:HookScript("OnLeave", onSearchResultLeave)
            resultFrame.LNNRankSearchResultHooked = true
        end
    end
end

refreshApplicantFrameBindings = function(applicantGroups, applicantGroupsById)
    if not LFGListFrame or
        not LFGListFrame.ApplicationViewer or
        not LFGListFrame.ApplicationViewer.ScrollBox or
        not LFGListFrame.ApplicationViewer.ScrollBox.ScrollTarget then
        return
    end

    local cover = LFGListFrame.ApplicationViewer.UnempoweredCover
    if cover then
        if type(cover.EnableMouse) == "function" then
            cover:EnableMouse(false)
        end
        if type(cover.EnableMouseWheel) == "function" then
            cover:EnableMouseWheel(false)
        end
        if type(cover.SetToplevel) == "function" then
            cover:SetToplevel(false)
        end
    end

    local applicantFrames = {LFGListFrame.ApplicationViewer.ScrollBox.ScrollTarget:GetChildren()}
    for frameIndex, appFrame in ipairs(applicantFrames) do
        local applicantID = resolveApplicantId(appFrame)
        local memberLookups = applicantID and applicantGroupsById[applicantID] or applicantGroups[frameIndex] or {}
        appFrame.wclApplicantLookups = memberLookups
        appFrame.wclApplicantID = applicantID or (memberLookups[1] and memberLookups[1].applicantID) or nil

        if not appFrame.LNNRankApplicantRowHooked and type(appFrame.HookScript) == "function" then
            if type(appFrame.EnableMouse) == "function" then
                appFrame:EnableMouse(true)
            end
            appFrame:HookScript("OnMouseUp", onApplicantRowMouseUp)
            appFrame.LNNRankApplicantRowHooked = true
        end

        for memberIndex = 1, 5 do
            local memberFrame = appFrame["Member" .. memberIndex]
            if memberFrame then
                assignLookupToFrameTree(memberFrame, memberLookups[memberIndex], memberIndex)
                hookApplicantMemberFrameTree(memberFrame)
            end
        end

        if type(appFrame.Members) == "table" then
            for memberIndex, memberFrame in ipairs(appFrame.Members) do
                assignLookupToFrameTree(memberFrame, memberLookups[memberIndex], memberIndex)
                hookApplicantMemberFrameTree(memberFrame)
            end
        end
    end
end

local function collectGroupMembers()
    local region = addon.GetCurrentRegionSlug()
    local entries = {}
    local relayMembers = {}

    if (type(addon.IsSuppressedInCurrentInstance) == "function" and addon.IsSuppressedInCurrentInstance()) or
        not addon.ShouldScanGroupMembers() then
        resetGroupRelayState()
        addon.PruneQueuedRequestsBySource("group", {})
        addon.ReplaceSnapshotBucket("groupMembers", entries)
        return
    end

    local function captureUnit(unitToken, memberIndex, groupID)
        if not UnitExists(unitToken) or not UnitIsPlayer(unitToken) then
            return
        end

        local name, realm = getUnitNameRealm(unitToken)
        if not name or not realm then
            return
        end

        local localizedClass, class = nil, nil
        if type(UnitClass) == "function" then
            localizedClass, class = UnitClass(unitToken)
        end

        local level = type(UnitLevel) == "function" and UnitLevel(unitToken) or nil
        local assignedRole = type(UnitGroupRolesAssigned) == "function" and UnitGroupRolesAssigned(unitToken) or nil
        if assignedRole == "NONE" then
            assignedRole = nil
        end

        local itemLevel = nil
        if unitToken == "player" and type(GetAverageItemLevel) == "function" then
            local equippedItemLevel = select(2, GetAverageItemLevel())
            itemLevel = tonumber(equippedItemLevel)
        end

        local requestKey = addon.BuildRequestKey(region, realm, name)
        local lookup = {
            region = region,
            realm = realm,
            characterName = name,
            source = "group",
            unitToken = unitToken,
            groupID = groupID,
            memberIndex = memberIndex,
            class = class,
            localizedClass = localizedClass,
            level = level,
            itemLevel = itemLevel,
            assignedRole = assignedRole,
            lastSeenAt = time(),
        }
        entries[requestKey] = lookup
        table.insert(relayMembers, lookup)

        if addon.ShouldAutoQueueLookup(region, realm, name) then
            local request = queueLookup(region, realm, name, "group", lookup)
            if request and type(addon.PublishSearchEvent) == "function" then
                addon.PublishSearchEvent(request)
            end
        end
    end

    if IsInRaid() then
        for index = 1, GetNumGroupMembers() do
            captureUnit("raid" .. index, index, 1)
        end
    elseif IsInGroup() then
        captureUnit("player", 0, 1)
        for index = 1, math.max(0, GetNumGroupMembers() - 1) do
            captureUnit("party" .. index, index, 1)
        end
    end

    maybePublishGroupRelaySnapshot(region, relayMembers)
    addon.PruneQueuedRequestsBySource("group", entries)
    addon.ReplaceSnapshotBucket("groupMembers", entries)
end

local function ensurePlayerQueuedForRefresh()
    local playerName, playerRealm = getUnitNameRealm("player")
    if not playerName or not playerRealm then
        return
    end

    local region = addon.GetCurrentRegionSlug()
    if not addon.ShouldAutoQueueLookup(region, playerRealm, playerName) then
        return
    end

    local request = queueLookup(region, playerRealm, playerName, "self", {
        unitToken = "player",
        queuedBecause = "daily-self-refresh",
    })
    if request and type(addon.PublishSearchEvent) == "function" then
        addon.PublishSearchEvent(request)
    end
end

local function collectApplicants()
    local region = addon.GetCurrentRegionSlug()
    local entries = {}
    local applicantGroups = {}
    local applicantGroupsById = {}
    local heartbeatMembers = {}
    local heartbeatContextActive = isApplicantHeartbeatContextActive()
    local activeLfgEntry = hasActiveLfgEntry()

    if (type(addon.IsSuppressedInCurrentInstance) == "function" and addon.IsSuppressedInCurrentInstance()) or
        not addon.ShouldScanApplicants() or type(C_LFGList) ~= "table" or type(C_LFGList.GetApplicants) ~= "function" then
        if type(addon.IsSuppressedInCurrentInstance) == "function" and addon.IsSuppressedInCurrentInstance() then
            resetApplicantRelayState()
        else
            clearApplicantState(region, {
                contextActive = heartbeatContextActive,
                forceClearWithoutContext = not activeLfgEntry,
            })
        end
        return
    end

    if not activeLfgEntry then
        clearApplicantState(region, {
            contextActive = heartbeatContextActive,
            forceClearWithoutContext = true,
        })
        return
    end

    local applicants = C_LFGList.GetApplicants() or {}
    for index = 1, #applicants do
        local applicantInfo = C_LFGList.GetApplicantInfo(applicants[index])
        if shouldIncludeApplicantInfo(applicantInfo) and applicantInfo.applicantID and not (type(issecretvalue) == "function" and issecretvalue(applicantInfo.applicantID)) then
            applicantGroups[index] = applicantGroups[index] or {}
            applicantGroupsById[applicantInfo.applicantID] = applicantGroupsById[applicantInfo.applicantID] or {}
            for memberIndex = 1, applicantInfo.numMembers or 0 do
                local fullName, class, localizedClass, level, itemLevel, honorLevel, tank, healer, damage, assignedRole, relationship =
                    C_LFGList.GetApplicantMemberInfo(applicantInfo.applicantID, memberIndex)

                local name, realm = splitFullName(fullName)
                if name and realm then
                    local requestKey = addon.BuildRequestKey(region, realm, name)
                    local applicantLookup = {
                        region = region,
                        realm = realm,
                        characterName = name,
                        source = "applicant",
                        applicantID = applicantInfo.applicantID,
                        groupID = applicantInfo.applicantID,
                        memberIndex = memberIndex,
                        class = class,
                        localizedClass = localizedClass,
                        level = level,
                        itemLevel = itemLevel,
                        assignedRole = assignedRole,
                        applicationStatus = applicantInfo.applicationStatus,
                        pendingApplicationStatus = applicantInfo.pendingApplicationStatus,
                    }
                    entries[requestKey] = {
                        region = region,
                        realm = realm,
                        characterName = name,
                        fullName = fullName,
                        source = "applicant",
                        class = class,
                        localizedClass = localizedClass,
                        level = level,
                        itemLevel = itemLevel,
                        honorLevel = honorLevel,
                        assignedRole = assignedRole,
                        relationship = relationship,
                        tank = tank == true,
                        healer = healer == true,
                        damage = damage == true,
                        applicantID = applicantInfo.applicantID,
                        groupID = applicantInfo.applicantID,
                        memberIndex = memberIndex,
                        applicationStatus = applicantInfo.applicationStatus,
                        pendingApplicationStatus = applicantInfo.pendingApplicationStatus,
                        lastSeenAt = time(),
                    }
                    applicantGroups[index][memberIndex] = applicantLookup
                    applicantGroupsById[applicantInfo.applicantID][memberIndex] = applicantLookup
                    table.insert(heartbeatMembers, applicantLookup)

                    if addon.ShouldAutoQueueLookup(region, realm, name) then
                        local request = queueLookup(region, realm, name, "applicant", applicantLookup)
                        if request and type(addon.PublishSearchEvent) == "function" then
                            addon.PublishSearchEvent(request)
                        end
                    end
                end
            end
        end
    end

    maybePublishApplicantRelaySnapshot(region, heartbeatMembers, heartbeatContextActive)
    addon.PruneQueuedRequestsBySource("applicant", entries)
    addon.ReplaceSnapshotBucket("applicants", entries)
    refreshApplicantFrameBindings(applicantGroups, applicantGroupsById)
end

function addon.RunCollectors()
    scanScheduled = false
    ensurePlayerQueuedForRefresh()
    collectGroupMembers()
    collectApplicants()
    refreshSearchResultFrameBindings()
end

function addon.ScheduleCollectors(delaySeconds)
    if scanScheduled then
        return
    end

    scanScheduled = true
    C_Timer.After(delaySeconds or 0.25, addon.RunCollectors)
end

local function shouldRunApplicantPoll()
    return addon.ShouldScanApplicants() and
        not (type(addon.IsSuppressedInCurrentInstance) == "function" and addon.IsSuppressedInCurrentInstance()) and
        type(addon.IsPassiveChannelEnabled) == "function" and
        (addon.IsPassiveChannelEnabled() or (type(addon.IsSavedEventBatchEnabled) == "function" and addon.IsSavedEventBatchEnabled()))
end

scanFrame:RegisterEvent("GROUP_ROSTER_UPDATE")
scanFrame:RegisterEvent("LFG_GROUP_DELISTED_LEADERSHIP_CHANGE")
scanFrame:RegisterEvent("LFG_LIST_ACTIVE_ENTRY_UPDATE")
scanFrame:RegisterEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
scanFrame:RegisterEvent("LFG_LIST_APPLICANT_UPDATED")
scanFrame:RegisterEvent("LFG_LIST_ENTRY_EXPIRED_TIMEOUT")
scanFrame:RegisterEvent("LFG_LIST_ENTRY_EXPIRED_TOO_MANY_PLAYERS")
scanFrame:RegisterEvent("LFG_LIST_SEARCH_RESULTS_RECEIVED")
scanFrame:RegisterEvent("LFG_LIST_SEARCH_RESULT_UPDATED")
scanFrame:RegisterEvent("PLAYER_ENTERING_WORLD")
scanFrame:RegisterEvent("PLAYER_LOGIN")
scanFrame:RegisterEvent("PLAYER_ROLES_ASSIGNED")
scanFrame:RegisterEvent("PLAYER_SPECIALIZATION_CHANGED")
scanFrame:SetScript("OnEvent", function(_, event, ...)
    if event == "LFG_LIST_ENTRY_EXPIRED_TIMEOUT" or
        event == "LFG_LIST_ENTRY_EXPIRED_TOO_MANY_PLAYERS" or
        event == "LFG_GROUP_DELISTED_LEADERSHIP_CHANGE" then
        clearApplicantState(addon.GetCurrentRegionSlug(), {
            forceClearWithoutContext = true,
        })
        addon.ScheduleCollectors(0)
        return
    end

    if event == "LFG_LIST_ACTIVE_ENTRY_UPDATE" then
        local created = ...
        if created == false or not hasActiveLfgEntry() then
            clearApplicantState(addon.GetCurrentRegionSlug(), {
                forceClearWithoutContext = true,
            })
        end
    end

    if event == "PLAYER_LOGIN" or event == "PLAYER_ENTERING_WORLD" then
        addon.ScheduleCollectors(0.5)
        return
    end

    addon.ScheduleCollectors(0.25)
end)

if type(C_Timer) == "table" and type(C_Timer.NewTicker) == "function" then
    C_Timer.NewTicker(APPLICANT_POLL_SECONDS, function()
        if shouldRunApplicantPoll() then
            addon.ScheduleCollectors(0)
        else
            resetApplicantRelayState()
        end
    end)
end
