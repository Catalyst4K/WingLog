# Online networks

WingLog can show the traffic of **VATSIM** or **IVAO** on the Track map, so you can see who else is
flying around you. It only **reads** the network's public data feed, the same one the networks'
own map websites use. Nothing is sent, no account is needed, and you don't log in to anything
through WingLog. It's **off** until you choose a network.

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

On the Track map, press the **aeroplane button** to show or hide the traffic. The button is on the
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

## How much data it uses

WingLog refreshes **every 15 seconds** while the traffic is shown, which is the networks' own
refresh rate: asking faster would only get the same file, and IVAO blocks clients that do. That's
about **140 MB an hour on VATSIM and 44 MB an hour on IVAO**, only while the traffic is switched on.
For scale, the sim's own scenery streaming is typically several GB an hour. One download serves the
PC and every paired phone.
