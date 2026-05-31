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
lookup is queued. That function is not implemented today, which means we can
add an outgoing transport without rewriting the queueing rules first.

That makes the current addon shape a good fit for a transport prototype.

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

### Concrete repo tasks

1. Add a tiny transport module in the addon that serializes a lookup request
   into a compact payload and exposes a `TryPublishRequestToPassiveChannel`
   implementation.
2. Add a repo-local watcher/decoder in `src/wow-addon-tools` that consumes that
   payload and pushes it into the existing lookup queue.
3. Add an app-side "live outbound transport" mode flag so this can coexist with
   the current SavedVariables flow.
4. Add a latency test script that records:
   addon queue time -> screenshot or frame seen -> decode time -> app queue time

## Bottom line

If the only goal right now is **addon -> app** within about 10 seconds, the
best current path is:

1. screenshot/QR first
2. pixel-strip second
3. read-only memory only if visual transport disappoints

Visible whisper or chat-log tricks are still worth understanding, but they look
much more like debug hacks than a good long-term transport for `lnnrank`.
