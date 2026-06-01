# Addon -> App Live Transport Options

Date: 2026-06-01

## Scope

This note is only about getting fresh lookup payloads from the running WoW addon
into the local desktop app within about 10 seconds, without `/reload`.

It is intentionally not about importing results back into the running addon.

## Current seam in this repo

`lnnrank` already has a clean hook for an outgoing live transport:

- `wow-addons/lnnrank/Interactions.lua`
- `wow-addons/lnnrank/Collectors.lua`

Both paths call `addon.TryPublishRequestToPassiveChannel(request)` after a
lookup is queued. That function is now implemented as an experimental passive
self-channel publisher, which means the repo already has a working seam for
outgoing transport without rewriting the queueing rules first.

Current repo status:

- `wow-addons/lnnrank/PassiveChannel.lua` publishes compact
  `LNNRANK|ch=...|ss=...|n=...|rg=...|re=...|nm=...|sr=...` envelopes.
- `src/wow-addon-tools/passive-live-feed.js` plus
  `src/wow-addon-tools/passive-live-scanner/` watch the running WoW process
  read-only and normalize those payloads into a live relay log.
- The dashboard can already turn matching live payloads into queue and LFG
  state before the next `SavedVariables` flush.

That makes the current addon shape a good fit for continuing transport
experiments inside the real app, not just isolated POCs.

## Constraints that still matter

### 1. SavedVariables are not live enough

SavedVariables remain the stable fallback, but they are still gated by reload
or logout.

Sources:

- WoWInterface discussion on real-time export:
  <https://www.wowinterface.com/forums/printthread.php?t=60297>
- Older WoWInterface sandbox discussion:
  <https://www.wowinterface.com/forums/showthread.php?t=2167>

### 2. Hidden addon comms do not directly reach a desktop app

The common addon-to-addon pattern is still `C_ChatInfo.SendAddonMessage` plus
`RegisterAddonMessagePrefix`, often wrapped in AceComm / ChatThrottleLib.

That is very useful for addon-to-addon communication, but by itself it does not
produce something a normal desktop app can read directly.

Official docs also note that normal addon messages are not logged.

Source:

- `C_ChatInfo.SendAddonMessage`:
  <https://warcraft.wiki.gg/wiki/API_C_ChatInfo.SendAddonMessage>

Local cross-check:

- Installed addons on this machine such as WeakAuras, Details, DBM, GTFO,
  OmniCD, and WorldQuestTracker all use AceComm / ChatThrottleLib /
  `SendAddonMessage` patterns.

### 3. Chat-log tailing is possible, but not trustworthy as a real-time pipe

Visible chat definitely lands in `WoWChatLog.txt` on this machine, and the file
is currently updating under:

- `C:\Program Files (x86)\World of Warcraft\_retail_\Logs\WoWChatLog.txt`

That proves visible messages can be harvested by the app.

The problem is flush behavior. Community evidence and public companion repos
still describe the chat log as buffered and bursty rather than reliably live.

Sources:

- WoWInterface real-time export thread:
  <https://www.wowinterface.com/forums/printthread.php?t=60297>
- BabelChat README:
  <https://github.com/Yumash/BabelChat>

### 4. Screenshot and screen-based transport are still allowed paths out

The current screenshot API is `Screenshot()`, which writes to WoW's
`_retail_\Screenshots` folder and pairs with `SCREENSHOT_SUCCEEDED`.

Sources:

- `Screenshot()`:
  <https://warcraft.wiki.gg/wiki/API_Screenshot>
- `SCREENSHOT_SUCCEEDED`:
  <https://warcraft.wiki.gg/wiki/SCREENSHOT_SUCCEEDED>

## Midnight-specific sources worth watching

These are the most relevant Midnight-era sources I found for this question.

### 1. Blizzard's Midnight addon communication rollback note

Date: October 3, 2025

Source:

- `Day 1 Alpha UI and Addons Update`:
  <https://www.bluetracker.gg/wow/topic/us-en/2177122-day-1-alpha-ui-and-addons-update/>

Why it matters:

- This is the clearest Midnight-specific note about chat and addon comms.
- Blizzard said the initial lockdown on parsing chat and addon comms in
  instances was too broad.
- They said they would narrow it so the new logic only applies while there is
  an active raid encounter or Mythic+ run underway.

What that means for us:

- For Midnight, pre-run and post-run signaling may be more workable than the
  original alpha wording suggested.
- During an active Mythic+ run, addon-based communication is still the riskiest
  place to anchor a transport.

### 2. Midnight planned API change summary

Date: surfaced in Public Alpha documentation, still indexed in 2026

Source:

- `Patch 12.0.0/Planned API changes`:
  <https://warcraft.wiki.gg/wiki/Patch_12.0.0/Planned_API_changes>

Important note:

- This page is community-maintained, not an official Blizzard domain.
- It is still useful because it aggregates the Midnight API communication notes
  into one place.

Why it matters:

- It explicitly summarizes the Midnight rule that, in instances, chat payloads
  reaching Lua can become Secret Values and addons are not allowed to send
  communications to other players through either addon comms or regular chat.
- It also states that combat log events are no longer available to addons.

What that means for us:

- The generic pre-Midnight idea of hiding payloads inside addon comm traffic is
  even less attractive under Midnight.
- A visual outbound path like screenshot or pixel transport becomes more
  attractive because it is orthogonal to the new comm restrictions.

### 3. Blizzard developer-doc entry point for Midnight APIs

Date: November 15, 2025 forum answer

Source:

- `Is there a place to get a list of API changes with Midnight?`:
  <https://us.forums.blizzard.com/en/wow/t/is-there-a-place-to-get-a-list-of-api-changes-with-midnight/2200149>

Why it matters:

- A UI and Macro forum reply points developers to two places:
  the `Documentation` addon available in-game through `/api`, and the Warcraft
  Wiki API changes page.

What that means for us:

- If we prototype this further, we should treat the in-client `Documentation`
  addon as the authoritative place to verify any specific API behavior in the
  current Midnight build.

### 4. Midnight-specific community examples already leaning on companions

These are not authoritative API docs, but they are useful directional signals.

#### Archon / Warcraft Logs Companion

Source:

- <https://www.archon.gg/wow/articles/help/companion>

What it shows:

- As of March 13, 2026, the Warcraft Logs Companion is still positioned around
  an Overwolf-powered overlay and in-game applicant lookup experience.
- The pattern remains "desktop/overlay companion beside the game", not "push a
  desktop payload directly back through addon comms".

#### MidnightHUD

Source:

- <https://www.curseforge.com/wow/addons/midnighthud>

What it shows:

- As of May 28, 2026, the author documents experimental `KeyRGB` /
  `MidnightRGB` projects that require an external `MidnightRGBBridge` app from
  the Microsoft Store.
- That is another Midnight-era signal that addon authors are comfortable using
  external bridge apps when they want capabilities beyond standard addon limits.

#### MidnightUI + MPI Companion

Source:

- <https://www.curseforge.com/wow/addons/midnightui-midnight-ready>

What it shows:

- The project explicitly markets an `MPI Companion` and says a tiny helper addon
  auto-toggles `/combatlog` so the companion can capture runs.
- That is not our exact use case, but it is another Midnight-specific example
  where the solution is "pair the addon with a companion pipeline", not "expect
  addon comms alone to solve external data flow".

## Ranked options for lnnrank's current focus

### 1. Event-driven screenshot/QR transport

Status: best first prototype

Pattern:

- When `TryPublishRequestToPassiveChannel(request)` is called, encode a compact
  payload into a tiny on-screen frame.
- Trigger `Screenshot()`.
- Let the desktop app watch `_retail_\Screenshots`, decode the payload, and
  enqueue the lookup immediately.

Why it fits lnnrank:

- `lnnrank` payloads are sparse event packets, not a continuous combat stream.
- The app already has queue, cache, and watcher-style logic.
- This avoids chat spam, alt-account dependencies, and admin-only memory reads.

Public example:

- ApplicantScout addon + companion:
  <https://www.curseforge.com/wow/addons/applicantscout-addon>
  <https://github.com/Antrakt92/ApplicantScout-Companion>

What makes it credible:

- It is current and public.
- The companion explicitly watches the screenshots folder and turns those
  captures into overlay updates.
- It solves the outbound transport without relying on chat logs or memory hooks.

Expected latency:

- Likely within the target budget if we only fire on queue events.
- Needs measurement in our own repo with real `Screenshot()` calls.

Main tradeoffs:

- Requires a transport frame that can survive screenshot capture.
- Produces files unless the watcher cleans them up.
- Still works best with live results shown in the app or overlay rather than
  inside the running addon.

Verdict:

- Recommended first path for `addon -> app`.

### 2. Pixel-strip screen serialization

Status: strong backup if screenshots feel too clunky

Pattern:

- Draw encoded data as pixel columns in a fixed screen region.
- Let the app continuously read the screen and decode frames.

Public examples:

- LibSerpix:
  <https://github.com/alex-berliner/LibSerpix>
- WoWTTS:
  <https://github.com/alex-berliner/WoWTTS>

Why it is interesting:

- No screenshot file buffering.
- Potentially lower latency than discrete screenshots.
- Still keeps the flow one-way and avoids memory reads.

Why it is not first:

- More brittle around scaling, capture timing, UI scale, HDR, and window mode.
- More engineering than screenshot/QR for our low-frequency payloads.

Verdict:

- Good second experiment if screenshot transport is workable but awkward.

### 3. Read-only memory reader for our own ring buffer

Status: technically strongest, product-riskier

Pattern:

- The addon writes queued request payloads into a small in-memory ring buffer.
- A local companion polls the WoW process with `ReadProcessMemory`.

Public example:

- BabelChat:
  <https://github.com/Yumash/BabelChat>

Why it is attractive:

- Public repo claims sub-second latency by polling every 250ms.
- No chat noise and no visual transport artifact.
- Best chance of comfortably beating the 10 second target.

Why it is risky:

- Requires admin on Windows.
- Changes the trust model from "helper companion" to "process memory reader".
- Even read-only access will be a much higher support and perception burden.

#### How hard is arbitrary string scanning?

Short answer:

- easier than building a robust overlay
- harder than building a clean screenshot watcher
- much easier live than by creating repeated dump files

Public implementation signals:

- Microsoft documents the core primitives:
  `OpenProcess`, `VirtualQueryEx`, and `ReadProcessMemory`.
- Jerry Coffin's example gist shows the standard pattern:
  enumerate memory regions with `VirtualQueryEx`, read them, and run a normal
  string search over the bytes.
- Generic scanners such as `Memory-Scanner`, `Pymem`, and `ReadWriteMemory`
  show that process-wide string scans are common and not exotic to prototype.

Sources:

- `OpenProcess`:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess>
- `VirtualQueryEx`:
  <https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualqueryex>
- `ReadProcessMemory`:
  <https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-readprocessmemory>
- Jerry Coffin string-scan gist:
  <https://gist.github.com/Mikulas/2551307>
- `Memory-Scanner`:
  <https://github.com/JulianOzelRose/Memory-Scanner>
- `Pymem`:
  <https://github.com/srounet/Pymem>
- `ReadWriteMemory`:
  <https://github.com/vsantiago113/ReadWriteMemory>

What makes it harder in WoW than in a toy example:

- You need a highly distinctive marker such as a nonce-prefixed payload, not a
  plain character name or realm string.
- You may need to search both UTF-8 and UTF-16 representations depending on
  where the string ends up.
- The same text can exist in more than one place: chat history, frame text,
  Lua string storage, copied buffers, and previous payloads.
- The address is unlikely to be stable across launches, reloads, or payload
  shape changes unless we deliberately engineer a fixed buffer pattern.

What I would infer from the public repos:

- Prototyping a one-off "can I find this marker in WoW memory right now?" tool
  is probably a day-scale task, not a month-scale task.
- Turning that into a supportable transport that survives restarts, client
  patches, and false positives is the real work.

#### Dumps versus live scanning

If the idea is "make the addon emit a marker, dump process memory, then search
the dump for that string", it is probably the wrong form of the idea.

Why:

- Windows dump tooling can include full memory, but that is a heavyweight step
  compared with reading live committed regions directly.
- For a repeated <=10 second transport loop, constantly writing dump files would
  be slower, noisier, and operationally uglier than a live reader.

Sources:

- User-mode dump options:
  <https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/-dump--create-dump-file->
- ProcDump:
  <https://learn.microsoft.com/en-us/sysinternals/downloads/procdump>

Practical conclusion:

- If we ever test the memory-reader route, do **live scanning**, not periodic
  dump creation.
- If we want to de-risk the memory route, design the addon payload around a
  unique sentinel like `LNNRANK|<nonce>|<seq>|...` so the reader can verify a
  real hit instead of guessing at arbitrary strings.

Verdict:

- Keep as the fastest technical fallback, not the default direction.

### 4. Visible whisper / Battle.net whisper -> chat log tail

Status: hacky experiment only

Pattern:

- When the addon queues a request, it sends a visible payload to a target that
  will appear in chat.
- The desktop app tails `WoWChatLog.txt` and converts matching lines into queue
  entries.

Relevant docs:

- `SendChatMessageType`:
  <https://warcraft.wiki.gg/wiki/API_types/SendChatMessageType>
- `CHAT_MSG_WHISPER_INFORM`:
  <https://warcraft.wiki.gg/wiki/CHAT_MSG_WHISPER_INFORM>
- `CHAT_MSG_BN_WHISPER_INFORM`:
  <https://warcraft.wiki.gg/wiki/CHAT_MSG_BN_WHISPER_INFORM>
- `BNSendWhisper`:
  <https://warcraft.wiki.gg/wiki/API_BNSendWhisper>

Why it is tempting:

- Very small prototype surface.
- We already have a local chat-log bridge POC.
- `WHISPER` is not marked hardware-event restricted in the current chat type
  docs, unlike `CHANNEL`.

Why it is weak:

- The chat log is still the bottleneck, and the public evidence says its flush
  timing is unpredictable.
- Requires visible messages, an alt, or a Battle.net friend target.
- Feels noisy and socially awkward compared with visual transport.

Verdict:

- Acceptable as a disposable experiment, not as a shipping plan.

### 5. Hidden addon comm to a second WoW client

Status: normal addon pattern, wrong target

Pattern:

- Use `SendAddonMessage` or `C_BattleNet.SendGameData` to another logged-in WoW
  client.
- Let that second client or a helper addon expose the payload to the app.

Relevant docs:

- `C_ChatInfo.SendAddonMessage`:
  <https://warcraft.wiki.gg/wiki/API_C_ChatInfo.SendAddonMessage>
- `C_BattleNet.SendGameData`:
  <https://warcraft.wiki.gg/wiki/API_C_BattleNet.SendGameData>

Why it is not a fit:

- It is great for addon-to-addon communication, and common installed addons use
  this pattern heavily.
- It still does not give the desktop app a direct read path.
- It adds a second client / second addon / second account problem before we even
  solve app ingestion.

Verdict:

- Not recommended unless we intentionally want a second-client bridge.

## What I would do next

### Shortlist

1. Prototype screenshot/QR transport at the existing
   `TryPublishRequestToPassiveChannel` seam.
2. Measure end-to-end latency on this machine with real screenshots and actual
   queued applicant/manual payloads.
3. If screenshot transport is annoying in practice, prototype a tiny pixel-strip
   transport next.
4. Keep whisper/chat-log transport as a low-effort debug path only.

### Remaining repo tasks

1. Measure real latency for each queue source:
   addon queue time -> live feed seen -> app queue time -> sync completion time.
2. Verify which sources survive `CHANNEL` restrictions consistently:
   manual `Ctrl-click`, world, chat-link, applicant, and any automated cases.
3. Decide whether to harden the current memory-reader path or pivot to
   screenshot/QR for a lower-risk long-term transport.
4. Add a compact app-side history/export story if the passive relay becomes a
   normal workflow rather than a lab feature.

## Bottom line

If the only goal right now is **addon -> app** within about 10 seconds, the
best long-term path still looks like:

1. screenshot/QR first
2. pixel-strip second
3. read-only memory only if visual transport disappoints

Visible whisper or chat-log tricks are still worth understanding, but they look
much more like debug hacks than a good long-term transport for `lnnrank`.

If the question is "what is already implemented in this repo today?", the
answer is different:

1. experimental passive self-channel publisher in the addon
2. read-only memory scan in the desktop app
3. live queue / LFG wiring in the dashboard

That does not make the memory-reader path the final recommendation, but it is
the current prototype that exists in code.
