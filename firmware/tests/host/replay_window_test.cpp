// The test hub's receiving rule (protocol section 4) against counters.json's replayWindow
// section, which the codec's vector harness skips because the firmware does not contain it.

#include <doctest/doctest.h>

#include <string>

#include "hsn/host/replay_window.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

std::string verdict_name(protocol::CounterVerdict verdict) {
  switch (verdict) {
    case protocol::CounterVerdict::accepted:
      return "accepted";
    case protocol::CounterVerdict::duplicate:
      return "duplicate";
    case protocol::CounterVerdict::too_old:
      return "tooOld";
  }
  return "?";
}

TEST_CASE("the hub's 64-packet replay window matches the vectors") {
  const json file = load_json(std::filesystem::path(HSN_VECTORS_DIR) / "counters.json");
  const json& sequences = file.at("replayWindow");
  REQUIRE(sequences.size() > 0);
  for (const json& sequence : sequences) {
    INFO("sequence: " << sequence.at("name").get<std::string>());
    host::ReplayWindow window;
    for (const json& step : sequence.at("steps")) {
      INFO("counter " << step.at("counter").get<std::uint32_t>());
      const protocol::CounterVerdict verdict =
          window.accept(step.at("counter").get<std::uint32_t>());
      if (step.at("accepted").get<bool>()) {
        CHECK(verdict == protocol::CounterVerdict::accepted);
        CHECK(window.highest() == step.at("highest").get<std::uint32_t>());
        CHECK(to_hex(window.state_bytes()) == step.at("state").get<std::string>());
      } else {
        CHECK(verdict_name(verdict) == step.at("rejection").get<std::string>());
      }
    }
  }
}

TEST_CASE("the replay window refuses counter 0 and accepts a first counter of any size") {
  host::ReplayWindow window;
  CHECK(window.check(0) == protocol::CounterVerdict::too_old);
  CHECK(window.accept(1024) == protocol::CounterVerdict::accepted);
  CHECK(window.accept(1024) == protocol::CounterVerdict::duplicate);
  CHECK(window.accept(960) == protocol::CounterVerdict::accepted);
  CHECK(window.accept(959) == protocol::CounterVerdict::too_old);
}

}  // namespace
}  // namespace hsn::test
