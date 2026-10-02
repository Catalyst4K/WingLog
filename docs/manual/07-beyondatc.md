# BeyondATC

If you fly with BeyondATC, WingLog connects to it and uses what ATC tells you: it shows your
clearances, fills in your procedures, draws your taxi route, and can ask ATC for your planned step
climbs. BeyondATC itself is still what talks to you; WingLog works alongside it.

> BeyondATC is a separate product by Skirmish Mode Games. WingLog isn't affiliated with them.

## Turning it on

**Settings → 3rd party → BeyondATC → On**. Leave the host as `localhost` when BeyondATC runs on the
same PC. A **BeyondATC** page appears, and the line at the top shows whether WingLog is connected.
BeyondATC can be started before or after WingLog.

## The BeyondATC page

- **Info**: the ATC facility you're talking to, COM2, your callsign and route progress.
- **Latest instruction**: the last clearance or instruction from ATC, broken into fields: cleared-to
  airport, SID, STAR, approach, runway, altitudes, QNH, squawk, the frequency to contact, holding
  point, stand and taxiways. A "readback correct" adds the next frequency without wiping the
  clearance.
- **Actions**: the same requests BeyondATC offers in its own menu (request clearance, taxi, and so
  on). Press one to send it. When BeyondATC has to wait for a gap on the frequency, the button stays
  highlighted and the line above says **Queued**, then **Transmitting…**, then **Awaiting ATC's
  reply**.
- **Radios**: set COM1 and COM2 by typing a frequency or choosing from **Frequencies** (departure
  and arrival airports, with runway-specific approach frequencies). **Auto-tune** and
  **Auto-respond** are BeyondATC's own settings, switched from here. **Auto step climb** is
  WingLog's (see below).
- **Transcript**: every radio call, yours, ATC's and other traffic's.

![The BeyondATC page with a departure clearance](images/beyondatc.png)

## Procedures from your clearance

When ATC clears you for a SID, a STAR or an approach, or gives you a runway, that's different from
what you have selected, WingLog asks **Update procedure from ATC clearance?** Choose **Update** to
switch your procedures to match, or **Dismiss** to keep yours. WingLog understands the usual ways
BeyondATC phrases these ("via the BIXAD2 departure", "expect the ILS approach runway 07R",
"cleared the … arrival").

## Your taxi route on the map

Switch on the **taxi chart** on the Track map. When ATC gives you a taxi clearance ("taxi to holding
point C9 runway 01R via B9, C9"), WingLog draws the route on the chart: from your aircraft, along the
taxiways in the order cleared, to the holding point (or to your stand after landing). The line
shortens behind you as you taxi.

## Automatic step climbs

With **Auto step climb** on (BeyondATC page → Radios), WingLog asks ATC for your step climbs at the
right time, using BeyondATC's **Request Altitude Change** menu, just as you would.

- **Planned steps.** Steps in your SimBrief plan are requested as you approach the step's waypoint.
- **Your own climbs.** If you set a higher altitude on the autopilot and the aircraft starts
  climbing, WingLog requests that level too, as long as it's no more than 4,000 ft above your
  cleared altitude. Turning the knob without climbing does nothing.
- **Never in the descent.** Once you're past top of descent, no more requests are made.
- The status line shows the next planned step, any request in progress and how ATC answered. If a
  level isn't offered or ATC doesn't clear it, WingLog tries once more, then gives up on that step.

Auto step climb starts **off** each time WingLog starts.

## Stand from ATC for GSX

After landing, when ATC taxis you to a stand ("taxi to Stand N32"), the GSX gate search offers that
stand with one click, for the times BeyondATC's handover to GSX doesn't happen by itself (see
[GSX](08-gsx.md)).
