# Second screen

The second screen shows your flight on a phone or tablet while you fly: the live map, your plan,
GSX and BeyondATC. It's a web page WingLog serves to your home network, so there's nothing to
install on the phone. It's **off** until you turn it on.

## Turning it on

1. Open **Settings → Data → Second screen** and press **On**.
2. Windows will ask whether to let WingLog through its firewall the first time. Choose **Allow**.
   If your home network is set to **Public** in Windows, allow Public networks too (or set the
   network to Private in Windows' network settings).
3. The phone or tablet must be on the **same Wi-Fi** as this PC (not a guest network).

WingLog listens on one address on your home network only, never on anything else.

## Pairing a phone

Every device has to be paired once, with a code only this PC shows.

1. In the Second screen card, press **Pair a device**. The QR code sharpens and a six-digit code
   and the page's address appear.
2. On the phone, **scan the QR code** with the camera: the page opens and pairs by itself. Or open
   the address by hand and type the six-digit code.
3. The phone remembers the pairing, so next time it opens straight to your flight.

The code works once and closes after 5 minutes. While the card is open WingLog replaces a used or
expired code with a new one, so you can pair a second device straight after the first. Press
**Close** to hide the QR code again.

**Paired devices** lists every phone and tablet, when it last connected, and a **Revoke** button.
A revoked device is sent back to the pairing screen straight away.

## What the phone shows

A bar along the bottom switches between four pages:

- **Track**: the live map, following your aircraft. A banner shows the flight number, times, the
  time flown, the time remaining and your estimated arrival. Buttons switch the VFR overlay and the
  taxi chart on and off, and **Procedures** lets you choose departure and arrival procedures in two
  tabs. Your choice is saved on the PC, just as if you'd made it there.
- **Dispatch**: the weather for your airports above your flight plan's figures (weights, fuel,
  step climbs and so on). It shows the flight being tracked, or your newest planned flight.
- **Ground services**: the same GSX menu, gate, commands and services as on the PC. Needs **GSX
  Remote Control** on (see [GSX](08-gsx.md)).
- **BeyondATC**: clearances, actions and the transcript. **Radios** is behind a button so the page
  stays uncluttered. Needs **BeyondATC** on (see [BeyondATC](07-beyondatc.md)).

From the phone you can press BeyondATC's actions, use GSX's menu and commands, and choose
procedures. Nothing else: no changes to your fleet, logbook or settings.

## Privacy and safety

- Off until you turn it on, and only reachable from your home network.
- A device needs the pairing code once, and then its own private key (stored on the phone; only a
  fingerprint of it is kept here).
- The connection isn't encrypted: it's plain HTTP on your home network, like most home devices.
  Anyone who can already watch your home network's traffic could read the live data. If you lose a
  phone, **Revoke** it.
- The phone loads map tiles from OpenFreeMap, so it needs an internet connection for the map.
- The page doesn't carry your data: it's sent only to a paired device, when it connects.

If the phone can't reach WingLog, see [Troubleshooting](12-troubleshooting.md).
