#include "hsn/device/services/setup.hpp"

#include <type_traits>

namespace hsn::device {
namespace {

using protocol::ByteView;
using protocol::MutableByteView;

std::array<std::uint8_t, 4> le_bytes(std::uint32_t value) {
  return {static_cast<std::uint8_t>(value & 0xFFu), static_cast<std::uint8_t>((value >> 8) & 0xFFu),
          static_cast<std::uint8_t>((value >> 16) & 0xFFu),
          static_cast<std::uint8_t>((value >> 24) & 0xFFu)};
}

template <std::size_t N>
void copy_view(ByteView from, std::array<std::uint8_t, N>& to, std::uint8_t& size) {
  const std::size_t count = from.size() < N ? from.size() : N;
  for (std::size_t i = 0; i < count; ++i) {
    to[i] = from[i];
  }
  size = static_cast<std::uint8_t>(count);
}

}  // namespace

PairingRecord PairingRecord::from(const protocol::PairingData& pairing) {
  PairingRecord record;
  record.address = pairing.address;
  record.key = pairing.key;
  record.hub_identity = pairing.hub_identity;
  record.firmware_signing_key = pairing.firmware_signing_key;
  record.site_channel = pairing.site_channel;
  record.allowed_data_rate_mask = pairing.allowed_data_rate_mask;
  copy_view(pairing.wifi_name.bytes, record.wifi_name, record.wifi_name_size);
  copy_view(pairing.wifi_password.bytes, record.wifi_password, record.wifi_password_size);
  return record;
}

LinkTarget PairingRecord::link_target() const {
  LinkTarget target;
  target.hub = hub_identity;
  target.wifi_name = ByteView(wifi_name.data(), wifi_name_size);
  target.wifi_password = ByteView(wifi_password.data(), wifi_password_size);
  return target;
}

protocol::CounterStep counter_step(std::uint8_t role) {
  return role == protocol::Role::sensor || role == 0 ? protocol::CounterStep::sensor
                                                     : protocol::CounterStep::siren_or_gateway;
}

std::uint8_t stored_role(Storage& storage) {
  Record<RoleRecord> role(storage, StoreKey::role, kRoleRecordVersion, RoleRecord{});
  return role.load() == HalError::none ? role.get().role : 0;
}

SetupService::SetupService(Storage& storage, const BuildInfo& build)
    : storage_(storage),
      build_(build),
      role_(storage, StoreKey::role, kRoleRecordVersion, RoleRecord{}),
      pairing_(storage, StoreKey::pairing, kPairingRecordVersion, PairingRecord{}) {}

HalError SetupService::load() {
  const HalError role_error = role_.load();
  const HalError pairing_error = pairing_.load();
  if (role_error != HalError::none && role_error != HalError::not_found) {
    return role_error;
  }
  if (pairing_error != HalError::none && pairing_error != HalError::not_found) {
    return pairing_error;
  }
  return HalError::none;
}

protocol::Identity SetupService::identity() const {
  protocol::Identity identity;
  identity.role = role();
  identity.chip_id = build_.chip_id;
  identity.firmware_version = build_.version;
  identity.paired = paired();
  if (identity.paired) {
    identity.hub_identity = pairing_.get().hub_identity;
  }
  identity.development_build = build_.development;
  return identity;
}

SetupResult SetupService::reply_identity(MutableByteView reply, SetupAction action) const {
  const auto size = protocol::encode_setup(identity(), reply);
  return SetupResult{size.ok() ? size.value() : 0, action};
}

SetupResult SetupService::reply_provision(std::uint8_t outcome, MutableByteView reply,
                                          SetupAction action) const {
  protocol::ProvisionResult result;
  result.result = outcome;
  const auto size = protocol::encode_setup(result, reply);
  return SetupResult{size.ok() ? size.value() : 0, action};
}

HalError SetupService::factory_reset() {
  const HalError error = storage_.erase_all_but_role();
  // The records' cached values must follow the erase, whatever its result.
  static_cast<void>(pairing_.erase());
  return error;
}

SetupResult SetupService::provision(const protocol::Provision& message, MutableByteView reply,
                                    LogBuffer& log, Instant now) {
  const bool allowed = build_.development || (role() == protocol::Role::gateway && !paired());
  if (!allowed) {
    return reply_provision(protocol::ProvisionOutcome::refused, reply, SetupAction::none);
  }
  // A new key: forget everything of the old pairing, then store the new one and a resume point
  // of one step, so a power loss before the first save cannot repeat a counter (section 4).
  const auto resume = le_bytes(static_cast<std::uint32_t>(counter_step(role())));
  if (factory_reset() != HalError::none ||
      pairing_.update(PairingRecord::from(message.pairing)) != HalError::none ||
      storage_.write(StoreKey::counter_resume, ByteView(resume)) != HalError::none) {
    log.add(now, LogLevel::error, log_code::storage_failed, "provision write");
    return reply_provision(protocol::ProvisionOutcome::refused, reply, SetupAction::restart);
  }
  return reply_provision(protocol::ProvisionOutcome::accepted, reply, SetupAction::restart);
}

SetupResult SetupService::set_role(const protocol::SetRole& message, MutableByteView reply,
                                   LogBuffer& log, Instant now) {
  if (!protocol::is_known<protocol::Role>(message.role)) {
    return reply_identity(reply, SetupAction::none);
  }
  if (role_.stored() && !build_.development) {
    return reply_identity(reply, SetupAction::none);
  }
  if (role_.stored() && role() == message.role) {
    return reply_identity(reply, SetupAction::none);
  }
  if (role_.stored() && factory_reset() != HalError::none) {
    log.add(now, LogLevel::error, log_code::storage_failed, "set role erase");
    return reply_identity(reply, SetupAction::restart);
  }
  RoleRecord record;
  record.role = message.role;
  if (role_.update(record) != HalError::none) {
    log.add(now, LogLevel::error, log_code::storage_failed, "set role write");
  }
  return reply_identity(reply, SetupAction::restart);
}

SetupResult SetupService::handle(ByteView message, MutableByteView reply, LogBuffer& log,
                                 Instant now) {
  SetupResult result;
  const protocol::Error error = protocol::decode_setup(message, [&](const auto& decoded) {
    using Message = std::decay_t<decltype(decoded)>;
    if constexpr (std::is_same_v<Message, protocol::Identify>) {
      result = reply_identity(reply, SetupAction::none);
    } else if constexpr (std::is_same_v<Message, protocol::Provision>) {
      result = provision(decoded, reply, log, now);
    } else if constexpr (std::is_same_v<Message, protocol::Erase>) {
      if (build_.development) {
        if (factory_reset() != HalError::none) {
          log.add(now, LogLevel::error, log_code::storage_failed, "erase");
        }
        result = SetupResult{0, SetupAction::restart};
      } else {
        log.add(now, LogLevel::warning, log_code::setup_ignored, "erase in release");
      }
    } else if constexpr (std::is_same_v<Message, protocol::SetRole>) {
      result = set_role(decoded, reply, log, now);
    } else {
      // Identity and provision result travel the other way.
      log.add(now, LogLevel::info, log_code::setup_ignored, "setup to hub");
    }
  });
  if (error != protocol::Error::none) {
    // A provision that does not decode is answered "not valid"; anything else is dropped.
    if (message.size() >= 2 && message[0] == protocol::kSetupMarker &&
        message[1] == protocol::setup_type::provision) {
      return reply_provision(protocol::ProvisionOutcome::not_valid, reply, SetupAction::none);
    }
    log.add(now, LogLevel::info, log_code::setup_ignored, "setup bad",
            static_cast<std::int32_t>(error));
  }
  return result;
}

}  // namespace hsn::device
