# Reload Transport POCs

These started as isolated probes for researching ways around WoW addon reload
requirements without touching the main app or addon.

Some of that work is now partially wired into the repo as an experimental
passive self-channel relay, but this folder still exists as the historical lab
notebook for that investigation.

## Current focus

If the current question is strictly **addon -> desktop app** live signaling,
start with:

- `addon-to-app-options.md`

If the current question is "what is actually implemented in the repo right
now?", also read:

- `memory-scan-prototype.md`

## Files

- `addon-to-app-options.md`
  Focused transport ranking for sending lookup payloads from the running addon
  to the local app without `/reload`.
- `memory-scan-prototype.md`
  Notes for the read-only memory scanning spike and how it maps to a possible
  hidden self-channel transport.
- `memory-string-host.js`
  Synthetic process that keeps a fake channel/message envelope alive in memory.
- `scan-process-string.ps1`
  Read-only process scanner for distinctive strings and nearby preview text.
- `watch-chatlog-latency.js`
  Tails `WoWChatLog.txt`, parses new lines, and estimates how long it took them
  to arrive after their embedded timestamp.
- `watch-screenshots.js`
  Watches the WoW screenshots folder, detects new files, and measures how long
  after the file `mtime` the file appears stable on disk.
- `chat-queue-bridge-poc.js`
  Watches `WoWChatLog.txt` for a custom channel plus payload prefix and turns
  matching messages into deduped lookup queue items.

## Example usage

```powershell
node research/reload-transport-pocs/watch-chatlog-latency.js --seconds 60
node research/reload-transport-pocs/watch-chatlog-latency.js --seconds 60 --channel mytest
node research/reload-transport-pocs/watch-screenshots.js --seconds 60
node research/reload-transport-pocs/chat-queue-bridge-poc.js --seconds 60 --channel wclbridge
```

## Research framing

- Chat-log transport is only interesting for **WoW -> desktop app** live queue
  signaling. It does not solve live data import back into a running addon.
- Screenshot transport is interesting because it enables a desktop overlay flow
  that avoids reload entirely, at the cost of moving live presentation out of
  the addon and into the companion app / overlay.
