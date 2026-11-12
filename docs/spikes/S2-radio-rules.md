# S2 — Radio rules for 863–870 MHz (EU and UK)

Desk research, 12 November 2026. No lab work. No legal advice.

Every claim carries a source link and one of three labels:

- **read in the primary source** — I opened the regulator's or standards body's own document and read the text.
- **from a secondary source** — I read it somewhere other than the original publisher, or through an unofficial copy.
- **could not verify** — I could not open or read a source that settles it.

Lines marked **our calculation** or **our inference** are our own working, not a quotation.

## Summary

1. "1% everywhere" is wrong. The duty cycle limit is 0.1%, 1% or 10% depending on the sub-band. Only 865–868, 868.0–868.6 and 869.7–870.0 MHz are 1% bands.
2. "14 dBm" is right for most sub-bands, but it is 25 mW **e.r.p.** (radiated, dipole-referenced), not conducted power. 869.4–869.65 MHz allows 500 mW e.r.p. (27 dBm) and 10% duty cycle.
3. Gateway replies and siren commands should move to 869.4–869.65 MHz (one 125 kHz channel at 869.525 MHz). This gives ten times the airtime of a 1% band. LoRaWAN does the same for its RX2 downlink.
4. The alarm-only sub-bands are closed to 125 kHz LoRa. Their channel-width limit is 25 kHz (100 kHz at most in 868.6–868.7 MHz).
5. UK rules match the EU rules for every sub-band we plan to use. One UK table row (865–868 MHz, 25 mW) could not be read in Ofcom's PDF, so we should not rely on that band in the UK yet.

## Sources used

| Key | Document | Link | How it was read |
|---|---|---|---|
| REC | ERC Recommendation 70-03, cover dated "Edition of October 2026", amended 9 October 2026 | https://docdb.cept.org/download/5013 (listing: https://docdb.cept.org/document/845) | read in the primary source |
| DEC | Commission Implementing Decision (EU) 2025/105, amending 2006/771/EC | https://eur-lex.europa.eu/eli/dec_impl/2025/105/oj/eng | could not verify on EUR-Lex (the page returned no text to my fetcher) |
| DEC-M | Unofficial copy of the same Decision | https://lawplayer.com/eu/act/32025D0105 | from a secondary source |
| R85 | CEPT Report 85 (8 March 2024). Contains the annex text CEPT proposed for that Decision | https://docdb.cept.org/download/4445 | read in the primary source (it is the proposal, not the adopted law) |
| EN2 | ETSI EN 300 220-2 V3.3.1 (2025-03) | https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf | read in the primary source |
| EN1 | ETSI EN 300 220-1 V3.1.1 (2017-02) | https://www.etsi.org/deliver/etsi_en/300200_300299/30022001/03.01.01_60/en_30022001v030101p.pdf | read in the primary source |
| EN32 | ETSI EN 300 220-3-2 V1.1.1 (2017-02), wireless alarms | https://www.etsi.org/deliver/etsi_en/300200_300299/3002200302/01.01.01_60/en_3002200302v010101p.pdf | read in the primary source |
| IR | Ofcom IR 2030, version 1.17, published 23 October 2026 | https://www.ofcom.org.uk/__data/assets/pdf_file/0028/84970/ir-2030.pdf | read in the primary source |
| UKDS | UK Notice of Publication 0145/26 (3 November 2026), designated standards for radio equipment | https://assets.publishing.service.gov.uk/media/6ae34b8aa5c2f99e3a7b832d/0145_26_Radio_Equipment_Notice_of_Publication.pdf (listing: https://www.gov.uk/government/publications/designated-standards-radio-equipment) | read in the primary source |
| RP | LoRaWAN Regional Parameters RP002-1.0.4 | https://resources.lora-alliance.org/technical-specifications/rp002-1-0-4-regional-parameters | read in the primary source |
| TTN | The Things Network, EU868 page | https://www.thethingsnetwork.org/docs/lorawan/regional-parameters/eu868/ | from a secondary source |
| SX | Semtech SX1261/2 datasheet Rev. 1.2 (June 2019), copy hosted by SparkFun | https://cdn.sparkfun.com/assets/6/b/5/1/4/SX1262_datasheet.pdf | from a secondary source (manufacturer's document on a distributor's server) |
| HS | Commission Implementing Decision (EU) 2025/2499 (harmonised standards list), unofficial copy | https://lawplayer.com/eu/act/32025D2499 | from a secondary source |

Note on REC: the file's cover says October 2026, but the Annex 1 and Annex 7 pages carry the footer "Edition of October 2025". I read that as "those pages last changed in October 2025". (our inference)

## 1. Sub-bands open to non-specific short-range devices

All power limits are **e.r.p.** (effective radiated power), not conducted power. EN2 defines e.r.p. as the power radiated in the direction of maximum radiation. If the device has a permanent antenna connector, the lab may measure conducted power, and then the largest allowed antenna gain (relative to a dipole) is the e.r.p. limit minus the measured conducted power. (read in the primary source — EN2 clauses 4.4.1 and 5.4.1.2, https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf)

25 mW e.r.p. = 14.0 dBm e.r.p. = 16.1 dBm e.i.r.p. 500 mW e.r.p. = 27.0 dBm e.r.p. (our calculation; the 2.15 dB e.r.p./e.i.r.p. offset is read in the primary source — RP footnote 15, https://resources.lora-alliance.org/technical-specifications/rp002-1-0-4-regional-parameters)

| Sub-band (MHz) | REC entry / EU band no. / ETSI band | Max power (e.r.p.) | Duty cycle | Can polite access (LBT + AFA) replace the duty cycle? | Width limit | 125 kHz LoRa fits? |
|---|---|---|---|---|---|---|
| 862–863 | h0 / 87 / K0 | 25 mW | ≤ 0.1% | No | ≤ 350 kHz | Yes, but 0.1% only |
| 863–865 | h1.3 / 46a / K | 25 mW | ≤ 0.1% | Yes | None (whole band) | Yes, but 0.1% only |
| 865–868 | h1.4 / 47 / L | 25 mW | ≤ 1% | Yes | None (whole band) | Yes |
| 868.0–868.6 | h1.5 / 48 / M | 25 mW | ≤ 1% | Yes | None (whole band, 600 kHz) | Yes |
| 868.7–869.2 | h1.6 / 50 / N | 25 mW | ≤ 0.1% | Yes | None (whole band, 500 kHz) | Yes, but 0.1% only |
| 869.4–869.65 | h1.7 / 54 / O | 500 mW | ≤ 10% | Yes | None (whole band, 250 kHz) | Yes, one channel |
| 869.7–870.0 | h1.9 / 56b / Q | 25 mW | ≤ 1% | Yes | None (whole band, 300 kHz) | Yes |
| 869.7–870.0 | h1.8 / 56a / P | 5 mW | No requirement | Not needed | None (whole band, 300 kHz) | Yes, at 7 dBm |

Status of this table:

- REC columns (frequency, power, duty cycle, "or LBT+AFA", "Not specified" bandwidth): read in the primary source — REC Annex 1 Table 1, https://docdb.cept.org/download/5013
- ETSI columns (band letters, "polite spectrum access", maximum occupied bandwidth "the whole band"): read in the primary source — EN2 Table 4 and Annex B, https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf
- EU band numbers and limits as adopted in law: from a secondary source — DEC-M, https://lawplayer.com/eu/act/32025D0105. The same rows and wording appear in CEPT's proposal, which I read in the primary source — R85 Annex 3, https://docdb.cept.org/download/4445
- "125 kHz LoRa fits?" column: our inference from the width limits.

Notes on the table:

- EU law words the polite-access option as "Requirements on techniques to access spectrum and mitigate interference apply. Alternatively, a duty cycle ≤ X% applies." (read in the primary source as CEPT's proposed text — R85, https://docdb.cept.org/download/4445; from a secondary source as adopted — DEC-M, https://lawplayer.com/eu/act/32025D0105)
- REC says: "Listen before talk (LBT) with Adaptive Frequency Agility (AFA) technique feature may be used instead of duty cycle." (read in the primary source — REC Annex 1 additional information, https://docdb.cept.org/download/5013)
- Polite access is not unlimited. EN2 Table 18 caps a polite device at 100 s of transmission per hour per 200 kHz of spectrum, 1 s per single transmission, 4 s per dialogue, and 100 ms minimum off time on the same frequency. The listen time must be at least 160 µs. (read in the primary source — EN2 clause 4.6.3, https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf)
- 100 s per hour is about 2.8% on one channel. That is better than a 1% band and worse than the 10% band. (our calculation)
- A polite device must also meet a tighter receiver sensitivity limit: S = 10·log10(channel width in kHz) − 117 dBm. For 125 kHz that is about −96 dBm. The channel-busy threshold is 15 dB above that limit below 100 mW e.r.p. and 11 dB above it from 100 to 500 mW. (formula and offsets read in the primary source — EN2 clauses 4.5.1.3 and 4.6.2, same URL; the −96 dBm figure is our calculation)
- There are two wider entries for 863–870 MHz as a whole, both at 0.1% and both excluding the alarm sub-bands. One is for frequency hopping with hop channels ≤ 100 kHz and at least 47 channels. The other is for non-hopping signals with a power density cap of −4.5 dBm per 100 kHz. (read in the primary source — REC entries h1.0 and h1.2, https://docdb.cept.org/download/5013; EN2 bands V and W, https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf)
- Neither wide entry suits us. 125 kHz is wider than a 100 kHz hop channel, and 14 dBm in 125 kHz is far above −4.5 dBm per 100 kHz. (our inference)
- 865–868 MHz is shared with RFID readers at up to 2 W e.r.p. on channels centred at 865.7, 866.3, 866.9 and 867.5 MHz. REC advises LBT + AFA or separation distances there. (read in the primary source — REC Annex 1 notes and Annex 11, https://docdb.cept.org/download/5013)
- 865–868 MHz also has a 500 mW "data network" entry on four 200 kHz slots (865.6–865.8, 866.2–866.4, 866.8–867.0, 867.4–867.6 MHz). It needs adaptive power control. The duty cycle is 10% for network access points and 2.5% for other devices. It is tested against EN 303 659, not EN 300 220. (read in the primary source — REC Annex 2 entry c1, https://docdb.cept.org/download/5013; R85 entry 47b, https://docdb.cept.org/download/4445)
- Adjacent sub-bands may be used as one band if the conditions of each are met. (read in the primary source as CEPT's proposed text — R85, https://docdb.cept.org/download/4445; could not verify in the adopted Decision on EUR-Lex)
- Only one 125 kHz channel fits sensibly in 869.4–869.65 MHz. Two would sit edge to edge with no guard. (our inference; not tested against the band-edge mask in EN2)

## 2. Alarm-only sub-bands

| Sub-band (MHz) | Who may use it | Max power (e.r.p.) | Duty cycle | Width limit | 125 kHz LoRa allowed? |
|---|---|---|---|---|---|
| 868.6–868.7 | Alarms | 10 mW | ≤ 1.0% | ≤ 25 kHz; the whole 100 kHz may also be used as one channel | No |
| 869.2–869.25 | Social alarms only | 10 mW | ≤ 0.1% | 25 kHz channel spacing | No |
| 869.25–869.3 | Alarms | 10 mW | ≤ 0.1% | ≤ 25 kHz | No |
| 869.3–869.4 | Alarms | 10 mW | ≤ 1.0% | ≤ 25 kHz | No |
| 869.65–869.7 | Alarms | 25 mW | ≤ 10% | ≤ 25 kHz | No |

- Limits: read in the primary source — REC Annex 7 Table 7, https://docdb.cept.org/download/5013. The UK table has the same values: read in the primary source — IR entries IR2030/17/1 to 17/5, https://www.ofcom.org.uk/__data/assets/pdf_file/0028/84970/ir-2030.pdf
- EU band numbers 49, 51, 52, 53 and 55 carry the same limits under the category "Reliable alarm devices". (from a secondary source — DEC-M, https://lawplayer.com/eu/act/32025D0105; read in the primary source as CEPT's proposal — R85, https://docdb.cept.org/download/4445)
- There is no polite-access alternative in these sub-bands. The tables list a duty cycle only. (read in the primary source — REC Annex 7, https://docdb.cept.org/download/5013)
- Yes, the width limits rule out 125 kHz LoRa in every alarm sub-band. The widest allowed channel is 100 kHz, in 868.6–868.7 MHz. (our inference from the limits above)
- The SX1262 does offer narrower LoRa bandwidths (7.81 to 62.5 kHz). A 62.5 kHz signal could fit 868.6–868.7 MHz at 10 mW. We have not planned for this. (bandwidth list from a secondary source — SX, https://cdn.sparkfun.com/assets/6/b/5/1/4/SX1262_datasheet.pdf; the fit is our inference)
- An alarm product does not have to use the alarm sub-bands. The non-specific category "covers all kinds of radio devices, regardless of the application" and lists alarms as a typical use. (read in the primary source as CEPT's proposed Table 1 — R85, https://docdb.cept.org/download/4445; the same definition is quoted in EN2 clause 1, https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf)
- ETSI warns alarm makers that 869.4–869.65 MHz, right next to the alarm sub-bands, may carry devices at up to 500 mW. (read in the primary source — EN32 Annex D, https://www.etsi.org/deliver/etsi_en/300200_300299/3002200302/01.01.01_60/en_3002200302v010101p.pdf)

## 3. How duty cycle is measured

- Definition: the ratio Σ(Ton)/Tobs, as a percentage. Ton is the on-time of **a single transmitter device**. It is measured inside an observation band Fobs. Unless stated otherwise, Tobs is **a continuous one-hour period** and Fobs is **the applicable frequency band**. (read in the primary source — REC Appendix 4, https://docdb.cept.org/download/5013; IR section 3, https://www.ofcom.org.uk/__data/assets/pdf_file/0028/84970/ir-2030.pdf; R85 annex, https://docdb.cept.org/download/4445)
- So the limit is per device and per sub-band. Each gateway has its own budget. Each sensor has its own budget. (our inference from the definition)
- A device that works in several bands gets each band's limit separately: "the Duty Cycle limit of each individual band applies to the series of transmissions within that band." (read in the primary source — EN2 clause 4.4.3.2, https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf)
- So a gateway may use 1% in 868.0–868.6 MHz and, in the same hour, 10% in 869.4–869.65 MHz. (our inference)
- The limit applies to the whole sub-band, not per channel. Hopping between three channels in 868.0–868.6 MHz does not triple the budget. (our inference from "Fobs is the applicable frequency band")
- 1% of an hour is 36 s. 10% is 360 s. 0.1% is 3.6 s. (read in the primary source — REC Appendix 4 Table 17, https://docdb.cept.org/download/5013)
- The test lab measures a "representative period" of one hour in "normal use", meaning the behaviour during 99% of transmissions over the product's life. Setup, commissioning and maintenance do not count. (read in the primary source — EN2 clause 5.4.3.1, https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf)
- Whether the hour is a fixed clock hour or any rolling 60 minutes: could not verify. The texts say "continuous one hour period" and nothing more. We should enforce a rolling window in firmware, which is the stricter reading. (our inference)
- Acknowledgements count. EN2 says: "Where an acknowledgement is used, the additional transmitter on-time from a message responder shall be taken into account only once whether included in the message initiator Duty Cycle or in the message responder Duty Cycle." The note adds that the rule is not meant to let equipment exceed the limit. (read in the primary source — EN2 clause 5.4.3.1, same URL)
- Our reading: every gateway reply is airtime that must be counted, and the natural place is the gateway's own budget in the sub-band where the reply is sent. How a test house applies "only once" to a two-device exchange: could not verify. Ask the lab.
- Emissions separated by less than a "disregard time" count as one transmission. The value is declared by the manufacturer. (read in the primary source — EN2 clause 3.1 and Annex G, same URL)
- In the sub-bands above there is no per-packet length limit when using duty cycle. Maximum on-time and minimum off-time rules apply only to bands above 870 MHz or where national rules say so. (read in the primary source — EN2 clause 4.4.12.1, same URL)
- A device using polite access in bands K, L, M, N, O, Q is exempt from the duty cycle limit but gets the Table 18 limits listed in section 1 instead. (read in the primary source — EN2 clauses 4.4.3.1 and 4.6.3, same URL)

## 4. UK differences

- Ofcom's IR 2030 is the UK rule book for licence-exempt short-range devices. The current edition is version 1.17, published 23 October 2026. (read in the primary source — IR, https://www.ofcom.org.uk/__data/assets/pdf_file/0028/84970/ir-2030.pdf)
- Version 1.16 (April 2026) was issued "to harmonise UK conditions with CEPT Rec 70-03 published June 2024 and Commission Implementing Decision (EU) 2025/105". So the UK still tracks the EU table after Brexit. (read in the primary source — IR document history, same URL)
- The UK duty cycle definition is word for word the same: single transmitter, one continuous hour, applicable band. (read in the primary source — IR section 3, same URL)

UK rows that I read (read in the primary source — IR Table for non-specific devices, same URL):

| Sub-band (MHz) | IR 2030 entry | Max power (e.r.p.) | Access rule | Same as EU? |
|---|---|---|---|---|
| 863–865 | IR2030/1/13 | 25 mW | Polite techniques, or duty cycle ≤ 0.1% | Yes |
| 865–868 | (row not readable) | — | — | could not verify |
| 868.0–868.6 | IR2030/1/16 | 25 mW | Polite techniques, or duty cycle ≤ 1% | Yes |
| 868.7–869.2 | IR2030/1/17 | 25 mW | Polite techniques, or duty cycle ≤ 0.1% | Yes |
| 869.4–869.65 | IR2030/1/19 | 500 mW | Polite techniques, or duty cycle ≤ 10% | Yes |
| 869.7–870.0 | IR2030/1/20 | 25 mW | Polite techniques, or duty cycle ≤ 1% | Yes |
| 869.7–870.0 | IR2030/1/21 | 5 mW | No duty cycle stated | Yes |
| 868–869.7 | IR2030/1/15 | 25 mW | Polite techniques, or duty cycle 0.1% | Matches the wide REC entry h1.2 in part |
| 869.3–869.4 | IR2030/1/18 | 10 mW | Duty cycle ≤ 10%, channel bandwidth ≤ 25 kHz | UK extra; not in the REC non-specific table |

- The "Same as EU?" column is our comparison with section 1. (our inference)
- The 865–868 MHz, 25 mW, 1% row is missing from the readable text of the PDF. Page 10 starts in the middle of a row (a fragment about 867.4–867.6 MHz, adaptive power control, and 10% / 2.5% duty cycles). The same gap is in Ofcom's December 2022 draft (https://www.ofcom.org.uk/__data/assets/pdf_file/0018/249021/draft-IR-2030_22.pdf). It looks like a table-layout fault, not a policy difference. (read in the primary source — both PDFs; the cause is our inference)
- Whether the UK allows 25 mW at 1% in 865–868 MHz: could not verify. Ask Ofcom or avoid the band in the UK.
- The UK alarm sub-band rows match section 2. (read in the primary source — IR entries IR2030/17/1 to 17/5, https://www.ofcom.org.uk/__data/assets/pdf_file/0028/84970/ir-2030.pdf)
- IR 2030 lists EN 300 220 as the reference standard for all these rows. The reference column is marked "informative". (read in the primary source — IR, same URL)
- For UK conformity, EN 300 220-2 V3.3.1, EN 300 220-3-1 V2.1.1, EN 300 220-3-2 V1.1.1 and EN 303 406 V1.1.1 are designated standards under the Radio Equipment Regulations 2017. EN 300 220-2 V3.1.1 stays designated until 11 June 2027. (read in the primary source — UKDS, https://assets.publishing.service.gov.uk/media/6ae34b8aa5c2f99e3a7b832d/0145_26_Radio_Equipment_Notice_of_Publication.pdf)
- UK marking rules (UKCA versus CE) were not researched here. could not verify.

## 5. What LoRaWAN EU868 does

- Three default channels, mandatory in every device: 868.10, 868.30 and 868.50 MHz, 125 kHz, SF7 to SF12, duty cycle "< 1%". All three sit in 868.0–868.6 MHz. (read in the primary source — RP section 2.4.2 Table 6, https://resources.lora-alliance.org/technical-specifications/rp002-1-0-4-regional-parameters)
- The first downlink window (RX1) uses the same channel as the uplink. (read in the primary source — RP section 2.4.7, same URL)
- The second downlink window (RX2) uses a fixed frequency: "869.525 MHz / DR0 (SF12, 125 kHz)" by default. That is the centre of 869.4–869.65 MHz. (read in the primary source — RP section 2.4.7, same URL)
- The Class B beacon and default ping slot also use 869.525 MHz. (read in the primary source — RP section 2.4.8, same URL)
- LoRaWAN does not use listen-before-talk in Europe: "The current LoRaWAN specification exclusively uses duty-cycled limited transmissions to comply with the ETSI regulations." (read in the primary source — RP section 2.4.2, same URL)
- Default device maximum is +16 dBm e.i.r.p., which is about 14 dBm e.r.p. (read in the primary source — RP section 2.4.3, same URL)
- There is no dwell-time limit in EU863-870. (read in the primary source — RP section 2.4.3, same URL)
- The Things Network lists RX2 at 869.525 MHz and describes 869.4–869.65 MHz as the sub-band that allows 10% at 500 mW e.r.p. (from a secondary source — TTN, https://www.thethingsnetwork.org/docs/lorawan/regional-parameters/eu868/)
- Precedent for us: uplinks in a 1% band at 14 dBm, heavy downlink traffic in the 10% band on one channel at 869.525 MHz, duty cycle rather than listen-before-talk. (our inference)

## 6. Standards a product would be tested against

- The harmonised standard for non-specific devices is ETSI EN 300 220-2. The current version is V3.3.1 (2025-03). (read in the primary source — EN2, https://www.etsi.org/deliver/etsi_en/300200_300299/30022002/03.03.01_60/en_30022002v030301p.pdf)
- V3.3.1 was added to the EU list of harmonised standards by Implementing Decision (EU) 2025/2499. The older V3.1.1 is removed from 11 June 2027. (from a secondary source — HS, https://lawplayer.com/eu/act/32025D2499; the 11 June 2027 date for V3.1.1 is read in the primary source for the UK — UKDS, https://assets.publishing.service.gov.uk/media/6ae34b8aa5c2f99e3a7b832d/0145_26_Radio_Equipment_Notice_of_Publication.pdf)
- V3.3.1 is self-contained. It no longer points to EN 300 220-1 for test methods. (read in the primary source — EN2 change history, same URL as above)
- V3.3.1 has no receiver categories. Older versions had categories 1, 1.5, 2 and 3; category 3 was withdrawn and category 2 became the minimum in V3.2.1. V3.3.1 replaces them with fixed receiver limits for all equipment. (read in the primary source — EN2 foreword and change history, same URL; category definitions read in the primary source — EN1 clause 4.2.5, https://www.etsi.org/deliver/etsi_en/300200_300299/30022001/03.01.01_60/en_30022001v030101p.pdf)
- Receiver limits in V3.3.1 that apply to us (read in the primary source — EN2 clauses 4.5.1 to 4.5.5, same URL):

| Requirement | Limit |
|---|---|
| Sensitivity, not using polite access | −60 dBm or better |
| Sensitivity, using polite access | 10·log10(channel width in kHz) − 117 dBm or better |
| Dynamic range | ≥ 60 dB |
| Blocking at ±2 MHz from channel edge | ≥ −69 dBm |
| Blocking at ±10 MHz, and at ±5% or ±15 MHz | ≥ −44 dBm |
| Spurious response rejection | ≥ −79 dBm at ±2 MHz from channel edges; ≥ −54 dBm further out |
| Adjacent channel selectivity, intermodulation | Only for channelised bands (not ours) |

- Transmitter tests in V3.3.1 include e.r.p., duty cycle, occupied bandwidth, frequency stability, emissions masks at the channel and at the band edge, and spurious emissions. (read in the primary source — EN2 clause 4.4 and table of contents, same URL)
- Alarms in the alarm-only sub-bands are tested against EN 300 220-3-2 (wireless alarms) or EN 300 220-3-1 (social alarms at 869.2–869.25 MHz). (read in the primary source — EN32 title and scope, https://www.etsi.org/deliver/etsi_en/300200_300299/3002200302/01.01.01_60/en_3002200302v010101p.pdf; IR references, https://www.ofcom.org.uk/__data/assets/pdf_file/0028/84970/ir-2030.pdf)
- EN 300 220-3-2 requires receiver blocking "better or equal to category 2". It says category 1 parameters (adjacent channel selectivity, saturation, spurious response) are not required. So even dedicated alarm-band equipment needs only category 2 blocking. (read in the primary source — EN32 clause 4.4.1 and Annex D, same URL)
- Category 1 was described as the level "to be used where the operation of a SRD may have inherent safety of human life implications". Nothing we read makes it mandatory for intruder alarms. (read in the primary source — EN1 Table 1, https://www.etsi.org/deliver/etsi_en/300200_300299/30022001/03.01.01_60/en_30022001v030101p.pdf; the "not mandatory" conclusion is our inference)
- Our product uses non-specific sub-bands, so EN 300 220-2 is the radio standard that applies, not part 3-2. (our inference)
- Intruder alarm product standards add their own radio-link requirements. EN 50131-5-3 covers alarm equipment using radio links and has clauses on immunity to attenuation, collision and interference by grade. The text is paid. Its requirements, and any tie to EN 300 220 receiver performance: could not verify. (existence and scope from a secondary source — catalogue listing, https://standards.iteh.ai/catalog/standards/clc/62c7e3a1-ed67-47c0-9b42-2458d5566a2a/en-50131-5-3-2017)

## Time on air

Formula, from the SX1261/2 datasheet section 6.1.4 (from a secondary source — SX, https://cdn.sparkfun.com/assets/6/b/5/1/4/SX1262_datasheet.pdf):

```
ToA (ms) = (2^SF / BW_kHz) × N_symbol

SF7 to SF12, low-data-rate optimisation off:
N_symbol = N_preamble + 4.25 + 8
         + ceil( max(8×N_bytes + N_crc − 4×SF + 8 + N_header, 0) / (4×SF) ) × (CR + 4)

Low-data-rate optimisation on: the divisor becomes 4×(SF − 2).

N_crc = 16 with CRC on. N_header = 20 with explicit header. CR = 1 for coding rate 4/5.
```

Settings used: BW 125 kHz, CR 4/5 (CR = 1), 8-symbol preamble, explicit header, CRC on, low-data-rate optimisation on for SF11 and SF12 only. The datasheet recommends that optimisation when the symbol time is 16.38 ms or more, which is SF11 and SF12 at 125 kHz. (from a secondary source — SX section 6.1.1.4, same URL)

Worked example, SF7, 16 bytes: numerator = 128 + 16 − 28 + 8 + 20 = 144. 144 / 28 = 5.14, rounded up to 6. 6 × 5 = 30. N_symbol = 8 + 4.25 + 8 + 30 = 50.25. Symbol time = 128 / 125 = 1.024 ms. ToA = 51.5 ms.

All figures below are our calculation. Packets per hour = floor(36 000 ms / ToA) for 1% and floor(360 000 ms / ToA) for 10%.

| SF | Payload (bytes) | Symbol time (ms) | Symbols | Time on air (ms) | Packets/hour at 1% | Packets/hour at 10% |
|---|---|---|---|---|---|---|
| 7 | 16 | 1.024 | 50.25 | 51.5 | 699 | 6 996 |
| 7 | 24 | 1.024 | 60.25 | 61.7 | 583 | 5 835 |
| 7 | 32 | 1.024 | 70.25 | 71.9 | 500 | 5 004 |
| 9 | 16 | 4.096 | 40.25 | 164.9 | 218 | 2 183 |
| 9 | 24 | 4.096 | 50.25 | 205.8 | 174 | 1 749 |
| 9 | 32 | 4.096 | 60.25 | 246.8 | 145 | 1 458 |
| 11 | 16 | 16.384 | 40.25 | 659.5 | 54 | 545 |
| 11 | 24 | 16.384 | 50.25 | 823.3 | 43 | 437 |
| 11 | 32 | 16.384 | 60.25 | 987.1 | 36 | 364 |
| 12 | 16 | 32.768 | 40.25 | 1 318.9 | 27 | 272 |
| 12 | 24 | 32.768 | 45.25 | 1 482.8 | 24 | 242 |
| 12 | 32 | 32.768 | 55.25 | 1 810.4 | 19 | 198 |

What this means for us (our calculation):

- A sensor sends 20 heartbeats an hour. At SF9 with 24 bytes that is 4.1 s, or 0.11%. It fits a 1% band easily. It does not fit a 0.1% band (3.6 s).
- At SF12 with 24 bytes, 20 heartbeats take 29.7 s, or 0.82%. That leaves about 6 s an hour for door events and retries: four more packets. SF12 with a 3-minute heartbeat is at the edge of 1%.
- A gateway that answers every heartbeat with a 16-byte reply at SF9 spends 3.3 s an hour per sensor. A 1% band supports about 10 sensors. The 10% band supports about 109.
- At SF12 the same gateway spends 26.4 s an hour per sensor. A 1% band supports one sensor. The 10% band supports 13.
- Under polite access a single transmission may last 1 s at most. Every SF12 packet in the table breaks that. SF11 with 32 bytes (987 ms) is just inside.

## Recommendation for our channel plan

**Sensor transmissions (door events, heartbeats): 868.0–868.6 MHz.**

- Use 868.1, 868.3 and 868.5 MHz, 125 kHz. This is the LoRaWAN default set, so modules and antennas are tuned for it.
- Power: 14 dBm e.r.p. (25 mW). Set the conducted power so that conducted power plus antenna gain in dBd stays at or below 14 dBm.
- Access: duty cycle, 1% per sensor per hour across the whole sub-band. No listen-before-talk. Enforce the limit in firmware over a rolling hour.
- Keep heartbeats at SF9 or faster where the link allows. Treat SF12 as a fallback and lengthen the heartbeat interval when it is in use.
- Do not use 863–865 or 868.7–869.2 MHz for sensors: 0.1% is too little for a 3-minute heartbeat.
- Do not rely on 865–868 MHz: RFID readers at 2 W share it, and the UK row could not be verified.

**Gateway replies and siren commands: 869.4–869.65 MHz, one channel at 869.525 MHz.**

- Yes, move them there. The gateway gets 360 s an hour instead of 36 s, and its 869.525 MHz airtime is counted separately from anything it sends in 868.0–868.6 MHz.
- Access: duty cycle, 10% per gateway per hour. No listen-before-talk.
- Power: default to 14 dBm e.r.p. A reply is only useful if the sensor's 14 dBm uplink also got through, so more downlink power does not extend the two-way range.
- Allow a higher setting for siren commands and for retries, up to the SX1262's +22 dBm conducted (about 22 dBm e.r.p. with a dipole-gain antenna). That is well under the 27 dBm limit. (SX1262 maximum from a secondary source — SX, https://cdn.sparkfun.com/assets/6/b/5/1/4/SX1262_datasheet.pdf)
- The siren controller's own transmissions (acks, status) can use the same 869.525 MHz channel under its own 10% budget, or the sensor channels under 1%. Either is legal. Using 869.525 MHz keeps the siren on one frequency.
- Sensors must retune from their uplink channel to 869.525 MHz to hear the reply. LoRaWAN's RX2 window does the same.

**Things to design around.**

- 869.525 MHz is a single shared channel. Every LoRaWAN gateway in range sends RX2 downlinks and Class B beacons there, and other 500 mW devices may use it. Expect more collisions than on the sensor channels. Keep replies short and fast (low SF) and make siren commands retry. (our inference)
- With several gateways, each has its own 10% budget, but they still share one channel. Only one gateway should answer a given sensor message. (our inference)
- Do not plan on polite access to escape duty cycle. It caps a channel at about 2.8%, forbids packets over 1 s, adds a tighter receiver sensitivity test, and is not what LoRaWAN precedent uses.
- The alarm-only sub-bands are not available to us at 125 kHz.
- Plan the type test against EN 300 220-2 V3.3.1. Ask the test house early how they will count gateway replies in the duty cycle test.

## Left unverified

1. The adopted text of Implementing Decision (EU) 2025/105 on EUR-Lex. The page returned no text. Band numbers and limits come from an unofficial copy and from CEPT's proposal (Report 85), which agree with each other and with REC and EN2.
2. Whether any later amendment to 2006/771/EC exists after 2025/105.
3. The UK conditions for 865–868 MHz at 25 mW. The row is not readable in Ofcom's IR 2030 PDF (October 2026 edition and December 2022 draft).
4. Whether the one-hour observation period is a fixed hour or a rolling window.
5. How a test house applies the "counted only once" acknowledgement rule to a gateway that replies to many sensors.
6. The official EUR-Lex text of Implementing Decision (EU) 2025/2499 (citation of EN 300 220-2 V3.3.1 and the EU withdrawal date of V3.1.1). Read only in an unofficial copy.
7. EN 50131-5-3 radio-link requirements for intruder alarms, and any receiver performance level it demands. Paid standard, not read.
8. The time-on-air formula was read in a copy of the Semtech datasheet hosted by a distributor, not on semtech.com. Semtech's own site and application note AN1200.13 could not be opened.
9. Whether two 125 kHz channels could pass the band-edge mask inside 869.4–869.65 MHz. Not tested; we assume one channel.
10. National deviations in individual EU countries. REC Appendix 1 lists them; only the general table was read.
11. UK marking and conformity route (UKCA versus CE). Not researched.
12. How busy 869.525 MHz is in practice near our installations. Needs a field measurement.
