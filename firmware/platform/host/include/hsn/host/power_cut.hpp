#pragma once

#include <cstdint>
#include <functional>
#include <vector>

namespace hsn::host {

/** Every kind of operation that changes a board's flash. */
enum class FlashOp : std::uint8_t {
  /** Storage::write of a record (NVS). */
  record_write,
  /** Storage::erase of one record. */
  record_erase,
  /** Storage::erase_all_but_role. */
  record_erase_all,
  /** FirmwareSlots::erase: one sector of the slot not running. */
  slot_erase,
  /** FirmwareSlots::write: a program of the slot not running. */
  slot_write,
  /** One copy of otadata rewritten: by select(), confirm(), reject() or the bootloader. */
  otadata_write,
};

/** Returns the snake-case name of a flash operation. */
const char* flash_op_name(FlashOp op);

/** Where a power cut falls on the operation it is aimed at. */
enum class CutPoint : std::uint8_t {
  /**
   * The operation is interrupted. A record write or erase leaves the record as it was (NVS writes
   * whole or nothing, m3-updates-design.md section 6); a slot erase or program, or an otadata
   * write, leaves the defined mess SimFlash describes.
   */
  during,
  /** The operation completes, then the power goes. */
  after,
};

/** What a flash operation must do, as its board's power decides. */
enum class FlashFate : std::uint8_t {
  /** Power is on: do it. */
  done,
  /** Do it whole; the power goes as it returns. */
  done_then_cut,
  /** The power goes half-way: leave the operation's mess. */
  interrupted,
  /** The power is already gone: nothing happens, and the call reports HalError::io. */
  lost,
};

/**
 * A board's power supply, as its flash sees it (m3-updates-design.md section 8, "a power cut at
 * every flash operation"). Every fake that changes flash asks it before each operation; it counts
 * them and, when armed, cuts the power at the Nth, during or after it. From the cut until power
 * comes back, the board's hardware does nothing that lasts: flash operations are lost, the radio
 * sends nothing, links carry nothing. The rest of the handle() in which the cut fell still runs
 * (the core cannot be stopped half-way on the host), but nothing it does leaves the board; the
 * SimDevice then turns the board off as a power loss does and powers it on again.
 */
class PowerCut {
public:
  /** One operation as counted, for a test to read. */
  struct Counted {
    std::uint64_t number = 0;
    FlashOp op = FlashOp::record_write;
  };

  /**
   * Cuts at the `nth` operation counted from now (1 is the next), at `point`. Counting restarts
   * from zero.
   */
  void arm(std::uint64_t nth, CutPoint point);

  /** No cut is waiting; counting goes on. */
  void disarm();

  /** Called by a fake before each flash operation; counts it unless the power is gone. */
  FlashFate operation(FlashOp op);

  /** True from a cut until restore(). */
  bool cut() const {
    return cut_;
  }

  /** Power is back (the SimDevice powers the board on). */
  void restore() {
    cut_ = false;
  }

  /** Operations counted since the last arm(), or since the board was made. */
  std::uint64_t count() const {
    return count_;
  }

  /** Every operation counted since the last arm(), or since the board was made, in order. */
  const std::vector<Counted>& counted() const {
    return counted_;
  }

  /** The operation the power was cut at, when it has been. */
  bool has_cut() const {
    return fired_;
  }
  const Counted& cut_at() const {
    return cut_at_;
  }

  /** Called once, at the instant of a cut (before the interrupted operation leaves its mess). */
  std::function<void()> on_cut;

private:
  void fire(const Counted& at);

  std::uint64_t count_ = 0;
  std::uint64_t armed_at_ = 0;
  CutPoint point_ = CutPoint::during;
  bool armed_ = false;
  bool cut_ = false;
  bool fired_ = false;
  Counted cut_at_;
  std::vector<Counted> counted_;
};

/**
 * The part of a fake that knows whether its board has power. A fake without a supply (a unit
 * test's) always has power.
 */
class Powered {
public:
  /** Attaches the supply every later call consults; null detaches it. */
  void set_power(PowerCut* power) {
    power_ = power;
  }

protected:
  /** True while the board's power is cut: the call must leave nothing behind. */
  bool unpowered() const {
    return power_ != nullptr && power_->cut();
  }

  /** The fate of one flash operation: always done without a supply. */
  FlashFate flash_operation(FlashOp op) const {
    return power_ != nullptr ? power_->operation(op) : FlashFate::done;
  }

private:
  PowerCut* power_ = nullptr;
};

}  // namespace hsn::host
