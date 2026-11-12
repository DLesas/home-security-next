#pragma once

#include <array>
#include <cstdint>

#include "hsn/protocol/messages.hpp"

namespace hsn::device {

/** Facts about the image and the chip, filled in by the platform. */
struct BuildInfo {
  protocol::FirmwareVersion version;
  /** A development build accepts Provision, Erase and Set role at any time (protocol §10). */
  bool development = false;
  std::array<std::uint8_t, 6> chip_id{};
};

}  // namespace hsn::device
