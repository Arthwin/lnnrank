# Memory Scan Prototype

Date: 2026-06-01

## Goal

This prototype answers a narrow question:

- can we keep a distinctive transport marker in a live process
- and can a local helper find that marker with read-only memory scanning

It does not touch WoW yet. It is a lab for the scanner itself.

## Files

- `memory-string-host.js`
  A small Node process that keeps a fake `channel + message` envelope alive in
  memory in both UTF-8 and UTF-16 forms.
- `scan-process-string.ps1`
  A read-only PowerShell scanner that walks readable memory regions with
  `OpenProcess`, `VirtualQueryEx`, and `ReadProcessMemory`, then searches for a
  target string.

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

If the scanner continues to look reliable, the next experimental addon-side
shape would be:

1. auto-create a unique temporary self-channel name
2. publish compact request envelopes into that channel
3. search WoW memory for the channel name or the payload prefix

There is now an opt-in addon-side prototype for that shape in
`wow-addons/lnnrank/PassiveChannel.lua`.

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

Important caveat:

- this is still experimental and unverified in a live WoW client
- `CHANNEL` sending rules may still limit which queue sources can publish

The most important implementation detail is the payload shape. It should be
highly distinctive, for example:

```text
LNNRANK|channel=lnnrank9ab3...|session=...|seq=42|message=...
```

That gives the scanner a better anchor than a plain player name or realm.
