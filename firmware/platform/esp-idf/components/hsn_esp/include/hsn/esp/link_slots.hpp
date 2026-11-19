#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

#include "hsn/device/hal/link.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/framing.hpp"

namespace hsn::esp {

/**
 * A link's received packets (design section 3, "Link"): kLinkReceiveQueue slots of 1,024 bytes.
 * The link's own task claims a free slot, fills it and posts its number; the main task hands the
 * packet to the core as a view, and frees the slot when the core's handle() has returned (the
 * next wait). With every slot taken a new packet is dropped, the newest, and counted.
 */
class LinkSlots {
public:
  static constexpr std::size_t kSlots = device::kLinkReceiveQueue;
  static constexpr std::size_t kSlotSize = protocol::kMaxFrameDataSize;

  /** From the link's task: a free slot's number, or -1 when all are taken (counted as dropped). */
  int claim();
  /** The slot's storage, to fill. */
  std::uint8_t* data(int slot) {
    return slots_[static_cast<std::size_t>(slot)].data();
  }
  void set_size(int slot, std::size_t size) {
    sizes_[static_cast<std::size_t>(slot)] = static_cast<std::uint16_t>(size);
  }
  /** Gives a slot back without posting it (a frame that turned out bad). */
  void release(int slot);
  /** The packet in a slot, as the core sees it. */
  protocol::ByteView packet(int slot) const {
    return protocol::ByteView(slots_[static_cast<std::size_t>(slot)].data(),
                              sizes_[static_cast<std::size_t>(slot)]);
  }
  /** Packets dropped for want of a slot, since start. */
  std::uint32_t dropped() const {
    return dropped_.load();
  }

private:
  std::array<std::array<std::uint8_t, kSlotSize>, kSlots> slots_{};
  std::array<std::uint16_t, kSlots> sizes_{};
  std::atomic<std::uint32_t> taken_{0};
  std::atomic<std::uint32_t> dropped_{0};
};

inline int LinkSlots::claim() {
  std::uint32_t taken = taken_.load();
  for (;;) {
    int free_slot = -1;
    for (std::size_t i = 0; i < kSlots; ++i) {
      if ((taken & (1u << i)) == 0) {
        free_slot = static_cast<int>(i);
        break;
      }
    }
    if (free_slot < 0) {
      dropped_.fetch_add(1);
      return -1;
    }
    if (taken_.compare_exchange_weak(taken, taken | (1u << free_slot))) {
      return free_slot;
    }
  }
}

inline void LinkSlots::release(int slot) {
  if (slot >= 0 && static_cast<std::size_t>(slot) < kSlots) {
    taken_.fetch_and(~(1u << static_cast<unsigned>(slot)));
  }
}

/** A link's send queue: kSlots packets copied in by send(), taken out by the link's own task. */
class SendSlots {
public:
  static constexpr std::size_t kSlots = 4;

  /** Creates the queue; false on failure. */
  bool begin();
  /** Copies `packet` in; false when full (the link answers HalError::busy). */
  bool put(protocol::ByteView packet);
  /** From the link's task: waits at most `wait_ms` for a packet and copies it into `out`. */
  bool take(std::array<std::uint8_t, protocol::kMaxFrameDataSize>& out, std::size_t& size,
            std::uint32_t wait_ms);
  /** True when nothing waits to be sent and nothing is being sent. */
  bool empty() const;
  /** The link's task has finished sending what it took. */
  void sent();

private:
  struct Item {
    std::uint16_t size = 0;
    std::array<std::uint8_t, protocol::kMaxFrameDataSize> bytes{};
  };
  std::array<Item, kSlots> items_{};
  void* free_ = nullptr;
  void* full_ = nullptr;
  std::atomic<std::uint32_t> in_flight_{0};
};

}  // namespace hsn::esp
