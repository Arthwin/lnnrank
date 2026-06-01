local addon = _G.lnnrank

if not addon then
    return
end

local scanFrame = CreateFrame("Frame")
local scanScheduled = false
local APPLICANT_HEARTBEAT_SECONDS = 3

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
        if type(addon.TryPublishRequestToPassiveChannel) == "function" then
            addon.TryPublishRequestToPassiveChannel(request)
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
            if type(addon.TryPublishRequestToPassiveChannel) == "function" then
                addon.TryPublishRequestToPassiveChannel(request)
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

local function refreshApplicantFrameBindings(applicantGroups, applicantGroupsById)
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

    if not addon.ShouldScanGroupMembers() then
        addon.ReplaceSnapshotBucket("groupMembers", entries)
        return
    end

    local function captureUnit(unitToken, source)
        if not UnitExists(unitToken) or not UnitIsPlayer(unitToken) then
            return
        end

        local name, realm = getUnitNameRealm(unitToken)
        if not name or not realm then
            return
        end

        local requestKey = addon.BuildRequestKey(region, realm, name)
        entries[requestKey] = {
            region = region,
            realm = realm,
            characterName = name,
            source = source,
            unitToken = unitToken,
            lastSeenAt = time(),
        }
    end

    if IsInRaid() then
        for index = 1, GetNumGroupMembers() do
            captureUnit("raid" .. index, "raid")
        end
    elseif IsInGroup() then
        captureUnit("player", "party")
        for index = 1, math.max(0, GetNumGroupMembers() - 1) do
            captureUnit("party" .. index, "party")
        end
    end

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

    queueLookup(region, playerRealm, playerName, "self", {
        unitToken = "player",
        queuedBecause = "daily-self-refresh",
    })
end

local function publishApplicantClearEvent(region)
    if type(addon.TryPublishRequestToPassiveChannel) ~= "function" or
        type(addon.IsPassiveChannelEnabled) ~= "function" or
        not addon.IsPassiveChannelEnabled() then
        return false
    end

    local playerName = type(UnitName) == "function" and UnitName("player") or "player"
    local playerRealm = type(GetRealmName) == "function" and GetRealmName() or "realm"
    return addon.TryPublishRequestToPassiveChannel({
        region = region,
        realm = playerRealm,
        characterName = playerName,
        source = "appclear",
    })
end

local function collectApplicants()
    local region = addon.GetCurrentRegionSlug()
    local entries = {}
    local applicantGroups = {}
    local applicantGroupsById = {}

    if not addon.ShouldScanApplicants() or type(C_LFGList) ~= "table" or type(C_LFGList.GetApplicants) ~= "function" then
        publishApplicantClearEvent(region)
        addon.PruneQueuedRequestsBySource("applicant", entries)
        addon.ReplaceSnapshotBucket("applicants", entries)
        refreshApplicantFrameBindings(applicantGroups, applicantGroupsById)
        return
    end

    publishApplicantClearEvent(region)
    local applicants = C_LFGList.GetApplicants() or {}
    for index = 1, #applicants do
        local applicantInfo = C_LFGList.GetApplicantInfo(applicants[index])
        if applicantInfo and applicantInfo.applicantID and not (type(issecretvalue) == "function" and issecretvalue(applicantInfo.applicantID)) then
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
                        lastSeenAt = time(),
                    }
                    applicantGroups[index][memberIndex] = applicantLookup
                    applicantGroupsById[applicantInfo.applicantID][memberIndex] = applicantLookup

                    if type(addon.TryPublishRequestToPassiveChannel) == "function" then
                        addon.TryPublishRequestToPassiveChannel(applicantLookup)
                    end

                    if addon.ShouldAutoQueueLookup(region, realm, name) then
                        queueLookup(region, realm, name, "applicant", applicantLookup)
                    end
                end
            end
        end
    end

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

local function shouldRunApplicantHeartbeat()
    return addon.ShouldScanApplicants() and
        type(addon.IsPassiveChannelEnabled) == "function" and
        addon.IsPassiveChannelEnabled()
end

scanFrame:RegisterEvent("GROUP_ROSTER_UPDATE")
scanFrame:RegisterEvent("LFG_LIST_ACTIVE_ENTRY_UPDATE")
scanFrame:RegisterEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
scanFrame:RegisterEvent("LFG_LIST_APPLICANT_UPDATED")
scanFrame:RegisterEvent("LFG_LIST_SEARCH_RESULTS_RECEIVED")
scanFrame:RegisterEvent("LFG_LIST_SEARCH_RESULT_UPDATED")
scanFrame:RegisterEvent("PLAYER_ENTERING_WORLD")
scanFrame:RegisterEvent("PLAYER_LOGIN")
scanFrame:RegisterEvent("PLAYER_ROLES_ASSIGNED")
scanFrame:RegisterEvent("PLAYER_SPECIALIZATION_CHANGED")
scanFrame:SetScript("OnEvent", function(_, event)
    if event == "PLAYER_LOGIN" or event == "PLAYER_ENTERING_WORLD" then
        addon.ScheduleCollectors(0.5)
        return
    end

    addon.ScheduleCollectors(0.25)
end)

if type(C_Timer) == "table" and type(C_Timer.NewTicker) == "function" then
    C_Timer.NewTicker(APPLICANT_HEARTBEAT_SECONDS, function()
        if shouldRunApplicantHeartbeat() then
            addon.ScheduleCollectors(0)
        end
    end)
end
