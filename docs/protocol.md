# Device protocol

Version 1, agreed 2026-11-12. How sensors, sirens, gateways and the hub talk to each other. Decision numbers refer to [architecture.md](architecture.md), requirement numbers to [software.md](requirements/software.md). M3's additions (firmware updates, the key change after a restore, pairing over Bluetooth) were added on 2026-11-18 from [m3-updates-design.md](m3-updates-design.md) and [m3-design.md](m3-design.md), and follow section 11's rules for extensions.

Not covered here:

- How the phone and web app talk to the hub: see [stack.md](stack.md).

Values marked † are provisional and are set by a measurement: spikes S6 (range), S7 (one radio hearing several settings, O14), S9 (Bluetooth) and the reply-timing measurement (O10). Values marked ‡ come from the M3 designs: provisional values set by a measurement on the boards or in S9, and facts about ESP-IDF and Bluetooth stated from memory, checked when ESP-IDF's sources and the boards are first used.

## 1. Overview

```
                 site channel (868.1, 868.3 or 868.5 MHz)
Sensor ───────────────────────────────────────→ Gateway ══ WebSocket or USB ══ Hub
       ←───────────────────────────────────────         (gateway's own packets,
Siren            869.525 MHz                              device packets inside)
  ║
  ╚══════════════════ WebSocket over Wi-Fi ══════════════════════════════════ Hub
```

- **One packet format everywhere.** A packet is the same bytes over LoRa, WebSocket and USB (D101).
- **End to end.** Every device packet is encrypted and authenticated with that device's own key, between the device and the hub. A gateway cannot read or forge device packets (D71).
- **Gateways wrap and forward.** A gateway puts each device packet it hears inside one of its own packets, encrypted with its own key, and sends it to the hub. The hub sends radio packets back the same way.
- **Two frequencies.** Devices send on the site's channel and listen on 869.525 MHz. The hub's replies and commands go out on 869.525 MHz, where 10% airtime is allowed (D104).
- **Only the hub answers** (D71), and only when it needs to (D72).

## 2. Radio

### Frequencies

| Direction | Frequency | Airtime limit | Power |
| --- | --- | --- | --- |
| Device to hub | One site channel: 868.1, 868.3 or 868.5 MHz | 1% per device per hour | 25 mW (14 dBm) radiated |
| Hub to device | 869.525 MHz | 10% per gateway per hour | up to the radio's +22 dBm, against 27 dBm allowed; the extra power lets replies use a faster setting (section 7) |

The hub chooses the site channel during setup, as the quietest of the three on the first gateway's noise measurement. Every device on the site uses it.

### LoRa settings

| Setting | Value |
| --- | --- |
| Bandwidth | 125 kHz |
| Coding rate | 4/5 |
| Preamble | 8 symbols |
| Header | explicit, with the radio's own CRC on |
| Low data rate optimisation | on for SF11 and SF12 |
| Sync word | private (0x12), so LoRaWAN traffic on 869.525 MHz is never decoded |
| IQ | normal in both directions |

### Data rates

| Index | Spreading factor |
| --- | --- |
| DR0 | SF12 |
| DR1 | SF11 |
| DR2 | SF10 |
| DR3 | SF9 |
| DR4 | SF8 |
| DR5 | SF7 |

A gateway's one radio hears one data rate at a time. So until spike S7 shows it can hear two (O14), **a site has one sending rate**: every sensor and siren sends at it, every gateway listens at it, and the hub pairs each device with that one rate allowed. The hub chooses it from the range test: DR5 where every device is near enough, a slower one otherwise †. It can change the site's channel and rate later, over the air, without any device being paired again (section 7, D115). Replies and commands may still use a faster rate than the site's, because the gateway can transmit at any rate. A device listens for the hub on 869.525 MHz at the reply data rate in its settings, usually faster than the rate it sends at (section 7). Until it has one, it listens at its own sending rate.

### Time on air

Milliseconds, from the formula in spike S2.

| Packet | Bytes | SF7 | SF9 | SF10 | SF12 |
| --- | --- | --- | --- | --- | --- |
| Sensor status | 25 | 62 | 206 | 412 | 1,483 |
| Hub reply | 32 | 72 | 247 | 453 | 1,810 |
| Disarmed notice | 18 | 51 | 185 | 330 | 1,319 |
| Siren command | 21 | 57 | 185 | 371 | 1,483 |
| Siren report | 28 | 67 | 226 | 412 | 1,647 |
| Started | 30 | 72 | 226 | 453 | 1,647 |
| Update query | 33 | 72 | 247 | 453 | 1,810 |
| Update status | 32 | 72 | 247 | 453 | 1,810 |
| Update offer | 43 | 87 | 288 | 535 | 2,138 |
| Key change | 34 | 77 | 247 | 453 | 1,810 |
| Log entry over LoRa, longest | 50 | 98 | 329 | 616 | 2,302 |

### Airtime budgets

Every transmitter keeps count of its airtime over a rolling hour. The limit is the law's, not ours: 1% of the hour is 36 seconds on the site channel, and 10% is 360 seconds on 869.525 MHz.

Regular traffic always stays inside the limit, and gives way early to leave room for urgent traffic. Urgent traffic is never held back: it goes at once, and it still goes when the device has used its whole legal hour (D111).

| Transmitter | Urgent: goes at once | Regular: gives way |
| --- | --- | --- |
| Sensor | Door, cover, button and started reports | Heartbeats and log entries: skipped once less than a fifth of the hour's airtime is left |
| Siren controller | Answers to commands, and reports of a change: the cover, mains power, the sounder stopping by itself, Wi-Fi going down | Regular reports and LoRa checks: paced to half of the hour's airtime (section 7). Log entries |
| Gateway | Siren commands | Replies: the last fifth of the hour's airtime is kept for siren commands |

How many packets the legal hour holds for one device: about 580 at SF7, 87 at SF10 and 24 at SF12. So the limit is out of reach at the fast and medium rates, and can be reached at SF12 by a door that changes more than about 24 times in an hour, or by two full retry runs.

When a device has used its whole legal hour and has an urgent packet to send:

- **The packet goes anyway.** This knowingly breaks the 1% rule (10% for a gateway), in a case that should be rare.
- **One safeguard stays, against a faulty device.** Past the legal hour, a device leaves a gap of nine times the packet's time on air after its last transmission. The wait is at most about half a second at SF7, 4 seconds at SF10 and 13 seconds at SF12. Past the limit a device then sends at most a tenth of the time, so a stuck door switch cannot lock out every other sensor or empty its own cell in hours. The worst hour measured in the simulation, with a door or cover changing every 2 seconds, held about 6½ minutes of airtime: the legal 36 seconds sent back to back, then a tenth of the rest.
- **It is logged.** Every packet sent past the limit is recorded as a warning, so the hub can tell the user that a device is using too much airtime: a faulty switch, or a sensor too far from its gateway.
- **Regular traffic stops** on that device until it is back inside the limit.

### Listening before sending

Sensors and sirens check whether another packet is already on the site channel before they send. This is the radio's channel activity detection. Following Semtech's recommended settings it takes about 3 ms at SF7 and about 160 ms at SF12 ([hardware notes](hardware-notes.md), section 3). If the channel is busy, the device waits a random 0.2 to 2 seconds and checks again. After 5 busy checks it sends anyway. A device that was listening for the hub when it started to send (a siren, or a sensor buzzing for a countdown) goes back to listening during each of those waits, so it does not miss a command or a disarmed notice. The check is a courtesy on top of the airtime limit, not a replacement for it. In the [gateway load simulation](spikes/gateway-load.md) it halved the packets lost to collisions.

## 3. Packet format

All multi-byte numbers are little-endian.

```
 0        1         5         9       10                      n−8      n
 ┌────────┬─────────┬─────────┬───────┬───────────────────────┬────────┐
 │ header │ address │ counter │ type  │ body                  │ tag    │
 └────────┴─────────┴─────────┴───────┴───────────────────────┴────────┘
 └──────── in the clear ──────┘└────────── encrypted ─────────┘
```

| Bytes | Field | Notes |
| --- | --- | --- |
| 0 | Header | Bits 7–4: protocol version, 1. Bit 3: direction, 0 = to the hub, 1 = from the hub. Bits 2–0: zero. |
| 1–4 | Device address | Given by the hub at pairing; random, never 0 or 0xFFFFFFFF. In a packet from the hub, it is the address of the device it is for. |
| 5–8 | Counter | The sender's counter, sent in full (section 4). |
| 9 | Message type | Encrypted (section 5). |
| 10… | Body | Encrypted (section 6). |
| last 8 | Tag | Authenticates everything above. |

Encryption is **AES-128-CCM with an 8-byte tag**, using the device's 16-byte key.

- **Nonce** (13 bytes): address (4) · direction (1 byte, 0x00 or 0x01) · counter (4) · four zero bytes.
- **Authenticated data**: the 9 clear bytes, followed by a binding where section 4 asks for one.

The address in the clear lets the hub find the key without trying them all. A packet from an unknown address is dropped at once, so a neighbouring system's traffic costs nothing. Two neighbouring systems sharing an address by chance still cannot read each other's packets; the tag check fails.

The smallest packet is 18 bytes. The largest radio packets in this version are the hub's update offer, 43 bytes, and a log entry over LoRa, up to 50. A radio packet may be up to 255 bytes. Over WebSocket and USB a packet may be up to 1,024 bytes, which forwarded packets and log entries need.

### Encoding rules

These remove any guessing, so every implementation produces the same bytes.

- **Header:** version 1 gives a header byte of 0x10 to the hub and 0x18 from the hub. Senders write the three low bits as zero, and receivers ignore them.
- **Direction:** a receiver drops a packet whose direction bit is not the one it expects. A device never accepts a "to the hub" packet, and the hub never accepts a "from the hub" one.
- **Order of checks:** a receiver reads only the header, address and counter before the tag is checked. It uses nothing from the encrypted part until the tag passes, and compares tags in constant time.
- **Bindings as bytes:** a counter used as a binding is its 4 bytes, little-endian. Random values are used as sent.
- **Body length:** a body shorter than the fields its type lists is not valid, and the packet is dropped. Extra bytes after the known fields are ignored (section 11).
- **Sensor status:** the body is 7 bytes for heartbeat, door changed and cover changed, and 8 bytes for button.
- **Battery byte:** (millivolts − 2,500) ÷ 10, rounded to the nearest whole number and limited to 0–255. Decoding gives 2,500 + 10 × the byte.
- **Rounding:** wherever a value is rounded to the nearest whole number, an exact half rounds up.
- **Counters:** a sender never sends 0. Counters and addresses are unsigned 32-bit numbers.
- **Enumerated values:** a field that takes one of a list of values (a role, button action, siren action, state or reason, when, priority, result, interference event, site channel or data rate) may hold a value this version does not list. The packet is still valid. The receiver ignores what it cannot act on: a siren does nothing for an action it does not know and still answers with a report, and a device told to use a channel or data rate it does not know keeps its current one.
- **Any failed check drops the packet.** Which check a receiver applies first does not matter to the protocol, with two exceptions: nothing encrypted is used before the tag passes, and a length byte over its limit is the error even when the data after it is also cut short. The error names used by the test vectors are defined in the vectors' README, for test harnesses only.
- **Firmware versions** are three bytes: major, minor, patch.
- **Flags:** senders write unused flag bits as zero, and receivers ignore them.
- **Addresses and counters that are never valid:** a receiver drops a packet with address 0 or 0xFFFFFFFF, or counter 0, before looking up any key.
- **Signed values:** every field given in dBm or °C is signed. All other numbers are unsigned unless the table says otherwise.
- **Text:** UTF-8. Log text that is not valid UTF-8 is shown with replacement characters; it does not make the packet invalid.

## 4. Counters and replay protection

### Sending

- Every sender keeps a 32-bit counter per key and direction. It starts at 1 at pairing and is never reused with the same key. A device restarts when it is paired, and so continues from its saved resume point: its first packet carries a counter of one step (64 or 1,024), not 1. The hub's own counters do start at 1.
- **Devices** save a resume point to flash every so many packets: every 64 on sensors, every 1,024 on sirens and gateways. After a power loss they continue from the resume point, so a value is skipped, never repeated, and flash is written rarely. Precisely: before using a counter that is a multiple of the step, the device saves counter + step. At pairing the saved resume point is one step, so a power loss before the first save cannot repeat a counter. A sender stops for good when its next resume point would pass 2³² − 1, and the device must then be paired again; at these rates that takes centuries.
- **The hub** uses resume points the same way, saved in its database, with a step of 1,024.
- **Restoring a backup** moves every saved hub resume point forward by 2²⁴, and the hub continues from there, so the restored hub never reuses a counter. It then changes each device's key as the device is heard (section 7, "Key change after a restore", D141).

### Receiving

| Receiver | Accepts a packet when | Keeps |
| --- | --- | --- |
| Hub, from a sensor or siren | The tag checks, and the counter is either higher than any accepted from that device, or one of the 64 below the highest (down to highest − 64) that has not been seen yet | The highest counter and which of the 64 below it were seen, per device, saved with the hub's next database commit: at once for a door, cover, button or started report, and within five minutes for routine packets (D112) |
| Hub, from a gateway | The tag checks, the packet is bound to the current connection, and the counter is higher than the last one on that connection. A hello opens a new connection when its counter is higher than any the hub has accepted from that gateway, so a recorded hello cannot be replayed. A gateway that is already connected is not replaced until the new connection has proved itself with its first packet bound to the new session | The highest counter accepted from each gateway |
| Sensor | The packet is bound to one of the sensor's own packets in the current exchange | Its own recent counters only, in sleep-retained memory |
| Siren, commands, settings, update offers and key changes | The tag checks and the counter is higher than the last command accepted; strictly higher, so commands can never be carried out out of order | The last accepted command counter, saved to flash with each command; commands are rare |
| Gateway | The packet is bound to the current connection, and its counter is higher than the last one on that connection. The first packet on a new connection may carry any counter | Nothing beyond the connection |

The hub allows the 64-packet window because a siren's report sent over LoRa can arrive after a later report sent over Wi-Fi, and both must count. A packet heard by two gateways is still accepted only once.

### Bindings

A binding is extra authenticated data. It is not sent; both sides already know it. A packet with the wrong binding fails its tag check.

| Packet | Binding |
| --- | --- |
| Any packet from the hub to a sensor | The counter (4 bytes) of the sensor packet it answers. A disarmed notice answers the newest report of that door opening that the hub has accepted. The sensor may have sent that report several times, so it tries the counter of every try of the current event, newest first, up to 16. |
| Gateway's welcome, or a key change sent in its place (section 7) | The gateway's random value from its hello (8 bytes) |
| Every later packet between gateway and hub, both ways | The connection's session value (16 bytes): gateway random followed by hub random |
| Everything else | None |

The bindings let sensors and gateways reject replays without saving anything to flash:

- **Sensors.** A recorded old reply answers an old packet, so it fails the tag check.
- **Gateways.** A recorded message from an old connection carries the wrong session value.

Siren commands carry no binding. The hub sends the same command bytes over LoRa and Wi-Fi, and the siren's counter check drops whichever copy arrives second (D73). A binding would make the two copies differ while sharing one nonce, which this encryption scheme forbids.

### Known limits

The hub commits routine packets (heartbeats, regular siren reports, statuses) in batches every five minutes, so that it does not wear out a small computer's memory card (D112). If the hub loses power, the routine packets it accepted since its last commit are forgotten, and each could be replayed to it once after it restarts. Door, cover, button and started reports are committed before they are answered, so they can never be replayed: a replayed door report could otherwise start a false alarm. What the hub sends is not affected: its own counters use resume points, written through to storage before they are needed.

Packets recorded between a backup and its restore are never acted on by the restored hub: it changes every device's key as each is heard (section 7, "Key change after a restore", D141). The first risk is accepted for two reasons. Device reports carry the current state, so a replayed one is corrected by the next real one. And the change count in sensor reports shows the hub if door changes were missed.

## 5. Message types

| Type | Name | From | To | Paths |
| --- | --- | --- | --- | --- |
| 0x01 | Heartbeat | sensor | hub | LoRa |
| 0x02 | Door changed | sensor | hub | LoRa |
| 0x03 | Cover changed | sensor | hub | LoRa |
| 0x04 | Button | sensor | hub | LoRa |
| 0x05 | Started | any device | hub | any |
| 0x06 | Update query | any device | hub | any |
| 0x07 | Update status | any device | hub | any |
| 0x10 | Siren report | siren | hub | LoRa, Wi-Fi |
| 0x20 | Hello | gateway | hub | Wi-Fi, USB |
| 0x21 | Forwarded packet | gateway | hub | Wi-Fi, USB |
| 0x22 | Gateway status | gateway | hub | Wi-Fi, USB |
| 0x23 | Transmit result | gateway | hub | Wi-Fi, USB |
| 0x24 | Interference | gateway | hub | Wi-Fi, USB |
| 0x30 | Log entries | any device | hub | any |
| 0x81 | Reply | hub | sensor | LoRa |
| 0x82 | Disarmed notice | hub | sensor | LoRa |
| 0x83 | Update offer | hub | any device | any |
| 0x84 | Key change | hub | any device | any |
| 0x90 | Siren command | hub | siren | LoRa and Wi-Fi at once |
| 0x91 | Siren settings | hub | siren | LoRa, Wi-Fi |
| 0xA0 | Welcome | hub | gateway | Wi-Fi, USB |
| 0xA1 | Transmit request | hub | gateway | Wi-Fi, USB |
| 0xA2 | Gateway settings | hub | gateway | Wi-Fi, USB |

The hub always answers a sensor's update query and update status, with an update offer or a reply, and the sensor listens for that answer. A device answers a key change with its next packet, under the new key (section 7, "Key change after a restore"). A sensor uses Wi-Fi only while it updates (section 10); its door, cover, button and heartbeat reports stay on LoRa throughout.

A receiver drops and logs a type it does not know.

Types 0x80 and above come from the hub, and types below 0x80 go to the hub. A receiver drops a packet whose type does not match its direction, even though the tag checked.

## 6. Message bodies

Offsets count from the first byte after the type.

### Sensor status: heartbeat, door changed, cover changed, button (0x01–0x04)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Settings version the sensor holds. It covers the armed state too: the hub changes a sensor's settings version whenever that sensor's armed state or any of its settings change (D72) |
| 1 | 1 | Flags. Bit 0 door open, 1 cover open, 2 on USB power, 3 charging, 4 reply wanted, 5 local alarm sounded since the last reply, 6 buzzing now, 7 listening at the sending rate: the sensor will listen for the answer to this packet at the data rate it was sent at, not at its reply rate |
| 2 | 1 | Battery: (millivolts − 2,500) ÷ 10, covering 2.50 to 5.05 V |
| 3 | 1 | Chip temperature, °C, signed |
| 4 | 1 | Door change count, adds one on every open and close, wraps at 256 |
| 5 | 2 | Event age: seconds since the event this packet reports (0 for heartbeats) |
| 7 | 1 | Button action, button packets only: 1 short press, 2 pairing hold ignored while armed, 3 factory-reset hold while armed, 4 factory reset going ahead |

### Started (0x05)

Sent once after every start-up. A sensor waking from deep sleep with its retained memory intact is not a start-up; every other start is. The hub always replies to a sensor's Started, and the sensor listens for that reply, and retries, as it does for a door report. A sensor that starts with no retained memory holds no armed state, and counts as disarmed until the reply arrives.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Role: 1 sensor, 2 siren, 3 gateway |
| 1 | 3 | Firmware version: major, minor, patch |
| 4 | 1 | Reset cause, as ESP-IDF reports it |
| 5 | 2 | Last fatal error code, 0 for none (FW5) |
| 7 | 1 | Settings version held |
| 8 | 1 | Image flags: bit 0 on trial, bit 1 rolled back since the last confirmed image (M3, D134) |
| 9 | 3 | Failed version: the version that was rolled back, zeros for none (M3) |

An older hub ignores the last two fields (section 11).

### Update query (0x06)

Sent when a reply carries "update available", and on every (re)connection while the device holds part of an image.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | Image id held, zeros for none |
| 8 | 1 | Held: 0 nothing, 1 part, 2 verified |
| 9 | 4 | Bytes held, up to the last checkpoint |
| 13 | 1 | Battery, encoded as in sensor status |
| 14 | 1 | Flags: bit 0 has Wi-Fi details, bit 1 on USB power or mains |

### Update offer (0x83)

Bound to the packet it answers, for a sensor; as settings are, for a siren (strictly higher counter); in the session, for a gateway.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Action: 0 nothing (discard anything held), 1 fetch on the link this offer came by, 2 join Wi-Fi and fetch, 3 open Bluetooth, 4 install the verified image now, 5 keep what you hold and wait, 6 fetch on the link this offer came by without waiting for the radio to be quiet (a gateway a person chose to update although its site is always busy, m3-updates-design.md section 5) |
| 1 | 8 | Image id |
| 9 | 4 | File bytes (header and image) |
| 13 | 3 | Version |
| 16 | 8 | Bluetooth session nonce (action 3), else zeros |
| 24 | 1 | Bluetooth window, in units of 10 seconds (action 3) |

### Update status (0x07)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | Image id |
| 8 | 1 | Stage: 1 fetching, 2 verified, 3 refused, 4 installing (sent just before the restart), 5 confirmed, 6 cancelled |
| 9 | 1 | Reason: 0 none, 1 battery, 2 armed, 3 noWifi, 4 hubNotFound, 5 linkLost, 6 badHeader, 7 wrongHub, 8 wrongRole, 9 tooLarge, 10 badSignature, 11 hashMismatch, 12 flash, 13 imageCheck, 14 windowEnded (Bluetooth), 15 sessionRefused, 16 onTrial, 17 radioBusy (a gateway, section 7) |
| 10 | 4 | Bytes written |

Over LoRa a device sends only stages 2 to 6, never progress. A sensor sends two to four update packets per update.

### Key change (0x84)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 16 | The device's new key |

Sent only after a restore (section 7, "Key change after a restore"). Bound as the hub's other answers are: to a sensor, the counter of the packet it answers; to a siren, none, under the strictly higher rule, as settings; to a gateway, its hello's random value, in place of the welcome.

### Reply (0x81)

Bound to the sensor packet it answers.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Settings version |
| 1 | 1 | Flags. Bit 0 armed, 1 countdown started, 2 update available |
| 2 | 1 | This sensor's countdown, seconds (D86) |
| 3 | 1 | Countdown remaining, seconds, when bit 1 is set |
| 4 | 1 | Heartbeat interval, in units of 15 seconds |
| 5 | 1 | Link check: ask for a reply on every Nth heartbeat |
| 6 | 1 | Data rate to send at |
| 7 | 1 | Data rate replies will use |
| 8 | 2 | Next heartbeat: when to send it, in tenths of a second after the end of the packet this reply answers; 0 keeps the current schedule |
| 10 | 2 | Clock correction: how much to stretch or shrink the sensor's sleep times, signed, in units of 10 parts per million (so ±32%) |
| 12 | 1 | Next site channel, numbered as in gateway settings: the channel the site is moving to. 0xFF when the channel stays as it is (section 7, "Changing the site's channel or rate") |
| 13 | 1 | Next sending rate: the data rate the site is moving to. 0xFF when the rate stays as it is. With both fields 0xFF no move is announced |

A reply always carries the full settings, so a sensor never has to ask twice. The settings version covers every setting in the reply, the clock correction included, so the hub always knows which correction a sensor holds. Only replies to heartbeats and to Started give a time for the next heartbeat; replies to door, cover, button and log packets carry 0, so an event does not move the rhythm.

### Disarmed notice (0x82)

No body. Bound to the door report that started the countdown. It also tells the sensor it is no longer armed: the sensor stops buzzing and holds "not armed" until a reply says otherwise. The hub sends it twice; a sensor that hears the second copy ignores it.

### Siren command (0x90)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Action: 0 off, 1 sound for an alarm, 2 test, 3 report now |
| 1 | 2 | Seconds to sound, for actions 1 and 2. The siren stops by itself when they run out (SR5). |

### Siren report (0x10)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Settings version held |
| 1 | 1 | State: 0 off, 1 sounding for an alarm, 2 testing |
| 2 | 2 | Seconds of sounding left |
| 4 | 2 | Low 16 bits of the counter of the last command or settings packet acted on |
| 6 | 1 | Flags. Bit 0 on mains, 1 cell fitted, 2 charging, 3 cover open, 4 Wi-Fi connected |
| 7 | 1 | Cell voltage, encoded as for sensors |
| 8 | 1 | Chip temperature, °C, signed |
| 9 | 1 | Reason: 0 regular report, 1 answer to a command, 2 LoRa check, 3 Wi-Fi report failed |

### Siren settings (0x91)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Settings version |
| 1 | 1 | Wi-Fi report interval, seconds (30) |
| 2 | 1 | LoRa check interval, in units of 15 seconds (20, meaning 5 minutes) |
| 3 | 2 | Longest a command may make it sound, seconds |
| 5 | 1 | Data rate to send at |
| 6 | 1 | Data rate commands will use |
| 7 | 1 | Site channel to send on, numbered as in gateway settings |

The siren answers with a report. It uses a new site channel or sending rate from its next transmission on. A report interval, check interval or longest time of 0 is not valid: the siren keeps the value it holds and logs a warning, so a bad settings packet can never stop it sounding. Until settings arrive, a siren caps a command at 5 minutes (D40).

### Hello (0x20) and welcome (0xA0)

| Message | Offset | Size | Field |
| --- | --- | --- | --- |
| Hello | 0 | 8 | Gateway random value, new for every connection |
| | 8 | 3 | Firmware version |
| | 11 | 1 | Settings version held |
| Welcome | 0 | 8 | Hub random value |

### Gateway settings (0xA2)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Settings version |
| 1 | 1 | Site channel: 0 = 868.1, 1 = 868.3, 2 = 868.5 MHz |
| 2 | 1 | Data rates to listen for, one bit per index |
| 3 | 1 | Status interval, seconds (30) |
| 4 | 1 | Interference alert: decibels above the gateway's normal noise level (10 †) |
| 5 | 1 | Interference alert: seconds the level must last (30 †) |
| 6 | 1 | Default transmit power, dBm, signed |
| 7 | 1 | Siren command transmit power, dBm, signed |

A status interval, alert level or alert duration of 0 is not valid: the gateway keeps the value it holds, or the default in section 8 if it holds none, and logs a warning.

### Forwarded packet (0x21)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Time the packet finished arriving, on the gateway's own microsecond clock |
| 4 | 2 | Signal strength, dBm, signed |
| 6 | 1 | Signal-to-noise ratio × 4, signed |
| 7 | 1 | Data rate |
| 8 | 1 | Site channel, numbered as in gateway settings |
| 9 | rest | The device packet, as received |

The gateway forwards only packets that pass the radio's CRC and are at least 18 bytes long. The packet inside a forwarded packet or a transmit request is a radio packet, so it is 18 to 255 bytes; any other length makes the message not valid, and a gateway answers such a transmit request with "not valid".

### Transmit request (0xA1) and transmit result (0x23)

| Message | Offset | Size | Field |
| --- | --- | --- | --- |
| Request | 0 | 1 | When: 0 at a given time, 1 as soon as possible |
| | 1 | 4 | Gateway clock time, microseconds: when to send, or for "as soon as possible" the latest moment to start (0 for no limit) |
| | 5 | 1 | Data rate |
| | 6 | 1 | Power, dBm, signed |
| | 7 | 1 | Priority: 0 normal, 1 siren command, which may use the kept-back airtime |
| | 8 | rest | The packet to send on 869.525 MHz |
| Result | 0 | 4 | Counter of the request it answers |
| | 4 | 1 | 0 sent, 1 too late, 2 no airtime left, 3 radio busy, 4 not valid |
| | 5 | 4 | Gateway clock time it was sent |

The gateway sends at the power the request names, limited to the radio's range of −9 to +22 dBm †: a request below it is sent at −9 dBm, one above it at +22 dBm. The two powers in its settings are what the hub fills requests with, and the hub accepts only values inside that range for them. A request for a given time is sent at that moment. If the gateway gets to it more than 20 ms † late, it answers "too late" and does not send, because the sensor has stopped listening by then.

Every request gets exactly one result, so the hub always knows what was not sent. A gateway holds only a few requests while they wait for their moment or for the radio. A request that arrives when every place is taken is answered "radio busy". The one exception is a siren command: it takes the place of the newest waiting request that is not a siren command, and that request is answered "radio busy" instead. The gateway logs a warning each time (D110).

### Gateway status (0x22)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Settings version held |
| 1 | 4 | Seconds since start-up |
| 5 | 2 | Airtime used on 869.525 MHz in the last hour, hundredths of a percent |
| 7 | 1 | Noise level, median since the last status, dBm, signed |
| 8 | 1 | Noise level, highest since the last status, dBm, signed |
| 9 | 1 | Normal noise level the gateway has learned, dBm, signed |
| 10 | 2 | Packets received with a good CRC since the last status, whatever their length |
| 12 | 2 | Packets that failed the radio's CRC since the last status; they are not counted in the field before |
| 14 | 1 | Wi-Fi signal strength, dBm, signed; 0 on USB |
| 15 | 1 | Flags. Bit 0 connected by USB, 1 cell fitted, 2 on mains |

### Interference (0x24)

Sent as soon as interference starts and again when it ends (GW11, D82).

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | 1 started, 0 ended |
| 1 | 1 | Noise level during it, dBm, signed |
| 2 | 2 | Seconds it has lasted |

### Log entries (0x30)

One or more entries, each: age (4), level (1), code (2), text length (1), text (up to 64 bytes). Levels: 0 debug, 1 info, 2 warning, 3 error, 4 critical; a level this version does not list is kept as it is. Age is how long before this packet was sealed the entry was made, in tenths of a second, so the hub can date an entry without knowing the device's clock. Entries fill the body exactly, so a partial entry at the end makes the body not valid.

Over Wi-Fi and USB a device sends its entries as they arise. Over LoRa a packet carries one entry, of warning level (2) or above, with at most 24 bytes of text, so the packet is at most 50 bytes; it counts as routine traffic: a device sends at most one after each heartbeat or LoRa check. The hub always replies to a sensor's log entries packet, and the entry stays in the sensor's buffer until that reply arrives. A sensor whose latest reply-wanted packet went unanswered holds its log entries until a reply arrives: sending them to a hub that is not answering would only use up the airtime its heartbeats need. So a fault inside a sensor reaches the hub within about one heartbeat, and nothing a device logs at warning level or above is lost while it can still reach the hub (D110).

## 7. Exchanges

### Sensor heartbeat

1. The sensor wakes on its timer, sends a heartbeat, and sleeps its processor until the heartbeat reply moment.
2. The gateway forwards it, and the hub records it.
3. The hub replies only if the sensor's settings version differs, the sensor asked for a reply, or an update offer waits for it (D72). The sensor asks on every Nth heartbeat, every 5th by default, which makes a link check every 15 minutes.
4. The sensor listens briefly at the reply time. It goes back to sleep at once if nothing starts arriving.

### Door opens while armed

```
Sensor               Gateway                Hub
  │ door changed ──────→│ forwarded ──────────→│ countdown starts at
  │ (reply wanted),     │                      │ report time − age
  │ then listens
  │                     │←── transmit request ─┤ (as soon as the radio is free)
  │←──── reply ─────────┤                      │
  │ armed, countdown    │                      │
  │ started, 30 s left  │                      │
  │ buzzes and listens  │                      │
  │                     │              user disarms within 30 s
  │←── disarmed notice ─┤←── transmit request ─┤ (sent twice, 2 s apart)
  │ stops buzzing       │                      │
```

If nobody disarms, the hub sounds the sirens when the countdown ends (AL3), and the sensor stops buzzing at the same moment. If the hub or its gateway fails during the countdown, nothing sounds until the hub is back and resumes it (D113); this is an accepted limit.

### Heartbeat slots

The hub gives every sensor its own moment in the heartbeat cycle, so that heartbeats, which are nearly all the radio traffic, do not land on top of each other. In the [gateway load simulation](spikes/gateway-load.md) this cut lost packets for 10 far-away sensors from 5% to about 1%.

- **Planning:** the hub spreads the heartbeats of every sensor on the site evenly over time, taking each one's interval and packet length into account. It keeps the moments when it will send link-check replies clear of them too.
- **Telling the sensor:** every link-check reply gives the time of the sensor's next heartbeat, counted from the end of the heartbeat it answers, so no clocks need to agree.
- **Correcting the clock:** a sensor's sleep clock is a cheap oscillator that runs a few percent fast or slow. The hub sees each heartbeat arrive, works out how fast that sensor's clock runs, and sends a correction in parts per million. The sensor scales its sleep times by it.
- **Aiming the reply:** a sensor times the wait for its heartbeat reply on that same cheap clock. One that runs more than about 2% off would open its listening window before or after a reply sent exactly at the reply moment, never hear it, and so never receive its correction. The hub therefore aims each heartbeat reply at the moment the sensor will really be listening, using its own estimate of that sensor's clock; once the sensor holds its correction the two agree.
- **Between replies:** the sensor keeps its schedule from the last reply it received. One that has not had a reply yet, or has lost several, uses its interval with ±10% at random until it hears again.
- **What slots do not touch:** door, cover and button reports still go out the moment something happens.

The simulation still worked with a sensor's clock wandering ±10 seconds per heartbeat, for 10 sensors in a 5-minute cycle. Spike S8 measures the real wander.

### Faster replies

The gateway transmits with more power than a sensor: up to +22 dBm against 14 dBm. That extra power lets a reply use a faster setting and still reach the sensor, about three steps faster for the full difference. For example, a sensor sending at SF12 can hear replies at SF9, which takes 0.2 seconds instead of 1.5.

- **Choosing the rate:** the hub picks each sensor's reply rate from the signal margin of that sensor's packets, keeping a safety margin †. It sends it in the reply's settings, and siren settings carry the same for commands.
- **Which rate the hub uses:** a device listens at the rate in the settings it holds, which may not be the newest. Every packet from a device names the settings version it holds, so the hub sends to it at the rate of that version, until the device reports a newer one. A log entries packet names no version and has no flags, so for its reply the hub goes by the sensor's most recent packet that did; a sensor sends a log entry straight after a heartbeat, so that is fresh.
- **Fewer deaf moments:** a short reply keeps the gateway's single radio busy for less time, so fewer incoming packets are lost while it sends.
- **Faster answers:** the sensor gets its answer sooner and listens for less time.
- **Falling back:** see "Data rate" below.

### Late door reports

Every door report carries its age. The hub counts the countdown from when the door actually opened, not from when the report arrived (D106):

- **Arrives within the countdown:** the countdown continues with what is left.
- **Arrives after the countdown would have ended:** the sirens sound for whatever is left of their automatic-stop time, counted from when the countdown would have ended.
- **Arrives after even that would have run out:** an alarm notification only, saying when the door opened.
- **The hub was disarmed when the report arrives:** nothing happens.

### No reply from the hub

The sensor retries about 2, 5 and 10 seconds after the event, then every 60 seconds, for up to 10 minutes. Each retry adds a random extra wait of up to half the gap before it, so two doors that opened together do not keep colliding. These are the earliest times: a retry never starts before the previous try's listening has ended, which at slow data rates is later. It listens before each try, as for every packet.

- Unanswered tries count towards the data-rate fall-back ("Data rate" below): after two it listens at its sending rate, and after every two more it sends one rate slower.
- If the door changes again meanwhile, it sends the newest state instead (DS3).
- If the first try goes unanswered and the sensor believes it is armed, it buzzes for its stored countdown, counted from the opening, then sounds its own alarm for about 3 minutes (DS6, D88). Retries carry on meanwhile.
- Any reply stops the local alarm if it says "not armed". A press of the button stops it too.
- The next report that gets through has bit 5 set, so the hub learns the local alarm went off and notifies.
- If all retries fail, the next heartbeat's change count tells the hub that door changes were missed.

### Data rate

A sensor starts at the fastest data rate the site allows and keeps the rate that last worked (LR4). When two reply-wanted packets in a row go unanswered, it first goes back to listening for replies at its own sending rate, in case the faster reply was what failed, and says so with flag bit 7 in each packet. The hub then answers at the rate the packet arrived at. The sensor returns to its reply rate when a reply tells it one again. If two more go unanswered, it steps its sending rate one slower among the rates it is allowed, and again after every two more. The rates allowed are those of its pairing, until a move of the site replaces them ("Changing the site's channel or rate"). From the slowest allowed rate it goes back to the fastest, so a sensor can never be left on a rate nobody listens at. With one rate allowed, as every site has for now, there is nothing to step to and it keeps its rate. A single loss is usually a collision, and a slower rate would only make collisions likelier. The hub tells it to step faster in a reply when the signal margin is large. While its latest reply-wanted packet is unanswered, a sensor asks for a reply on every heartbeat, not only every Nth, so one that lost touch during an outage is back within a heartbeat or two of the gateway's return.

At slow rates the sensor lengthens its heartbeat to stay inside its airtime: at least 3 minutes at SF11 and 5 minutes at SF12. The hub knows each sensor's rate from the forwarded packets, so its silence timeout follows the real interval (HB8). How many missed heartbeats count as silent depends on that sensor's measured packet loss (D107).

### Changing the site's channel or rate

The hub can move a whole site to another channel or sending rate over the air (D115). A gateway hears one rate on one channel at a time, so the move is made in three steps, and no moment needs two settings heard at once.

1. **Announce.** The hub puts the next channel and rate into every sensor's reply. They are settings like the rest, so each sensor's settings version changes, and each sensor gets them at its next heartbeat. The hub waits until every sensor's packets show the new version.
2. **Switch.** The hub sends the gateways their new settings, and they listen on the new channel and rate at once. It then sends each siren its settings with the new channel and rate, on both paths as it sends a command; a siren uses them from its next transmission.
3. **Follow.** Each sensor finds its old settings unanswered and moves, as below. A reply to a packet that arrived on the next settings names their rate as the rate to send at and announces nothing more. A reply to a packet that still arrived on the old settings, heard by a gateway that had not yet switched, goes on announcing the move.

What a sensor does while it holds next settings:

- It asks for a reply on every heartbeat, so it notices the switch at its first heartbeat after it.
- When a reply-wanted packet goes unanswered, its following packet goes on the other settings: the next ones if that packet used the current ones, and back again if it used the next ones. It listens for the answer at the rate it sent at, and says so with flag bit 7.
- A reply to a packet sent on the next settings makes them its current settings. They replace the channel and the allowed rate from its pairing for good: from then on the site's rate is the one rate it may send at.
- A reply that announces no next settings clears any it holds; that is how the hub cancels a move before the switch.
- It stores next settings in flash with its other settings, so a restart does not lose them.

So an idle sensor is out of touch for a heartbeat or two after the switch, and a door report for about two seconds: its first try goes unanswered on the old settings and its retry goes on the new ones.

What the hub does besides:

- It does not switch until every sensor holds the next settings, unless the user forces it. With every sensor in touch that takes about two heartbeat intervals: one for the reply that announces, one for the heartbeat that confirms. The hub warns the user when a sensor has not confirmed after four intervals †, and the user then forces the switch or cancels the move. A sensor that was out of touch through the announcement never learns the next settings, keeps sending on the old ones, and has to be paired again; the hub names it.
- It does not switch while a countdown or an alarm is running; it waits for it to end.
- A device paired while a move is announced is given the current settings and learns the next ones like every other sensor, and the hub waits for it too. After the switch, pairing gives the new settings.
- After the switch it holds back the silence alert of any sensor not yet heard on the new settings for four heartbeat intervals †.
- The reply frequency, 869.525 MHz, never changes. Reply and command rates are settings of their own and change as before.
- Every step is recorded: who asked, each sensor's confirmation, the switch, and each device first heard on the new settings (D110).

### Siren command

The hub sends a siren a command only when what that siren should do changes. A siren already sounding for an alarm is not commanded again when another door's countdown ends; only the sirens that door adds are (D95). Thirty doors opening together then cost one command per siren, not thirty.

1. The hub sends the same command packet over the siren's Wi-Fi connection and, through the gateway that last heard the siren best, over LoRa (D73).
2. The siren acts on the first copy and drops the second by its counter.
3. It answers with a report that names the command it acted on, on the path the command came by. It answers an exact repeat of its latest command the same way, so the hub's retries are safe. Older counters get no answer.
4. The hub repeats the same packet every 2 seconds on Wi-Fi and every 5 seconds on LoRa until a report confirms it, for up to a minute. After that it warns that the siren cannot be reached.
5. One at a time: while a command is unconfirmed, the hub sends that siren nothing else, except a newer command, which replaces it. Settings wait. Otherwise a later packet arriving first would make the siren drop the command as too old. A replaced or already confirmed command may still arrive late by the slower path; the siren drops it, and that is expected.

### Siren reports

- The siren reports every 30 seconds over Wi-Fi.
- It reports over LoRa at once when a Wi-Fi report fails, and every 5 minutes as a check. A Wi-Fi report has failed when the connection is down or will not take the packet. To notice a dead connection, the siren pings the hub over the WebSocket every 15 seconds and treats 15 seconds without an answer as down.
- A siren starts its report and check timers at a random point in their interval, so sirens that power up together after a power cut do not report at the same instants and collide.
- The hub does not reply to reports.
- Losing either path is a warning, and losing both means the siren is silent (D73, D52).
- While Wi-Fi is down, each 30-second report goes over LoRa. The siren paces these reports and its LoRa checks so that together they use at most half of its airtime †: they go no closer together than 200 times one report's time on air. That is every 13 seconds at SF7, so every report goes; every 83 seconds at SF10; and every 5½ minutes at SF12. Without the pace, a siren at a slow rate would send reports back to back until its airtime ran out and then be silent for most of an hour.
- A report of a change (the cover, mains power, the sounder stopping by itself, Wi-Fi going down) is urgent: it goes at once, and neither the pace nor the airtime kept back from regular reports holds it (section 2).
- The hub knows each siren's sending rate, and its silence rule for a siren on LoRa alone follows the pace. Because regular reports are paced to half, the other half of the hour is always free for answers to commands and reports of a change.

### Gateway connection

1. The gateway connects and sends a hello with a fresh random value.
2. The hub answers with a welcome bound to that value, carrying its own random value. The two values together are the session value.
3. The hub sends the gateway its settings.
4. From then on the gateway sends forwarded packets, a status every 30 seconds and transmit results, and the hub sends transmit requests. The first packet bound to the session proves it, whatever its type: a forwarded packet counts, and the hub acts on what it carries.
5. The hub reports a gateway offline after 60 seconds with nothing from it (D97).
6. A gateway that loses its connection retries after 1, 2, 4, 8, 15 and then every 30 seconds.

### Reply timing and a busy gateway

A gateway has one radio. It cannot send while it is receiving, or send two things at once, and at slow settings one packet holds the radio for up to 1.5 seconds. So replies are timed by how much they matter:

| Reply | When the gateway sends it | What the sensor does | If the radio is busy |
| --- | --- | --- | --- |
| To a heartbeat, including link checks | At a fixed moment on the gateway's own clock: the heartbeat reply moment after the packet finished arriving, moved by the hub to match that sensor's clock while the sensor does not yet hold its correction ("Heartbeat slots", aiming the reply) | Sleeps until that moment, then listens briefly | The reply is skipped. The sensor gets its settings at the next link check. |
| To a door, cover, button or started report | As soon as the radio is free, but no later than the sensor will still be listening | Listens from the moment it finishes sending, for the event listen time | The gateway waits for the radio, then sends. If it would be too late, it reports "too late" and the sensor's retry covers it. |
| Disarmed notice | As soon as the radio is free | Listening, because it is buzzing | Waits, then sends. |
| Siren command | As soon as the radio is free, with priority over replies | Always listening | Waits, then sends. |

Two more rules:

- **Receiving comes first.** The gateway never cuts off a packet it is in the middle of receiving in order to send.
- **One gateway replies.** When several gateways hear the same packet, the hub uses the first copy, drops the rest by counter, and replies through that same gateway (GW9). The gateway counts any send-at time on its own clock from when it heard the packet end, so no clocks need to agree.

### Firmware update over Wi-Fi or USB

The device pulls the image with transfer frames (section 10) on its own link: a siren or a gateway on its Wi-Fi or USB link, a sensor in Wi-Fi range on a Wi-Fi link it joins only for the update (UP5). Which devices are offered an update, and when, is the hub's rollout (D139).

```
Hub                                          Device
 │── Update offer {1 or 2, image, bytes} ──→│ siren, gateway: on its link
 │                                          │ sensor: in a reply to its query, then joins Wi-Fi,
 │                                          │   finds the hub by mDNS (section 10), opens the WebSocket
 │←── Update query (on this link) ──────────│ sensor only: identifies the link
 │── Update offer {1} ─────────────────────→│ grant on this link
 │←── Get {0, 128} ─────────────────────────│
 │── Data {header} ────────────────────────→│ checks 1–5 before any flash write
 │←── Get × 4 … ────────────────────────────│ erase a sector, write, checkpoint every 64 KB
 │── Data × 4 … ───────────────────────────→│
 │←── Update status {fetching} every 256 KB ‡ (links only)
 │←── Update status {verified} ─────────────│ read back, SHA-256 equal
 │── Update offer {4 install now} ─────────→│ at its turn (D139)
 │←── Update status {installing} ───────────│ links drain; restart
 │←── Started {new version, on trial} ──────│ sensor: on LoRa, as always
 │── reply / welcome / report now ─────────→│ healthy: confirm
 │←── Update status {confirmed} ────────────│
```

"Checks 1–5" are those of section 10, "The image header". Links drain as before any restart ([firmware-design.md](firmware-design.md) section 3, `Waiter`).

- **A sensor in Wi-Fi range** has 30 s ‡ to join and find the hub, else it reports `noWifi` or `hubNotFound` over LoRa. Its LoRa side runs throughout, so its heartbeats and door reports go on. It leaves Wi-Fi after the status `installing`, or on any refusal.
- **A break.** The link reports `down`; the device reconnects on its usual back-off (1, 2, 4, 8, 15, 30 s) for up to 2 minutes ‡, then sends an update query on the new link and continues from its checkpoint. After 2 minutes without a link it reports `linkLost` (over LoRa for a sensor) and keeps the part; the next offer resumes it.
- **A gateway while it updates** goes on listening and forwarding; forwarded packets and transmit results go before Gets on its link. It writes flash only while no transmit request waits for its moment and the radio is not receiving ‡. If it writes no sector for 10 minutes ‡ while fetching, it stops, keeps its part and checkpoint, and reports `Update status {refused, radioBusy}`. It is deaf only during its restart and reconnection.
- **A siren** keeps both paths and its commands while it downloads, and installs only when off.
- **The trial.** The new image runs on trial and confirms itself only after it has opened a packet from its own hub: for a sensor, the reply to its Started; for a siren, a hub command or settings packet on either path, with one LoRa transmission completed (the hub sends "report now" on both paths to a siren whose Started says it is on trial); for a gateway, welcomed on its link, its settings opened, and its continuous receive started without a fault. Any reset before it confirms boots the old image, whose Started then reports "rolled back" and the failed version. A trial image never sleeps deeply (D134). The deadlines are in section 8.

### Firmware update over Bluetooth

For a sensor out of Wi-Fi range (UP6), from a phone, only on the hub's offer (D138). The service and its frames are in section 10.

1. A person asks the hub for a Bluetooth session from the phone. The hub draws an 8-byte nonce and gives the phone the session key (section 10) inside the app's channel; that is the only place the key travels.
2. The sensor learns of it at its next reply ("update available"): at its next heartbeat, or at once if its cover is opened, which sends a cover report that is always answered. It sends an update query and gets an offer with action 3, the nonce and the window.
3. It advertises for the window, 120 s ‡, as `hsn-<address as 8 hex digits>` in the scan response, with the update service's UUID in the advertisement. Its LoRa side runs on.
4. The phone connects, asks for the largest MTU (517), and subscribes to notifications. The sensor notifies Hello. The phone answers Open with the tag. A wrong tag closes the connection; five wrong in one window ‡ end it (`sessionRefused` over LoRa).
5. The sensor pulls the file with Gets (notifications); the phone answers with Data (writes without response). On a drop, the phone reconnects within the window or the session's life.
6. At the end the sensor notifies Done and sends `Update status {verified}` over LoRa; the hub answers with "install now" when its rollout's conditions hold, else "wait". Bluetooth stops when Done is sent, at the window's end with nobody connected, after 30 s ‡ without progress, or at the session's life.

### Key change after a restore

A restored hub's replay windows are the backup's, so it acts on no packet sealed under a device's old key (D141). It answers the first such packet from each device with a key change (0x84) holding a new 16-byte key, sealed under the old key with the answer's usual binding (section 6). Every paired device is changed: sensors, sirens and gateways.

- **Sensors** get theirs in answer to their first packet under the old key. **Sirens** get theirs at the restored hub's first start, on both paths, in place of "report now". **A gateway** gets its in place of the welcome, bound to its hello's random value.
- **The hub** keeps both keys until it hears the new one, and sends the same new key again if the first is lost, at most one key change per device every 10 s ‡. Nothing expires: a device out of range is answered when it is next heard, a day or a month later. Until then the hub acts on nothing it sends.
- **A device** that opens a key change, in this order: writes its pairing record with the new key (whole or nothing); writes its resume point as one step, 64 on a sensor and 1,024 on a siren or gateway (section 4); uses the new key from then on; and sends again, under the new key, what it was saying: a sensor its current report (a door report with its age still counting from the opening, D106), or after a heartbeat a heartbeat asking for a reply; a siren a report (reason 1); a gateway a new hello. A power cut between the two writes leaves the new key with the old, higher resume point, so counters are skipped, never repeated. A cut before the first leaves the old key, and its next packet draws the same key change again.
- **The switch.** The first packet under the new key is accepted as usual and switches the device on the hub: its counters restart under the new key, as at pairing, its replay window is cleared, and the packet is acted on as any other. After the switch a packet under the old key fails its tag, as from a stranger.

A restore from a backup made before a device's last key change leaves that device with a key the restored hub never knew: it must be paired again.

### Hub restart

1. The hub sends "report now" to every siren on both paths. A hub restored from a backup sends each siren a key change instead ("Key change after a restore").
2. It resumes saved countdowns and alarms (D80).
3. Gateways reconnect with a new hello.

## 8. Timing

| Value | Setting | Where it comes from |
| --- | --- | --- |
| Heartbeat reply moment: end of the heartbeat to start of the reply | 1 second † | O10 |
| Event listen time: how long a sensor listens after a door, cover, button, started or log packet, by the rate it sent at | the hub's round trip, plus one packet's wait for a busy radio, plus the reply †: 3.0 s at DR0, 2.6 s at DR1, 2.2 s at DR2, 1.9 s at DR3, 1.7 s at DR4, 1.5 s at DR5. The hub uses the same table to know how late a reply may start | O10, [gateway load](spikes/gateway-load.md) |
| Sensor listening margin around the heartbeat reply moment | 20 ms early to 50 ms plus 8 symbols late † | Sleep clock drift |
| Heartbeat interval | 3 minutes, at the moment the hub assigns; ±10% at random until a sensor has one | D52, DS4, D108 |
| Reply data rate | usually three steps faster than the sending rate, chosen by the hub from the signal margin † | D108 |
| Link check | every 5th heartbeat | D72 |
| Sensor retries | about 2, 5, 10 s, then every 60 s, each plus a random extra wait of up to half the gap, up to 10 minutes | LR3 |
| Listening before sending | if busy, wait 0.2–2 s at random, up to 5 times | [gateway load](spikes/gateway-load.md) |
| Disarmed notice | sent twice, 2 s apart | D24 |
| Siren report over Wi-Fi | every 30 s | D73 |
| Siren LoRa check | every 5 minutes | D73 |
| Siren command repeats | every 2 s on Wi-Fi, every 5 s on LoRa, up to 1 minute | SR4 |
| Gateway status | every 30 s | GW6 |
| Gateway offline | after 60 s of nothing | D97 |
| Interference alert | 10 dB above normal for 30 s † | D82 |
| Trial deadline: a new image that has not confirmed by then rolls back | 10 minutes for a sensor, 5 for a siren or gateway ‡ | D134 |
| Gets outstanding, and when one is asked again | 4 on Wi-Fi and USB, 8 on Bluetooth; asked again after 2 s, 3 s on Bluetooth ‡ | D137 |
| Bluetooth update window | 120 s ‡ | D138 |
| Key changes to one device | at most one every 10 s ‡ | D141 |

## 9. Pairing data

The data a device receives when it is added (PR2). It is delivered over USB (section 10), and from M3 over Bluetooth (section 10, "Pairing over Bluetooth").

| Field | Size |
| --- | --- |
| Format version | 1 |
| Device address | 4 |
| Device key | 16 |
| Hub identity: the first 8 bytes of the SHA-256 hash of the 64 key bytes in the next field | 8 |
| Hub firmware-signing public key, P-256: X then Y, 32 bytes each, big-endian, without the usual leading 0x04 byte | 64 |
| Site channel | 1 |
| Data rates allowed, one bit per index | 1 |
| Wi-Fi network name: length, then the name's bytes exactly as the network uses them | 1 + up to 32 |
| Wi-Fi password: length, then the password's bytes | 1 + up to 64 |

The site channel and the data rate allowed are the site's settings on the day the device is paired; the hub can change them later over the air (section 7, D115). Each pairing gives a new key, so counters restart at 1. The Wi-Fi name and password are carried as bytes, not text, so a device never has to check their encoding; a name the user types is encoded as UTF-8. A format version other than 1, or an address of 0 or 0xFFFFFFFF, makes the pairing data not valid.

## 10. Wi-Fi, USB and Bluetooth

### Wi-Fi

- **Finding the hub:** the hub advertises itself on the home network by mDNS, as `_hsn-hub._tcp`, with the TXT keys `id` (the hub identity of section 9, 16 hex digits), `app` (the apps' port, decimal) and `aid` (the app identity, 26 characters of base32, [m2-design.md](m2-design.md) section 5). A device connects only to the hub whose identity it was paired with. Apps use `app` and `aid` only to choose where to try; the channel's handshake proves the hub.
- **Connection:** a WebSocket to `ws://<hub>:<port>/device`, on the hub's device port; the apps use a second port with HTTPS (D101). Each binary WebSocket message carries exactly one packet, or one transfer frame ("Firmware transfer frames" below).
- **No TLS:** every packet is already encrypted and authenticated, so the connection needs no TLS and no login.
- **What uses it:** gateways and sirens use it all the time. Sensors use it only for updates.

### USB

- **Link:** the gateway appears as a USB serial port; the ESP32-S3 has one built in. The hub recognises Espressif's USB vendor number.
- **Choosing USB or Wi-Fi (D81):** while a computer is attached to its USB port, a gateway sends a hello there every 2 seconds. If a welcome comes back, it uses USB only. If none comes within 10 seconds, or no computer is attached, it uses Wi-Fi, and tries USB again every 30 seconds while a computer is attached.
- **Framing:** each packet is COBS-encoded and ends with a zero byte. Otherwise the link works exactly like Wi-Fi. An encoder does not add an empty block after a final run of exactly 254 non-zero bytes; a decoder accepts the frame with or without one. A decoder skips empty frames, meaning two delimiters with nothing between them. A frame that decodes to no bytes at all is passed on like any other and fails as too short. A decoder drops a frame longer than a 1,024-byte packet can encode to (1,029 bytes) or one that decodes to more than 1,024 bytes.

### Setup messages, USB and Bluetooth pairing

These messages are not encrypted on USB, because the cable is trusted (D100); over Bluetooth they travel inside the pairing session ("Pairing over Bluetooth" below). A device ignores them on any other path. All start with the byte 0xF1, which no encrypted packet starts with.

| Second byte | Message | Direction | Body |
| --- | --- | --- | --- |
| 0x01 | Identify | hub to device | none |
| 0x02 | Identity | device to hub | role (1), chip identifier (6), firmware version (3), paired (1), hub identity or zeros (8), development build (1) |
| 0x03 | Provision | hub to device | pairing data (section 9) |
| 0x04 | Provision result | device to hub | 0 accepted, 1 refused, 2 not valid. "Refused" also covers a device that could not store the pairing |
| 0x05 | Erase | hub to device | none; development builds only |
| 0x06 | Set role | hub to device | role (1). The device stores it and answers with its identity |

The "paired" and "development build" bytes are 0 or 1; any other value makes the message not valid. A message that does not start with 0xF1 is not a setup message. Extra bytes after a setup message's fields are ignored, as for message bodies. In an identity, the hub identity bytes mean nothing when "paired" is 0, and the receiver ignores them.

Who accepts what:

- **Release builds:** a gateway accepts Provision only while unpaired, which is how a gateway plugged into the hub computer is added automatically (D100). Sensors and sirens refuse it.
- **Development builds:** every role accepts Provision and Erase at any time (PR5). That is how the first milestone sets keys.
- **Set role (D103):** a release build accepts it only while no role is stored, which is how a board is given its role when it is made. A development build accepts it at any time, and forgets its pairing when the role changes. A role outside the listed values is refused, and the identity that comes back shows the role unchanged.
- **Over Bluetooth:** Identify at any time in a session. Provision only while unpaired, in a release build; at any time in a development build. Never Erase or Set role, which stay USB only.
- **A sensor on USB power** never sleeps more deeply than light sleep, so its USB port stays up for these messages.

### Pairing over Bluetooth

A phone adds a device over Bluetooth with the code on the device's display (PR1, D85, D133). The hub makes the Provision message, as for USB.

- **The pairing window.** Bluetooth is off (PR3) except in a window of 2 minutes (DS7): on an unpaired board at power-up and at any press of the button. A paired board opens no pairing window in a release build; a development build opens it on a paired board too (PR5). The window closes when a Provision is accepted, after 5 wrong codes, or at its end, and stays open while a session is.
- **Advertising** while the window is open: protocomm's service UUID, and service data of format 1, the role and the chip identifier (6 bytes) †; local name `hsn-pair-<4 hex>` †. Nothing secret, and nothing about updates: a board advertises either this service in a pairing window or the update service in an update window, never both (D138).
- **Carriage.** ESP-IDF's protocomm over Bluetooth Low Energy, used directly, in its own GATT layout: one service, one characteristic per endpoint, a request written and its answer read back ‡. The endpoints: `proto-ver`, read in the clear: `hsn-pair/1`, the role, the chip and the firmware version; `prov-session`, the security handshake; `hsn-setup`, the setup messages.
- **Security.** Protocomm security 2 ‡: SRP6a (RFC 5054's 3,072-bit group with SHA-512) with the board's pairing code as the password and a fixed user name, then AES-256-GCM on every later request and answer. The board stops listening after 5 wrong codes in one window.
- **Setup messages.** Identify, Identity, Provision and Provision result, byte for byte as over USB, one per request on `hsn-setup`, accepted as "Who accepts what" says for Bluetooth.
- **The pairing code** (PR6, D85). Made from the chip's random number generator at first boot and at each factory reset, kept in flash, never sent. Eight characters of Crockford base32, `XXXX-XXXX`: seven of secret (35 bits) and a check character, made as the linking code's is (mod 37, [m2-design.md](m2-design.md) section 5), and read with the same forgiveness (case, spaces, dashes, `I` and `L` as `1`, `O` as `0`). Its length and alphabet are provisional until spike S9 shows a person can type it from the display †.
- **The display** shows the QR code `hsn://pair/1?c=<code without its dash>&d=<chip identifier, 12 hex digits>`, the code in large characters, the role in words with the chip's last four hex digits ("Siren 4F2A"), and one line, "Add it in the app."

The pairing service is separate from the update service below (D138).

### Firmware transfer frames

A device pulls a firmware file in pieces with transfer frames (D137). They are not packets: they carry nothing secret and are checked by the signature (below). Each starts with 0xF2, which no packet starts with (packets start 0x10 or 0x18, setup messages 0xF1). One frame per WebSocket message, per COBS frame on USB, per Bluetooth write or notification. Little-endian.

| Kind | Name | From | Body after 0xF2 and the kind byte |
| --- | --- | --- | --- |
| 0x01 | Get | device | image id (8), offset u32, length u16 |
| 0x02 | Data | source | image id (8), offset u32, CRC-32 of the data u32, data |
| 0x03 | Gone | source | image id (8), reason u8: 0 not available, 1 not granted, 2 paused, 3 out of range |
| 0x10 | Hello | device, Bluetooth only | device address u32, device random (8), image id (8), bytes held u32, largest data u16 |
| 0x11 | Open | phone | tag (16) |
| 0x12 | Done | device, Bluetooth only | image id (8), result u8 (0 verified, 1 refused), reason u8 (as Update status) |

- **Sizes.** A Data frame's header is 18 bytes. On Wi-Fi and USB, data is at most 1,000 bytes, so a frame stays inside the 1,024-byte buffers the links already have (section 3). On Bluetooth, at most the ATT payload less 18: 164 bytes at an MTU of 185, 496 at 517 ‡.
- **Pull.** The device asks; the source answers each Get with one Data or one Gone. A source sends nothing unasked. Up to 4 Gets ‡ outstanding on Wi-Fi and USB, 8 ‡ on Bluetooth; a Get unanswered after 2 s (3 s on Bluetooth) ‡ is asked again; a Data that matches no outstanding Get, or fails its CRC, is dropped.
- **Order.** The header (offset 0, 128 bytes) first, then the image in order, never more than the current sector and the next ahead, so two 4 KB buffers hold everything in flight.
- **CRC-32**: the reflected polynomial 0xEDB88320, initial value and final XOR 0xFFFFFFFF, as the retained block's ‡.
- **Resume** is asking from the last checkpoint. Within a session nothing else is needed; after a link drop the device sends an update query on the new link (the hub grants per link); after a reset, the device's stored update record gives the checkpoint.
- **The hub** serves frames only on a link where it has granted the transfer, with an update offer on that link (section 7). While a countdown or alarm runs it answers Gone, paused, and downloads resume from their checkpoints when it ends (D139).

### The image header

The file a device pulls is a 128-byte header followed by the image; offsets in transfer frames count from the header's first byte. The hub makes and signs the header for every image it stores, official or not (D136). Little-endian:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | `HSNI` |
| 4 | 1 | format 1 |
| 5 | 1 | flags: bit 0 an owner's own build (not from the publisher); others zero |
| 6 | 1 | roles: bit 1 sensor, bit 2 siren, bit 3 gateway (D103: all three for every image today) |
| 7 | 1 | target: 1, an ESP32-S3 board of ours |
| 8 | 3 | version: major, minor, patch (section 3) |
| 11 | 1 | zero |
| 12 | 4 | image bytes |
| 16 | 32 | SHA-256 of the image bytes |
| 48 | 8 | the identity of the hub that signed it (section 9) |
| 56 | 8 | zero |
| 64 | 64 | ECDSA P-256 over SHA-256 of `hsn-image/1`, a zero byte and bytes 0 to 63: `r` then `s`, 32 bytes each, big-endian |

The **image id** is bytes 16 to 23, the first 8 bytes of the image's hash. The hub signs deterministically (RFC 6979).

What a device checks, in order:

1. Magic, format, target, zero bytes: else refused `badHeader`.
2. Hub identity equals the paired one: else `wrongHub`.
3. Its own role's bit is set: else `wrongRole`.
4. Image bytes fit its other slot: else `tooLarge`.
5. The signature verifies under the paired signing key (section 9's 64 bytes, with a leading 0x04 added): else `badSignature`. Nothing has been written to flash before this point.
6. While writing: each Data frame's CRC-32; a bad one is dropped and asked again.
7. After the last byte: the slot read back, SHA-256 equal to the header's: else `hashMismatch`, and the download starts again from zero.
8. At "install now": selecting the slot, which checks ESP-IDF's image format ‡: else `imageCheck`.

There is no version check on the device: the hub decides which version a device runs, and going back to an older image is how a bad release is undone.

### The update service over Bluetooth

A sensor opens it only on the hub's offer with action 3, for the offer's window (section 7, "Firmware update over Bluetooth"; D138).

| Item | Value |
| --- | --- |
| Service UUID (in the advertisement) | `1012a7e5-5d53-44e0-9170-6c34720148a4` ‡ |
| Characteristic `rx`: phone writes, without response | `9e848f59-78c5-4f7e-b604-38d088ceda4f` ‡ |
| Characteristic `tx`: device notifies | `0a218c6e-e0b9-4cfe-9580-e13887bcd840` ‡ |
| Device name, in the scan response | `hsn-` and the address as 8 lower-case hex digits, most significant first |
| MTU | the phone asks for 517; the device uses what is agreed |
| Frames | transfer frames as above, one per write or notification, never split |
| Order | subscribe to `tx` → Hello → Open → (Get → Data)… → Done |
| Phone's duty | answer each Get with exactly the bytes asked, from the file, with their CRC-32; answer a Get outside the file with Gone, out of range; reconnect after a drop until the session's expiry |

- **The session key.** `K = HKDF-SHA256(key = the device's 16-byte key, salt = the nonce, info = "hsn-ble-update/1", a zero byte, the device address u32)`, 32 bytes. The nonce is the update offer's. The hub gives K to the phone; the device key never leaves the hub or the device.
- **The tag** in Open: the first 16 bytes of `HMAC-SHA256(K, "hsn-ble-open/1", a zero byte, address u32, the device random, the image id)`, with the device random and image id from Hello. A wrong tag closes the connection; five wrong in one window ‡ end it.
- One nonce serves one session; a new offer replaces it. Without K nobody can open a session, keep a sensor awake beyond its window, or start a window at all. The image's integrity does not depend on it; the signature does that.

## 11. Versions and extensions

- **Major version:** the header carries the protocol version, 1. A receiver drops and logs a packet with a version it does not support.
- **Adding fields:** new fields are only ever added at the end of a body, and receivers ignore bytes past the fields they know. So a newer hub works with older devices, and older devices with a newer hub, without a version change.
- **Adding message types:** a new type is added the same way. Unknown types are dropped and logged.
- **New device types (D27):** a new role number, plus its own message types.

## 12. Test vectors

`packages/protocol/vectors/` holds one JSON file per message type. Each case gives:

- the key, address, counter and binding;
- the body fields;
- the exact bytes expected.

The TypeScript package and the C++ firmware both encode and decode every case on every build. Cases that must be rejected are included as well: a wrong tag, an old counter, a wrong binding, a truncated packet.

M3 adds vectors for the update messages, the key change, Started's new fields, the transfer frames and their CRC-32, the image header and its signature, the Bluetooth session key and tag, and the pairing exchange, made from ESP-IDF's own sources.

## 13. Security summary

| Someone who… | Can | Cannot |
| --- | --- | --- |
| Listens to the radio | See that a device sent something, when, and how long it was. A packet that does not follow the heartbeat rhythm suggests a door event. | Read door state, armed state, battery or commands. |
| Transmits on the radio | Jam it. The gateway notices (D82), and an armed sensor that gets no reply sounds its own buzzer. | Forge or replay a packet; the 8-byte tag and the counters prevent it. |
| Is on the home network | Delay or drop Wi-Fi traffic, as a jammer could. | Read, forge or replay device traffic. |
| Steals a gateway | Learn the gateway's own key. | Read any sensor or siren traffic (D71). |
| Steals a sensor | Learn that sensor's key, and so pretend to be that one sensor. | Affect any other device. The hub removes the sensor. |

## 14. Open points

- **Heartbeat slots and clock correction (S8):** the sleep clock's real wander, measured on the development boards.
- **Reply rate margin:** how much signal margin the hub keeps when choosing a faster reply rate, set from the range test (S6).
- **Reply timing (O10):** the heartbeat reply moment and the event listen time are measured on the development boards.
- **Capacity (O11):** the [gateway load simulation](spikes/gateway-load.md) found that airtime is ample, and that collisions between sensors are the limit. Ten sensors at SF12, or about thirty at SF7, fit one gateway with listening first. A site with many far-away sensors needs a second gateway near them, so they can use a faster setting.
- **One radio hearing two data rates (O14):** until spike S7 settles it, each site uses one sending rate (section 2). The whole-system test showed why: with two rates allowed and a gateway listening at one, a sensor that fell back to the other during an outage was never heard again.
- **How busy 869.525 MHz is (S2):** LoRaWAN networks and other devices use it too. Measured at the property.
- **Firmware transfer:** the sizes, windows and timeouts marked ‡ (sections 8 and 10) are measured on the boards, and on Bluetooth in spike S9.
- **Pairing over Bluetooth:** the exact values of protocomm's GATT layout and security 2 (section 10) are pinned from ESP-IDF's sources before the pairing vectors are made.
- **Interference that comes and goes:** the gateway alerts when every noise reading for 30 seconds is above its normal level. Interference that pauses briefly never fills the 30 seconds, though it can still block most packets. The rule is set from measurements on the boards; a rule that counts most of the readings, not all, is the likely change. The status already carries the median and highest noise and the count of damaged packets, so the hub can judge this too.
- **A gateway that restarts during interference** learns the interference as its normal level and does not alert. The hub keeps each gateway's long-term normal level from its status reports and compares against that as well.
