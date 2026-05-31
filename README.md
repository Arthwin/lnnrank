# LÑÑRank

`lnnrank` is a local Warcraft Logs powered World of Warcraft addon project with two main parts:

- a Retail WoW addon in `wow-addons/lnnrank`
- a local Node.js companion/dashboard stack in `src/wow-addon-tools`

The system is intentionally **Warcraft Logs only**. Raider.IO, chat bridge, and other abandoned experiments are not part of the shipped behavior.

## What it does

- Shows cached Warcraft Logs Mythic+ data in WoW tooltips.
- Lets the user queue refreshes from the addon without passive hover lookups.
- Stores character results in a lightweight local JSON DB.
- Generates a companion addon bundle that WoW loads on `/reload`.
- Runs a local dashboard for queue, results, status, and LFG views.

## Core limitation

WoW still requires `/reload` to:

- flush addon `SavedVariables` requests to disk
- import newly generated companion addon data back into the running client

The project optimizes this flow, but it does not bypass WoW's reload boundary.

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
npm run wow-addon-dashboard
npm run build-wow-addon-character -- --region us --realm Stormrage --name Urmomgargles
npm run build-wow-addon-mock -- --install-wow
npm run sync-wow-addon-requests -- --install-wow
```

Dashboard URL:

```text
http://127.0.0.1:47832
```

## Environment variables

- `WCL_CLIENT_ID`: Warcraft Logs API client ID
- `WCL_CLIENT_SECRET`: Warcraft Logs API client secret
- `WCL_LOOKUP_PROVIDER`: `web`, `api`, `auto`, or `off`
- `WCL_WEB_BROWSER`: optional browser executable override for web scraping mode
- `WCL_WEB_DATA_TIMEOUT_MS`: browser wait timeout for page data
- `WCL_WEB_BROWSER_IDLE_MS`: shared browser reuse window
- `WCL_DASHBOARD_PORT`: dashboard port, default `47832`
- `WCL_DASHBOARD_DB_PATH`: optional override for the local DB JSON path
- `WCL_DASHBOARD_ACCOUNT_ROOT`: optional WoW account root override for SavedVariables scanning
- `WCL_DASHBOARD_OUTPUT_DIR`: optional generated output directory override
- `WCL_DASHBOARD_ADDONS_DIR`: optional WoW AddOns install directory override

## Behavior summary

- Hover is read-only by default.
- Known data always displays when present, even if stale.
- Queueing is explicit for most player surfaces via `Ctrl-click`.
- LFG applicants auto-queue when they appear.
- Self can auto-refresh daily.
- All lookup sources flow through one deterministic WCL gather pipeline.
- Highest dungeon key data comes from a separate WCL by-level view, not the parse page.
- Tanks use `playerscore`, DPS use `dps`, healers use `hps`.

## Container note

The repo includes a `Dockerfile` that starts the local dashboard server. In a containerized environment you typically provide:

- a mounted output directory
- optional mounted WoW `SavedVariables` data
- optional mounted WoW AddOns destination

The container image does not assume a live Windows WoW install path.
