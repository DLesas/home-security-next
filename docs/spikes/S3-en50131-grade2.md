# S3: EN 50131 grade 2 desk research

Date: 2026-11-12. Type: desk research from public sources. Nobody bought a standard for this.

## Summary

- **A self-monitored grade 2 system is possible on paper.** The 2017 amendment of EN 50131-1 added notification option E for grade 2. It needs one self-powered siren. Alarm transmission to a receiving centre is optional. In the UK this option (old name "2X") cannot get police response.
- **Our radio timing is well inside the limits.** Grade 2 allows up to 120 minutes between device messages. It blocks setting if nothing was heard for 20 minutes. We send every 3 minutes and flag silence at 9 minutes.
- **Our message security is more than grade 2 asks.** Grade 2 only needs 1,000,000 possible device identity codes. Detecting substituted or replayed messages is mandatory only at grade 4.
- **The radio protocol has no blocker.** It needs small additions: a defined jamming window, a bounded delivery time, and an install mode that cuts the link budget by 8 dB.
- **The board has two blockers.** Wireless grade 2 devices must detect removal from the wall. Housings must need a tool to open. A sliding cover with one switch does neither.
- **The siren has one blocker.** For option E it must be self-powered. Today the battery is optional.
- **The hub has the biggest blocker.** Control equipment needs tamper detection and 12 hours of backup power. Software on a user's own computer has neither. Certification would need a dedicated hub box, or the control function moved into our own hardware.
- **Hub rules need work.** At grade 2 a tamper while set must sound the siren. Faults, tampers, silent devices and jamming must block setting until a user overrides, and the override must be logged. Disarming from the lock screen without any authorisation does not comply.

### What we could read, and how sure we are

| Standard | What we actually read | Gap |
|---|---|---|
| EN 50131-1 (system) | Full English text of EN 50131-1:2006 + A1:2009 + interpretation IS2:2010, as adopted in Ukraine and shown on a third-party site (OCR copy). NSI bulletins on the 2017 (A2) and 2020 (A3) amendments. NSI inspection marking table (2021). | The 2017 and 2020 texts themselves. A3:2020 Annex B (remote access). |
| EN 50131-2-6 (opening contacts) | Full text of the 2008 edition in Ukrainian translation. | Any later edition. |
| EN 50131-3 (control equipment) | Preview pages 1 to 13 of the 2009 edition. Vendor guides. | Almost all requirement tables. A new edition, EN 50131-3:2026, was published this year and we saw none of it. |
| EN 50131-4 (warning devices) | Preview pages of the 2006, 2009 and 2019 editions. NSI marking table. | Standby table for self-powered sirens. 2019 sound table. |
| EN 50131-5-3 (radio) | Preview pages 1 to 9 of the 2017 edition (clauses 4.1 to 4.5). | Clause 4.6 (link monitoring and jamming detection) and the antenna clause. |
| EN 50131-6 (power supplies) | Nothing direct. Power rules come from EN 50131-1 clause 9. | The whole part. |
| EN 50136-1 (alarm transmission) | Full English text of the 2012 edition, same third-party site. | Amendment A1:2018. |
| PD 6662:2017, BS 8243:2021 (UK) | NSI bulletins and marking table only. | The documents themselves. |

Confidence marks:

- **High**: read in the standard text or a preview of it, or several independent sources agree.
- **Medium**: one credible source, or an older edition, or a translation.
- **Low**: one weak source, or sources disagree.

Clause and table numbers are from the 2006 + A1:2009 text unless stated. The 2017 edition deleted old Table 11, so later table numbers are one lower there.

---

## 1. Wireless supervision

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Every link must be checked by periodic messages. Longest allowed gap is 120 minutes. (Grade 1: 240 minutes. Grade 3: 100 seconds. Grade 4: 10 seconds.) | EN 50131-1 clause 8.8.4.1, Table 17 [text][en1-5]. EN 50131-5-3:2017 Table 2 uses the same 120 minute period [preview][rf]. High. NSI says the 2020 amendment changed the wording and format of this table; we did not see the new values [NSI 0054][nsi54]. | Heartbeat every 3 minutes. Silent after 3 misses, about 9 minutes. | Meets | Nothing. Keep the adjustable heartbeat capped. |
| If a link cannot be verified, the system raises a fault when the cause is known. When the cause is not known it raises a tamper or a fault. At grade 2 the maker chooses. Grade 3 and 4 must use tamper. | EN 50131-1 clause 8.8.4.1 and Table 20 [text][en1-5]. High. | A silent sensor sends a phone notification. No siren. | Meets, if we class it as a fault | Record it as an "interconnection fault". Show it. Log it. See the setting rule below. |
| Setting must be prevented if the last message is older than 20 minutes. (Grade 1: 60 minutes. Grade 3: 60 seconds. Grade 4: 10 seconds.) | EN 50131-1 clause 8.8.4.2, Table 18 [text][en1-5]. NSI marking table item J03 confirms 20 minutes for the 2017 edition [NSI 670][nsi670]. Ajax tells installers to keep "ping interval x missed pings" at or under 20 minutes for grade 2 [Ajax][ajax]. High for the number. Sources disagree on scope: the official interpretation and NSI say at least one component must have reported in the window; Ajax applies it to every device [IS2 text][en1-10]. | Every device is heard within 9 minutes or flagged silent. Arming is not blocked by a silent device. | Timing meets. Blocking does not meet. | Hub: refuse to arm while any device is silent, unless a user overrides and the override is logged. Cap settings so heartbeat x misses is at most 20 minutes. |
| The radio channel may be unavailable for at most 100 seconds before a tamper or fault is raised. If the gap between periodic messages is longer than 100 seconds, grade 1 and 2 systems must monitor the channel itself, for example by listening for jamming. | EN 50131-1 clause 8.8.3, Table 16 and its note [text][en1-5]. NSI item F01 confirms 100 seconds for the 2017 edition [NSI 670][nsi670]. High. | Heartbeat is 180 seconds, so channel monitoring is required. The gateway measures noise. "Sustained" has no number yet. | Unclear | Define the detection time. A blocked channel must be reported in under 100 seconds. See section 2. |
| Supervision timing is the same when set and when unset. Only the reaction differs. A fault when set: indication mandatory, outdoor siren not permitted, indoor siren optional. A fault when unset: indication mandatory, no sirens. | EN 50131-1 Table 7 [text][en1-4] and the grade 2 excerpt in the interpretation [IS2 text][en1-9]. High. | Notification only, in both states. | Meets | Nothing for the siren. Indication and log rules apply. |
| A signal must reach its destination within 10 seconds. Notification must start within a further 10 seconds. So 20 seconds at most from door opening to siren. | EN 50131-1 clauses 8.8.1 and 8.9.2 [text][en1-5]. Interpretation [IS2 text][en1-10]. EN 50131-2-6 also gives the contact 10 seconds to send [text, Ukrainian][c26-2]. High. | Door events are acknowledged and retried. No stated upper bound. | Unclear | Firmware: size the retry schedule so delivery finishes inside 10 seconds. Hub to siren must also be inside 10 seconds. |
| A wireless opening contact must be able to send a new intrusion signal within 180 seconds of the last one. (Grade 1: 300. Grade 3: 30. Grade 4: 15.) | EN 50131-2-6:2008 clause 4.4.1 [text, Ukrainian][c26-2]. Medium (translation, one source). | Sensor wakes on every door change. | Meets | Nothing. Do not add a lock-out longer than 180 seconds. |
| With the system at full size, our own traffic may occupy at most 10 % of the channel in any 120 minutes. Receivers must decode 999 of 1,000 messages. Acknowledgement of all messages is required only at grade 3 and 4. | EN 50131-5-3:2017 clauses 4.3.2 and 4.3.3, Tables 2 and 3 [preview][rf]. High. | Not calculated. | Unclear | Calculate airtime for the largest supported system. Test the decode ratio. |
| In install or maintenance mode the equipment must cut the link budget by at least 8 dB, automatically, on every link. (Grade 3 and 4: 15 dB.) Portable devices are exempt. | EN 50131-5-3:2017 clause 4.2, Table 1 [preview][rf]. High. | Not present. | Does not meet | Firmware: an install mode that lowers transmit power (or raises the receive threshold) by 8 dB or more. |
| One vendor blog says the longest supervision gap at grade 2 is 200 seconds, citing "EN 50131-1:2018 clause 8.4.2". | [Roombanker][room]. Low. It conflicts with the standard text above, and we found no 2018 edition. Shown because sources disagree. | 180 seconds. | Meets either way | Nothing. |

## 2. Radio interference and jamming

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Receivers (control equipment, sirens, repeaters, transmission units) must keep working under test interference. Out of band: 10 V/m at two test frequencies. In band: reference level + 8 dB. All 20 test messages must be received. No false alarm and no false "link lost". All grades. | EN 50131-5-3:2017 clause 4.5 [preview][rf]. High. | Not tested. | Unclear | Nothing in the design. A lab test later. |
| The system must detect interference that adds up to more than 30 seconds in any 60 seconds. (Grade 3 and 4: 10 seconds in any 20.) | The clause exists (4.6.4, Tables 5 to 7) but is past the preview [preview][rf]. Numbers from a French installer site [choisir-son-alarme][csa] and from an alarm dealer forum that calls it "EN 30/60" [Surety][surety]. Medium. | Alert on "sustained" interference. No number. | Unclear | Firmware and hub: a sliding 60 second window. Trigger at 30 seconds of blocked channel in total. This also satisfies the 100 second rule in section 1. |
| The interference level that must be detected is the reference signal + 30 dB at grade 2. (Grade 3: + 9 dB.) | [choisir-son-alarme][csa] only. Low. | Gateway measures the noise level. | Unclear | Make the threshold configurable. Relate it to the received level of our own devices. |
| At grade 2 the control equipment receiver must detect interference. For the siren's receiver it is optional. (Grade 3: both.) | [choisir-son-alarme][csa] only. Low. Two vendors disagree: one says jamming detection is only "recommended" at grade 2 [Roombanker][room]; Ajax ties its interference settings to grade 3 [Ajax][ajax]. EN 50131-1 clause 8.8.3 (section 1) still forces channel monitoring at grade 2 when the heartbeat is slower than 100 seconds. | The gateway detects. The siren controller does not. | Meets, probably | Nothing. |
| Reaction at grade 2: a tamper or a fault, maker's choice. If a fault: indication mandatory, outdoor siren not permitted when set, logged as an interconnection fault. | EN 50131-1 Tables 20, 7 and 22 [text][en1-5], [text][en1-4]. The installer site says the same ("fault or tamper" at grade 2) [choisir-son-alarme][csa]. High. | Hub raises an alert. Siren stays quiet. | Meets | Log it as an interconnection fault. |
| An interconnection fault must prevent setting at grade 2. A user may override. | EN 50131-1 Tables 4 and 5 [text][en1-3]. High. | Not specified. | Does not meet | Hub: block arming while jammed, with a logged override. |

## 3. Message security

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Each transmitter must carry an identification code. At least 1,000,000 possible codes. (Grade 1: 100,000. Grade 3: 10,000,000. Grade 4: 100,000,000.) Alternative: the installer can pick from at least 256 codes on site. | EN 50131-5-3:2017 clause 4.4.2, Table 4 [preview][rf]. High. | Per-device AES-128 key. Device identity in each packet. | Meets, if the identity field is 20 bits or more | Confirm the device ID field is at least 20 bits (2^20 = 1,048,576). |
| Detecting substituted components is mandatory only at grade 4. Detecting delayed, modified, substituted or lost messages is mandatory only at grade 4. Optional at grades 1 to 3. | EN 50131-1 Tables 14 and 19 [text][en1-5]. EN 50131-5-3:2017 clause 4.4.3 [preview][rf]. High. | Every packet is encrypted and authenticated. Replay counter. | Meets, with margin | Nothing. |
| If we claim an optional function, it must meet the rules of the grade we claim, or of the higher grade where it is defined. For substitution detection that means detection within 100 seconds (grade 3 figure). | EN 50131-1 A1:2009, addition to clause 6 [text][en1-6]. Table 15 [text][en1-5]. Medium. | A bad or replayed packet is rejected at once. | Meets, probably | Decide whether to claim the function. If yes, raise a tamper or fault on repeated bad packets. |
| No cipher or key length is set for the in-house radio link in the parts we could read. | EN 50131-5-3:2017 pages 1 to 9 [preview][rf]. Medium (we did not see the whole part). | AES-128. | Meets | Nothing. |
| Control devices used outside the protected premises must prevent substitution of the device or its messages. Communication for remote users must meet Annex B of the 2020 amendment. | EN 50131-1 clause 8.7.2 [text][en1-4]. NSI bulletin on A3:2020 [NSI 0054][nsi54]. High that the rule exists. Annex B content not seen. | Phone app through an internet relay. Encrypted. | Unclear | Read Annex B before fixing the app-to-hub security design. |
| For a future alarm transmission path (EN 50136-1): protection against substitution and information security are optional for categories SP1 to SP3 and DP1 to DP2, mandatory from SP4 and DP3. Where used, they must be cryptographic. | EN 50136-1:2012 Tables 8 and 9 [text][atp-3]. High for the 2012 edition. | No alarm transmission system. | Not applicable today | Nothing. |

## 4. Tamper

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Tamper detection is mandatory on control equipment, ancillary control equipment, transmission units, warning devices and power supplies at every grade. It is mandatory on intrusion detectors from grade 2. Portable control devices are exempt. | EN 50131-1 Table 12 as replaced by A1:2009 [text][en1-7]. NSI item D01 [NSI 670][nsi670]. High. | Sensor, gateway and siren controller have a cover switch. The hub is software on a normal computer. | Does not meet (hub) | The control function must live in hardware with a tamper-detecting housing. See the hub list. |
| Opening by normal means must be detected. All grades. For the magnetic switch itself the standard accepts this may be impractical; sealed contacts are exempt. | EN 50131-1 Table 13 [text][en1-7]. EN 50131-2-6 Table 1 [text, Ukrainian][c26-2]. High. | Switch under the cover. | Meets | Nothing. |
| Removal from mounting must be detected on wire-free components at grade 2. (Wired components: optional at grade 2.) This covers wireless detectors and wire-free sirens. | EN 50131-1 Table 13 as replaced by A1:2009 [text][en1-7]. EN 50131-2-6 Table 1 note d [text, Ukrainian][c26-2]. NSI items D02 b and N05 b [NSI 670][nsi670]. Installer site agrees [choisir-son-alarme][csa]. High. | Not detected. | Does not meet | Board and enclosure: a second tamper that trips when the unit leaves the wall. Needed on sensor, siren controller and gateway. |
| Detecting penetration of the housing is mandatory only at grade 4. | EN 50131-1 Table 13 [text][en1-7]. High. | None. | Meets | Nothing. |
| Housings must be robust enough that internal access leaves visible damage or is detected. Normal access must need a tool. Terminals and adjusters must be inside. | EN 50131-1 clause 8.7.1 [text][en1-4]. NSI items C01 and C02 [NSI 670][nsi670]. High. | Sliding cover. | Does not meet, probably | Enclosure: a screw or other tool-only fastening. |
| Resistance to an outside magnet is optional at grade 1 and 2. Mandatory from grade 3. | EN 50131-2-6 Table 1 [text, Ukrainian][c26-2]. Medium. | Plain reed switch. | Meets | Nothing. |
| A tamper lasting more than 400 ms must be processed. A detector must send its tamper within 10 seconds. A siren must send its tamper within 1 second. | EN 50131-1 clause 8.9.1 [text][en1-5]. EN 50131-2-6 clause 4.2 [text, Ukrainian][c26-2]. EN 50131-4:2009 clause 5.1.3 [preview][wd09]. High. | Sensor sleeps between door changes. | Unclear | Firmware: the tamper switch must wake the device. Send at once, with the same acknowledge and retry as a door event. |
| Tamper detection must work both set and unset. | EN 50131-1 clause 8.7.2 [text][en1-4]. High. | Works in both. | Meets | Nothing. |
| Tamper while set: indication mandatory, outdoor siren mandatory, indoor siren mandatory. A transmission system, if present, sends "intruder" or "tamper". | EN 50131-1 Table 7 [text][en1-4] and grade 2 excerpt [IS2 text][en1-9]. High. | Notification only. No siren. | Does not meet | Hub: a tamper while armed starts the full alarm, siren included. |
| Tamper while unset: indication mandatory, outdoor siren not permitted, indoor siren optional. | Same sources. High. | Notification only. | Meets | Nothing. |
| A tamper condition must prevent setting. A user (access level 2) may override at grade 2. A user may also restore after a tamper at grade 2. | EN 50131-1 Tables 4, 5 and 6 [text][en1-3]. High. | Not specified. | Does not meet | Hub: block arming on open tamper, with a logged override. |
| Siren housing: impact rating IK06 indoors, IK07 outdoors at grade 2. A 2.5 mm rod must not reach the inside. Where removal detection is fitted, it must trip within 10 mm. | EN 50131-4:2009 Tables 4 and 5 [preview][wd09]. Removal distance from the 2006 specification [preview][wd06]. Medium (older editions). | Enclosure not chosen. | Unclear | Choose the siren enclosure against these figures. |

## 5. Power

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Three supply types. A: mains plus a battery the system recharges. B: mains plus a battery it does not recharge. C: battery only. | EN 50131-1 clause 9.1 [text][en1-5]. High. | Sensor is type C. Gateway and siren would be type A with the cell fitted. Hub has nothing. | See the rows below | See the rows below. |
| Standby after mains failure: 12 hours for type A, 24 hours for type B. Normal operation must continue, with enough energy left for two separate alarms. | EN 50131-1 clause 9.2, Table 23 [text][en1-5]. UK installer page gives the same 12 and 24 hours [Crosby][crosby]. Installer site gives half a day [choisir-son-alarme][csa]. NSI item M04 points to PD 6662:2017 Table B.1 for the UK [NSI 670][nsi670]. High. | Hub: no battery. Gateway and siren: backup cell optional. | Does not meet | Hub hardware with 12 hours of backup. Backup cell mandatory in gateway and siren, sized for 12 hours plus two alarms. |
| A type A battery must recharge to 80 % within 72 hours. | EN 50131-1 Table 24 [text][en1-5]. High. | Charger not specified. | Unclear | Size the charger. |
| Mains failure must be recognised as a fault and shown. Switching to battery and back must not cause an alarm or change the system state. Telling a receiving centre may wait up to 1 hour. | EN 50131-1 Table 1 [text][en1-2], clause 9.2 [text][en1-5], clause 8.6 [text][en1-4]. NSI items M01 and P06 [NSI 670][nsi670]. High. | No mains-fail detection described. | Does not meet | Board: sense mains (USB) presence. Firmware: report it. Hub: show it. |
| A mains fault and a backup battery fault must each prevent setting at grade 2. A user may override. Logging these two faults is optional at grade 2. | EN 50131-1 Tables 4, 5 and 22 [text][en1-3], [text][en1-5]. High. | Not specified. | Does not meet | Hub rule. |
| A low backup battery must be shown before it can no longer run the system. | EN 50131-1 clause 9.2 [text][en1-5]. High. | Not described for the backup cells. | Unclear | Firmware: report backup cell voltage from gateway and siren. |
| A battery-only device must run for at least 1 year in all conditions of use. It must raise a fault before the voltage is too low to work. | EN 50131-1 clause 9.2 [text][en1-5]. High. | One 18650. Low-battery report. | Meets, if measured life is over 1 year | Prove the 1 year by measurement at the 3 minute heartbeat and at the coldest rated temperature. |
| A dead detector must not go unnoticed. For externally powered contacts, total power loss gives an intrusion signal, unless the control equipment sees it as loss of communication. | EN 50131-2-6 clause 4.6.6 [text, Ukrainian][c26-2]. NSI item S01 [NSI 670][nsi670]. Medium. | A dead sensor stops its heartbeat and is flagged. | Meets | Nothing. |
| The system and its parts must keep working through supply changes: the power supply part must meet EN 50131-6 at the right grade. | EN 50131-1 clause 9.1 [text][en1-5]. High that the rule exists. EN 50131-6 itself not seen. | USB supplies of unknown type. | Unclear | A grade 2 claim needs a supply tested to EN 50131-6. A generic USB charger or desktop UPS is unlikely to qualify. |

## 6. Warning devices

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Option E (and option B) needs one self-powered audible warning device. Self-powered means the power source is inside the device, so it still sounds if its supply is cut. | Table 10 of the 2017 edition as reproduced by NSI [NSI 0040][nsi40]. Definition in EN 50131-4:2019 clause 3.1.10 [preview][wd19] and in the interpretation [IS2 text][en1-10]. High. | Mains powered. Backup cell optional. The sounder is a separate 12 V unit. | Does not meet | Battery mandatory. It must drive the sounder at full level. Controller, battery and sounder in one tamper-protected unit, or a protected link between them. |
| The storage must power at least 10 full sounding periods, or 30 minutes of sound, whichever is shorter. | NSI item N07, citing EN 50131-4 clause 5.6.3.1 [NSI 670][nsi670]. Medium. | One 18650 feeding a 12 V sounder. Not calculated. | Unclear | Size the cell and boost converter. |
| The storage must also hold the device in standby for a set time. The times are in a table of EN 50131-4 by device type (W, X, Y, Z). | NSI item N08 [NSI 670][nsi670]. Type table referenced in the preview [preview][wd19]. Values not found. Low. | Unknown. | Unclear | Buy EN 50131-4 before sizing the siren battery. |
| If remote power is lost, a grade 2 self-powered siren must do at least one of: sound, send a tamper, send a fault. Within 10 seconds. | EN 50131-4:2019 Table 2 note b [preview][wd19]. EN 50131-4:2009 clause 5.1.3 [preview][wd09]. NSI item N10 [NSI 670][nsi670]. High. | Not described. | Does not meet | Firmware: siren controller reports mains loss as a fault within 10 seconds. |
| Functions at grade 2, self-powered: respond to trigger (mandatory), tamper output (mandatory), monitor remote power (mandatory when it has a remote supply). Optional at grade 2: fault output, local self-test, monitoring of the trigger link. | EN 50131-4:2019 Table 1 [preview][wd19]. High. | Trigger and cover tamper exist. | Meets in part | Add the remote power monitor above. |
| Sound level at 1 m: outdoor device at least 100 dB(A) mean, no single reading under 95. Indoor device at least 80 dB(A) mean, none under 75. The sound must vary. | EN 50131-4:2009 Table 3 [preview][wd09]. Ajax quotes 80 dB and 100 dB [Ajax][ajax]. High for 2009; the 2019 table is past the preview. | Separate 12 V sounder, not chosen. | Unclear | Pick a sounder with measured data to this method. |
| Sounding time: at least 90 seconds, at most 15 minutes, or less where local rules say so. | EN 50131-1 clause 8.6 [text][en1-4]. EN 50131-4:2009 clause 5.1.3 [preview][wd09]. NSI items P03 and N03 b [NSI 670][nsi670]. Ajax [Ajax][ajax]. High. | 5 minutes by default. Stops by itself. | Meets | Limit the setting to 90 seconds to 15 minutes. Keep the self-stop in the siren firmware. |
| Start within 1 second of the trigger. Stop within 1 second of the cancel. | EN 50131-4:2009 clause 5.1.3 [preview][wd09]. High for 2009. | Radio command. Latency not specified. | Unclear | Measure it. The siren receiver must always listen. |
| With no alarm transmission system the siren must not be delayed. (With one, a delay up to 10 minutes is allowed.) | EN 50131-1 clause 8.6 [text][en1-4]. NSI item P04 [NSI 670][nsi670]. High. | Sounds at once after any entry delay. | Meets | Nothing. |
| The outdoor siren must not be started by the control equipment when unset. It may start itself on its own tamper or on loss of its link. | EN 50131-1 Table 7, note 5 [text][en1-4]. High. | Siren only sounds on alarm. | Meets | Keep it so when tamper-to-siren is added (section 4). |
| A siren fault must be recognised. It may be inferred from a missed periodic message. It prevents setting and is logged at grade 2. | EN 50131-1 Table 1 and its note [text][en1-2]. Tables 4 and 22 [text][en1-3], [text][en1-5]. High. | Siren reports every 30 seconds. | Detection meets. Hub rules missing. | Hub: block arming on siren fault. Log it. |
| UK practice: councils expect an automatic cut-out after 20 minutes. The 1982 code behind this was withdrawn in 2014 but its guidance still stands. | [GOV.UK][govuk]. [Epsom and Ewell council][council]. Medium. | 5 minutes. | Meets | Nothing. The 15 minute EN limit is stricter. |

## 7. Setting and unsetting

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Four access levels. Level 1: anyone, no control. Level 2: user; may set, unset, restore, inhibit, override, read the log. Level 3: installer; changes configuration; needs a level 2 user's permission. Level 4: manufacturer; changes the program; needs level 2 and 3 permission. | EN 50131-1 clause 8.3.1, Table 2 [text][en1-2], updated by A1:2009 [text][en1-6]. High. | App users. No roles described. | Unclear | Hub and app: separate user, installer and firmware-update roles. A user must approve installer access and updates. |
| Authorisation strength: at least 10,000 combinations for a code or other logical key. 3,000 for a physical key. Setting alone may use the grade 1 figure of 1,000. Other means, such as biometrics, are not excluded. | EN 50131-1 clause 8.3.2, Table 3, and clause 8.3.4 [text][en1-2], [text][en1-3]. Interpretation [IS2 text][en1-8]. High. | App login. Disarm button on the lock screen works without unlocking the phone. | Does not meet (lock-screen disarm) | App: disarm must need the phone unlocked, a biometric, or a PIN of 4 digits or more. Arming needs authorisation too, at the lower strength. |
| Repeated wrong authorisation attempts must be detected or restricted, from grade 2. Vendors implement this as a lock of at least 90 seconds after 3 wrong codes. One blog says 5. | 2020 amendment clause 8.3.2 [NSI 0054][nsi54]. EN 50131-3:2009 has a table for it (Table 4) that we could not read [preview][cie09]. Ajax [Ajax][ajax]. EBS panel manual [EBS][ebs]. [Roombanker][room]. High that a limit is required. Medium for 90 seconds. Low for the count. | Not specified. | Unclear | Hub and app: lock out for 90 seconds or more after a few failed attempts. Log it. |
| A phone can be the means. The 2020 amendment says the operating rules apply whether access is at the equipment or remote, "e.g. via a smart phone". Remote access needs authorisation equal to the table above. The remote link must meet Annex B. All mandatory indications must be available to the remote user. | [NSI 0054][nsi54]. The 2006 text already allowed remote access with equal authorisation [text][en1-2]. NSI item H02 c [NSI 670][nsi670]. High that it is allowed. Annex B not seen. | Phone app and web app are the only means. | Meets in principle. Details unclear. | Read Annex B. Show every mandatory indication in the app (section 8 lists them). |
| One maker's evidence: the app asks for a user code and an app password, which it treats as level 2. The app times out after 5 minutes idle. | Pyronix compliance statement, seen only as a search excerpt [Pyronix][pyro]. Low. | No idle timeout described. | Unclear | App: idle timeout. |
| All mandatory indications must be together on at least one control or ancillary control unit. | EN 50131-1 clause 8.5.1 [text][en1-4]. 2017 wording via NSI [NSI 0040][nsi40]. High that the rule exists. Whether an app alone satisfies it: not established. | No keypad. Web app at home. | Unclear | May need one fixed indicator or panel in the home. Ask a test house. |
| Entry: at most 45 seconds to finish unsetting. An entry indication must run during that time. If time runs out, alarm. Completion of unsetting is shown for at most 30 seconds. Unsetting from outside, with no entry time, is also permitted. | EN 50131-1 clause 8.3.8.2 [text][en1-3]. NSI item J16 [NSI 670][nsi670]. Ajax [Ajax][ajax]. High. | 30 seconds default per sensor. Zero allowed. No stated maximum. No entry sound described. | Meets on default. Unclear on maximum and indication. | Cap entry delay at 45 seconds. Give an entry indication (siren controller beep or similar). |
| An alarm during the entry time must be signalled locally. Any message to a receiving centre must wait until the local signal has run 30 seconds and the entry time has ended. | EN 50131-1 clause 8.3.8.2 as amended [text][en1-7]. NSI item J16 d [NSI 670][nsi670]. High. | No receiving centre. | Not applicable today | Keep in mind for a later transmission path. |
| Exit: EN 50131-1 sets no exit time. It needs an authorised action, everything in a normal state, and a time-limited "setting complete" indication. | EN 50131-1 clauses 8.3.4 and 8.3.7 [text][en1-3]. NSI item J08 [NSI 670][nsi670]. High for the 2006 + A1 text. The 2020 edition now refers to CLC/TS 50131-12 for setting methods, which we have not seen [NSI 0054][nsi54]. | No exit delay. App shows the state. | Meets, probably | Confirm against CLC/TS 50131-12. |
| UK only, and only for confirmed-alarm systems (BS 8243:2021, PD 6662:2017 Annex A.5): setting from a remote device needs a timed setting period of 30 to 60 seconds with an audible warning through the premises. People inside must be able to cancel. Setting is cancelled if a detector is active. Remote set, unset, failure and errors are logged with user and device. | NSI item J28 [NSI 670][nsi670]. [NSI 0059][nsi59]. [NSI 0040][nsi40]. Trade press on the 2015 industry agreement [Professional Security][ia1501]. Medium. | No exit delay. No warning sound. | Does not meet. Matters only if we later want UK police response. | Optional mode: 30 to 60 second timed setting with siren-controller beeps and a cancel action. |
| While set, grade 1 and 2 must do one of: prevent entry, or start an entry procedure when the entry door opens, or show the set/unset status. | EN 50131-1 clause 8.3.7 [text][en1-3]. High. | Entry delay per sensor. | Meets | Nothing. |
| Setting must be prevented at grade 2 when any of these is present: an active (open) detector, unless on the agreed exit route; a detector fault; a tamper; an interconnection fault; a mains fault; a backup battery fault; a transmission fault; a siren fault; other faults. | EN 50131-1 clause 8.3.5, Table 4 [text][en1-3]. NSI item J02 [NSI 670][nsi670]. High. | Only an open door is handled. | Does not meet | Hub: one "ready to set" check that covers the whole list. |
| A user (level 2) may override every one of these at grade 2. The override lasts for that set period only. It must be logged. It is not allowed if it would cause an alarm. | EN 50131-1 clause 8.3.6, Table 5 [text][en1-3]. NSI item J04 [NSI 670][nsi670]. High. | User confirms arming with a door open. The door arms when it closes. | Meets for a person arming, once logged. Unclear for schedules. | Log each override with user and device. For schedules there is no person to override: fail the scheduled set and notify, unless a test house accepts a stored user decision. |
| Automatic setting and unsetting at set times is foreseen (EN 50131-3 has a test for it). | Table 26 title in the contents of EN 50131-3:2009 [preview][cie09]. Low: we saw the title only. | Schedules. | Unclear | Read EN 50131-3 (2009 and 2026) for the conditions. |
| What a person without authorisation may see: while set, an alert indication is not permitted, and set/unset status is optional at grade 2. Detail belongs to authorised users. | EN 50131-1 Table 9 [text][en1-7]. High for the table. Its application to phone notifications is our reading. | Notifications show on the lock screen. | Unclear | App option: hide detail until the phone is unlocked. |

## 8. Event log

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Room for at least 250 mandatory events. (Grade 3: 500. Grade 4: 1,000.) Optional events must not push mandatory ones out. | EN 50131-1 clause 8.10, Table 21 [text][en1-5]. Interpretation [IS2 text][en1-10]. Ajax [Ajax][ajax]. High. | One year of history on disk. | Meets | Nothing. |
| The log must survive 30 days with no power. | EN 50131-1 Table 21 [text][en1-5]. High. | On disk. | Meets | Nothing. |
| No retention time is set. When full, the oldest events may be overwritten. | EN 50131-1 clause 8.10 [text][en1-5]. High. | One year. | Meets | Nothing. |
| Each event carries date and time at grade 2. The clock may drift at most 10 minutes a year. | EN 50131-1 clause 8.10 [text][en1-5]. NSI items K01 b and K02 [NSI 670][nsi670]. High. | Computer clock. | Meets | Log clock changes (optional at grade 2). |
| The log must be protected against accidental or deliberate deletion or change. Users must have no way to delete records. Reading it needs level 2. | EN 50131-1 clause 8.10 and Table 2 [text][en1-5], [text][en1-2]. Interpretation [IS2 text][en1-10]. NSI item K01 d [NSI 670][nsi670]. High. | A database on the user's own computer. The owner can edit or delete it. | Does not meet | Append-only log with no delete in the app. Tamper-evident chaining helps. Real protection needs hardware the user cannot casually open. |
| Events from one source are limited to at least 3 and at most 10 in each set or unset period. | EN 50131-1 clause 8.10 [text][en1-5]. Interpretation [IS2 text][en1-10]. Ajax [Ajax][ajax]. High. | No limit. | Does not meet | Hub: count per source and event type. Stop logging repeats after a set number between 3 and 10. Reset on set and unset. |
| Mandatory at grade 2: set and part set; unset; intruder alarm; tamper; zone or detector inhibited; isolated; interconnection fault; transmission fault; siren fault; override of a prevention of setting; first detector to alarm; zone or detector overridden; users added or removed. | EN 50131-1 Table 22 [text][en1-5]. NSI item K01 a [NSI 670][nsi670]. High. | "Event history". Content not specified. | Unclear | Hub: make sure each of these is a distinct logged event. Also log the end of each condition (recommended). |
| Optional at grade 2: who set or unset; zone identity; detector fault; mains fault; backup fault; battery change needed; clock changes; configuration changes. | EN 50131-1 Table 22 [text][en1-5]. High. | Not specified. | Meets | Worth logging anyway. Several become mandatory at grade 3. |
| 2020 amendment: the log must show that an event came from remote access and who the remote user was. Rejected attempts to open remote communication are a new event. | [NSI 0054][nsi54]. High. | Not specified. | Unclear | Hub: log user and device for every app action. Log rejected app connections. |
| The log lives in the system. A remote copy is allowed in addition. Events waiting to be sent must be stored. | EN 50131-1 clause 8.10 [text][en1-5]. Interpretation [IS2 text][en1-10]. High. | Local. | Meets | Nothing. |

## 9. Notification options and self-monitoring

Grade 2 options in Table 10 of EN 50131-1:2006 + A2:2017, as reproduced by NSI ([NSI 0040][nsi40], high):

| Option | Remotely powered sirens | Self-powered sirens | Alarm transmission system |
|---|---|---|---|
| A | 2 | optional | SP2 |
| B | optional | 1 | SP2 |
| C | optional | optional | DP1 |
| D | optional | optional | SP3 |
| E | optional | 1 | optional |
| F | optional | optional | DP2 |

SP and DP are the single-path and dual-path categories of EN 50136-1.

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| The system must meet at least one option in the table. | EN 50131-1 clause 8.6 [text][en1-4]. NSI item P01 [NSI 670][nsi670]. High. | Siren plus phone push. | See next rows | See next rows. |
| Option E is the siren-only option. One self-powered siren. No transmission system needed. It was added in 2017 and replaces the UK's old "2X". | [NSI 0040][nsi40]. [NSI monitoring note][nsimon]. High. | Siren is mains powered with an optional cell. | Does not meet yet | Make the siren self-powered and compliant with EN 50131-4 grade 2 (section 6). Then a self-monitored system fits option E. |
| Before 2017 there was no siren-only option at grade 2 in the EN. Every option needed a transmission system. | EN 50131-1:2006 + A1:2009 Table 10 [text][en1-4]. A panel manual of that era says it supports options A, B and C of that table [Abus][abus]. High. | Not relevant. | Note | Certify against the 2017 or later edition. |
| Phone push is not an "alarm transmission system". That term means transfer to an alarm receiving centre. | Definition in EN 50131-1 A1:2009 [text][en1-6]. Scope of EN 50136-1 [text][atp-1]. High. | Encrypted push through a relay to phones. | Cannot count toward options A, B, C, D or F | Nothing. Describe it as an extra. |
| Extra means of notification are allowed if they do not harm the mandatory ones. | EN 50131-1 clause 8.6 [text][en1-4]. NSI item P01 [NSI 670][nsi670]. High. | Push runs beside the siren. | Meets | The siren must not depend on the internet or the relay. |
| UK: grade 1 systems and grade 2 option E systems must not be used to call police. | [NSI 0040][nsi40]. High. | No police response wanted. | Meets | Insurers may still ask for a monitored option. That would mean option B, C, D or F. |
| If a transmission path is added later, SP2 needs: mean delivery 60 seconds, 95 % within 90 seconds, never over 120 seconds; path failure reported within 25 hours. SP3: 20, 30, 60 seconds and 30 minutes. DP1: 25 hours on the main path, 50 hours overall. | EN 50136-1:2012 Tables 2 and 3 [text][atp-2]. High for 2012. | Relay tells phones the hub is unreachable after 3 minutes. | Timing would meet SP2 and SP3. Not a compliant system today. | Nothing now. Keep a clean interface where a certified transmission unit could attach later. |
| With a transmission system: a transmission fault must be recognised, shown, logged, and must prevent setting. | EN 50131-1 Tables 1, 4, 22 [text][en1-2], [text][en1-3], [text][en1-5]. High. | No such system. | Not applicable | Nothing now. |
| With option E nothing is required when the internet is lost. | Follows from the table: transmission is optional [NSI 0040][nsi40]. High. | Phones are told after 3 minutes. | Meets, with margin | Nothing. |

## 10. Environmental classes

| Requirement (grade 2) | Source and confidence | Our design | Verdict | What would have to change |
|---|---|---|---|---|
| Four classes. I: indoor, +5 to +40 °C. II: indoor general, -10 to +40 °C. III: outdoor sheltered or indoor extreme, -25 to +50 °C. IV: outdoor general, -25 to +60 °C. Humidity averages about 75 %; classes III and IV see 85 to 95 % for 30 days a year. A higher class may be used in a lower one. The class does not depend on the grade. | EN 50131-1 clause 7 and clause 11 [text][en1-2], [text][en1-6]. UK installer page lists the same four classes [Crosby][crosby]. High. | Not classified. | Unclear | Decide a class per product. |
| Denmark, Finland, Norway and Sweden: class IV goes down to -40 °C. | EN 50131-1 Annex A [text][en1-6]. High. | Not considered. | Unclear | Only if we sell an exposed outdoor unit there. |
| A sensor on the outside of a door is class III if sheltered (porch, covered entrance) and class IV if exposed to weather. | Follows from the class definitions [text][en1-2]. High. | "Outdoor door sensor" with an 18650. | Unclear | Declare class III or IV and design to it. |
| Tests for opening contacts. All classes: dry heat, cold, impact, vibration, EMC. Classes II to IV add cyclic damp heat and sulphur dioxide corrosion. Classes III and IV add water ingress and a damp heat endurance cycle. Methods are in EN 50130-5; EMC in EN 50130-4. | EN 50131-2-6:2008 Tables 4 and 5 [text, Ukrainian][c26-4]. Medium. | Not designed for this. | Unclear | Sealed enclosure, gasket, coated board. The tamper switches must survive the same tests. |
| Every component is marked with its grade and class. | EN 50131-1 clause 15 [text][en1-6]. High. | No marking. | Does not meet yet | Label design, later. |
| EN 50131-1 covers systems in buildings, including parts on the outside of the building. It has no rules for exterior systems. | Scope as quoted by NSI [NSI 0054][nsi54]. High. | Gates and sheds may be in view. | Unclear | A sensor on a garden gate is outside the standard. One on the house's own outer door is inside it. |
| Application guidance: magnetic contacts should sit inside the supervised premises. Parts outside need suitable tamper protection. | NSI item S05, citing CLC/TS 50131-7 [NSI 670][nsi670]. EN 50131-1 clause 8.7.1 [text][en1-4]. Medium. | Sensor may be fitted outdoors. | Unclear | Recommend fitting on the inside face of the door. Treat true outdoor fitting as outside the graded system. |
| No IP rating number for detectors was found. The siren standard refers to the IP code (EN 60529) and impact code (EN 62262). | EN 50131-4:2019 normative references [preview][wd19]. Low. | None. | Unclear | Buy EN 50130-5 and the product parts before fixing an IP target. |

Our own engineering note, not from a source: ordinary lithium-ion cells lose capacity in the cold and should not be charged below freezing. The 1 year battery rule in section 5 has to hold at the lowest temperature of the declared class.

---

## Changes that touch the radio protocol or device firmware timing

1. **Jamming window.** Detect a blocked channel when blocking adds up to 30 seconds in any 60 seconds. Report it well inside 100 seconds. (Sections 1 and 2.)
2. **Bounded delivery.** Door, tamper and fault messages must arrive within 10 seconds, retries included. Hub to siren also within 10 seconds. (Section 1.)
3. **Install mode.** Cut the link budget by 8 dB or more on every link while in install or maintenance mode. (Section 1.)
4. **Heartbeat limits.** Cap the adjustable settings so heartbeat x allowed misses stays at or under 20 minutes. The hard ceiling is 120 minutes. (Section 1.)
5. **Tamper as a wake source.** Both tamper switches wake the sensor and send at once, with acknowledge and retry. Siren tamper within 1 second. (Section 4.)
6. **Identity field.** Confirm the device ID is at least 20 bits. (Section 3.)
7. **Channel occupation.** Calculate our airtime for the largest system. It must stay under 10 % in any 120 minutes. Check 999 of 1,000 decode. (Section 1.)
8. **Mains and backup reporting.** Gateway and siren report mains loss and low backup cell. Siren within 10 seconds of mains loss. (Sections 5 and 6.)
9. **Siren timing.** Start and stop within 1 second of the command. Keep the self-stop. Allowed range 90 seconds to 15 minutes. (Section 6.)
10. **No long lock-out.** Never suppress a new door event for more than 180 seconds. (Section 1.)
11. **Optional: entry and setting beeps.** An entry indication, and for the UK a 30 to 60 second setting warning, from the siren controller. (Section 7.)

Nothing found requires a change to the encryption, the authentication or the replay counter.

## Changes that touch the board hardware

1. **Removal-from-wall tamper.** A second tamper input and switch on the shared board, for sensor, siren controller and gateway. (Section 4.)
2. **Tool-only opening.** Replace the plain sliding cover with a screw or similar fastening. (Section 4.)
3. **Mains-present sense.** A way for gateway and siren boards to see that USB power is gone. (Section 5.)
4. **Backup cell mandatory on gateway and siren.** Sized for 12 hours plus two alarms. Recharge to 80 % in 72 hours. Voltage monitoring. (Section 5.)
5. **Self-powered siren.** The cell must drive the 12 V sounder at full level: 10 sounding periods or 30 minutes. Boost stage sized for that. Sounder, controller and cell in one protected unit. (Section 6.)
6. **Sounder choice.** At least 100 dB(A) mean at 1 m outdoors, 80 dB(A) indoors, measured to the standard's method. Housing IK07 outdoors, IK06 indoors. (Sections 4 and 6.)
7. **Outdoor variant.** Sealed enclosure and coated board for class III or IV. Cell choice checked at -25 °C. (Section 10.)
8. **Spare input for a fixed indicator.** In case a test house wants indications on a fixed unit in the home. (Section 7.)

## Changes that touch the hub or app

1. **Where the hub runs.** For certification the control function needs tamper-protected hardware with 12 hours of backup and a protected log. Keep the hub software portable to a dedicated box. This is the largest open point. (Sections 4, 5, 8.)
2. **Tamper while set sounds the siren.** Tamper while unset stays quiet outdoors. (Section 4.)
3. **Ready-to-set check.** Block setting on: open detector, detector fault, tamper, silent device, jamming, mains fault, backup fault, siren fault. Allow a user override. Log every override with user and device. (Section 7.)
4. **Schedules.** A scheduled set that hits a blocking condition fails and notifies. (Section 7.)
5. **No unauthorised disarm.** The lock-screen Disarm button must require unlock, biometric or PIN. 10,000 combinations or more. (Section 7.)
6. **Attempt limiting.** Lock out for 90 seconds or more after a few failed authorisations. (Section 7.)
7. **Roles.** User, installer and firmware-update levels, with user approval for the last two. (Section 7.)
8. **Entry delay.** Cap at 45 seconds. Zero stays allowed. (Section 7.)
9. **Siren duration setting.** Limit to 90 seconds to 15 minutes. (Section 6.)
10. **Fault classes.** Treat silent device and jamming as interconnection faults. Treat mains and backup problems as power faults. Show each in the app. (Sections 1, 2, 5.)
11. **Event log.** Append-only. No delete. Named events as listed in section 8. Per-source repeat limit of 3 to 10 per set or unset period. User and device on every remote action. Rejected connections logged. (Section 8.)
12. **Indications.** All mandatory indications available in the app. Option to hide detail on the lock screen. Idle timeout. (Section 7.)
13. **UK optional mode.** Timed setting of 30 to 60 seconds with warning and cancel, for a later BS 8243 system. (Section 7.)
14. **Later transmission path.** Keep an interface where a certified transmission unit could attach. (Section 9.)

## What could not be established without buying the standards

1. **EN 50131-5-3:2017 clause 4.6 and Tables 5 to 7.** The exact jamming detection times, levels and which receivers must detect. Our figures come from two secondary sources. Also the "periodic communication before setting" clause for radio links, and the antenna clause (Table 8).
2. **Scope of the 20 minute rule.** Whether every device, or only at least one, must have reported within 20 minutes before setting. Sources disagree.
3. **EN 50131-1:2006 + A3:2020 full text.** Whether the supervision tables kept their values after being reworded. The whole of Annex B (remote access) and Annex C (cyber threats). The "coerciveness principle" clause 8.8.2.2.
4. **EN 50131-3 (2009 and the new 2026 edition).** The table on invalid authorisation attempts (count and lock time). Rules for automatic setting at set times. Rules for ancillary control equipment types and whether a phone app alone can carry the mandatory indications. Extra log events. Processing monitoring. What changed in 2026.
5. **CLC/TS 50131-12:2016.** Methods of setting and unsetting. Now referenced by EN 50131-1. Any exit-time rule would be here.
6. **EN 50131-4:2019.** Standby time table for self-powered sirens by type (W, X, Y, Z). Whether the 2019 sound levels and tamper tables match 2009. Removal-from-mounting rule for a radio-linked siren in its own words.
7. **EN 50131-6:2017 + A1:2021.** Everything: low-voltage thresholds, monitoring, whether a separate commercial supply or UPS can form part of a graded system.
8. **EN 50131-2-6.** Whether a later edition changed the 2008 requirements we read in translation.
9. **EN 50130-5 and EN 50130-4.** Actual test severities for classes III and IV. Any IP rating.
10. **PD 6662:2017 Annex A.5 and BS 8243:2021 clause 6.3.2.** The full conditions for phone setting and unsetting in the UK. We have only the NSI inspection wording.
11. **Whether a software hub on a general-purpose computer can ever be certified.** No source addressed it. The tamper, power and log rules suggest not.
12. **Whether a siren made of a controller plus a separate sounder can count as one self-powered warning device.**
13. **National deviations outside the UK** (for example VdS in Germany, NF&A2P in France, INCERT in Belgium, SSF in Sweden). Not researched.
14. **EN 50136-1 A1:2018.** Whether it changed the SP2 and SP3 figures.

## Sources

Standard texts and previews:

- [en1-2] to [en1-10]: EN 50131-1:2006 + A1:2009 + IS2:2010, English text as adopted in Ukraine (DSTU EN 50131-1:2014), OCR copy on a third-party site. Pages: https://dnaop.com/html/61223_2.html , https://dnaop.com/html/61223_3.html , https://dnaop.com/html/61223_4.html , https://dnaop.com/html/61223_5.html , https://dnaop.com/html/61223_6.html , https://dnaop.com/html/61223_7.html , https://dnaop.com/html/61223_8.html , https://dnaop.com/html/61223_9.html , https://dnaop.com/html/61223_10.html
- [c26-2], [c26-4]: EN 50131-2-6:2008 in Ukrainian translation (DSTU EN 50131-2-6:2012). https://dnaop.com/html/62607_2.html , https://dnaop.com/html/62607_4.html
- [atp-1] to [atp-3]: EN 50136-1:2012, English text (DSTU EN 50136-1:2014). https://dnaop.com/html/62154_1.html , https://dnaop.com/html/62154_2.html , https://dnaop.com/html/62154_3.html
- [rf]: EN 50131-5-3:2017 preview, pages 1 to 9. https://cdn.standards.iteh.ai/samples/58812/ddc39e697ce4448ca5509c2af3ba4a80/SIST-EN-50131-5-3-2017.pdf
- [wd19]: EN 50131-4:2019 preview. https://cdn.standards.iteh.ai/samples/63563/52ff765c19aa443f81cad169cbe9105f/SIST-EN-50131-4-2019.pdf
- [wd09]: EN 50131-4:2009 preview. https://cdn.standards.iteh.ai/samples/20898/1ea4295dd0bc43388e3d1e76b9c45473/SIST-EN-50131-4-2009.pdf
- [wd06]: CLC/TS 50131-4:2006 preview. https://cdn.standards.iteh.ai/samples/2482/6d821c7f3d7641a5bdf8d77e97243274/SIST-TS-CLC-TS-50131-4-2007.pdf
- [cie09]: EN 50131-3:2009 preview. https://cdn.standards.iteh.ai/samples/20900/716256251afb4f44a773141e7dc32c09/SIST-EN-50131-3-2009.pdf
- EN 50131-3:2026 catalogue entry (existence only). https://genorma.com/en/standards/en-50131-3-2026

Inspectorate (NSI, UK):

- [nsi40]: Technical Bulletin 0040, PD 6662:2017 and EN 50131-1 A2:2017, with Table 10. https://members.nsi.org.uk/document/nsi-technical-bulletin-no-0040-pd-6662-2017/
- [nsi54]: Technical Bulletin 0054, EN 50131-1 A3:2020. https://members.nsi.org.uk/document/nsi-technical-bulletin-0054-publication-of-bs-en-50131-1-a3_2020/
- [nsi59]: Technical Bulletin 0059, BS 8243:2021. https://members.nsi.org.uk/document/nsi-technical-bulletin-no-0059-publication-of-bs-8243_2021/
- [nsi670]: NSF 670.7 marking table for PD 6662:2017 and BS 8243:2021 (August 2021). https://members.nsi.org.uk/document/nsf-670-7-marking-table-for-pd-6662-2017-bs-8243_2021-alarms-aug-2021/
- [nsimon]: Selection and configuration of monitoring options under PD 6662:2017. https://members.nsi.org.uk/document/selection-and-configuration-of-monitoring-options-for-an-intruder-and-hold-up-alarm-system-in-line-with-the-requirements-of-pd-666-22017/

Manufacturers, installers, other:

- [ajax]: Ajax, how to configure a system to EN 50131. https://ajax.systems/support/posts/configure-according-en-requirements/
- [csa]: choisir-son-alarme.tech, standards and certifications (installer site). https://choisir-son-alarme.tech/en/standards-and-certifications/
- [surety]: Surety forum, PowerG jam detection ("EN 30/60"). https://support.suretyhome.com/t/qolsys-firmware-2-5-powerg-jam-detection/9771/2
- [ebs]: EBS CPX200NB manual, grade 2 behaviour. https://www.manualslib.com/manual/1594500/Ebs-Cpx200nb.html?page=93
- [abus]: Abus Secvest manual, EN 50131 statement. https://www.manualslib.com/manual/1918318/Abus-Secvest.html?page=292
- [pyro]: Pyronix HomeControl, evidence of compliance with EN 50131-3:2009 Annex C (seen as a search excerpt only). https://pyronix.com/downloads/homecontrol-evidence-of-compliance-to-bsen50131-32009-annex-c
- [room]: Roombanker, grade 2 wireless compliance guide (vendor blog). https://www.roombanker.com/blog/en50131-grade2-wireless-compliance-guide/
- [crosby]: Crosby Intruder, European standards. https://www.crosbyintruder.co.uk/european-standards/
- [ia1501]: Professional Security, industry agreement on PD 6662 (2015). https://professionalsecurity.co.uk/products/alarms/industry-agreement-on-pd-6662/
- [govuk]: GOV.UK, Code of practice on noise from audible intruder alarms 1982 (withdrawn 2014). https://www.gov.uk/government/publications/code-of-practice-on-noise-from-audible-intruder-alarms-1982
- [council]: Epsom and Ewell Borough Council, intruder alarms. https://www.epsom-ewell.gov.uk/residents/environmental-services/noise-nuisance-pollution/intruder-alarms

[en1-2]: https://dnaop.com/html/61223_2.html
[en1-3]: https://dnaop.com/html/61223_3.html
[en1-4]: https://dnaop.com/html/61223_4.html
[en1-5]: https://dnaop.com/html/61223_5.html
[en1-6]: https://dnaop.com/html/61223_6.html
[en1-7]: https://dnaop.com/html/61223_7.html
[en1-8]: https://dnaop.com/html/61223_8.html
[en1-9]: https://dnaop.com/html/61223_9.html
[en1-10]: https://dnaop.com/html/61223_10.html
[c26-2]: https://dnaop.com/html/62607_2.html
[c26-4]: https://dnaop.com/html/62607_4.html
[atp-1]: https://dnaop.com/html/62154_1.html
[atp-2]: https://dnaop.com/html/62154_2.html
[atp-3]: https://dnaop.com/html/62154_3.html
[rf]: https://cdn.standards.iteh.ai/samples/58812/ddc39e697ce4448ca5509c2af3ba4a80/SIST-EN-50131-5-3-2017.pdf
[wd19]: https://cdn.standards.iteh.ai/samples/63563/52ff765c19aa443f81cad169cbe9105f/SIST-EN-50131-4-2019.pdf
[wd09]: https://cdn.standards.iteh.ai/samples/20898/1ea4295dd0bc43388e3d1e76b9c45473/SIST-EN-50131-4-2009.pdf
[wd06]: https://cdn.standards.iteh.ai/samples/2482/6d821c7f3d7641a5bdf8d77e97243274/SIST-TS-CLC-TS-50131-4-2007.pdf
[cie09]: https://cdn.standards.iteh.ai/samples/20900/716256251afb4f44a773141e7dc32c09/SIST-EN-50131-3-2009.pdf
[nsi40]: https://members.nsi.org.uk/document/nsi-technical-bulletin-no-0040-pd-6662-2017/
[nsi54]: https://members.nsi.org.uk/document/nsi-technical-bulletin-0054-publication-of-bs-en-50131-1-a3_2020/
[nsi59]: https://members.nsi.org.uk/document/nsi-technical-bulletin-no-0059-publication-of-bs-8243_2021/
[nsi670]: https://members.nsi.org.uk/document/nsf-670-7-marking-table-for-pd-6662-2017-bs-8243_2021-alarms-aug-2021/
[nsimon]: https://members.nsi.org.uk/document/selection-and-configuration-of-monitoring-options-for-an-intruder-and-hold-up-alarm-system-in-line-with-the-requirements-of-pd-666-22017/
[ajax]: https://ajax.systems/support/posts/configure-according-en-requirements/
[csa]: https://choisir-son-alarme.tech/en/standards-and-certifications/
[surety]: https://support.suretyhome.com/t/qolsys-firmware-2-5-powerg-jam-detection/9771/2
[ebs]: https://www.manualslib.com/manual/1594500/Ebs-Cpx200nb.html?page=93
[abus]: https://www.manualslib.com/manual/1918318/Abus-Secvest.html?page=292
[pyro]: https://pyronix.com/downloads/homecontrol-evidence-of-compliance-to-bsen50131-32009-annex-c
[room]: https://www.roombanker.com/blog/en50131-grade2-wireless-compliance-guide/
[crosby]: https://www.crosbyintruder.co.uk/european-standards/
[ia1501]: https://professionalsecurity.co.uk/products/alarms/industry-agreement-on-pd-6662/
[govuk]: https://www.gov.uk/government/publications/code-of-practice-on-noise-from-audible-intruder-alarms-1982
[council]: https://www.epsom-ewell.gov.uk/residents/environmental-services/noise-nuisance-pollution/intruder-alarms
