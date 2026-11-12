# Device protocol

Version 1, agreed 2026-11-12. How sensors, sirens, gateways and the hub talk to each other. Decision numbers refer to [architecture.md](architecture.md), requirement numbers to [software.md](requirements/software.md).

Not covered here:

- How the phone and web app talk to the hub: see [stack.md](stack.md).
- How pairing data travels over Bluetooth, and how firmware images are transferred. Both belong to M3 and will be added then. The pairing data itself is defined in section 9.

Values marked † are provisional and are set by a measurement: spikes S6 (range), S7 (one radio hearing several settings, O14) and the reply-timing measurement (O10).

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

Each site allows a set of data rates. The provisional set † is DR5 (fast) and DR2 (slow). A long-range site may allow DR0. A device listens for the hub on 869.525 MHz at the reply data rate in its settings, usually faster than the rate it sends at (section 7). Until it has one, it listens at its own sending rate.

### Time on air

Milliseconds, from the formula in spike S2.

| Packet | Bytes | SF7 | SF9 | SF10 | SF12 |
| --- | --- | --- | --- | --- | --- |
| Sensor status | 25 | 62 | 206 | 412 | 1,483 |
| Hub reply | 30 | 72 | 226 | 453 | 1,647 |
| Disarmed notice | 18 | 51 | 185 | 330 | 1,319 |
| Siren command | 21 | 57 | 185 | 371 | 1,483 |
| Siren report | 28 | 67 | 226 | 412 | 1,647 |
| Started | 26 | 62 | 206 | 412 | 1,647 |

### Airtime budgets

Every transmitter enforces its own limit over a rolling hour.

| Transmitter | Rule when the budget runs low |
| --- | --- |
| Sensor | Door, cover and button reports always go first. Heartbeats are skipped once less than a fifth of the hour's budget is left. |
| Siren controller | Answers to commands go first, then LoRa checks. |
| Gateway | The last fifth of the hour's budget is kept for siren commands. |

### Listening before sending

Sensors and sirens check whether another packet is already on the site channel before they send. This is the radio's channel activity detection. Following Semtech's recommended settings it takes about 3 ms at SF7 and about 160 ms at SF12 ([hardware notes](hardware-notes.md), section 3). If the channel is busy, the device waits a random 0.2 to 2 seconds and checks again. After 5 busy checks it sends anyway. The check is a courtesy on top of the airtime limit, not a replacement for it. In the [gateway load simulation](spikes/gateway-load.md) it halved the packets lost to collisions.

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

The smallest packet is 18 bytes and the largest radio packet in this version is 30. A radio packet may be up to 255 bytes. Over WebSocket and USB a packet may be up to 1,024 bytes, which forwarded packets and log entries need.

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

- Every sender keeps a 32-bit counter per key and direction. It starts at 1 at pairing and is never reused with the same key.
- **Devices** save a resume point to flash every so many packets: every 64 on sensors, every 1,024 on sirens and gateways. After a power loss they continue from the resume point, so a value is skipped, never repeated, and flash is written rarely. Precisely: before using a counter that is a multiple of the step, the device saves counter + step. At pairing the saved resume point is one step, so a power loss before the first save cannot repeat a counter. A sender stops for good when its next resume point would pass 2³² − 1, and the device must then be paired again; at these rates that takes centuries.
- **The hub** uses resume points the same way, saved in its database, with a step of 1,024.
- **Restoring a backup** moves every saved hub resume point forward by 2²⁴, and the hub continues from there, so the restored hub never reuses a counter (O16).

### Receiving

| Receiver | Accepts a packet when | Keeps |
| --- | --- | --- |
| Hub, from a sensor or siren | The tag checks, and the counter is either higher than any accepted from that device, or one of the 64 below the highest (down to highest − 64) that has not been seen yet | The highest counter and which of the 64 below it were seen, per device, saved with every packet |
| Hub, from a gateway | The tag checks, the packet is bound to the current connection, and the counter is higher than the last one on that connection. The first packet on a new connection may carry any counter | Nothing beyond the connection |
| Sensor | The packet is bound to one of the sensor's own packets in the current exchange | Its own recent counters only, in sleep-retained memory |
| Siren, commands and settings | The tag checks and the counter is higher than the last command accepted; strictly higher, so commands can never be carried out out of order | The last accepted command counter, saved to flash with each command; commands are rare |
| Gateway | The packet is bound to the current connection, and its counter is higher than the last one on that connection. The first packet on a new connection may carry any counter | Nothing beyond the connection |

The hub allows the 64-packet window because a siren's report sent over LoRa can arrive after a later report sent over Wi-Fi, and both must count. A packet heard by two gateways is still accepted only once.

### Bindings

A binding is extra authenticated data. It is not sent; both sides already know it. A packet with the wrong binding fails its tag check.

| Packet | Binding |
| --- | --- |
| Any packet from the hub to a sensor | The counter (4 bytes) of the sensor packet it answers. A disarmed notice answers the door report that started the countdown. |
| Gateway's welcome | The gateway's random value from its hello (8 bytes) |
| Every later packet between gateway and hub, both ways | The connection's session value (16 bytes): gateway random followed by hub random |
| Everything else | None |

The bindings let sensors and gateways reject replays without saving anything to flash:

- **Sensors.** A recorded old reply answers an old packet, so it fails the tag check.
- **Gateways.** A recorded message from an old connection carries the wrong session value.

Siren commands carry no binding. The hub sends the same command bytes over LoRa and Wi-Fi, and the siren's counter check drops whichever copy arrives second (D73). A binding would make the two copies differ while sharing one nonce, which this encryption scheme forbids.

### Known limit

Packets recorded between a backup and its restore could each be replayed once to the restored hub. The risk is accepted for two reasons. Device reports carry the current state, so a replayed one is corrected by the next real one. And the change count in sensor reports shows the hub if door changes were missed.

## 5. Message types

| Type | Name | From | To | Paths |
| --- | --- | --- | --- | --- |
| 0x01 | Heartbeat | sensor | hub | LoRa |
| 0x02 | Door changed | sensor | hub | LoRa |
| 0x03 | Cover changed | sensor | hub | LoRa |
| 0x04 | Button | sensor | hub | LoRa |
| 0x05 | Started | any device | hub | any |
| 0x10 | Siren report | siren | hub | LoRa, Wi-Fi |
| 0x20 | Hello | gateway | hub | Wi-Fi, USB |
| 0x21 | Forwarded packet | gateway | hub | Wi-Fi, USB |
| 0x22 | Gateway status | gateway | hub | Wi-Fi, USB |
| 0x23 | Transmit result | gateway | hub | Wi-Fi, USB |
| 0x24 | Interference | gateway | hub | Wi-Fi, USB |
| 0x30 | Log entries | any device | hub | Wi-Fi, USB |
| 0x81 | Reply | hub | sensor | LoRa |
| 0x82 | Disarmed notice | hub | sensor | LoRa |
| 0x90 | Siren command | hub | siren | LoRa and Wi-Fi at once |
| 0x91 | Siren settings | hub | siren | LoRa, Wi-Fi |
| 0xA0 | Welcome | hub | gateway | Wi-Fi, USB |
| 0xA1 | Transmit request | hub | gateway | Wi-Fi, USB |
| 0xA2 | Gateway settings | hub | gateway | Wi-Fi, USB |

A receiver drops and logs a type it does not know.

Types 0x80 and above come from the hub, and types below 0x80 go to the hub. A receiver drops a packet whose type does not match its direction, even though the tag checked.

## 6. Message bodies

Offsets count from the first byte after the type.

### Sensor status: heartbeat, door changed, cover changed, button (0x01–0x04)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Settings version the sensor holds |
| 1 | 1 | Flags. Bit 0 door open, 1 cover open, 2 on USB power, 3 charging, 4 reply wanted, 5 local alarm sounded since the last reply, 6 buzzing now |
| 2 | 1 | Battery: (millivolts − 2,500) ÷ 10, covering 2.50 to 5.05 V |
| 3 | 1 | Chip temperature, °C, signed |
| 4 | 1 | Door change count, adds one on every open and close, wraps at 256 |
| 5 | 2 | Event age: seconds since the event this packet reports (0 for heartbeats) |
| 7 | 1 | Button action, button packets only: 1 short press, 2 pairing hold ignored while armed, 3 factory-reset hold while armed |

### Started (0x05)

Sent once after every start-up. The hub always replies to a sensor's Started, and the sensor listens for that reply as it does after a door report.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Role: 1 sensor, 2 siren, 3 gateway |
| 1 | 3 | Firmware version: major, minor, patch |
| 4 | 1 | Reset cause, as ESP-IDF reports it |
| 5 | 2 | Last fatal error code, 0 for none (FW5) |
| 7 | 1 | Settings version held |

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
| 10 | 2 | Clock correction: parts per million to add to the sensor's sleep timer, signed |

A reply always carries the full settings, so a sensor never has to ask twice.

### Disarmed notice (0x82)

No body. Bound to the door report that started the countdown.

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
| 4 | 2 | Low 16 bits of the counter of the last command acted on |
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

The siren answers with a report.

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

### Gateway status (0x22)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Settings version held |
| 1 | 4 | Seconds since start-up |
| 5 | 2 | Airtime used on 869.525 MHz in the last hour, hundredths of a percent |
| 7 | 1 | Noise level, median since the last status, dBm, signed |
| 8 | 1 | Noise level, highest since the last status, dBm, signed |
| 9 | 1 | Normal noise level the gateway has learned, dBm, signed |
| 10 | 2 | Packets received since the last status |
| 12 | 2 | Packets that failed the radio's CRC |
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

One or more entries, each: milliseconds since start-up (4), level (1), code (2), text length (1), text (up to 64 bytes). Entries fill the body exactly, so a partial entry at the end makes the body not valid. Wi-Fi and USB only. A sensor's logs travel only while it is on Wi-Fi for an update.

## 7. Exchanges

### Sensor heartbeat

1. The sensor wakes on its timer, sends a heartbeat, and sleeps its processor until the heartbeat reply moment.
2. The gateway forwards it, and the hub records it.
3. The hub replies only if the sensor's settings version differs or the sensor asked for a reply (D72). The sensor asks on every Nth heartbeat, every 5th by default, which makes a link check every 15 minutes.
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

If nobody disarms, the hub sounds the sirens when the countdown ends (AL3), and the sensor stops buzzing at the same moment.

### Heartbeat slots

The hub gives every sensor its own moment in the heartbeat cycle, so that heartbeats, which are nearly all the radio traffic, do not land on top of each other. In the [gateway load simulation](spikes/gateway-load.md) this cut lost packets for 10 far-away sensors from 5% to about 1%.

- **Planning:** the hub spreads the heartbeats of every sensor on the site evenly over time, taking each one's interval and packet length into account. It keeps the moments when it will send link-check replies clear of them too.
- **Telling the sensor:** every link-check reply gives the time of the sensor's next heartbeat, counted from the end of the heartbeat it answers, so no clocks need to agree.
- **Correcting the clock:** a sensor's sleep clock is a cheap oscillator that runs a few percent fast or slow. The hub sees each heartbeat arrive, works out how fast that sensor's clock runs, and sends a correction in parts per million. The sensor scales its sleep times by it.
- **Between replies:** the sensor keeps its schedule from the last reply it received. One that has not had a reply yet, or has lost several, uses its interval with ±10% at random until it hears again.
- **What slots do not touch:** door, cover and button reports still go out the moment something happens.

The simulation still worked with a sensor's clock wandering ±10 seconds per heartbeat, for 10 sensors in a 5-minute cycle. Spike S8 measures the real wander.

### Faster replies

The gateway transmits with more power than a sensor: up to +22 dBm against 14 dBm. That extra power lets a reply use a faster setting and still reach the sensor, about three steps faster for the full difference. For example, a sensor sending at SF12 can hear replies at SF9, which takes 0.2 seconds instead of 1.5.

- **Choosing the rate:** the hub picks each sensor's reply rate from the signal margin of that sensor's packets, keeping a safety margin †. It sends it in the reply's settings, and siren settings carry the same for commands.
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

The sensor retries about 2, 5 and 10 seconds after the event, then every 60 seconds, for up to 10 minutes. Each retry adds a random extra wait of up to half the gap before it, so two doors that opened together do not keep colliding. It listens before each try, as for every packet.

- After the second failed try it steps one data rate slower.
- If the door changes again meanwhile, it sends the newest state instead (DS3).
- If the first try goes unanswered and the sensor believes it is armed, it buzzes for its stored countdown, counted from the opening, then sounds its own alarm for about 3 minutes (DS6, D88). Retries carry on meanwhile.
- Any reply stops the local alarm if it says "not armed". A press of the button stops it too.
- The next report that gets through has bit 5 set, so the hub learns the local alarm went off and notifies.
- If all retries fail, the next heartbeat's change count tells the hub that door changes were missed.

### Data rate

A sensor starts at the fastest data rate the site allows and keeps the rate that last worked (LR4). When two reply-wanted packets in a row go unanswered, it first goes back to listening for replies at its own sending rate, in case the faster reply was what failed. If two more go unanswered, it steps its sending rate one slower. A single loss is usually a collision, and a slower rate would only make collisions likelier. The hub tells it to step faster in a reply when the signal margin is large.

At slow rates the sensor lengthens its heartbeat to stay inside its airtime: at least 3 minutes at SF11 and 5 minutes at SF12. The hub knows each sensor's rate from the forwarded packets, so its silence timeout follows the real interval (HB8). How many missed heartbeats count as silent depends on that sensor's measured packet loss (D107).

### Siren command

1. The hub sends the same command packet over the siren's Wi-Fi connection and, through the gateway that last heard the siren best, over LoRa (D73).
2. The siren acts on the first copy and drops the second by its counter.
3. It answers with a report that names the command it acted on. It answers an exact repeat of its latest command the same way, so the hub's retries are safe. Older counters get no answer.
4. The hub repeats the same packet every 2 seconds on Wi-Fi and every 5 seconds on LoRa until a report confirms it, for up to a minute. After that it warns that the siren cannot be reached.

### Siren reports

- The siren reports every 30 seconds over Wi-Fi.
- It reports over LoRa at once when a Wi-Fi report fails, and every 5 minutes as a check.
- The hub does not reply to reports.
- Losing either path is a warning, and losing both means the siren is silent (D73, D52).

### Gateway connection

1. The gateway connects and sends a hello with a fresh random value.
2. The hub answers with a welcome bound to that value, carrying its own random value. The two values together are the session value.
3. The hub sends the gateway its settings.
4. From then on the gateway sends forwarded packets, a status every 30 seconds and transmit results, and the hub sends transmit requests.
5. The hub reports a gateway offline after 60 seconds with nothing from it (D97).
6. A gateway that loses its connection retries after 1, 2, 4, 8, 15 and then every 30 seconds.

### Reply timing and a busy gateway

A gateway has one radio. It cannot send while it is receiving, or send two things at once, and at slow settings one packet holds the radio for up to 1.5 seconds. So replies are timed by how much they matter:

| Reply | When the gateway sends it | What the sensor does | If the radio is busy |
| --- | --- | --- | --- |
| To a heartbeat, including link checks | At a fixed moment, the heartbeat reply moment after the packet finished arriving, on the gateway's own clock | Sleeps until that moment, then listens briefly | The reply is skipped. The sensor gets its settings at the next link check. |
| To a door, cover, button or started report | As soon as the radio is free, but no later than the sensor will still be listening | Listens from the moment it finishes sending, for the event listen time | The gateway waits for the radio, then sends. If it would be too late, it reports "too late" and the sensor's retry covers it. |
| Disarmed notice | As soon as the radio is free | Listening, because it is buzzing | Waits, then sends. |
| Siren command | As soon as the radio is free, with priority over replies | Always listening | Waits, then sends. |

Two more rules:

- **Receiving comes first.** The gateway never cuts off a packet it is in the middle of receiving in order to send.
- **One gateway replies.** When several gateways hear the same packet, the hub uses the first copy, drops the rest by counter, and replies through that same gateway (GW9). The gateway counts any send-at time on its own clock from when it heard the packet end, so no clocks need to agree.

### Hub restart

1. The hub sends "report now" to every siren on both paths.
2. It resumes saved countdowns and alarms (D80).
3. Gateways reconnect with a new hello.

## 8. Timing

| Value | Setting | Where it comes from |
| --- | --- | --- |
| Heartbeat reply moment: end of the heartbeat to start of the reply | 1 second † | O10 |
| Event listen time: how long a sensor listens after a door, cover, button or started report | the hub's round trip, plus one packet's wait for a busy radio, plus the reply: from about 1.5 s at SF7 to about 3 s at SF12 with faster replies † | O10, [gateway load](spikes/gateway-load.md) |
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

## 9. Pairing data

The data a device receives when it is added (PR2). It is delivered over USB (section 10) now, and over Bluetooth from M3.

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

Each pairing gives a new key, so counters restart at 1. The Wi-Fi name and password are carried as bytes, not text, so a device never has to check their encoding; a name the user types is encoded as UTF-8. A format version other than 1, or an address of 0 or 0xFFFFFFFF, makes the pairing data not valid.

## 10. Wi-Fi and USB

### Wi-Fi

- **Finding the hub:** the hub advertises itself on the home network by mDNS, as `_hsn-hub._tcp` with its identity in the record. A device connects only to the hub whose identity it was paired with.
- **Connection:** a WebSocket to `ws://<hub>:<port>/device`, the same port as the apps. Each binary WebSocket message carries exactly one packet.
- **No TLS:** every packet is already encrypted and authenticated, so the connection needs no TLS and no login.
- **What uses it:** gateways and sirens use it all the time. Sensors use it only for updates.

### USB

- **Link:** the gateway appears as a USB serial port; the ESP32-S3 has one built in. The hub recognises Espressif's USB vendor number.
- **Framing:** each packet is COBS-encoded and ends with a zero byte. Otherwise the link works exactly like Wi-Fi. An encoder does not add an empty block after a final run of exactly 254 non-zero bytes; a decoder accepts the frame with or without one. A decoder skips empty frames, meaning two delimiters with nothing between them. A frame that decodes to no bytes at all is passed on like any other and fails as too short. A decoder drops a frame longer than a 1,024-byte packet can encode to (1,029 bytes) or one that decodes to more than 1,024 bytes.

### Setup messages, USB only

These messages are not encrypted, because the cable is trusted (D100). A device ignores them on any other path. All start with the byte 0xF1, which no encrypted packet starts with.

| Second byte | Message | Direction | Body |
| --- | --- | --- | --- |
| 0x01 | Identify | hub to device | none |
| 0x02 | Identity | device to hub | role (1), chip identifier (6), firmware version (3), paired (1), hub identity or zeros (8), development build (1) |
| 0x03 | Provision | hub to device | pairing data (section 9) |
| 0x04 | Provision result | device to hub | 0 accepted, 1 refused, 2 not valid |
| 0x05 | Erase | hub to device | none; development builds only |

The "paired" and "development build" bytes are 0 or 1; any other value makes the message not valid. A message that does not start with 0xF1 is not a setup message. Extra bytes after a setup message's fields are ignored, as for message bodies. In an identity, the hub identity bytes mean nothing when "paired" is 0, and the receiver ignores them.

Who accepts what:

- **Release builds:** a gateway accepts Provision only while unpaired, which is how a gateway plugged into the hub computer is added automatically (D100). Sensors and sirens refuse it.
- **Development builds:** every role accepts Provision and Erase at any time (PR5). That is how the first milestone sets keys.

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
- **One radio hearing two data rates (O14):** if it cannot, each site uses one data rate, chosen from the range test.
- **How busy 869.525 MHz is (S2):** LoRaWAN networks and other devices use it too. Measured at the property.
- **Firmware transfer:** over Wi-Fi and Bluetooth, defined in M3. The "update available" flag in replies is already in place.
- **Pairing over Bluetooth:** defined in M3, delivering the pairing data in section 9.
