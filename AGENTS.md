# AGENTS

This repository is the clean local starting point for the `LÑÑRank` Warcraft Logs tooltip project.

## Project rules

- Keep the shipped behavior **Warcraft Logs only**.
- Do not reintroduce Raider.IO dependencies, code paths, UI labels, or data assumptions.
- Treat the passive live relay and in-addon live event log as active supported behavior.
- Preserve the WoW reload boundary: optimize around it, but do not claim to bypass it.

## Critical invariants

- All lookup sources must flow through the same gather pipeline.
  - Manual imports, queued addon requests, LFG-driven requests, and self refreshes must produce the same record shape.
- Metric routing must be deterministic.
  - Tank: `playerscore`
  - DPS: `dps`
  - Healer: `hps`
- Highest dungeon level data must come from the separate WCL level-oriented page, not by inference from parse pages.
- Tooltip and dashboard data must continue to work when records are stale.
- The local JSON DB is the source of truth for cached character state.

## Addon constraints

- Hover must stay read-only by default.
- Queueing is explicit except for LFG applicant auto-queue and daily self refresh.
- Minimap button behavior matters:
  - circular fill
  - green when clean
  - red when refresh is needed
  - left click reloads/imports
  - right click opens settings
  - only reopens LFG after reload if LFG was already open when clicked

## Dashboard constraints

- Tabs are the top-level navigation model.
- Queue and recent statuses must reflect the real unified request state.
- Results and LFG rows must link to the correct WCL metric page for the character role.

## Safe workflow

1. Run:
   - `npm run check`
   - `npm test`
2. If touching WoW addon Lua:
   - update `wow-addons/lnnrank`
   - copy the updated addon files into `C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\lnnrank`
   - keep the repo addon and live WoW addon folder in sync after every addon update
   - keep the runtime behavior unchanged unless intentionally requested
3. If touching lookup logic:
   - preserve the unified pipeline guarantee
   - preserve deterministic role-to-metric mapping

## Files that define behavior

- `src/wow-addon-tools/live-provider.js`
- `src/wow-addon-tools/sync-service.js`
- `src/wow-addon-tools/cache.js`
- `src/wow-addon-tools/lnnrank-bridge.js`
- `src/shared/wow-performance.js`
- `src/shared/wow-specs.js`
- `src/wow-addon-tools/dashboard/app.js`
- `wow-addons/lnnrank/Tooltip.lua`
- `wow-addons/lnnrank/Core.lua`
- `wow-addons/lnnrank/Interactions.lua`
- `wow-addons/lnnrank/Collectors.lua`
- `wow-addons/lnnrank/MinimapButton.lua`
