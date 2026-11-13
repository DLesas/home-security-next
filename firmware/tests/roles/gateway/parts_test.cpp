// The gateway's small parts on their own: the 32-bit clock and the nearest instant, the transmit
// queue's order and bounds, the noise monitor's median, normal level and episodes, the choice of
// one data rate.

#include "gateway_bench.hpp"
#include "hsn/roles/gateway/gateway_clock.hpp"
#include "hsn/roles/gateway/gateway_settings.hpp"
#include "hsn/roles/gateway/noise_monitor.hpp"
#include "hsn/roles/gateway/transmit_queue.hpp"

namespace hsn::test {
namespace {

using namespace roles::gateway;

constexpr std::uint64_t kSpan = std::uint64_t{1} << 32;

TEST_CASE(
    "§6 the gateway clock is the instant's low 32 bits; a value maps to the nearest instant") {
  CHECK(clock_value(Instant{kSpan * 3 + 17}) == 17u);
  const Instant now{kSpan * 5 + 1000};
  CHECK(nearest_instant(now, 2000) == Instant{kSpan * 5 + 2000});
  CHECK(nearest_instant(now, 500) == Instant{kSpan * 5 + 500});
  // Just below a wrap: a small value is just ahead, a large one just behind.
  const Instant late{kSpan * 5 + kSpan - 10};
  CHECK(nearest_instant(late, 5) == Instant{kSpan * 6 + 5});
  CHECK(nearest_instant(Instant{kSpan * 6 + 5}, 0xFFFFFFF0u) == Instant{kSpan * 5 + 0xFFFFFFF0u});
  // Near zero nothing goes below it.
  CHECK(nearest_instant(Instant{100}, 0xFFFFFF00u) == Instant{0xFFFFFF00u});
  // Exactly half a span away stays where it is.
  CHECK(nearest_instant(Instant{kSpan * 2}, 0x80000000u) == Instant{kSpan * 2 + 0x80000000u});
}

TEST_CASE(
    "the transmit queue: a fixed number of places, siren commands first, then first come first "
    "served") {
  TransmitQueue queue;
  const Bytes packet = opaque_packet(1, 1);
  for (std::uint32_t i = 0; i < kTransmitQueueSize; ++i) {
    TransmitEntry entry;
    entry.counter = i;
    entry.siren_command = i == 5;
    CHECK(queue.add(entry, view_of(packet)) != TransmitQueue::kNone);
  }
  CHECK(queue.full());
  CHECK(queue.add(TransmitEntry{}, view_of(packet)) == TransmitQueue::kNone);
  CHECK(queue.entry(queue.next_as_soon_as_possible()).counter == 5);
  CHECK(queue.entry(queue.newest_routine()).counter == kTransmitQueueSize - 1);
  queue.remove(queue.next_as_soon_as_possible());
  CHECK(queue.entry(queue.next_as_soon_as_possible()).counter == 0);
  CHECK(Bytes(queue.packet(0).begin(), queue.packet(0).end()) == packet);
  CHECK(queue.clear() == kTransmitQueueSize - 1);
  CHECK(queue.empty());
  // A packet longer than the radio takes is refused.
  CHECK(queue.add(TransmitEntry{}, view_of(Bytes(256, 0))) == TransmitQueue::kNone);
}

TEST_CASE("the transmit queue's deadlines: moments, and the instant after a latest moment") {
  TransmitQueue queue;
  const Bytes packet = opaque_packet(1, 1);
  TransmitEntry timed;
  timed.timing = TransmitTiming::at_time;
  timed.when = Instant{5000};
  TransmitEntry limited;
  limited.when = Instant{3000};
  TransmitEntry open;
  static_cast<void>(queue.add(timed, view_of(packet)));
  static_cast<void>(queue.add(limited, view_of(packet)));
  static_cast<void>(queue.add(open, view_of(packet)));
  CHECK(queue.next_deadline() == Instant{3001});
  CHECK(queue.expired(Instant{3000}) == TransmitQueue::kNone);
  CHECK(queue.expired(Instant{3001}) != TransmitQueue::kNone);
  CHECK(queue.due_at_time(Instant{4999}) == TransmitQueue::kNone);
  CHECK(queue.due_at_time(Instant{5000}) != TransmitQueue::kNone);
}

TEST_CASE("GW11 the noise monitor: median, highest, a normal level by integer averaging") {
  NoiseState state;
  NoiseMonitor monitor(state);
  CHECK(monitor.median() == kNoNoiseReading);
  CHECK(monitor.normal() == kNoNoiseReading);
  InterferenceLimits limits;
  const std::int16_t levels[] = {-110, -118, -116, -117, -112};
  for (std::size_t i = 0; i < 5; ++i) {
    CHECK(monitor.sample(Instant{} + seconds(static_cast<std::int64_t>(i)), levels[i], limits)
              .change == InterferenceChange::none);
  }
  CHECK(monitor.median() == -116);
  CHECK(monitor.highest() == -110);
  // The running mean of -110, -118, -116, -117, -112 is -114.6, rounded: -115.
  CHECK(monitor.normal() == -115);
  monitor.start_period();
  CHECK(monitor.median() == kNoNoiseReading);
  CHECK(monitor.highest() == kNoNoiseReading);
  CHECK(monitor.normal() == -115);
  // At most 64 samples are kept, and readings beyond a byte are limited to it.
  for (std::int64_t i = 0; i < 100; ++i) {
    static_cast<void>(monitor.sample(Instant{} + seconds(10 + i), -200, limits));
  }
  CHECK(state.sample_count == kNoiseSampleCount);
  CHECK(monitor.median() == -128);
}

TEST_CASE(
    "GW11 an episode: suspected, started after the duration, ended on the first quiet sample") {
  NoiseState state;
  NoiseMonitor monitor(state);
  InterferenceLimits limits;
  limits.threshold_db = 10;
  limits.seconds = 5;
  static_cast<void>(monitor.sample(Instant{}, -117, limits));
  {
    // 10 dB above is not above the threshold; 11 is.
    NoiseState other = state;
    NoiseMonitor probe(other);
    static_cast<void>(probe.sample(Instant{} + seconds(1), -107, limits));
    CHECK(other.phase == InterferencePhase::normal);
    other = state;
    static_cast<void>(probe.sample(Instant{} + seconds(1), -106, limits));
    CHECK(other.phase == InterferencePhase::suspected);
  }
  for (std::int64_t t = 2; t < 6; ++t) {
    CHECK(monitor.sample(Instant{} + seconds(t), -100, limits).change == InterferenceChange::none);
  }
  // A single quiet sample ends a suspicion: no false start.
  CHECK(monitor.sample(Instant{} + seconds(6), -117, limits).change == InterferenceChange::none);
  for (std::int64_t t = 7; t < 12; ++t) {
    CHECK(monitor.sample(Instant{} + seconds(t), -100, limits).change == InterferenceChange::none);
  }
  const InterferenceReport started = monitor.sample(Instant{} + seconds(12), -96, limits);
  CHECK(started.change == InterferenceChange::started);
  CHECK(started.duration_seconds == 5);
  CHECK(started.noise_dbm == -99);  // (-100 × 5 − 96) ÷ 6, toward zero
  CHECK(monitor.sample(Instant{} + seconds(13), -100, limits).change == InterferenceChange::none);
  const InterferenceReport ended = monitor.sample(Instant{} + seconds(20), -116, limits);
  CHECK(ended.change == InterferenceChange::ended);
  CHECK(ended.duration_seconds == 13);
  // The episode taught the normal level nothing.
  CHECK(monitor.normal() == -117);
}

TEST_CASE("O14 one data rate: the slowest the mask names") {
  CHECK(listen_data_rate(0x20) == std::optional<std::uint8_t>(5));
  CHECK(listen_data_rate(0x24) == std::optional<std::uint8_t>(2));
  CHECK(listen_data_rate(0x3F) == std::optional<std::uint8_t>(0));
  CHECK_FALSE(listen_data_rate(0xC0).has_value());
  CHECK(names_several_data_rates(0x24));
  CHECK_FALSE(names_several_data_rates(0xA0));
  HeldSettings none;
  none.status_interval_seconds = 0;
  none.interference_threshold_db = 0;
  none.interference_seconds = 0;
  CHECK(status_interval(none) == seconds(30));
  CHECK(interference_limits(none).threshold_db == 10);
  CHECK(interference_limits(none).seconds == 30);
}

}  // namespace
}  // namespace hsn::test
