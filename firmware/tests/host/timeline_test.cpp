// The timeline's selections and assertion helpers, on hand-made records.

#include <doctest/doctest.h>

#include "hsn/host/sim_time.hpp"
#include "hsn/host/timeline.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::test {
namespace {

using device::milliseconds;
using device::seconds;
using host::at;
using host::Record;
using host::RecordKind;

Record transmission(host::ActorId actor, device::Instant from, device::Duration length,
                    std::uint8_t type) {
  Record record;
  record.at = from;
  record.actor = actor;
  record.kind = RecordKind::transmission;
  record.from = from;
  record.until = from + length;
  record.label.has_header = true;
  record.label.type = type;
  return record;
}

TEST_CASE("selections filter by actor, kind, time and type, and name the types in order") {
  host::Timeline timeline;
  const host::ActorId door = timeline.add_actor("door");
  const host::ActorId hub = timeline.add_actor("hub");
  timeline.add(
      transmission(door, at(seconds(1)), milliseconds(62), protocol::message_type::door_changed));
  timeline.add(transmission(hub, at(seconds(2)), milliseconds(72), protocol::message_type::reply));
  Record write;
  write.at = at(seconds(3));
  write.actor = door;
  write.kind = RecordKind::flash_write;
  timeline.add(write);
  timeline.add(
      transmission(door, at(seconds(4)), milliseconds(62), protocol::message_type::heartbeat));

  CHECK(timeline.select().count() == 4);
  CHECK(timeline.of(door).count() == 3);
  CHECK(timeline.of(door).kind(RecordKind::transmission).type_names() == "door_changed, heartbeat");
  CHECK(timeline.select()
            .kind(RecordKind::transmission)
            .between(at(seconds(1)), at(seconds(4)))
            .type_names() == "door_changed, reply");
  CHECK(timeline.of(door).kind(RecordKind::flash_write).count() == 1);
  CHECK(timeline.of(door).kind(RecordKind::flash_write).kind(RecordKind::transmission).count() ==
        3);
  CHECK(timeline.select().type(protocol::message_type::reply).count() == 1);
  CHECK(timeline.of(door).airtime() == milliseconds(124));
  CHECK(timeline.of(hub).dump().find("hub  transmission") != std::string::npos);
  // Out of order is a bench error.
  CHECK_THROWS(timeline.add(transmission(door, at(seconds(1)), milliseconds(1), 0)));
}

TEST_CASE("the busiest window counts the parts of transmissions inside it") {
  host::Timeline timeline;
  const host::ActorId door = timeline.add_actor("door");
  // On air during [0, 10), [3600, 3605) and [3604, 3609) seconds.
  timeline.add(transmission(door, at(seconds(0)), seconds(10), 0));
  timeline.add(transmission(door, at(seconds(3600)), seconds(5), 0));
  timeline.add(transmission(door, at(seconds(3604)), seconds(5), 0));
  // An hour from 5 s holds the first one's last 5 s, all of the second and 1 s of the third;
  // from 9 s, 1 s of the first and both others whole. No hour holds more than 11 s.
  CHECK(timeline.of(door).busiest_hour() == seconds(11));
  CHECK(timeline.of(door).busiest(seconds(20)) == seconds(10));
  // Overlapping transmissions both count: [3604, 3605) holds 2 s of airtime.
  CHECK(timeline.of(door).busiest(seconds(1)) == seconds(2));
}

}  // namespace
}  // namespace hsn::test
