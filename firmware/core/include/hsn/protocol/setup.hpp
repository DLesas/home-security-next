#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <tuple>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/cipher.hpp"
#include "hsn/protocol/error.hpp"
#include "hsn/protocol/layout.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"

namespace hsn::protocol {

/** Pairing data format version (section 9). */
constexpr std::uint8_t kPairingFormatVersion = 1;

/** Longest Wi-Fi network name in bytes (section 9). */
constexpr std::size_t kMaxWifiNameSize = 32;

/** Longest Wi-Fi password in bytes (section 9). */
constexpr std::size_t kMaxWifiPasswordSize = 64;

/** First byte of every setup message; no encrypted packet starts with it (section 10). */
constexpr std::uint8_t kSetupMarker = 0xF1;

/** First 8 bytes of SHA-256 over the hub's signing key (section 9). */
using HubIdentity = std::array<std::uint8_t, 8>;

/** The hub's P-256 public key: X then Y, big-endian, without the 0x04 prefix (section 9). */
using SigningKey = std::array<std::uint8_t, 64>;

/** Setup message types, the byte after the marker (section 10). */
namespace setup_type {
constexpr std::uint8_t identify = 0x01;
constexpr std::uint8_t identity = 0x02;
constexpr std::uint8_t provision = 0x03;
constexpr std::uint8_t provision_result = 0x04;
constexpr std::uint8_t erase = 0x05;
}  // namespace setup_type

/** Provision results (section 10). */
struct ProvisionOutcome {
  static constexpr std::uint8_t accepted = 0;
  static constexpr std::uint8_t refused = 1;
  static constexpr std::uint8_t not_valid = 2;
  static constexpr std::array<std::uint8_t, 3> known{accepted, refused, not_valid};
};

/**
 * What a device receives when it is added (section 9). The Wi-Fi name and password are bytes,
 * never checked as text, and are views into the input.
 */
struct PairingData {
  std::uint32_t address = 0;
  DeviceKey key{};
  HubIdentity hub_identity{};
  SigningKey firmware_signing_key{};
  /** See SiteChannel. */
  std::uint8_t site_channel = 0;
  /** One bit per data rate index; unknown bits pass through. */
  std::uint8_t allowed_data_rate_mask = 0;
  LengthPrefixed<kMaxWifiNameSize, ByteContent> wifi_name;
  LengthPrefixed<kMaxWifiPasswordSize, ByteContent> wifi_password;

  /**
   * Wire layout: format version 1, then the fields; a bad version is Error::bad_version and an
   * address of 0 or 0xFFFFFFFF Error::bad_address.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        fixed_byte(kPairingFormatVersion, Error::bad_version),
        checked_field("address", &PairingData::address, &is_valid_address, Error::bad_address),
        field("key", &PairingData::key), field("hubIdentity", &PairingData::hub_identity),
        field("firmwareSigningKey", &PairingData::firmware_signing_key),
        field("siteChannel", &PairingData::site_channel),
        field("allowedDataRateMask", &PairingData::allowed_data_rate_mask),
        field("wifiName", &PairingData::wifi_name),
        field("wifiPassword", &PairingData::wifi_password));
  }
};

/** Identify (0x01), hub to device: no body. */
struct Identify {
  static constexpr std::uint8_t type = setup_type::identify;

  /**
   * Wire layout: empty.
   */
  static constexpr auto layout() {
    return std::make_tuple();
  }
};

/** Identity (0x02), device to hub. */
struct Identity {
  static constexpr std::uint8_t type = setup_type::identity;
  /** See Role. */
  std::uint8_t role = 0;
  std::array<std::uint8_t, 6> chip_id{};
  FirmwareVersion firmware_version;
  bool paired = false;
  /**
   * The paired hub's identity, or zeros; ignored when `paired` is false (section 10).
   */
  HubIdentity hub_identity{};
  bool development_build = false;

  /**
   * Wire layout, 20 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("role", &Identity::role), field("chipId", &Identity::chip_id),
                           field("firmwareVersion", &Identity::firmware_version),
                           field("paired", &Identity::paired),
                           field("hubIdentity", &Identity::hub_identity),
                           field("developmentBuild", &Identity::development_build));
  }
};

/** Provision (0x03), hub to device: pairing data. */
struct Provision {
  static constexpr std::uint8_t type = setup_type::provision;
  PairingData pairing;

  /**
   * Wire layout: the pairing data.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("pairing", &Provision::pairing));
  }
};

/** Provision result (0x04), device to hub. */
struct ProvisionResult {
  static constexpr std::uint8_t type = setup_type::provision_result;
  /** See ProvisionOutcome. */
  std::uint8_t result = 0;

  /**
   * Wire layout, 1 byte.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("result", &ProvisionResult::result));
  }
};

/** Erase (0x05), hub to device, development builds only: no body. */
struct Erase {
  static constexpr std::uint8_t type = setup_type::erase;

  /**
   * Wire layout: empty.
   */
  static constexpr auto layout() {
    return std::make_tuple();
  }
};

/** Every setup message of version 1, for dispatch on the setup type. */
using SetupMessages = std::tuple<Identify, Identity, Provision, ProvisionResult, Erase>;

/**
 * Decodes pairing data on its own (as Bluetooth will deliver it). Extra bytes are ignored;
 * `out` is left unchanged on error.
 */
Error decode_pairing_data(ByteView bytes, PairingData& out);

/**
 * Encodes pairing data and returns its size.
 */
Result<std::size_t> encode_pairing_data(const PairingData& pairing, MutableByteView out);

/**
 * Decodes the body of a setup message (the bytes after marker and type) into `out`.
 * Instantiated for every type in SetupMessages.
 */
template <typename Message>
Error decode_setup_body(ByteView body, Message& out);

/**
 * Writes a setup message: marker, type, body. Instantiated for every type in SetupMessages.
 */
template <typename Message>
Result<std::size_t> encode_setup(const Message& message, MutableByteView out);

/**
 * Decodes a setup message and passes the decoded struct to `visitor`, which must accept every
 * type in SetupMessages. Fails with Error::truncated, Error::bad_value (no marker),
 * Error::unknown_type, or the body's error.
 */
template <typename Visitor>
Error decode_setup(ByteView bytes, Visitor&& visitor) {
  if (bytes.empty()) {
    return Error::truncated;
  }
  if (bytes[0] != kSetupMarker) {
    return Error::bad_value;
  }
  if (bytes.size() < 2) {
    return Error::truncated;
  }
  const std::uint8_t type = bytes[1];
  const ByteView body = bytes.subspan(2);
  Error error = Error::unknown_type;
  for_each_type<SetupMessages>([&](auto tag) {
    using Message = typename decltype(tag)::type;
    if (Message::type != type) {
      return;
    }
    Message message;
    error = decode_setup_body(body, message);
    if (error == Error::none) {
      visitor(static_cast<const Message&>(message));
    }
  });
  return error;
}

}  // namespace hsn::protocol
