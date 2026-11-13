// The real-time driver (hub-design.md section 11, item 1) against a host clock moved by hand: it
// follows the host clock, never runs ahead of it, delivers input at its arrival instant, and
// reports lags over 5 ms.

#include <doctest/doctest.h>

#include <vector>

#include "hsn/host/real_time.hpp"
#include "hsn/host/sim_time.hpp"

namespace hsn::test {
namespace {

using device::milliseconds;
using device::seconds;
using host::at;

TEST_CASE("true time follows the host clock and never runs ahead of it") {
  host::Simulation sim;
  host::ManualHostClock clock;
  clock.advance(seconds(100));  // the host clock's origin is arbitrary
  host::RealTimeDriver driver(sim, clock);
  std::vector<device::Instant> ran;
  sim.schedule(at(seconds(1)), [&]() { ran.push_back(sim.now()); });
  sim.schedule(at(seconds(3)), [&]() { ran.push_back(sim.now()); });

  clock.advance(milliseconds(999));
  driver.catch_up();
  CHECK(ran.empty());
  CHECK(sim.now() == at(milliseconds(999)));
  CHECK(driver.time_to_next(seconds(10)) == milliseconds(1));
  clock.advance(milliseconds(1));
  driver.catch_up();
  REQUIRE(ran.size() == 1);
  CHECK(ran[0] == at(seconds(1)));
  CHECK(sim.now() == at(seconds(1)));
  CHECK(driver.time_to_next(milliseconds(50)) == milliseconds(50));
  CHECK(driver.lags() == 0);
}

TEST_CASE("input is delivered at the host instant it arrived, with what it makes due") {
  host::Simulation sim;
  host::ManualHostClock clock;
  host::RealTimeDriver driver(sim, clock);
  clock.advance(milliseconds(1234));
  device::Instant delivered;
  device::Instant follow_up;
  driver.deliver([&]() {
    delivered = sim.now();
    sim.schedule(sim.now(), [&]() { follow_up = sim.now(); });
  });
  CHECK(delivered == at(milliseconds(1234)));
  CHECK(follow_up == at(milliseconds(1234)));
}

TEST_CASE("an action that runs more than 5 ms late is reported; 5 ms or less is not") {
  host::Simulation sim;
  host::ManualHostClock clock;
  host::RealTimeDriver driver(sim, clock);
  std::vector<host::Lag> lags;
  driver.set_lag_listener([&](const host::Lag& lag) { lags.push_back(lag); });
  sim.schedule(at(seconds(1)), []() {});
  sim.schedule(at(seconds(2)), []() {});
  clock.advance(seconds(1) + milliseconds(5));
  driver.catch_up();
  CHECK(lags.empty());
  clock.advance(seconds(1) + milliseconds(7));  // host at 2.012 s: the 2 s action is 12 ms late
  driver.catch_up();
  REQUIRE(lags.size() == 1);
  CHECK(lags[0].due == at(seconds(2)));
  CHECK(lags[0].by == milliseconds(12));
  CHECK(driver.lags() == 1);
  CHECK(driver.worst_lag() == milliseconds(12));
  // Overdue now: the loop must not wait.
  sim.schedule(at(seconds(2)), []() {});
  CHECK(driver.time_to_next(seconds(1)) == device::Duration{});
}

}  // namespace
}  // namespace hsn::test
