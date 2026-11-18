#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/hal/key_import.hpp"
#include "hsn/device/hal/storage.hpp"
#include "hsn/device/status.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/binding.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/cipher.hpp"
#include "hsn/protocol/counters.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"

namespace hsn::device {

/** The send counter as kept in the retained block between wakes. Zero means unknown. */
struct CounterState {
  std::uint32_t next = 0;
  std::uint32_t resume_point = 0;
};

/** How many of its own counters a sensor tries a hub packet against (protocol section 4). */
constexpr std::size_t kMaxBoundCandidates = 16;

/** A sealed packet. */
struct Sealed {
  std::size_t size = 0;
  std::uint32_t counter = 0;
};

/** A hub packet accepted by a sensor, and which of its counters it answers. */
struct BoundOpen {
  protocol::OpenedPacket packet;
  std::uint32_t answered = 0;
};

/** The siren's judgement of a command or settings packet (protocol section 7, siren command). */
enum class CommandVerdict : std::uint8_t {
  /** Higher than the last accepted: act on it and answer. */
  new_command,
  /** The same counter as the last accepted: answer again, act no further. */
  repeat_of_latest,
  /** Lower: no answer. */
  too_old,
};

/** A command or settings packet that passed its tag. */
struct CommandOpen {
  protocol::OpenedPacket packet;
  CommandVerdict verdict = CommandVerdict::too_old;
  /** False when the new counter could not be written to flash (the siren acts anyway). */
  bool saved = true;
};

/** One gateway connection's receive state, in RAM only (protocol section 4). */
struct SessionState {
  protocol::RandomValue gateway_random{};
  protocol::RandomValue hub_random{};
  bool welcomed = false;
  std::uint32_t last_accepted = 0;

  /** Starts a new connection with a fresh gateway random value. */
  void begin(const protocol::RandomValue& random) {
    *this = SessionState{};
    gateway_random = random;
  }

  /** The binding of every packet after the welcome. */
  protocol::Binding binding() const {
    return protocol::Binding::session(gateway_random, hub_random);
  }
};

/**
 * The device end of protocol section 4: the device's address and key, its send counter with the
 * resume-point rule, and the receiving rule of each case. It owns the counters' persistence: the
 * resume point is written before the packet that needs it is sealed, and a siren's command
 * counter before the command is acted on. Opened bodies are views into the channel's own buffer,
 * valid until the next open.
 */
class SecureChannel {
public:
  /**
   * `keys` replaces the platform's device key in change_key(); without it change_key() is
   * Status::not_ready.
   */
  SecureChannel(const protocol::PacketCipher& cipher, Storage& storage, CounterState& state,
                KeyImport* keys = nullptr)
      : cipher_(cipher), storage_(storage), state_(state), keys_(keys) {}

  /**
   * Starts sending as `address` with the role's step. With `retained_valid`, continues from the
   * retained counter; otherwise from the resume point in flash, rounded up as section 4 says (a
   * missing one gives one step). Also loads a siren's last command counter. Status::refused for
   * an invalid address; Status::storage_error when flash cannot be read.
   */
  Status start(std::uint32_t address, protocol::CounterStep step, bool retained_valid);

  /**
   * True once start() has succeeded.
   */
  bool started() const {
    return started_;
  }

  std::uint32_t address() const {
    return address_;
  }

  /**
   * Returns the counter of the last packet sealed, or 0.
   */
  std::uint32_t last_counter() const {
    return last_counter_;
  }

  /**
   * Encodes and seals a message to the hub into `out`. Takes a counter; when the counter is a
   * multiple of the step, writes the new resume point first, and on a write failure seals
   * nothing and keeps the counter for the next try (Status::storage_error).
   */
  template <typename Message>
  Outcome<Sealed> seal(const Message& message, const protocol::Binding& binding,
                       protocol::PacketLimit limit, protocol::MutableByteView out) {
    const auto size = protocol::encode_plaintext(message, protocol::MutableByteView(tx_plain_));
    if (!size.ok()) {
      return Outcome<Sealed>(Status::protocol_error, size.error());
    }
    return seal_plaintext(protocol::ByteView(tx_plain_).first(size.value()), binding, limit, out);
  }

  /**
   * The sensor's rule: accepts a hub packet bound to one of `candidates`, the counters of the
   * current event's tries, newest first; at most kMaxBoundCandidates are tried.
   */
  Outcome<BoundOpen> open_bound(protocol::ByteView packet,
                                protocol::Span<const std::uint32_t> candidates);

  /**
   * The siren's rule: no binding; a siren command or settings packet is judged against the last
   * accepted command counter, which is written to flash before this returns a new command.
   * Other types are Status::refused, and a body shorter than its type's fields is
   * Status::protocol_error (Error::truncated); neither moves the counter or writes flash.
   */
  Outcome<CommandOpen> open_command(protocol::ByteView packet, protocol::PacketLimit limit);

  /**
   * The gateway's rule: before the welcome, only a welcome bound to the hello's random value;
   * after it, packets bound to the session value with strictly higher counters. Updates
   * `session`. A body shorter than its type's fields is Status::protocol_error and moves nothing;
   * a transmit request whose carried packet has a bad length is returned, for "not valid".
   */
  Outcome<protocol::OpenedPacket> open_session(protocol::ByteView packet, SessionState& session);

  /**
   * Returns the last accepted command counter (the siren's report carries its low 16 bits).
   */
  std::uint32_t last_command() const {
    return command_rx_.last_accepted();
  }

  /**
   * Changes the device key after a hub restore (m3-updates-design.md section 7, D141), when the
   * role has opened a Key change (0x84) under its own receiving rule. In this order, each step
   * before the next: (1) the pairing record with the new key, whole or nothing; (2) the resume
   * point as one step (64 on a sensor, 1,024 on a siren or gateway); (3) the new key into the
   * platform's crypto (KeyImport). The send counter then continues from that step under the new
   * key, and nothing is ever sealed under the old key again. A siren's command counter restarts
   * with the key. On success, Device calls the role's report_again() once the event's handle()
   * returns (take_key_change()). A failure leaves the steps already done; a cut between (1) and
   * (2) skips counters under the new key and never repeats one.
   *
   * Until the key change's owner builds it, it is Status::refused and changes nothing.
   */
  Status change_key(const protocol::DeviceKey& key, Instant now);

  /**
   * True once after each successful change_key(): Device asks it after every event and then
   * calls the role's report_again().
   */
  bool take_key_change();

private:
  Outcome<Sealed> seal_plaintext(protocol::ByteView plaintext, const protocol::Binding& binding,
                                 protocol::PacketLimit limit, protocol::MutableByteView out);
  Outcome<protocol::PacketHeader> header_for_me(protocol::ByteView packet,
                                                protocol::PacketLimit limit) const;

  const protocol::PacketCipher& cipher_;
  Storage& storage_;
  CounterState& state_;
  KeyImport* keys_;
  bool key_changed_ = false;
  std::uint32_t address_ = 0;
  bool started_ = false;
  protocol::SendCounter counter_{protocol::CounterStep::sensor, 0, 0};
  protocol::StrictlyHigherCounter command_rx_;
  std::uint32_t last_counter_ = 0;
  std::array<std::uint8_t, protocol::kMaxLinkPacketSize> tx_plain_{};
  std::array<std::uint8_t, protocol::kMaxLinkPacketSize> rx_plain_{};
};

}  // namespace hsn::device
