# LÑÑRank

A desktop companion for World of Warcraft (Retail) that scores the players around you using
Warcraft Logs data, and feeds that data back into the in-game **LÑÑRank** addon tooltips.

## Install

1. Download the latest **`LNNRank-<version>-setup.exe`** from the
   [Releases](https://github.com/Arthwin/lnnrank/releases) page.
2. Run the installer and launch **LÑÑRank**.
3. On first launch, enter your **Warcraft Logs API credentials** in Settings
   (create a v2 client at <https://www.warcraftlogs.com/api/clients>). They're stored locally
   on your machine only.

That's it — the app installs its WoW addon for you and keeps it updated. It also updates
itself automatically (check anytime with the **Check for updates** button, top-right).

## Using it

- **Search** any character to see their LÑÑ score, parse breakdown, enchant audit, and dungeons.
- **LFG / Group / Live** populate automatically from the game while you play (the addon must be
  loaded — the app installs it; type `/reload` in WoW after first install).
- The app refreshes the addon's data in the background, so your in-game tooltips stay current.

## Requirements

- Windows 10/11, World of Warcraft (Retail) installed.
- A free Warcraft Logs API v2 client (client id + secret).

## Privacy

Your Warcraft Logs credentials never leave your machine — they're stored in your local app
data and used only to call the Warcraft Logs API directly from your computer.
