# Online networks

WingLog can show the traffic of **VATSIM** or **IVAO** on the Track map, so you can see who else is
flying around you. It only **reads** the network's public data feed, the same one the networks'
own map websites use. Nothing is sent, and you don't log in to anything through WingLog. VATSIM's
traffic needs no account; IVAO's needs your member number (below). It's **off** until you choose a
network.

## Choosing a network

1. Open **Settings → 3rd party → Online network**.
2. Choose **VATSIM** or **IVAO** (one at a time).
3. Enter your member number: your **CID** on VATSIM, or your **VID** on IVAO.

On VATSIM the CID is optional. It's only used to leave your own aircraft out of the traffic.

**On IVAO the VID is required.** IVAO shows other pilots only to its own members, so WingLog shows
no IVAO traffic until you enter yours. The traffic button on the map is greyed out until then, and
WingLog doesn't contact IVAO at all. Other members' flights are only ever drawn on the screen: they
are never saved, exported or written to a log.

## Showing the traffic

On the Track map, press **Show VATSIM traffic** (or IVAO), the aeroplane button at the top right, to
show or hide the traffic. The button is on the
PC and on the phone's Track page, and it is **one switch for both**: pressing it on the phone
changes it on the PC, and it is remembered next time you start WingLog.

- Aircraft are drawn pointing the way they're heading, with their callsign beside them once you
  zoom in. Click or tap one to see its callsign, type, route, altitude and speed.
- **Aircraft on the ground are smaller and dimmer**, and are labelled only when you zoom in close.
  VATSIM doesn't say whether a pilot is on the ground, so WingLog treats anyone under 40 kt as
  parked or taxiing.
- Between refreshes, aircraft **glide** along their heading at their speed, so the map moves
  smoothly. They jump to the real position at each refresh.
- Only the nearest aircraft within 250 nm of you are shown, which is a little more than the map
  holds at cruise. With no sim connected, WingLog looks around the departure airport of the
  flight shown.

If the network can't be reached, the map keeps the last aircraft for 45 seconds, then says
"traffic unavailable" and tries again, waiting a little longer each time.

## The sim's own traffic

Under the network button on the Track map is a second button, **Show sim traffic**. It draws the
aircraft the simulator itself has around you, in **teal** (the network's are amber): the real-world
traffic BeyondATC adds, and any other AI traffic. Like the network button it is one switch for the
PC and the phone, and it is remembered.

- It works whether or not you have chosen a network, and it reads the sim directly. Nothing is
  sent anywhere.
- **It is off while the network's traffic is shown.** The networks' pilots are also placed in the
  sim as AI aircraft, so showing both would draw each one twice. The button greys out with
  "Off while VATSIM traffic is shown" (or IVAO), and comes back, still on, when you hide the
  network's traffic.
- Your own aircraft is left out, and so are the scenery objects some add-ons list as aircraft
  (jetway helpers and the like).
- If the sim isn't running yet, the map says "Sim traffic unavailable" and tries again every 15
  seconds.

## Filing your flight plan

On **Dispatch** (beside the OFP’s PDF button) and on **Track** (on the flight card), **File on VATSIM** and **File on IVAO** open the network’s own filing page with your plan already filled in, from the link SimBrief put in the OFP. You log in there and press File: WingLog files nothing itself and never sees your login. With a network chosen in Settings only its button shows; with none chosen both do. If an older plan has no link, WingLog says so.

## Knowing you are online

While a flight is being tracked, WingLog looks for you in the network’s feed about once a minute (or every 15 seconds while the traffic is shown, from the same download). The network’s own program (vPilot, Altitude and so on) is what connects you: WingLog only notices.

- **With your CID or VID entered,** you are found by it.
- **Without one (VATSIM only),** you are "probably" online if a pilot has filed the same departure and arrival as your flight and is within 5 nm of your aircraft.

A flight you were online for while in the air is saved with the network and your callsign. The **Logbook** shows a VATSIM or IVAO badge on it, the callsign on its detail page, and offers **All / Online / VATSIM / IVAO** buttons above the list once you have flown online.

## BeyondATC while online

Human controllers are the only voice when you are online, so WingLog hides BeyondATC’s clearance prompt and its taxi line, hides its frequency suggestions, and stops the auto step climb asking for levels. A note on Track says why. BeyondATC itself keeps running, and everything comes back when you are offline again. To keep it all anyway, turn on **Keep BeyondATC while online** in Settings → 3rd party → Online network.

BeyondATC’s **Auto-tune** is BeyondATC’s own setting, and WingLog never changes it for you. While it is on, BeyondATC can retune your radios to its own frequencies, away from the network’s controllers. So if BeyondATC is connected with Auto-tune on while you are online, WingLog shows a warning on Track (and the phone’s Track) and above the toggles in the **Radios** card on the BeyondATC page, even with **Keep BeyondATC while online** on. Turn **Auto-tune** off there or in BeyondATC and the warning goes.

## Who is online at your airports

While a flight is tracked, Track (and the phone’s Track page, as a folded section) lists the controllers online at the flight’s departure, arrival and alternate airports: their position (DEL, GND, TWR, APP), callsign and frequency, and each airport’s ATIS with its letter and text. The frequencies are only shown: WingLog never tunes your radios. Some US stations use the three-letter airport code (JFK_TWR for KJFK), which WingLog matches too. Enroute controllers are not listed, because neither network says where they are. On IVAO this needs your VID, like the traffic.

When an ATIS names exactly one runway, WingLog shows **Runway in use (from the ATIS)** above its text. It is a suggestion only: nothing is changed or tuned from it. It stays blank whenever the ATIS names several runways, splits arrivals from departures, mentions a closed runway or names none, because a wrong runway is worse than none. In a read of VATSIM's ATIS texts it found one for a little over half of them.

## How much data it uses

WingLog refreshes **every 15 seconds** while the traffic is shown, which is the networks' own
refresh rate: asking faster would only get the same file, and IVAO blocks clients that do. That's
about **140 MB an hour on VATSIM and 44 MB an hour on IVAO** while the traffic is switched on.

While a flight is tracked with a network chosen, WingLog also looks for you in the feed once a minute,
even with the traffic off: about **35 MB an hour on VATSIM and 11 MB on IVAO**. While the traffic is
shown, that check uses the same download. With no network chosen, nothing is downloaded at all.

For scale, the sim's own scenery streaming is typically several GB an hour. One download serves the
PC and every paired phone.
