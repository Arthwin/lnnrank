# Memory Scan Prototype

Date: 2026-06-01

## Goal

This prototype started by answering a narrow question:

- can we keep a distinctive transport marker in a live process
- and can a local helper find that marker with read-only memory scanning

It began as a scanner-only lab. The repo now also includes an experimental WoW
passive self-channel transport that uses the same idea.

## Files

- `memory-string-host.js`
  A small Node process that keeps a fake `channel + message` envelope alive in
  memory in both UTF-8 and UTF-16 forms.
- `scan-process-string.ps1`
  A read-only PowerShell scanner that walks readable memory regions with
  `OpenProcess`, `VirtualQueryEx`, and `ReadProcessMemory`, then searches for a
  target string.

Current repo integration:

- `wow-addons/lnnrank/PassiveChannel.lua`
  The addon-side passive self-channel publisher.
- `src/wow-addon-tools/passive-live-feed.js`
  The dashboard-side monitor that normalizes live payload hits into clean
  relay log entries.
- `src/wow-addon-tools/passive-live-scanner/`
  The Windows helper used by the app for discovery and fast rereads.

## Quick start

Start the host:

```powershell
node research/reload-transport-pocs/memory-string-host.js --interval-ms 1500
```

It prints a PID, channel name, and session token. Example:

```text
PID=12345
CHANNEL=lnnrankabc123
SESSION=xyz987
```

In another terminal, scan for either the channel name or the full prefix:

```powershell
powershell -ExecutionPolicy Bypass -File research/reload-transport-pocs/scan-process-string.ps1 -ProcessId 12345 -Pattern lnnrankabc123

powershell -ExecutionPolicy Bypass -File research/reload-transport-pocs/scan-process-string.ps1 -ProcessId 12345 -Pattern LNNRANK -Encoding both
```

Type a new line into the host terminal to rotate the in-memory payload:

```text
applicant:stormrage:urmomgargles
```

Then scan again.

## What a good result looks like

The scanner should print one or more matches with previews that contain the
channel, session, sequence, and message fields.

That is enough to prove the basic idea:

- a distinctive marker can be found in a live process
- nearby text can also be surfaced

## How this maps to WoW

The repo now has that addon-side shape in place:

1. auto-create a unique temporary self-channel name
2. publish compact request envelopes into that channel
3. search WoW memory for the channel name or the payload prefix

Prototype control:

```text
/lnnrank passive on
/lnnrank passive status
/lnnrank passive off
```

Current intent:

- join a unique temporary channel automatically
- hide that channel from visible chat windows as best we can
- publish compact self-channel payloads from the existing
  `TryPublishRequestToPassiveChannel(request)` seam
- let the dashboard turn live payload hits into queue and LFG state immediately

Current app-side view:

- the Passive tab shows a compact stats strip and a clean relay log
- live payloads and `SavedVariables` message snapshots are merged into one log
- the live queue can advance before the next `/reload`

Important caveat:

- this is still experimental even though live world/unit payload capture is now
  working on this machine
- `CHANNEL` sending rules may still limit which queue sources can publish

The most important implementation detail is the payload shape. The repo now uses
a distinctive fixed envelope:

```text
LNNRANK|ch=lnnrank9ab3...|ss=...|n=42|rg=us|re=Stormrage|nm=Target|sr=world
```

That gives the scanner a better anchor than a plain player name or realm.
