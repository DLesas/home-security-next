#include "hsn/device/device.hpp"

#include <cstring>

#include "hsn/protocol/checksum.hpp"
#include "hsn/protocol/transfer.hpp"

namespace hsn::device {
namespace {

using protocol::ByteView;
using protocol::MutableByteView;

/** Two wakes as one: the earlier time, the shallower sleep, either's inputs, either's restart. */
Wake merged(const Wake& a, const Wake& b) {
  Wake wake;
  wake.at = earliest(a.at, b.at);
  wake.deepest = a.deepest < b.deepest ? a.deepest : b.deepest;
  wake.deep_wake_inputs = a.deep_wake_inputs | b.deep_wake_inputs;
  wake.restart = a.restart || b.restart;
  return wake;
}

void put_u16(MutableByteView out, std::size_t at, std::uint16_t value) {
  out[at] = static_cast<std::uint8_t>(value & 0xFFu);
  out[at + 1] = static_cast<std::uint8_t>(value >> 8);
}

void put_u32(MutableByteView out, std::size_t at, std::uint32_t value) {
  for (std::size_t i = 0; i < 4; ++i) {
    out[at + i] = static_cast<std::uint8_t>((value >> (8 * i)) & 0xFFu);
  }
}

std::uint16_t get_u16(ByteView in, std::size_t at) {
  return static_cast<std::uint16_t>(in[at] | (in[at + 1] << 8));
}

std::uint32_t get_u32(ByteView in, std::size_t at) {
  std::uint32_t value = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    value |= static_cast<std::uint32_t>(in[at + i]) << (8 * i);
  }
  return value;
}

/** An empty core part, copied from here rather than built on the stack. */
constexpr CoreRetained kEmptyCore{};

/** Header offsets. */
constexpr std::size_t kMagicAt = 0;
constexpr std::size_t kLayoutAt = 4;
constexpr std::size_t kRoleAt = 5;
constexpr std::size_t kRoleLayoutAt = 6;
constexpr std::size_t kCoreSizeAt = 8;
constexpr std::size_t kRoleSizeAt = 10;
constexpr std::size_t kCrcAt = 12;

/** CRC over the header without its CRC field, then the payload. */
std::uint32_t block_crc(ByteView block, std::size_t payload_size) {
  const std::uint32_t head = protocol::crc32(block.first(kCrcAt));
  return protocol::crc32(block.subspan(kRetainedHeaderSize, payload_size), head);
}

}  // namespace

protocol::MutableByteView Device::role_bytes() {
  return role_ != nullptr && active_ ? role_->state_bytes() : MutableByteView();
}

std::uint8_t Device::role_id() const {
  return role_ != nullptr && active_ ? role_->role_id() : 0;
}

std::uint8_t Device::role_layout() const {
  return role_ != nullptr && active_ ? role_->state_layout() : 0;
}

void Device::write_breadcrumb(std::uint32_t value) {
  const MutableByteView crumb = services_.hal.retained.breadcrumb();
  if (crumb.size() >= kBreadcrumbSize) {
    put_u32(crumb, 0, value);
  }
}

std::uint32_t Device::read_breadcrumb() {
  const MutableByteView crumb = services_.hal.retained.breadcrumb();
  return crumb.size() >= kBreadcrumbSize ? get_u32(crumb, 0) : 0;
}

bool Device::restore() {
  const MutableByteView block = services_.hal.retained.block();
  const MutableByteView state = role_bytes();
  const std::size_t payload = sizeof(CoreRetained) + state.size();
  retain_ = block.size() >= kRetainedHeaderSize + payload;
  if (!retain_) {
    return false;
  }
  if (get_u32(block, kMagicAt) != kRetainedMagic || block[kLayoutAt] != kRetainedLayout ||
      block[kRoleAt] != role_id() || block[kRoleLayoutAt] != role_layout() ||
      get_u16(block, kCoreSizeAt) != sizeof(CoreRetained) ||
      get_u16(block, kRoleSizeAt) != state.size() ||
      get_u32(block, kCrcAt) != block_crc(block, payload)) {
    return false;
  }
  std::memcpy(&services_.core, block.data() + kRetainedHeaderSize, sizeof(CoreRetained));
  if (!state.empty()) {
    std::memcpy(state.data(), block.data() + kRetainedHeaderSize + sizeof(CoreRetained),
                state.size());
  }
  return true;
}

void Device::seal() {
  if (!retain_ || restart_) {
    return;
  }
  const MutableByteView block = services_.hal.retained.block();
  const MutableByteView state = role_bytes();
  const std::size_t payload = sizeof(CoreRetained) + state.size();
  put_u32(block, kMagicAt, kRetainedMagic);
  block[kLayoutAt] = kRetainedLayout;
  block[kRoleAt] = role_id();
  block[kRoleLayoutAt] = role_layout();
  block[7] = 0;
  put_u16(block, kCoreSizeAt, static_cast<std::uint16_t>(sizeof(CoreRetained)));
  put_u16(block, kRoleSizeAt, static_cast<std::uint16_t>(state.size()));
  std::memcpy(block.data() + kRetainedHeaderSize, &services_.core, sizeof(CoreRetained));
  if (!state.empty()) {
    std::memcpy(block.data() + kRetainedHeaderSize + sizeof(CoreRetained), state.data(),
                state.size());
  }
  put_u32(block, kCrcAt, block_crc(block, payload));
}

void Device::invalidate_retained() {
  const MutableByteView block = services_.hal.retained.block();
  if (block.size() >= kRetainedHeaderSize) {
    put_u32(block, kMagicAt, 0);
  }
}

void Device::boot(const Event& event) {
  const Instant now = event.now;
  const std::uint32_t previous = read_breadcrumb();
  write_breadcrumb(breadcrumb_of(EventKind::boot, 0));
  booted_ = true;
  restart_ = false;

  if (services_.setup.load() != HalError::none) {
    services_.log.add(now, LogLevel::error, log_code::storage_failed, "setup load");
  }
  services_.health.boot(event.boot, previous);
  active_ =
      role_ != nullptr && services_.setup.paired() && services_.setup.role() == role_->role_id();

  const bool valid = restore();
  if (!valid) {
    services_.core = kEmptyCore;
    retained_status_ = RetainedStatus::none;
    if (!retain_) {
      services_.log.add(now, LogLevel::error, log_code::retained_too_large, "retained too large",
                        static_cast<std::int32_t>(role_bytes().size()));
    }
  } else if (now < services_.core.last_now) {
    retained_status_ = RetainedStatus::clock_reset;
    services_.core.last_now = now;
    services_.airtime.rebase(now);
    services_.log.add(now, LogLevel::warning, log_code::clock_reset, "clock reset");
  } else {
    retained_status_ = RetainedStatus::intact;
  }

  Event delivered = event;
  delivered.boot.retained = retained_status_;
  if (is_start_up(delivered.boot)) {
    services_.core.started_at = now;
  }
  awake_since_ = now;

  if (active_) {
    const PairingRecord& pairing = services_.setup.pairing();
    const Status status =
        services_.channel.start(pairing.address, counter_step(services_.setup.role()), valid);
    if (status != Status::ok) {
      services_.log.add(now, LogLevel::error, log_code::storage_failed, "channel start",
                        static_cast<std::int32_t>(status));
    }
    services_.update.boot(now);
    write_breadcrumb(breadcrumb_of(EventKind::boot, role_->state_id()));
    role_->handle(delivered);
  }
}

bool Device::handle_update(const Event& event) {
  if (event.kind != EventKind::link) {
    return false;
  }
  const LinkEvent& link = event.link;
  if (link.kind == LinkEventKind::packet && !link.packet.empty() &&
      link.packet[0] == protocol::kTransferMarker) {
    services_.update.frame(link.link, link.packet, event.now);
    return true;
  }
  if (link.link != LinkKind::bluetooth) {
    // A USB or network link's own up and down go to the role as before, and to the service too,
    // so an update resumes after a break whatever the role does (a sensor's network link is up
    // only for an update, which the service started).
    if (link.kind != LinkEventKind::packet) {
      services_.update.link_changed(link.link, link.kind == LinkEventKind::up, event.now);
    }
    return false;
  }
  // Bluetooth carries transfer frames only (m3-updates-design.md section 5).
  if (link.kind == LinkEventKind::packet) {
    services_.log.add(event.now, LogLevel::warning, log_code::bluetooth_ignored,
                      "bluetooth not a frame");
  } else {
    services_.update.link_changed(link.link, link.kind == LinkEventKind::up, event.now);
  }
  return true;
}

Wake Device::active_wake() const {
  Wake wake = merged(role_->next_wake(), services_.update.next_wake());
  if (services_.update.on_trial() && wake.deepest == SleepDepth::deep) {
    // A deep-sleep wake goes through the bootloader, which would roll the trial image back.
    wake.deepest = SleepDepth::light;
  }
  return wake;
}

bool Device::handle_setup(const Event& event) {
  if (event.kind != EventKind::link || event.link.kind != LinkEventKind::packet ||
      event.link.packet.empty() || event.link.packet[0] != protocol::kSetupMarker) {
    return false;
  }
  if (event.link.link != LinkKind::usb || services_.hal.usb == nullptr) {
    // Setup messages count only on the trusted cable (protocol section 10).
    services_.log.add(event.now, LogLevel::warning, log_code::setup_ignored, "setup off usb");
    return true;
  }
  const SetupResult result = services_.setup.handle(
      event.link.packet, MutableByteView(setup_reply_), services_.log, event.now);
  if (result.reply_size > 0) {
    const HalError error = services_.hal.usb->send(ByteView(setup_reply_).first(result.reply_size));
    if (error != HalError::none) {
      services_.log.add(event.now, LogLevel::warning, log_code::setup_ignored, "setup reply");
    }
    // Only gateways use USB as an operating link. Identify can mean the hub restarted.
    if (active_ && role_->role_id() == protocol::Role::gateway && event.link.packet.size() == 2 &&
        event.link.packet[1] == protocol::Identify::type) {
      role_->handle(event);
    }
  }
  if (result.action == SetupAction::restart) {
    // The pairing or the role changed: nothing retained may outlive it.
    invalidate_retained();
    restart_ = true;
  }
  return true;
}

void Device::check_awake(Instant now) {
  if (!active_) {
    return;
  }
  const Wake wake = active_wake();
  if (wake.deepest == SleepDepth::deep) {
    awake_since_ = now;
    return;
  }
  Duration bound = role_->longest_awake();
  if (bound.us > 0 && bound < kUpdateLongestAwake &&
      (services_.update.active() || services_.update.on_trial())) {
    bound = kUpdateLongestAwake;
  }
  if (bound.us > 0 && now - awake_since_ > bound) {
    raise_fatal(fatal_code::stuck_awake, now);
  }
}

void Device::raise_fatal(std::uint16_t code, Instant now) {
  services_.health.raise_fatal(code, now, services_.log);
}

void Device::handle(const Event& event) {
  if (event.kind == EventKind::boot) {
    boot(event);
  } else if (!booted_) {
    return;
  } else {
    write_breadcrumb(breadcrumb_of(event.kind, active_ ? role_->state_id() : 0));
    if (!handle_setup(event) && active_) {
      services_.update.poll(event.now);
      if (!handle_update(event)) {
        role_->handle(event);
      }
    }
  }
  if (active_ && services_.channel.take_key_change()) {
    role_->report_again(event.now);
  }
  check_awake(event.now);
  if (event.now > services_.core.last_now) {
    services_.core.last_now = event.now;
  }
  seal();
}

Wake Device::next_wake() const {
  if (restart_ || services_.health.restart_requested()) {
    Wake wake;
    wake.restart = true;
    return wake;
  }
  if (!active_) {
    // Setup-only, without a timer. On external power, stay reachable for setup messages; on a
    // cell, sleep deep until power arrives or the button is pressed (pairing over Bluetooth, M3).
    Wake wake;
    if (services_.hal.power.external_power()) {
      wake.deepest = SleepDepth::light;
    } else {
      wake.deepest = SleepDepth::deep;
      wake.deep_wake_inputs = WakeMask::of(Input::external_power).with(Input::button);
    }
    return wake;
  }
  return active_wake();
}

}  // namespace hsn::device
