#pragma once

#include <array>
#include <cstdint>

#include "hsn/device/hal/storage.hpp"
#include "hsn/device/time.hpp"

// Every number the door sensor uses, named once, with the section of protocol.md (§), the design
// (design §), the requirement or the decision it comes from. Values marked † are provisional,
// as the protocol's own † values are.

namespace hsn::roles::sensor {

/** Transmit power on the site channel: 25 mW radiated (§2, "Frequencies"). */
constexpr std::int8_t kTxPowerDbm = 14;

/** Heartbeat reply moment: from a heartbeat's end to its reply's start, 1 s † (§8). */
constexpr device::Duration kReplyMoment = device::seconds(1);

/** The listening margin around the reply moment: 20 ms early † (§8). */
constexpr device::Duration kReplyEarly = device::milliseconds(20);

/** The listening margin around the reply moment: 50 ms late, plus kReplyLateSymbols † (§8). */
constexpr device::Duration kReplyLate = device::milliseconds(50);

/** The late margin's symbols at the reply's data rate † (§8). */
constexpr std::uint8_t kReplyLateSymbols = 8;

/**
 * Symbols the radio uses to confirm a preamble before its receive timer stops (hardware notes
 * section 3, SetLoRaSymbNumTimeout: even values only); the window of §8 allows 8.
 */
constexpr std::uint8_t kPreambleConfirmSymbols = 4;

/** Heartbeat interval units: 15 seconds (§6, reply). */
constexpr device::Duration kHeartbeatUnit = device::seconds(15);

/** Heartbeat interval before the hub gives one: 3 minutes, 12 units (§8, D52, DS4). */
constexpr std::uint8_t kDefaultHeartbeatUnits = 12;

/** Link check before the hub gives one: a reply on every 5th heartbeat (§7, §8, D72). */
constexpr std::uint8_t kDefaultLinkCheckEvery = 5;

/** Entry countdown before the hub gives one: the house default, 30 seconds (D40, D86). */
constexpr std::uint8_t kDefaultCountdownSeconds = 30;

/** An unslotted heartbeat moves by up to this much either way, per cent (§7, heartbeat slots). */
constexpr std::uint8_t kHeartbeatJitterPercent = 10;

/** The shortest heartbeat interval at SF11 (DR1), to stay inside the airtime (§7, data rate). */
constexpr device::Duration kMinHeartbeatAtSf11 = device::seconds(3 * 60);

/** The shortest heartbeat interval at SF12 (DR0) (§7, data rate). */
constexpr device::Duration kMinHeartbeatAtSf12 = device::seconds(5 * 60);

/** Unanswered reply-wanted packets in a row before listening at the sending rate (§7). */
constexpr std::uint8_t kMissesBeforeOwnRate = 2;

/**
 * Further unanswered packets before each step one allowed data rate slower, round from the
 * slowest to the fastest (§7, data rate).
 */
constexpr std::uint8_t kMissesPerSlowerStep = 2;

/**
 * Unanswered reply-wanted packets in a row after which the heartbeat slot is dropped for the
 * interval ±10%: a sensor that "has lost several" replies (§7, heartbeat slots). The protocol
 * gives no number; this reading uses the data-rate fall-back's first threshold.
 */
constexpr std::uint8_t kMissesBeforeUnslotted = kMissesBeforeOwnRate;

/** The local alarm after the stored countdown, when the hub does not answer (DS6, D88). */
constexpr device::Duration kLocalAlarmLength = device::seconds(3 * 60);

/** A button press held this long is a pairing hold (DS7). */
constexpr device::Duration kPairingHold = device::seconds(5);

/** A button press held this long is a factory-reset hold (DS7). */
constexpr device::Duration kResetHold = device::seconds(15);

/** How long a pairing hold keeps the pairing window open (DS7). */
constexpr device::Duration kPairingWindow = device::seconds(2 * 60);

/**
 * The battery voltage the hub treats as 10% for the sensor's lithium-ion cell (DS11, D109,
 * sensor-board E2), † until the hub's table for the fitted cell is settled (HB33).
 */
constexpr std::uint16_t kLowBatteryMillivolts = 3500;

/** The low-battery chirp sounds at most once in this long (DS11) †. */
constexpr device::Duration kLowBatteryChirpGap = device::seconds(12 * 3600);

/** The unit of a reply's next heartbeat field: a tenth of a second (§6, reply). */
constexpr device::Duration kTenth = device::milliseconds(100);

/**
 * The longest the sensor stays awake without deep sleep, counted from its latest input or the
 * end of external power: a 10-minute retry run plus a 255 s countdown and a 3-minute local alarm
 * (design §6, "Stuck awake").
 */
constexpr device::Duration kLongestAwake = device::seconds(20 * 60);

/** The flash record of the settings held, without the armed state (design §5). */
constexpr device::StoreKey kSettingsKey = device::StoreKey::sensor_first;

/** The settings record's version byte (design §5); 2 added the site and the move (D115). */
constexpr std::uint8_t kSettingsRecordVersion = 2;

/** Data rates the protocol lists, DR0 to DR5 (§2, "Data rates"). */
constexpr std::uint8_t kDataRateCount = 6;

}  // namespace hsn::roles::sensor
