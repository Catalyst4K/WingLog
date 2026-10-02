# Installing and updating

## Installing

1. Download the installer, `WingLog-<version>-win-x64.exe`, from WingLog's GitHub releases page or
   from flightsim.to. Both always carry the same version.
2. Run it. You can choose where WingLog is installed.
3. Windows may show a blue **Windows protected your PC** screen. WingLog's installer isn't
   code-signed (signing certificates cost more than a free project can justify), so SmartScreen
   doesn't recognise it yet. Choose **More info**, then **Run anyway**.

WingLog can start before or after Microsoft Flight Simulator, in either order. It connects to the
sim by itself and shows the connection in the top-right corner (**SimConnect: connected**).

## Updating

WingLog checks GitHub for a newer version shortly after it starts and every few hours (you can
switch this off in **Settings → About**). When there is one, a banner appears across the top:

- **What's new** shows the release notes.
- **Download** opens the release page, where you download the new installer.
- **Skip this version** hides the banner until a newer version comes out.
- The **×** hides it until you next start WingLog.

The banner never appears while you're in the air.

To update, run the new installer over the old one. Your fleet, logbook and settings are kept.
**Settings → About → Check now** checks straight away.

## Where your data lives

Everything is in one database file in your Windows user folder:
`%APPDATA%\WingLog\winglog.db`. Paste `%APPDATA%\WingLog` into File Explorer's address bar to
open the folder.

- **Automatic backups.** Each time WingLog starts, it saves a copy of the database in the
  `backups` folder next to it, keeping the five most recent.
- **Logs.** If something goes wrong, `logs\main.log` in the same folder is what to attach to a bug
  report.
- **Exports.** To keep a copy of your fleet and logbook in a portable form, use
  **Settings → Data → Export** (see [Settings](10-settings.md)).

## Uninstalling

Use **Settings → Apps** in Windows. Your database is left in place in case you reinstall; delete
the `%APPDATA%\WingLog` folder as well if you want it gone.
