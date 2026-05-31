# No-Reload Transport Recommendation

Date: 2026-05-31

If the current question is only **addon -> desktop app**, see
`addon-to-app-options.md` first.

## Bottom line

If the goal is **true no-reload live updates**, the viable path is:

1. keep the addon as a **capture/control surface**
2. move **live display** into the desktop app / overlay
3. use **visual transport** from WoW to the app

The most credible visual transport is **screenshot/QR**, with **pixel-strip
screen serialization** as a more experimental alternative.

If we only want to remove the **WoW -> app** reload, but accept that the addon
still needs reload to import fresh results, then a **custom-channel chat-log
bridge** is viable as a smaller stage-one improvement.

## What is not realistically fixable

We did not find a normal, supported way to make a running WoW addon re-import
fresh local files or external data without `/reload`. That means a live desktop
fetch can never become a live in-addon tooltip update unless we:

- switch the live presentation to an overlay or desktop window, or
- choose a much riskier route such as memory writing, injection, or automation
  back into WoW, which we should reject.

## Ranked options

### 1. Screenshot/QR + overlay

Status: **recommended**

Why:

- Public, current, working reference:
  [ApplicantScout-Addon](https://github.com/Antrakt92/ApplicantScout-Addon)
  and
  [ApplicantScout-Companion](https://github.com/Antrakt92/ApplicantScout-Companion)
- Their addon comments explicitly say they rejected chat-log transport because
  chat delivery is buffered and unsuitable for real-time companion transport.
- Their companion README describes the split clearly: addon emits QR, WoW writes
  screenshots, companion watches the screenshot folder, decodes, fetches WCL,
  reads local RaiderIO, and renders an overlay.

Why it fits our project:

- It solves the reload problem **end to end** by moving the live result display
  outside the addon.
- It stays in a safer trust model than memory-writing or code injection.
- It matches our existing desktop app architecture: queue, workers, cache, and
  presentation already exist. We would be adding a transport and overlay layer,
  not rebuilding the data pipeline.

Tradeoffs:

- Requires a visible transport frame or similar capture region in WoW.
- Requires us to build an overlay or compact always-on-top result window.
- More engineering than a chat-log bridge.

### 2. Custom-channel chat-log bridge

Status: **viable for one-way live queue only**

Why:

- On this machine, `WoWChatLog.txt` contains both `/say` and custom channel
  lines like `[5. mytest] Urmomgargles-Stormrage: WCLBRIDGE-12345`.
- The isolated proof in `chat-queue-bridge-poc.js` converts chat-log messages
  into deduped lookup queue items.
- Official API docs indicate `CHANNEL` sends are hardware-event restricted,
  which is acceptable for our `Ctrl-click` and LFG interaction triggers.

What it solves:

- Removes the need for reload to get **lookup requests out of WoW**.
- Lets the desktop app update queue, results, and live dashboard immediately.

What it does **not** solve:

- Fresh results still cannot appear inside a running addon without reload.
- So this is only a partial reload fix unless paired with an overlay.

Risks:

- Community evidence says `WoWChatLog.txt` is buffered and may flush in bursts.
- Our live watch during this research window saw no new writes in 35 seconds,
  which reinforces that it is not a guaranteed low-latency stream.
- Because messages are visible chat, transport needs a hidden custom channel or
  another user-tolerable presentation.

### 3. Pixel-strip screen serialization

Status: **interesting fallback / experimental**

Why:

- Public repo:
  [LibSerpix](https://github.com/alex-berliner/LibSerpix)
- README describes real-time transmission out of WoW by drawing serialized data
  as pixels on screen for an external reader.

What it solves:

- Like screenshot/QR, it avoids reload by using visual transport.
- Unlike screenshot/QR, it aims for continuous realtime output instead of
  writing files.

Why it is not the first recommendation:

- The repo appears much smaller and older than ApplicantScout.
- It is still one-way transport; live display must remain outside WoW.
- Continuous screen capture and decoding may be more fiddly than discrete
  screenshot decoding for our use case, where events are sparse.

### 4. ReadProcessMemory companion

Status: **technically strong, recommended against**

Why:

- Public repo:
  [BabelChat](https://github.com/Yumash/BabelChat)
- It explicitly says it rejected `WoWChatLog.txt` because of buffering and uses
  `ReadProcessMemory` every 250ms for sub-second chat delivery.

Why we should not choose it:

- Requires admin privileges.
- Increases trust, support, and anti-cheat anxiety, even if read-only.
- Expands the project from "helper companion" into "process memory reader,"
  which is a bigger line than we need to cross.

## Local proofs built during research

Files:

- `watch-chatlog-latency.js`
- `watch-screenshots.js`
- `chat-queue-bridge-poc.js`

What they proved:

- The chat-log bridge can parse and dedupe queue payloads correctly.
- The screenshot watcher can detect a newly written image and wait until it is
  stable enough to read.
- In a simulated screenshot write, the file stabilized about `434ms` after it
  was first noticed.

What they did **not** prove yet:

- actual live WoW screenshot timing from `Screenshot()`
- actual custom-channel flush latency distribution under current gameplay

## Recommended implementation path

### Best long-term path

Build a **live overlay mode** in the desktop app and treat the addon as the
capture/control layer.

Transport recommendation:

- first choice: **QR screenshot transport**
- second choice: **pixel-strip transport**

Use the existing addon only for:

- cached info display
- manual actions
- reload convenience
- fallback when the companion is not running

### Small stage-one improvement

If we want a smaller step before committing to overlay transport:

- add a **custom-channel live request bridge** from addon -> app
- keep results live in the desktop app
- keep the addon tooltip as cached-only until next reload

That would not fully remove reload, but it would remove the most annoying
request-export half and make the app feel truly live.

## Sources

- Official WoW API docs:
  [Screenshot](https://warcraft.wiki.gg/wiki/API_Screenshot)
  [SendChatMessage](https://warcraft.wiki.gg/wiki/API_SendChatMessage)
  [SendChatMessageType](https://warcraft.wiki.gg/wiki/API_types/SendChatMessageType)
- Community discussion on getting data out without reload:
  [WoWInterface: Getting information out of the game in real time](https://www.wowinterface.com/forums/printthread.php?t=60297)
- Public production-like screenshot transport:
  [ApplicantScout-Addon](https://github.com/Antrakt92/ApplicantScout-Addon)
  [ApplicantScout-Companion](https://github.com/Antrakt92/ApplicantScout-Companion)
  [ApplicantScout on CurseForge](https://www.curseforge.com/wow/addons/applicant-scout)
- Experimental pixel transport:
  [LibSerpix](https://github.com/alex-berliner/LibSerpix)
- Read-only memory reader example:
  [BabelChat](https://github.com/Yumash/BabelChat)
- Warcraft Logs official overlay/app context:
  [Warcraft Logs Companion article](https://www.wowhead.com/news/warcraft-logs-companion-app-upload-and-analyze-combat-reports-in-game-320762)
- Overlay platform docs if we choose an overlay shell:
  [Overwolf in-game overlays](https://dev.overwolf.com/ow-native/guides/product-guidelines/app-screen-behavior/in-game-overlays)
