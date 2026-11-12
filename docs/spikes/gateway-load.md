# Gateway load: can one gateway serve many sensors?

Simulated 12 November 2026. Code in [`spikes/gateway-load`](../../spikes/gateway-load); one simulated year per case. Feeds O11 and LR9.

## Summary

- **Airtime is not the problem.** Even 10 sensors at the slowest setting keep the gateway sending for about 1.2% of the hour, against the 10% allowed.
- **Collisions are.** Sensors share one channel and don't coordinate. Ten sensors at the slowest setting lose about 11% of their packets to each other, and to the gateway being busy sending.
- **Door reports were always answered** within the 10-minute retry period, once retries wait a random extra time. Without that, two doors opening within a second of each other kept colliding on every retry until both gave up. The simulation found this; the spec now fixes it.
- **Listening before sending halves the losses.** The sensor checks whether another packet is on the air and waits a moment if so.
- **The "silent after 3 missed heartbeats" rule (D52) raised false alerts on busy, slow sites**, so it now adapts per sensor (D107). In the worst case tested, even with listening first, it gave 157 false "sensor silent" alerts a year. Five missed heartbeats gave about one a year or fewer in every case tested.

## What was simulated

| Assumption | Value |
| --- | --- |
| Packet size | 25 bytes, from [protocol.md](../protocol.md) |
| Heartbeats | 3 minutes (5 at SF12), ±10% at random, a reply wanted on every 5th |
| Door events | 20 a day per sensor, at random |
| Door retries | 2, 5, 10 s, then every 60 s for up to 10 minutes, each with a random extra wait of up to half the gap |
| Event replies | sent as soon as the gateway's radio is free; the sensor listens straight away |
| Link-check replies | at a fixed moment 1 s after the heartbeat; skipped if the radio is busy then |
| Hub round trip over Wi-Fi | 0.05–0.3 s, at random |
| Siren | one, sending a LoRa check every 5 minutes at SF10 |
| Listening first | if another packet is on the air, wait 0.2–2 s and check again, up to 5 times. 30% of the time the other sensor is out of earshot and is not noticed. |
| Collisions | two overlapping packets are both lost; the gateway hears nothing while sending |

Two things real radios do better than the model, so it is on the safe side:

- LoRa often decodes the stronger of two colliding packets.
- Sensors on different settings barely interfere, while the model puts every sensor on the same one.

## Results

"Door reply" is the time from the door opening to the sensor receiving the hub's reply.

| Sensors | Setting | Listen first | Packets lost | Link-check replies lost | Door replied on the first try | Door reply, median / 99% / worst | Gateway sending | False "silent" alerts a year: after 3 / 4 / 5 missed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | SF12, 5 min | no | 11.1% | 14.0% | 88.1% | 3.2 / 14.8 / 320 s | 1.2% | 1,734 / 262 / 37 |
| 10 | SF12, 5 min | yes | 5.0% | 9.5% | 94.0% | 3.2 / 10.6 / 160 s | 1.2% | 157 / 5 / 0 |
| 10 | SF10, 3 min | no | 5.0% | 7.2% | 94.5% | 1.0 / 3.9 / 159 s | 0.5% | 345 / 28 / 1 |
| 10 | SF10, 3 min | yes | 2.0% | 4.6% | 97.4% | 1.0 / 3.7 / 86 s | 0.5% | 25 / 1 / 0 |
| 20 | SF10, 3 min | yes | 4.0% | 9.2% | 95.5% | 1.0 / 4.0 / 94 s | 1.0% | 265 / 19 / 1 |
| 30 | SF7, 3 min | no | 2.4% | 3.6% | 97.5% | 0.3 / 2.9 / 151 s | 0.2% | 88 / 1 / 0 |
| 30 | SF7, 3 min | yes | 0.9% | 2.2% | 99.0% | 0.3 / 2.3 / 8 s | 0.2% | 2 / 0 / 0 |

No door report went unanswered for 10 minutes in any case.

## What changes

In [protocol.md](../protocol.md):

1. **Listen before sending:** sensors and sirens check the site channel before sending.
2. **Random retry waits:** every retry waits a random extra time.
3. **Slower data rate only after two misses:** a sensor steps slower only after two reply-wanted packets in a row go unanswered. A single collision would otherwise push it to a slower rate, which means longer packets and more collisions.
4. **Door replies are sent as soon as the gateway's radio is free,** and the sensor listens straight away.
5. **Heartbeat slots and faster replies** (D108), from the further reductions below.

For the owner:

- **The silence rule:** now chosen per sensor from its measured packet loss, 3 to 8 missed heartbeats (D107). Applied to the simulated cases, that gives 9 minutes for a few sensors near the gateway, 12 minutes for 30 at SF7, and 25 minutes for 10 at SF12.
- **Capacity guidance:** the cure for many far-away sensors is a second gateway near them, so they can use a faster setting. A packet at SF7 is 24 times shorter than at SF12. A second gateway in the same spot adds little, because the sensors' packets still collide in the air.

## Further reductions

Two more ideas were simulated for a year each, on top of listening first:

- **Faster replies.** The gateway sends replies three settings faster than the sensor sends, for example SF9 for a sensor at SF12. It uses its extra transmit power to make up the range: up to the radio's +22 dBm, where the sensor uses 14 dBm and 869.525 MHz allows 27 dBm. The gateway is then deaf for a much shorter time per reply.
- **Heartbeat slots.** The hub gives each sensor its own moment in the heartbeat cycle, so heartbeats stop landing on top of each other. Each link-check reply says when the next heartbeat is due and how fast that sensor's clock runs. Door reports still go out the moment the door moves.

| Case | Variant | Packets lost | Link-check replies lost | Door reply median / 99% | False "silent" alerts a year, after 3 / 4 missed |
| --- | --- | --- | --- | --- | --- |
| 10 at SF12 | listen first (current spec) | 5.0% | 9.5% | 3.2 / 10.6 s | 157 / 5 |
| 10 at SF12 | + faster replies | 3.7% | 8.2% | 1.9 / 6.4 s | 86 / 4 |
| 10 at SF12 | + heartbeat slots | 1.1% | 1.1% | 3.2 / 9.0 s | 0 / 0 |
| 10 at SF12 | + both | 0.6% | 0.7% | 1.9 / 5.2 s | 0 / 0 |
| 20 at SF10 | listen first (current spec) | 4.0% | 9.2% | 1.0 / 4.0 s | 265 / 19 |
| 20 at SF10 | + both | 0.3% | 0.4% | 0.7 / 3.4 s | 0 / 0 |
| 30 at SF7 | listen first (current spec) | 0.9% | 2.2% | 0.3 / 2.3 s | 2 / 0 |
| 30 at SF7 | + heartbeat slots | 0.1% | 0.2% | 0.3 / 2.3 s | 0 / 0 |

How far a sensor's clock may wander between corrections, for 10 sensors at SF12 with both changes:

| Clock wander per heartbeat | Packets lost | False "silent" alerts a year after 3 missed |
| --- | --- | --- |
| ±1 s | 0.6% | 0 |
| ±6 s | 0.6% | 0 |
| ±10 s | 0.7% | 0 |
| ±15 s | 0.9% | 2 |

Ten sensors in a 5-minute cycle are 30 seconds apart, so the slots tolerate a lot of wander. The ESP32-S3's sleep clock is an uncalibrated oscillator, accurate to a few percent *(from memory)*. Most of that error is steady, though, and the hub can measure it from arrival times and correct it. Spike S8 measures the rest on the development boards.

Not simulated, and smaller or costlier:

- **Shorter packets:** at SF12, airtime grows in steps of 5 bytes, so trimming a byte or two often saves nothing.
- **Fewer heartbeats:** fewer collisions, but slower silence detection.
- **A second radio on gateways, on a second channel:** halves collisions, but changes the shared board (D49).

## Not covered

- Real radio behaviour: the range test (S6) and the two-setting test (S7) replace the model's assumptions.
- Busy hours: everyone leaving at once makes events bunch together.
- Other systems on 869.525 MHz.
