// Time arithmetic, the clock correction, and TimerSet.

#include "hsn/device/time.hpp"
#include "device_support.hpp"
#include "hsn/device/timers.hpp"

namespace hsn::test {
namespace {

using device::Duration;

TEST_CASE("instants saturate instead of wrapping") {
  CHECK((Instant::never() + device::seconds(5)).is_never());
  CHECK((Instant{3} + device::microseconds(-10)).us == 0);
  CHECK((Instant{10} + device::microseconds(-3)).us == 7);
  CHECK((Instant{Instant::never().us - 2} + device::seconds(1)).us == Instant::never().us - 1);
  CHECK((Instant{5} - Instant{8}).us == -3);
  CHECK(device::earliest(Instant{4}, Instant::never()).us == 4);
}

TEST_CASE("clock correction stretches by parts per million, rounded to the microsecond") {
  CHECK(device::corrected(device::seconds(180), 0) == device::seconds(180));
  CHECK(device::corrected(device::seconds(180), 1000) == device::microseconds(180180000));
  CHECK(device::corrected(device::seconds(180), -1000) == device::microseconds(179820000));
  // Half a microsecond rounds away from zero.
  CHECK(device::corrected(device::microseconds(1), 500000) == device::microseconds(2));
  CHECK(device::corrected(device::microseconds(1), -500000) == device::microseconds(0));
  // The reply field's extremes, ±327,680 ppm, over a day.
  CHECK(device::corrected(device::seconds(86400), 327680).us == 86400000000 + 28311552000);
  CHECK(device::corrected(device::seconds(86400), -327680).us == 86400000000 - 28311552000);
}

enum class T : std::uint8_t { a, b, c };

TEST_CASE("a timer set keeps deadlines and gives the earliest") {
  device::TimerSet<T, 3> timers;
  CHECK(timers.earliest().is_never());
  timers.arm(T::b, at_seconds(10));
  timers.arm(T::c, at_seconds(4));
  CHECK(timers.earliest() == at_seconds(4));
  CHECK_FALSE(timers.take_if_due(T::b, at_seconds(9)));
  CHECK(timers.take_if_due(T::c, at_seconds(4)));
  CHECK_FALSE(timers.armed(T::c));
  CHECK(timers.earliest() == at_seconds(10));
  timers.cancel_all();
  CHECK(timers.earliest().is_never());
  static_assert(std::is_trivially_copyable_v<device::TimerSet<T, 3>>);
}

}  // namespace
}  // namespace hsn::test
