#include "hsn/roles/gateway/transmit_queue.hpp"

#include <cstring>

namespace hsn::roles::gateway {
namespace {

/** One microsecond: an "as soon as possible" request is too late just after its latest moment. */
constexpr device::Duration kJustAfter = device::microseconds(1);

}  // namespace

std::size_t TransmitQueue::size() const {
  std::size_t used = 0;
  for (const TransmitEntry& entry : entries_) {
    used += entry.used ? 1u : 0u;
  }
  return used;
}

std::size_t TransmitQueue::add(const TransmitEntry& entry, protocol::ByteView packet) {
  if (packet.size() > protocol::kMaxRadioPacketSize) {
    return kNone;
  }
  for (std::size_t i = 0; i < kTransmitQueueSize; ++i) {
    if (!entries_[i].used) {
      entries_[i] = entry;
      entries_[i].used = true;
      entries_[i].size = static_cast<std::uint8_t>(packet.size());
      entries_[i].order = next_order_++;
      if (!packet.empty()) {
        std::memcpy(packets_[i].data(), packet.data(), packet.size());
      }
      return i;
    }
  }
  return kNone;
}

std::size_t TransmitQueue::newest_routine() const {
  std::size_t found = kNone;
  for (std::size_t i = 0; i < kTransmitQueueSize; ++i) {
    const TransmitEntry& entry = entries_[i];
    if (entry.used && !entry.siren_command &&
        (found == kNone || entry.order > entries_[found].order)) {
      found = i;
    }
  }
  return found;
}

std::size_t TransmitQueue::due_at_time(device::Instant now) const {
  std::size_t found = kNone;
  for (std::size_t i = 0; i < kTransmitQueueSize; ++i) {
    const TransmitEntry& entry = entries_[i];
    if (entry.used && entry.timing == TransmitTiming::at_time && entry.when <= now &&
        (found == kNone || entry.when < entries_[found].when)) {
      found = i;
    }
  }
  return found;
}

bool TransmitQueue::too_late(const TransmitEntry& entry, device::Instant now) {
  return entry.timing == TransmitTiming::at_time ? now - entry.when > kMomentTolerance
                                                 : entry.when < now;
}

std::size_t TransmitQueue::expired(device::Instant now) const {
  for (std::size_t i = 0; i < kTransmitQueueSize; ++i) {
    if (entries_[i].used && too_late(entries_[i], now)) {
      return i;
    }
  }
  return kNone;
}

void TransmitQueue::defer(std::size_t index, device::Instant until) {
  if (index < kTransmitQueueSize && entries_[index].used) {
    entries_[index].deferred = true;
    entries_[index].not_before = until;
  }
}

void TransmitQueue::end_deferrals(device::Instant now) {
  for (TransmitEntry& entry : entries_) {
    if (entry.used && entry.deferred && entry.not_before <= now) {
      entry.deferred = false;
    }
  }
}

std::size_t TransmitQueue::next_as_soon_as_possible() const {
  std::size_t found = kNone;
  for (std::size_t i = 0; i < kTransmitQueueSize; ++i) {
    const TransmitEntry& entry = entries_[i];
    if (!entry.used || entry.timing != TransmitTiming::as_soon_as_possible || entry.deferred) {
      continue;
    }
    if (found == kNone) {
      found = i;
      continue;
    }
    const TransmitEntry& best = entries_[found];
    // Siren commands go first (protocol section 7, "Reply timing and a busy gateway").
    if (entry.siren_command != best.siren_command) {
      if (entry.siren_command) {
        found = i;
      }
    } else if (entry.order < best.order) {
      found = i;
    }
  }
  return found;
}

device::Instant TransmitQueue::next_deadline() const {
  device::Instant first = device::Instant::never();
  for (const TransmitEntry& entry : entries_) {
    if (!entry.used) {
      continue;
    }
    first = device::earliest(
        first, entry.timing == TransmitTiming::at_time ? entry.when : entry.when + kJustAfter);
    if (entry.deferred) {
      first = device::earliest(first, entry.not_before);
    }
  }
  return first;
}

protocol::ByteView TransmitQueue::packet(std::size_t index) const {
  if (index >= kTransmitQueueSize || !entries_[index].used) {
    return protocol::ByteView();
  }
  return protocol::ByteView(packets_[index]).first(entries_[index].size);
}

void TransmitQueue::remove(std::size_t index) {
  if (index < kTransmitQueueSize) {
    entries_[index] = TransmitEntry{};
  }
}

std::size_t TransmitQueue::clear() {
  const std::size_t dropped = size();
  for (TransmitEntry& entry : entries_) {
    entry = TransmitEntry{};
  }
  return dropped;
}

}  // namespace hsn::roles::gateway
