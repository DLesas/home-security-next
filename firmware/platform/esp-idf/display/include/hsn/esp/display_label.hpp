#pragma once

#include "hsn/device/hal/build_info.hpp"
#include "hsn/device/hal/random.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/esp/epaper.hpp"

namespace hsn::esp {

/** Owns the persistent code and tracks a label through power loss during its first refresh. */
class DisplayLabel {
public:
  DisplayLabel(device::Storage& storage, const device::BuildInfo& build);

  /** Reads or creates a label before ADC or RF startup. */
  bool prepare(std::uint8_t role, device::Random& random);
  /** Attaches the panel to the shared bus and starts an outstanding refresh. */
  bool begin(int cs, int dc, int reset, int busy, device::Instant now);
  /** Advances the refresh and commits completion after panel deep sleep. */
  void poll(device::Instant now);
  /** The waiter's next panel deadline. */
  device::Instant due() const {
    return panel_.due();
  }
  /** Returns the durable code being displayed, including during its first refresh. */
  const PairCode* code() const;

private:
  struct Label {
    PairCode code{};
    std::uint8_t role = 0;
    std::uint8_t drawn = 0;
  };

  static constexpr auto kKey = static_cast<device::StoreKey>(0xff);
  const device::BuildInfo& build_;
  device::Record<Label> label_;
  Epaper panel_;
};

}  // namespace hsn::esp
