# Troubleshooting

## The sim isn't connecting

The top-right corner shows **SimConnect: connected** once WingLog can see MSFS. If it stays on
**connecting** or **disconnected**:

- Make sure MSFS 2024 is running and you've loaded into a flight (the main menu is enough to
  connect, but there's nothing to track there).
- WingLog keeps retrying by itself; there's nothing to restart.
- If you run MSFS as administrator, run WingLog the same way, or neither.

## Tracking didn't start

- Check you loaded at the departure airport in Dispatch's plan, and that the aircraft has stopped
  moving.
- Press **Start tracking** on Track. This always works.
- If automatic starting keeps misfiring with your setup, switch it off in **Settings → UI →
  Tracking** and use the button.

## The flight didn't finish

WingLog finishes the flight once you're parked with the engines off after landing. If you shut down
somewhere unusual, or left an engine running, press **Finish & save**. Automatic finishing can be
switched off in **Settings → UI → Tracking**.

## WingLog closed during a flight

Start it again. It offers to resume tracking the flight (if it's still going in the sim) or discard
it. Nothing recorded before it closed is lost.

## BeyondATC isn't connecting

- BeyondATC must be running, with a flight loaded.
- **Settings → 3rd party → BeyondATC** must be **On**, with the host `localhost` if BeyondATC runs on
  the same PC.
- If the **Frequencies** list is empty, it fills in once BeyondATC has your flight plan loaded.

## GSX Remote Control isn't connecting

- GSX Pro must be running in the sim (Couatl started).
- Check the port in **Settings → 3rd party → GSX Remote Control** matches **Remote Client** in GSX's
  own settings (8744 by default).

## The taxi chart takes a long time

The first time you open the taxi chart at an airport, WingLog reads the airport's taxiways from the
sim, which can take a few minutes at a large airport. After that it's saved and opens straight away.

## Reporting a bug

Open an issue at
[github.com/Catalyst4K/WingLog/issues](https://github.com/Catalyst4K/WingLog/issues). Say what you
were doing and what you expected, and attach `logs\main.log` from `%APPDATA%\WingLog` (see
[Installing and updating](02-installing.md)).
