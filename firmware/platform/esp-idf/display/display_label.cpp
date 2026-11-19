#include "hsn/esp/display_label.hpp"

#include "bootloader_random.h"
#include "esp_log.h"

namespace hsn::esp {

DisplayLabel::DisplayLabel(device::Storage& storage, const device::BuildInfo& build)
    : build_(build), label_(storage, kKey, 1, {}) {}

bool DisplayLabel::prepare(std::uint8_t role, device::Random& random) {
  const auto loaded = label_.load();
  if (loaded == device::HalError::none && label_.get().role == role) {
    return true;
  }
  if (loaded != device::HalError::not_found && loaded != device::HalError::none) {
    return false;
  }
  Label next;
  next.role = role;
  if (loaded == device::HalError::not_found) {
    std::array<std::uint8_t, 5> bytes{};
    bootloader_random_enable();
    random.fill(protocol::MutableByteView(bytes));
    bootloader_random_disable();
    next.code = make_code(bytes);
  } else {
    // Setting the factory role finalizes the label already shown on a blank board.
    next.code = label_.get().code;
  }
  return label_.update(next) == device::HalError::none;
}

bool DisplayLabel::begin(int cs, int dc, int reset, int busy, device::Instant now) {
  if (!panel_.begin(cs, dc, reset, busy)) {
    return false;
  }
  if (label_.stored() && label_.get().drawn == 0) {
    panel_.draw(label_.get().code, build_.chip_id, label_.get().role, now);
  }
  return true;
}

void DisplayLabel::poll(device::Instant now) {
  panel_.step(now);
  if (panel_.take_done()) {
    Label done = label_.get();
    done.drawn = 1;
    if (label_.update(done) != device::HalError::none) {
      ESP_LOGW("hsn.epaper", "label completion could not be stored");
    }
  }
}

const PairCode* DisplayLabel::code() const {
  return label_.stored() ? &label_.get().code : nullptr;
}

}  // namespace hsn::esp
