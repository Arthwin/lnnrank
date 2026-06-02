# lnnrank

`lnnrank` is a local Warcraft Logs powered World of Warcraft addon project with two main parts:

- a Retail WoW addon in `wow-addons/lnnrank`
- a local Node.js companion/dashboard stack in `src/wow-addon-tools`

The system is intentionally **Warcraft Logs only**. Raider.IO and older chat-log
bridge experiments are not part of the main flow. The current experimental live
transport work is the passive self-channel relay described below.

## What it does

- Shows cached Warcraft Logs Mythic+ data in WoW tooltips.
- Lets the user queue refreshes from the addon without passive hover lookups.
- Stores character results in a lightweight local JSON DB.
- Generates a companion addon bundle that WoW loads on `/reload`.
- Runs a local dashboard for queue, results, status, LFG, and passive relay
  views.
- Can optionally push outbound lookup requests from the addon to the desktop app
  without `/reload` through an experimental passive self-channel relay.

## Core limitation

WoW still requires `/reload` to:

- import newly generated companion addon data back into the running client

The passive relay can bypass `/reload` for **addon -> app** request export, but
it does not bypass WoW's import boundary for showing fresh results back inside a
running addon.

## Repo layout

- `src/mplus-matrix`: shared WCL API/query helpers and normalization utilities
- `src/shared`: shared spec, role, color, and presentation math
- `src/wow-addon-tools`: local DB, sync pipeline, WCL gathering, addon bundle generation, dashboard server
- `src/wow-addon-tools/dashboard`: browser UI
- `research/reload-transport-pocs`: archived local POCs from the reload-transport investigation
- `wow-addons/lnnrank`: addon source
- `test`: Node test coverage for sync, mock, and lookup behavior
- `REQUIREMENTS.md`: frozen functional requirements from the build conversation

## Local setup

```powershell
cd C:\Users\dan_o\Desktop\repos\lnnrank
Copy-Item .env.example .env
npm install
```

If you want API access, populate:

```text
WCL_CLIENT_ID
WCL_CLIENT_SECRET
```

## Commands

```powershell
npm run check
npm test
npm run dev
npm run wow-addon-dashboard
npm run build-wow-addon-character -- --region us --realm Stormrage --name Urmomgargles
npm run build-wow-addon-mock -- --install-wow
npm run sync-wow-addon-requests -- --install-wow
npm run stress:search -- 30 2 web
```

Dashboard URL:

```text
http://127.0.0.1:47832
```

Dev dashboard URL:

```text
http://127.0.0.1:47842
```

## Safe dev run

Use the repo-local dev launcher when you want to iterate without touching the live WoW install:

```powershell
npm run dev
```

This runs the dashboard in watch mode and keeps its state inside the current worktree under `output/dev-run`, including:

- a sandbox DB JSON
- a sandbox `WTF\Account\...\SavedVariables\lnnrank.lua`
- sandbox staged addon output
- a sandbox `Interface\AddOns` target

Optional examples:

```powershell
node src/wow-addon-tools/dev-run.js --port 47852
node src/wow-addon-tools/dev-run.js --reset-state
node src/wow-addon-tools/dev-run.js --copy-saved-variables C:\path\to\lnnrank.lua
```

## Passive relay (experimental)

The repo now includes an experimental one-way live transport from the addon to
the desktop app.

Addon controls:

```text
/lnnrank passive on
/lnnrank passive status
/lnnrank passive off
```

What it does today:

- opens a unique per-session self-channel
- publishes compact `LNNRANK|...` lookup payloads when requests are queued
- lets the dashboard watch those payloads live with a read-only memory scanner
- feeds the app queue and LFG view before the next `SavedVariables` flush

What it does not do:

- it does not push fresh lookup results back into the running addon
- it is still an experimental Windows-only transport path

## Environment variables

- `WCL_CLIENT_ID`: Warcraft Logs API client ID
- `WCL_CLIENT_SECRET`: Warcraft Logs API client secret
- `WCL_LOOKUP_PROVIDER`: `auto`, `web`, `api`, or `off`; default `auto`
- `WCL_WEB_BROWSER`: optional browser executable override for web scraping mode
- `WCL_WEB_DATA_TIMEOUT_MS`: browser wait timeout for page data
- `WCL_WEB_BROWSER_IDLE_MS`: shared browser reuse window
- `WCL_SYNC_WORKERS`: default lookup worker count for sync runs, default `1`
- `WCL_DASHBOARD_SYNC_WORKERS`: dashboard auto-sync lookup workers, default `2`
- `WCL_DASHBOARD_PORT`: dashboard port, default `47832`
- `WCL_DASHBOARD_DEV_PORT`: dev dashboard port, default `47842`
- `WCL_DASHBOARD_DB_PATH`: optional override for the local DB JSON path
- `WCL_DASHBOARD_ACCOUNT_ROOT`: optional WoW account root override for SavedVariables scanning
- `WCL_DASHBOARD_OUTPUT_DIR`: optional generated output directory override
- `WCL_DASHBOARD_ADDONS_DIR`: optional WoW AddOns install directory override

## Behavior summary

- Hover is read-only by default.
- Known data always displays when present, even if stale.
- Queueing is explicit for most player surfaces via `Ctrl-click`.
- LFG applicants auto-queue when they appear.
- With passive relay enabled, outbound world/unit/chat-link/applicant lookups
  can appear in the desktop app immediately.
- Self can auto-refresh daily.
- All lookup sources flow through one deterministic WCL gather pipeline.
- Highest dungeon key data comes from a separate WCL by-level view, not the parse page.
- Tanks use `playerscore`, DPS use `dps`, healers use `hps`.

## Search performance notes

The dashboard search queue is intentionally the single path for manual searches,
addon requests, live relay events, LFG applicants, and self-refreshes. The queue
dedupes normalized `(region, realm, name)` lookups before live work starts, then
the sync service checks cache freshness before using Warcraft Logs.

When tuning lookup speed:

- add timestamps first so queue wait, lookup duration, and total request time are visible
- keep the queue dedupe guarantee for both normal and force-refresh lookups
- prefer configurable worker counts over hard-coded parallelism
- keep `/reload` import behavior separate from addon-to-app live request export

Current timing visibility:

- request statuses store `queuedAt`, `startedAt`, `finishedAt`, `queueWaitMs`, `lookupDurationMs`, and `totalDurationMs`
- the Search view worker strip shows worker count plus current/last lookup duration
- queue rows and cached result rows show compact timing labels when a matching status exists

Dashboard auto-sync defaults to `auto` provider mode, `4` workers, and WCL API
batches of `3` characters. With WCL API credentials available, the dashboard
prewarms the API token in the background and uses aliased GraphQL requests to
fetch score plus the likely parse metric in one round trip. Use
`WCL_DASHBOARD_SYNC_WORKERS=1` or `WCL_API_BATCH_SIZE=1` if you want to compare
against single-worker or non-batched behavior.

Manual stress runs:

```powershell
npm run stress:search -- --count 30 --workers 4 --provider auto --api-batch-size 3
```

This command clones the current local DB into `output/search-stress/<timestamp>`
and runs force-refresh searches there, so it does not alter the live dashboard DB
or installed addon payload. Each run writes:

- `stress-report.json`: full lookup, status, update, and summary data
- `stress-report.csv`: per-character timing rows for quick inspection

Use `--force false` for a cache-path baseline, `--api-batch-size 1` to disable
API character batching, or `--run-dir <path>` to choose a specific output
folder. API/auto stress runs prewarm the WCL token by default to match dashboard
behavior; use `--prewarm-api false` to measure cold startup. Direct Node
invocation also supports named flags:

```powershell
node src/wow-addon-tools/stress-search.js --count 30 --workers 4 --provider auto --api-batch-size 3
```

## Container note

The repo includes a `Dockerfile` that starts the local dashboard server. In a containerized environment you typically provide:

- a mounted output directory
- optional mounted WoW `SavedVariables` data
- optional mounted WoW AddOns destination

The container image does not assume a live Windows WoW install path.
