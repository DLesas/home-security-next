#include "hsn/host/power_cut.hpp"

namespace hsn::host {

const char* flash_op_name(FlashOp op) {
  switch (op) {
    case FlashOp::record_write:
      return "record_write";
    case FlashOp::record_erase:
      return "record_erase";
    case FlashOp::record_erase_all:
      return "record_erase_all";
    case FlashOp::slot_erase:
      return "slot_erase";
    case FlashOp::slot_write:
      return "slot_write";
    case FlashOp::otadata_write:
      return "otadata_write";
  }
  return "?";
}

void PowerCut::arm(std::uint64_t nth, CutPoint point) {
  count_ = 0;
  counted_.clear();
  armed_at_ = nth;
  point_ = point;
  armed_ = nth > 0;
  fired_ = false;
}

void PowerCut::disarm() {
  armed_ = false;
}

void PowerCut::fire(const Counted& at) {
  armed_ = false;
  cut_ = true;
  fired_ = true;
  cut_at_ = at;
  if (on_cut) {
    on_cut();
  }
}

FlashFate PowerCut::operation(FlashOp op) {
  if (cut_) {
    return FlashFate::lost;
  }
  count_ += 1;
  const Counted counted{count_, op};
  counted_.push_back(counted);
  if (!armed_ || count_ != armed_at_) {
    return FlashFate::done;
  }
  fire(counted);
  return point_ == CutPoint::during ? FlashFate::interrupted : FlashFate::done_then_cut;
}

}  // namespace hsn::host
