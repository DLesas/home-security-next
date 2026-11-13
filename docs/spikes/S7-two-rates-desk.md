# S7, desk part: can one gateway radio hear two data rates?

Desk research, 2026-11-13. It answers part of open item O14 before the boards arrive. The measurement on real boards (spike S7) is still needed for the figures marked "calculated".

## Short answer

No, not at the same moment. The SX1262 has one LoRa receiver, set to one spreading factor at a time. It can be made to **take turns** between two rates, but that costs airtime on every packet and a few decibels of range. Hearing two rates properly needs a second radio or a gateway chip built for it.

## What the radio can and cannot do

| Fact | Source |
| --- | --- |
| The SX1262 is configured with one spreading factor and one bandwidth; there is one receiver | SX1262 datasheet, as summarised in [hardware-notes.md](../hardware-notes.md) section 3 |
| A channel check (CAD) looks for one spreading factor. It takes 2.66 ms at SF7, 38.73 ms at SF10 and 158.79 ms at SF12 with Semtech's recommended settings | Semtech AN1200.48, in hardware-notes.md section 3 |
| A channel check can be set to go straight into receiving when it detects something | SX1262 datasheet, `cadExitMode` 0x01 |
| At SF7 a channel check detects 97% of packets at −123 dBm, 74% at −125 dBm and 1% at −130 dBm | Semtech AN1200.48 |
| Semtech's gateway chips (SX1302, SX1303) have 8 receivers for 125 kHz channels, each hearing SF5 to SF12 at once | [Semtech SX1302 product page](https://www.semtech.com/products/wireless-rf/lora-gateways/sx1302) |

No source found says the SX1262 can demodulate two spreading factors at once. That matches how every single-radio LoRa device is built.

## Option 1: one radio taking turns

The gateway checks for the fast rate, then for the slow rate, and repeats. When a check detects a packet, the radio goes straight into receiving at that rate.

A packet is only caught if its preamble is still on the air when its turn comes round, so every sender must lengthen its preamble to cover a whole round. Calculated from Semtech's check durations:

| Site rates | One round | Fast packet (25 bytes) | Slow packet (25 bytes) |
| --- | --- | --- | --- |
| SF7 and SF10 | about 43 ms | preamble 8 → about 50 symbols; 62 → about 105 ms on air (+70%) | preamble 8 → about 15 symbols; 412 → about 470 ms (+14%) |
| SF7 and SF12 | about 163 ms | preamble 8 → about 170 symbols; 62 → about 230 ms (nearly four times) | preamble 8 → about 15 symbols; 1,483 → about 1,710 ms (+15%) |

Costs:

- **Airtime and battery** on every packet, most on the fast rate that most sensors would use.
- **Range.** A channel check detects weak packets less reliably than a receiver already listening: a quarter are missed 1 dB above the receiver's limit at SF7. The far-away sensors that need the slow rate are the weak ones.
- **False detections** put the radio into receiving for nothing, deaf to the other rate meanwhile.
- **Still one packet at a time.** While it receives at one rate it hears nothing at the other.

Verdict: workable for a fast and a medium rate, poor for fast and slowest. Not worth designing in before it is measured.

## Option 2: two radios on the gateway

A second SX1262 on the gateway, one radio per rate, each listening all the time.

- No change to senders, no loss of range, and two packets can arrive at once, one per rate.
- Cost: one more radio module on gateways only, and either a second antenna or a splitter that costs 3 dB.
- The protocol is ready: a forwarded packet already says which data rate it arrived at.

## Option 3: a gateway built on Semtech's gateway chip

An SX1302 or SX1303 with its two front-end chips, usually bought as a small module made for Raspberry Pi gateways.

- Hears every data rate on all three site channels at once.
- Cost: tens of euros for the module, a few hundred milliamps, and Semtech's driver, which is written for Linux, not for the ESP32. It fits a hub that runs on a Raspberry Pi: the Pi would be hub and gateway in one.
- The protocol is ready here too: forwarded packets carry the data rate and the channel.

## What this means now

- A gateway built on our board hears one rate, so **a site has one sending rate** (protocol section 2). That stays.
- Changing a site's rate or channel later is done **over the air by the hub** (D115), with no need to hear two rates: sensors are told the new settings in advance and move to them when the old ones stop being answered.
- Options 2 and 3 stay open for the board design and for a Pi-hosted hub. Either would allow fast and slow sensors on one site, which Option 1 does badly.
- Spike S7 on the boards should measure Option 1's real detection rate and, with a second radio module on jumper wires, confirm Option 2.
