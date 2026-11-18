#include "hsn/host/timeline.hpp"

#include <algorithm>
#include <cstdio>
#include <sstream>
#include <utility>

#include "hsn/device/hal/link.hpp"
#include "hsn/host/sim_time.hpp"
#include "hsn/host/simulation_error.hpp"

namespace hsn::host {
namespace {

std::uint32_t kind_bit(RecordKind kind) {
  return 1u << static_cast<std::uint32_t>(kind);
}

std::string type_name_or_unknown(std::uint8_t type) {
  return type == 0 ? std::string("unknown") : message_type_name(type);
}

std::string label_text(const PacketLabel& label) {
  if (!label.has_header) {
    return "not a packet";
  }
  std::ostringstream out;
  out << type_name_or_unknown(label.type) << " "
      << (label.direction == protocol::Direction::to_hub ? "to hub" : "from hub") << " #"
      << label.counter;
  return out.str();
}

const char* link_text(std::uint32_t kind) {
  switch (kind) {
    case static_cast<std::uint32_t>(device::LinkKind::usb):
      return "usb";
    case static_cast<std::uint32_t>(device::LinkKind::network):
      return "network";
    case static_cast<std::uint32_t>(device::LinkKind::bluetooth):
      return "bluetooth";
    default:
      return "?";
  }
}

std::string radio_text(const Record& record) {
  char text[48];
  std::snprintf(text, sizeof(text), "%u.%03u MHz DR%u", record.frequency_hz / 1000000,
                (record.frequency_hz / 1000) % 1000, static_cast<unsigned>(record.data_rate));
  return text;
}

}  // namespace

const char* record_kind_name(RecordKind kind) {
  switch (kind) {
    case RecordKind::power_on:
      return "power_on";
    case RecordKind::boot:
      return "boot";
    case RecordKind::wait:
      return "wait";
    case RecordKind::deep_sleep:
      return "deep_sleep";
    case RecordKind::restart:
      return "restart";
    case RecordKind::power_loss:
      return "power_loss";
    case RecordKind::input:
      return "input";
    case RecordKind::transmission:
      return "transmission";
    case RecordKind::reception:
      return "reception";
    case RecordKind::crc_error:
      return "crc_error";
    case RecordKind::collision:
      return "collision";
    case RecordKind::rx_window:
      return "rx_window";
    case RecordKind::rx_timeout:
      return "rx_timeout";
    case RecordKind::channel_check:
      return "channel_check";
    case RecordKind::flash_write:
      return "flash_write";
    case RecordKind::flash_erase:
      return "flash_erase";
    case RecordKind::retained_write:
      return "retained_write";
    case RecordKind::output:
      return "output";
    case RecordKind::buzzer:
      return "buzzer";
    case RecordKind::led:
      return "led";
    case RecordKind::link_up:
      return "link_up";
    case RecordKind::link_down:
      return "link_down";
    case RecordKind::link_sent:
      return "link_sent";
    case RecordKind::link_received:
      return "link_received";
    case RecordKind::slot_erase:
      return "slot_erase";
    case RecordKind::slot_write:
      return "slot_write";
    case RecordKind::otadata_write:
      return "otadata_write";
  }
  return "?";
}

ActorId Timeline::add_actor(const std::string& name) {
  actors_.push_back(name);
  return actors_.size() - 1;
}

const std::string& Timeline::actor_name(ActorId actor) const {
  static const std::string none = "-";
  return actor < actors_.size() ? actors_[actor] : none;
}

void Timeline::add(const Record& record) {
  if (!records_.empty() && record.at < records_.back().at) {
    throw SimulationError("timeline record out of order at " + format_instant(record.at));
  }
  records_.push_back(record);
  if (listener_) {
    listener_(record);
  }
}

Selection Timeline::select() const {
  return Selection(*this);
}

Selection Timeline::of(ActorId actor) const {
  return select().of(actor);
}

std::string Timeline::describe(const Record& record) const {
  std::ostringstream out;
  char head[64];
  std::snprintf(head, sizeof(head), "%14s  ", format_instant(record.at).c_str());
  out << head << actor_name(record.actor) << "  " << record_kind_name(record.kind);
  switch (record.kind) {
    case RecordKind::boot:
      out << " kind " << record.value << (record.flag ? " (timer)" : "");
      break;
    case RecordKind::wait:
      out << (record.value == 1 ? " light" : " awake");
      break;
    case RecordKind::deep_sleep:
      out << " until " << format_instant(record.until) << " inputs 0x" << std::hex << record.value
          << std::dec;
      break;
    case RecordKind::input:
      out << " " << record.value << (record.flag ? " active" : " inactive");
      break;
    case RecordKind::transmission:
      out << " " << radio_text(record) << " " << record.rssi_dbm << " dBm " << record.length
          << " B until " << format_instant(record.until) << " " << label_text(record.label);
      break;
    case RecordKind::reception:
      out << " from " << actor_name(record.peer) << " " << radio_text(record) << " "
          << record.rssi_dbm << " dBm snr/4 " << static_cast<int>(record.snr_quarter_db) << " "
          << label_text(record.label);
      break;
    case RecordKind::crc_error:
    case RecordKind::collision:
      out << " of " << actor_name(record.peer) << "'s " << label_text(record.label);
      break;
    case RecordKind::rx_window:
      out << " " << record.frequency_hz << " Hz rates 0x" << std::hex << record.value << std::dec
          << " until " << format_instant(record.until);
      break;
    case RecordKind::channel_check:
      out << " " << radio_text(record) << (record.flag ? " busy" : " clear");
      break;
    case RecordKind::flash_write:
    case RecordKind::flash_erase:
      out << " key 0x" << std::hex << record.value << std::dec << " " << record.length << " B"
          << (record.flag ? " FAILED" : "");
      break;
    case RecordKind::retained_write:
      out << " " << record.value << " bytes changed";
      break;
    case RecordKind::output:
      out << (record.flag ? " on" : " off");
      break;
    case RecordKind::buzzer:
    case RecordKind::led:
      out << " " << record.value;
      break;
    case RecordKind::link_up:
    case RecordKind::link_down:
      out << " " << link_text(record.value);
      break;
    case RecordKind::link_sent:
    case RecordKind::link_received:
      out << " " << link_text(record.value) << " " << record.length << " B "
          << label_text(record.label);
      break;
    case RecordKind::slot_erase:
    case RecordKind::slot_write:
      out << " at " << record.value << " " << record.length << " B"
          << (record.flag ? " FAILED" : "");
      break;
    case RecordKind::otadata_write:
      out << " copy " << record.length << " state " << record.value
          << (record.flag ? " FAILED" : "");
      break;
    case RecordKind::power_loss:
      if (record.flag) {
        out << " cut at flash operation " << record.value;
      }
      break;
    case RecordKind::restart:
      out << (record.flag ? " watchdog" : "");
      break;
    default:
      break;
  }
  return out.str();
}

Selection Selection::of(ActorId actor) const {
  Selection next = *this;
  next.actor_ = actor;
  return next;
}

Selection Selection::kind(RecordKind kind) const {
  Selection next = *this;
  next.kinds_ |= kind_bit(kind);
  return next;
}

Selection Selection::between(device::Instant from, device::Instant to) const {
  Selection next = *this;
  next.from_ = from;
  next.to_ = to;
  return next;
}

Selection Selection::type(std::uint8_t message_type) const {
  Selection next = *this;
  next.typed_ = true;
  next.type_ = message_type;
  return next;
}

Selection Selection::where(std::function<bool(const Record&)> predicate) const {
  Selection next = *this;
  next.predicates_.push_back(std::move(predicate));
  return next;
}

template <typename Visit>
void Selection::each(Visit visit) const {
  const std::vector<Record>& all = timeline_->records();
  // Records are in time order, so the time range is found by binary search.
  auto it =
      std::lower_bound(all.begin(), all.end(), from_,
                       [](const Record& record, device::Instant at) { return record.at < at; });
  for (; it != all.end() && it->at < to_; ++it) {
    const Record& record = *it;
    if (actor_ != kNoActor && record.actor != actor_) {
      continue;
    }
    if (kinds_ != 0 && (kinds_ & kind_bit(record.kind)) == 0) {
      continue;
    }
    if (typed_ && record.label.type != type_) {
      continue;
    }
    bool accepted = true;
    for (const auto& predicate : predicates_) {
      if (!predicate(record)) {
        accepted = false;
        break;
      }
    }
    if (accepted) {
      visit(record);
    }
  }
}

std::size_t Selection::count() const {
  std::size_t total = 0;
  each([&](const Record&) { total += 1; });
  return total;
}

std::vector<Record> Selection::records() const {
  std::vector<Record> found;
  each([&](const Record& record) { found.push_back(record); });
  return found;
}

std::vector<std::uint8_t> Selection::message_types() const {
  std::vector<std::uint8_t> types;
  each([&](const Record& record) { types.push_back(record.label.type); });
  return types;
}

std::string Selection::type_names() const {
  std::string names;
  each([&](const Record& record) {
    if (!names.empty()) {
      names += ", ";
    }
    names += type_name_or_unknown(record.label.type);
  });
  return names;
}

device::Duration Selection::airtime() const {
  device::Duration total;
  each([&](const Record& record) {
    if (record.kind == RecordKind::transmission) {
      total = total + (record.until - record.from);
    }
  });
  return total;
}

device::Duration Selection::busiest(device::Duration window) const {
  std::vector<std::pair<device::Instant, device::Instant>> spans;
  each([&](const Record& record) {
    if (record.kind == RecordKind::transmission) {
      spans.emplace_back(record.from, record.until);
    }
  });
  std::sort(spans.begin(), spans.end());
  // Prefix sums of lengths, and the longest span, which bounds how far back a span can reach.
  std::vector<std::int64_t> prefix(spans.size() + 1, 0);
  std::int64_t longest = 0;
  for (std::size_t i = 0; i < spans.size(); ++i) {
    const std::int64_t length = (spans[i].second - spans[i].first).us;
    prefix[i + 1] = prefix[i] + length;
    longest = std::max(longest, length);
  }
  const auto first_starting_at = [&](device::Instant at) {
    return static_cast<std::size_t>(
        std::lower_bound(spans.begin(), spans.end(), at,
                         [](const auto& span, device::Instant t) { return span.first < t; }) -
        spans.begin());
  };
  // Airtime inside [start, start + window): whole spans starting inside, less what sticks out at
  // the end, plus the parts of spans that started before.
  const auto inside = [&](device::Instant start) {
    const device::Instant end = start + window;
    const std::size_t a = first_starting_at(start);
    const std::size_t b = first_starting_at(end);
    std::int64_t total = prefix[b] - prefix[a];
    for (std::size_t k = b; k > a && (spans[k - 1].first + device::Duration{longest}) > end; --k) {
      if (spans[k - 1].second > end) {
        total -= (spans[k - 1].second - end).us;
      }
    }
    for (std::size_t k = a; k > 0 && (spans[k - 1].first + device::Duration{longest}) > start;
         --k) {
      const device::Instant stop = std::min(spans[k - 1].second, end);
      if (stop > start) {
        total += (stop - start).us;
      }
    }
    return total;
  };
  // The total is piecewise linear in the window's start, so its maximum is at a window that
  // starts where a span starts or ends where a span ends.
  std::int64_t best = 0;
  for (const auto& span : spans) {
    best = std::max(best, inside(span.first));
    best = std::max(best, inside(span.second + device::Duration{-window.us}));
  }
  return device::Duration{best};
}

std::string Selection::dump() const {
  std::string text;
  each([&](const Record& record) {
    text += timeline_->describe(record);
    text += "\n";
  });
  return text;
}

}  // namespace hsn::host
