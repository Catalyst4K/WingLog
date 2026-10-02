# Dispatch

Dispatch is where a flight is planned. It uses SimBrief for the flight plan (the OFP) and the sim's
own navigation data for procedures.

## Planning a flight

Under **Plan a flight**, choose the aircraft, departure and destination. Airline ICAO, flight number
and departure time are optional. Then either:

- **Generate…** creates the plan in SimBrief without leaving WingLog: a small SimBrief window opens,
  generates it and closes, and the plan loads into Dispatch. The first time, log in to SimBrief with
  your Navigraph account (in that window, or with **Log in with Navigraph** under **Settings → 3rd
  party**). Your SimBrief username must be set too.
- **Plan on SimBrief…** opens SimBrief's own planner with these details filled in, for when you want
  to adjust everything there.
- **Fetch latest OFP** loads the most recent plan you made on SimBrief, using your SimBrief username.

**Advanced** holds optional SimBrief settings: passengers and cargo, fuel factors and extra fuel,
reserves, taxi times, cost index, cruise level and route choices. Every field can be left blank.
**Load settings from a previous flight** copies them from an earlier plan.

If the aircraft has a **last parked** stand at your departure airport, Dispatch reminds you of it,
so you can choose the same gate when you start the flight in MSFS.

## Reading the plan

Once a plan is loaded, Dispatch shows the flight number and route, cruise level and step climbs,
scheduled times, planned fuel, payload and weights, cost index and the full route. **View OFP PDF**
opens SimBrief's full flight plan.

WingLog matches the plan to a fleet aircraft by its tail number. If it can't, pick one under **Fleet
aircraft**.

## Weather

METARs for the departure, destination and alternate are shown alongside the plan, with their flight
category (VFR, MVFR, IFR, LIFR).

## Procedures

The **Procedures** card is where you choose your departure runway, SID and transition, and your
STAR, approach and their transitions. These come from the navigation data installed in MSFS, so
what you see matches what the sim (and your aircraft) has, with no subscription needed. You can
change them right up until you land, on the Track page too.

With BeyondATC turned on, WingLog reads your clearance and offers to fill these in for you (see
[BeyondATC](07-beyondatc.md)).

## Starting the flight

Press **Fly** to save the flight and go to Track. If another flight is already planned or being
tracked, WingLog asks before replacing it. **Discard plan** clears the plan from Dispatch; you can
fetch it again from SimBrief.
