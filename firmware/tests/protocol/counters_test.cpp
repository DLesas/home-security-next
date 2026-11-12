#include <random>
#include <set>

#include "hsn/protocol/counters.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::CounterStep;
using protocol::CounterVerdict;
using protocol::Error;
using protocol::SendCounter;

TEST_CASE("a paired counter starts at 1 with one step saved") {
  const SendCounter sensor = SendCounter::paired(CounterStep::sensor);
  CHECK(sensor.next() == 1);
  CHECK(sensor.resume_point() == 64);
  const SendCounter siren = SendCounter::paired(CounterStep::siren_or_gateway);
  CHECK(siren.resume_point() == 1024);
  const SendCounter resumed = SendCounter::resumed(CounterStep::sensor, 192);
  CHECK(resumed.next() == 192);
  CHECK(resumed.resume_point() == 192);
}

TEST_CASE("a resumed counter rounds the saved resume point up to a step") {
  CHECK(SendCounter::resumed(CounterStep::sensor, 128).next() == 128);
  CHECK(SendCounter::resumed(CounterStep::sensor, 100).next() == 128);
  CHECK(SendCounter::resumed(CounterStep::sensor, 1).next() == 64);
  CHECK(SendCounter::resumed(CounterStep::sensor, 0).next() == 64);
  CHECK(SendCounter::resumed(CounterStep::siren_or_gateway, 1025).next() == 2048);
  SendCounter odd = SendCounter::resumed(CounterStep::sensor, 100);
  CHECK(odd.resume_point() == 128);
  const auto taken = odd.take();
  REQUIRE(taken.ok());
  CHECK(taken.value().counter == 128);
  CHECK(taken.value().save_resume_point);
  CHECK(taken.value().resume_point == 192);
}

TEST_CASE("a resumed counter at the top of the 32-bit range keeps the exhaustion rule") {
  // 0xFFFFFF7F rounds to 0xFFFFFF80, the last step that can still save a resume point.
  SendCounter last = SendCounter::resumed(CounterStep::sensor, 0xFFFFFF7Fu);
  CHECK(last.next() == 0xFFFFFF80u);
  for (std::uint32_t expected = 0xFFFFFF80u; expected < 0xFFFFFFC0u; ++expected) {
    const auto taken = last.take();
    REQUIRE(taken.ok());
    CHECK(taken.value().counter == expected);
  }
  CHECK(last.take().error() == Error::counter_exhausted);
  // Values that round past the last multiple that fits resume there, already exhausted.
  for (const std::uint32_t saved : {0xFFFFFF81u, 0xFFFFFFC0u, 0xFFFFFFF0u, 0xFFFFFFFFu}) {
    SendCounter top = SendCounter::resumed(CounterStep::sensor, saved);
    CHECK(top.next() == 0xFFFFFFC0u);
    CHECK(top.take().error() == Error::counter_exhausted);
  }
  SendCounter siren = SendCounter::resumed(CounterStep::siren_or_gateway, 0xFFFFFC01u);
  CHECK(siren.next() == 0xFFFFFC00u);
  CHECK(siren.take().error() == Error::counter_exhausted);
}

TEST_CASE("a counter state that could repeat a counter is refused") {
  SendCounter zero(CounterStep::sensor, 0, 64);
  CHECK(zero.take().error() == Error::bad_counter);
  SendCounter past(CounterStep::sensor, 70, 64);
  CHECK(past.take().error() == Error::bad_counter);
  CHECK(past.next() == 70);
  SendCounter equal(CounterStep::sensor, 65, 65);
  CHECK(equal.take().error() == Error::bad_counter);
  SendCounter no_step(static_cast<CounterStep>(0), 1, 64);
  CHECK(no_step.take().error() == Error::bad_counter);
}

TEST_CASE("an exhausted counter stays exhausted") {
  SendCounter counter(CounterStep::siren_or_gateway, 0xFFFFFC00u, 0xFFFFFC00u);
  for (int i = 0; i < 3; ++i) {
    CHECK(counter.take().error() == Error::counter_exhausted);
    CHECK(counter.next() == 0xFFFFFC00u);
  }
}

TEST_CASE("power losses never repeat a counter") {
  std::mt19937 random(0x5EED1);
  for (const CounterStep step : {CounterStep::sensor, CounterStep::siren_or_gateway}) {
    SendCounter counter = SendCounter::paired(step);
    std::uint32_t flash = counter.resume_point();
    std::set<std::uint32_t> used;
    for (int i = 0; i < 20000; ++i) {
      if (random() % 97 == 0) {
        counter = SendCounter::resumed(step, flash);
        continue;
      }
      const auto taken = counter.take();
      REQUIRE(taken.ok());
      if (taken.value().save_resume_point) {
        flash = taken.value().resume_point;
      }
      CHECK(taken.value().counter != 0);
      CHECK(taken.value().counter < flash);
      CHECK(used.insert(taken.value().counter).second);
    }
  }
}

TEST_CASE("the strictly-higher rule checks without recording") {
  protocol::StrictlyHigherCounter counter(10);
  CHECK(counter.check(11) == CounterVerdict::accepted);
  CHECK(counter.last_accepted() == 10);
  CHECK(counter.check(10) == CounterVerdict::duplicate);
  CHECK(counter.check(9) == CounterVerdict::too_old);
  CHECK(counter.accept(9) == CounterVerdict::too_old);
  CHECK(counter.last_accepted() == 10);
  CHECK(counter.accept(12) == CounterVerdict::accepted);
  CHECK(counter.last_accepted() == 12);
  CHECK(protocol::StrictlyHigherCounter().check(0) == CounterVerdict::duplicate);
}

}  // namespace
}  // namespace hsn::test
