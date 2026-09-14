# Using WingLog

A quick walkthrough of a typical flight, start to finish. WingLog runs alongside MSFS —
launch it before or after the sim, in either order.

## 1. Add an aircraft (Fleet)

Open **Fleet → New aircraft** and enter a registration and ICAO type. Hit **Look up** to
pull the real-world type, operator and a photo automatically from a public registration
database — you can still edit anything it fills in. If you fly with a specific SimBrief
airframe profile (a custom livery/config saved in SimBrief), link it here so Dispatch
plans use its real weights instead of SimBrief's generic default for the type.

## 2. Plan a flight (Dispatch)

Pick your aircraft, a departure and destination, and generate a SimBrief OFP without
leaving WingLog — or fetch the latest plan you already made on SimBrief's own site. Check
the METARs for departure, destination and alternate on the right, then choose your
departure/arrival procedures (SID, transition, STAR, approach) from the **Procedures**
card — these come straight from the sim's own navdata, not a subscription service, so
whatever's installed in MSFS is what shows up here. Change your mind at any point before
or during the flight; the choice isn't locked in until you land.

When you're happy, hit **Fly**. This saves the flight and switches you to Track.

## 3. Fly it (Track)

Load into MSFS at your departure airport. WingLog watches for a stable, on-the-ground
aircraft at roughly the right spot and starts tracking automatically — no button to
press. If that doesn't fire (e.g. you loaded somewhere unusual), use **Start tracking**
manually.

Track shows your live position, altitude, speed and current phase of flight on a map,
following your chosen SID/STAR/approach. If WingLog closes or crashes mid-flight, it'll
offer to resume tracking (or discard the flight) the next time you open it — nothing is
lost.

## 4. Review the flight (Logbook)

Once you've landed and the flight ends, it shows up in **Logbook** with the full picture:
block and air time, fuel burn, your flown route on a map, altitude/speed charts, and a
real landing report — touchdown rate, G-force, pitch, bank, crosswind, centreline offset,
distance from threshold, and a 0–100 landing score with a breakdown of exactly which
category cost you points.

If you use GSX Pro for ground handling, its catering/fuel/handling receipts for this
flight show up here automatically too, once GSX tracking is enabled (see below).

## Settings

- **Units** — weights (kg/lb), OFP altitudes (ft/m/hybrid), METAR wind speed (kt/m/s),
  landing distances (ft/m) — each independent, set them however you think in.
- **Theme** — light, dark, or follow your system setting.
- **3rd party** — your SimBrief username (used to fetch your latest plan), and GSX
  ground-service tracking. WingLog checks for GSX's receipts folder automatically on
  first launch; toggle it here if you need to turn it on/off or point it at a
  non-default folder.
- **Data** — import an existing fleet (JSON) or logbook (CSV), or export your own back
  out. It's your data; nothing here is a one-way door.

## Notes

- Everything lives in a local SQLite database on your own machine. WingLog makes no
  network calls on your behalf except to SimBrief, to generate the OFP you asked for.
- WingLog is not affiliated with, endorsed by, or sponsored by Microsoft Corporation or
  Asobo Studio.

Questions or a bug to report? [Open an issue on GitHub](https://github.com/Catalyst4K/WingLog/issues).
