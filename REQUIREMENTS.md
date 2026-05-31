# LÑÑRank Requirements

This file freezes the current functional requirements for the local `LÑÑRank` Warcraft Logs tooltip project as it exists at handoff time.

## Product scope

- Visible product name is `LÑÑRank`.
- Code paths, folder names, and local identifiers may use `lnnrank`.
- The shipped product is **Warcraft Logs only**.
- Raider.IO dependencies, data sources, UI labels, and enrichment logic are removed.
- The abandoned passive chat bridge / custom channel transport is removed.

## Architecture

- The project consists of:
  - a Retail WoW addon in `wow-addons/lnnrank`
  - a local Node.js backend and dashboard in `src/wow-addon-tools`
  - a lightweight local JSON DB used as the source of truth for cached records and statuses
- WoW still requires `/reload` to:
  - flush addon `SavedVariables` requests to disk
  - import regenerated companion addon data into the running client
- The system should optimize around this reload boundary, not claim to bypass it.

## Lookup and caching behavior

- Hover is read-only by default.
- Known cached data should always display when present, even if stale.
- Refreshes should only be requested from explicit actions or approved automatic sources.
- Cache TTL is `24` hours.
- The local DB should preserve the last good record and merge partial refreshes without destroying richer older fields.
- All lookup entry points must flow through the same deterministic gather pipeline.
  - dashboard/manual imports
  - addon queued requests
  - LFG auto-queued requests
  - daily self refresh
- Search/import results from different entry points should be deterministically the same for the same character at the same source state.

## Queue behavior

- Manual queue and WoW `SavedVariables` queue are treated as one unified queue in the dashboard.
- Queue processing should consume the same queue snapshot the UI is showing.
- Queue entries should be deduped by normalized `(region, realm, name)`.
- Clearing the queue from the app should also clear queued requests from WoW `SavedVariables` so the addon reacts correctly after the next `/reload`.
- Removing or canceling LFG-driven requests before reload should also clear them from the queued request state that the addon will read next.

## Automatic and explicit lookup sources

- `Ctrl`-click should queue lookups from:
  - player/world units
  - unit frames such as target and party frames
  - chat name links
- LFG applicants should auto-queue when they appear.
- Group and raid members should not auto-queue by default.
- The addon should auto-queue the current player for refresh when their cached record is older than `24` hours.

## Warcraft Logs data rules

- Tanks use `playerscore`.
- DPS use `dps`.
- Healers use `hps`.
- There should be no silent fallback from role-specific pages back to points-style parse data.
  - If a role-specific page fails, the correct metric remains selected and missing parse values stay blank.
- Metric routing must be deterministic and generic.
  - explicit WoW role hints should override conflicting page hints
  - spec-to-role mapping must be deterministic for all specs
- WCL links in the dashboard must open the correct metric page for the role.
- Highest dungeon key data must come from an independent WCL level-oriented page, not inferred from the parse page.
- Dungeon rows should store and display:
  - dungeon abbreviation
  - pulled parse percent
  - highest level text
  - WCL-style color for the highest level text
- Timed key suffixes like `+`, `++`, `+++` should be derived deterministically from the available points/level data.

## Tooltip requirements

- Tooltip title shows `LÑÑRank`.
- The tooltip should not show `Last Updated`.
- Current row layout is:
  - title
  - colored character name on the left, role icon and blended percent on the right
  - `Averages` row with calculated parse average and total WCL score
  - one row per current dungeon with parse percent and highest key text
  - one raid progression row
  - ctrl-click refresh hint at the bottom
- The top-row percent is the blended numeric representation of:
  - the calculated WCL score percentile/color tier
  - the calculated dungeon-parse aggregate
- The name color should use that same blended presentation color.
- The role icon must be a role icon, not a spec icon.
- Dungeon highest-level text should be colored independently to align with WCL-style progression colors.
- If no data exists, the tooltip should say `No LÑÑRank data found.`

## Dashboard requirements

- Top-level navigation is tab-only.
- The dashboard must run locally and serve on a configurable port, default `47832`.
- Tabs currently include queue, LFG, stats, and results.
- The queue tab should reflect the real unified request state.
- Recent statuses should reflect real queue/search outcomes and include source information.
- A reload-required indicator should remain supported in the dashboard state model.
- Results rows should include status and link to Warcraft Logs.
- Character names in results should be clickable to the correct WCL profile page.

## LFG dashboard requirements

- The LFG tab is a compact row-based view.
- Applicants that belong to the same party should be visually grouped.
- Group wrappers should have a slightly different background from single applicants.
- The dashboard should not duplicate the score in multiple places.
- Name/server/region plus compact score info should fit into a tight header row.
- Parse strips should be compact, not padded bubble chips.
- Group header labels/titles were intentionally removed in favor of a minimal grouped presentation.

## Minimap button requirements

- The minimap button remains circular.
- The background fill should be:
  - green when no refresh is needed
  - red when a refresh is needed
- The fill should fit the circular border correctly and not render as a square.
- Left-click should trigger reload behavior.
- Right-click should open addon-specific settings.
- Hover tooltip should show the addon name and click hints.
- Clicking the reload button should only reopen the LFG UI after reload if the relevant LFG view was already open when the button was clicked.

## Settings requirements

- The addon has its own settings panel.
- Current settings include:
  - show queued/searching tooltip lines
  - show in combat
  - scan group/raid snapshots
  - scan LFG applicants

## Packaging requirements

- Repo root is intended to be runnable from a clean/containerized environment.
- The repo should include:
  - addon source
  - backend source
  - frontend source
  - tests
  - docs
  - Dockerfile
  - `.env.example`
  - `.gitignore`
- A working local `.env` may exist for development, but it must be ignored by git.
