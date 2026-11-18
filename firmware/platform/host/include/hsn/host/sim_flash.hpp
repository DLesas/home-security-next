#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "hsn/device/status.hpp"
#include "hsn/host/power_cut.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::host {

/**
 * NOR flash as the ESP32-S3's (m3-updates-design.md section 8): sectors of kSectorSize bytes that
 * erase to 0xFF, and programs that can only clear bits (a 1 becomes 0, a 0 stays 0). Every erase
 * and program is one flash operation for the board's PowerCut, and a cut that falls during one
 * leaves a defined mess, the same on every run:
 *
 * - an interrupted erase leaves the sector's first half erased (0xFF) and its second half garbage
 *   (each byte the old byte OR a byte of a sequence seeded by the board and the operation);
 * - an interrupted program clears the bits of its first half (size / 2 bytes) as a whole one
 *   would, clears only the bits of the next byte that its high nibble would, and leaves the rest as
 *   it was;
 * - an interrupted rewrite (an otadata copy: erase, then program) erases the sector whole and
 *   interrupts the program.
 *
 * It does not refuse a program into bytes that are not erased, as the chip does not; such a
 * program is counted in `unerased_programs`, so a test can assert that none happened.
 */
class SimFlash : public Powered {
public:
  /** The erase unit, as FirmwareSlots' (kSlotSectorSize). */
  static constexpr std::size_t kSectorSize = 4096;

  /** `size` bytes (a multiple of kSectorSize), all erased; `seed` makes the messes. */
  SimFlash(std::size_t size, std::uint64_t seed);

  /** Its size in bytes. */
  std::size_t size() const {
    return bytes_.size();
  }

  /**
   * Erases the sector at `address`. HalError::invalid off a sector boundary or past the end;
   * HalError::io when the power is gone or a fault switch says so, and nothing changes.
   */
  device::HalError erase(std::uint32_t address, FlashOp op);

  /**
   * Programs `bytes` at `address`: each bit already 0 stays 0. HalError::invalid past the end;
   * HalError::io as for erase().
   */
  device::HalError program(std::uint32_t address, protocol::ByteView bytes, FlashOp op);

  /**
   * Erases the sector at `address` and programs `bytes` at its start, as one operation: how an
   * otadata copy is rewritten.
   */
  device::HalError rewrite(std::uint32_t address, protocol::ByteView bytes, FlashOp op);

  /** Copies bytes out. Reading never fails and is not an operation. */
  void read(std::uint32_t address, protocol::MutableByteView out) const;

  /** The whole contents, for the fake bootloader and for tests. */
  const std::vector<std::uint8_t>& contents() const {
    return bytes_;
  }

  /**
   * Writes bytes as a factory programmer does over serial: erases every sector they touch, then
   * writes them exactly. Not an operation: never cut, never counted.
   */
  void load(std::uint32_t address, protocol::ByteView bytes);

  /** Erases `size` bytes from `address` (whole sectors) as load() does. */
  void blank(std::uint32_t address, std::size_t size);

  /** True while the board's power is cut: every operation is lost. */
  bool power_gone() const {
    return unpowered();
  }

  /** Bumped by every change; lets a reader cache what it computed from the bytes. */
  std::uint64_t generation() const {
    return generation_;
  }

  /** Fault switches: every erase fails; every program fails; the next N operations fail. */
  bool fail_erases = false;
  bool fail_programs = false;
  int fail_next = 0;

  /** Programs that asked for a 0 bit to become 1: the bytes were not erased. */
  std::uint64_t unerased_programs = 0;

private:
  bool fault(bool always);
  void apply_program(std::uint32_t address, protocol::ByteView bytes, std::size_t whole,
                     bool half_next);
  void mess_erase(std::uint32_t address);

  std::vector<std::uint8_t> bytes_;
  std::uint64_t seed_;
  std::uint64_t messes_ = 0;
  std::uint64_t generation_ = 0;
};

}  // namespace hsn::host
