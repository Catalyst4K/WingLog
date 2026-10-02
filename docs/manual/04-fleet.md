# Fleet

The Fleet page lists your aircraft. Sort it by registration, type, airline, location, hours or
number of flights by clicking a column heading. **Active** and **Retired** aircraft have their own
tabs.

## Adding an aircraft

1. Choose **New aircraft**.
2. Enter the registration and the ICAO type (for example `A359`).
3. Press **Look up** to fill in the real-world type, operator and a photo from a public registration
   database. Anything it fills in can still be edited.
4. Optionally pick the aircraft's **SimBrief profile** (see below), then save.

The **Location** column shows where each aircraft is, updated when a flight ends there.

## The aircraft page

Click an aircraft to see:

- its photo, airline, current airport, total hours, number of flights and last flight;
- **Last parked** stand: when a flight ends at a gate, WingLog notes which stand you parked at, and
  shows it here and in Dispatch so you can start your next flight from the same gate;
- **SimBrief profile**: the SimBrief airframe Dispatch uses for this aircraft;
- **Landing history** and **Flights**: click a flight to open it in the Logbook.

## SimBrief profiles

A SimBrief airframe holds an aircraft's real weights, engines and performance. Without one, SimBrief
uses its own default for the type, which is usually close but can be off on weights, and so on fuel.

On the edit page you can pick a profile from SimBrief's community airframe list, which shows the
developer and simulator each one was made for. If you plan a flight with a custom airframe that isn't
saved to the aircraft yet, Dispatch offers **Save this airframe**.

## Retiring, replacing and deleting

- **Retire** moves an aircraft to the Retired tab. Its flight history is kept, it just can't be
  picked for new flights. **Un-retire** brings it back.
- **Replace…** is for the same physical airframe changing registration or livery: it moves the
  flight history onto another fleet aircraft and retires the old one. It can't be undone from the
  app.
- **Delete** removes the aircraft for good.

To bring in an existing fleet, use **Settings → Data → Fleet → Import**.
