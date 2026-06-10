# AGENTS

This repo is the local source of truth for the LNNRank Warcraft Logs tooltip
addon and dashboard.

## Install And Run

```powershell
cd C:\Users\dan_o\Desktop\repos\lnnrank
Copy-Item .env.example .env
npm install
npm run check
npm test
npm run sync-wow-addon-requests -- --install-wow
npm start
```

Open `http://127.0.0.1:47832`.

In WoW, enable both addons:

- `lnnrank`
- `lnnrank_companion`

Then run `/reload`.

Use `npm run dev` for an isolated sandbox dashboard. It writes state under
`output/dev-run` and does not touch the live WoW AddOns folder.

## Project Rules

- Keep shipped behavior Warcraft Logs only.
- Do not reintroduce Raider.IO dependencies, UI labels, or data assumptions.
- Treat the passive live relay and in-addon live event log as supported behavior.
- Preserve WoW's import boundary: the app can receive live addon events, but the
  running addon still needs `/reload` to import newly generated companion data.
- Keep addon source changes synchronized to the live WoW AddOns folder whenever
  the user asks for addon deployment or live testing.

## Critical Invariants

- All lookup sources flow through the same gather pipeline: manual search,
  addon requests, live relay events, LFG applicants, group members, and self
  refreshes.
- Search queue entries are deduped by normalized `(region, realm, name)`.
- Force searches bypass cache expiration, but are still deduped while queued.
- Metric routing is deterministic: tanks and DPS use `dps`; healers use `hps`.
- Highest dungeon level data comes from the WCL level-oriented data path, not
  by inference from parse pages.
- Role-specific parse refreshes are authoritative: `null` parse fields should
  clear stale player-score parse values while preserving key-level data.
- The local JSON DB is the source of truth for cached character state.

## Addon Constraints

- Hover stays read-only by default.
- Queueing is explicit except for LFG applicant auto-queue, group scans, and
  daily self refresh.
- Ctrl-click player interactions are force-refresh searches.
- The minimap button background is intentionally black/static.
- The addon should not send lookup messages while inside active Mythic+ runs.
- Auto combat logging is controlled by addon settings and should remain aligned
  with the local AutoCombatLogger behavior.

## Dashboard Constraints

- Tabs are the top-level navigation model.
- LFG, group, search, live log, and reader views consume brokered events rather
  than bespoke side channels.
- Live log is a consumer only; clearing it must not reset the reader pipeline.
- Queue and recent statuses must reflect the unified request state.
- Class colors in the app are calculated at render time from class names.
- LFG rows can show queued/error/found states and should queue forced refreshes
  for stale/incomplete records when required.

## Useful Commands

```powershell
npm run check
npm test
npm start
npm run dev
npm run sync-wow-addon-requests -- --install-wow
npm run stress:search -- --count 30 --workers 4 --provider auto --api-batch-size 3
```

Default live WoW AddOns directory:

```text
C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns
```

## Files That Define Behavior

- `src/wow-addon-tools/live-provider.js`
- `src/wow-addon-tools/sync-service.js`
- `src/wow-addon-tools/cache.js`
- `src/wow-addon-tools/dashboard-server.js`
- `src/wow-addon-tools/lnnrank-bridge.js`
- `src/shared/wow-performance.js`
- `src/shared/wow-specs.js`
- `src/wow-addon-tools/dashboard/app.js`
- `wow-addons/lnnrank/Core.lua`
- `wow-addons/lnnrank/EventBridge.lua`
- `wow-addons/lnnrank/Interactions.lua`
- `wow-addons/lnnrank/PassiveChannel.lua`
- `wow-addons/lnnrank/Tooltip.lua`
