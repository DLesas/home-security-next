// The controller's side of the lockstep socket (hub-design.md section 11, "Transport"): a line
// from the hub that arrives in many pieces is read whole, and a long line to the hub is written
// whole, whatever the socket takes at a time. Against a stand-in hub (fake_hub.ts) that writes
// its answers 100 bytes at a time and says how long each line it got was.

#include <doctest/doctest.h>

#include <string>

#include "hsn/host/lockstep.hpp"
#include "lockstep_support.hpp"

namespace hsn::test {
namespace {

namespace lockstep = host::lockstep;

TEST_CASE("lockstep: lines both ways arrive whole, whatever their size and pieces") {
  lockstep::RunFolder folder;
  lockstep::HubProcess hub(host::lockstep::HubProgram{HSN_BUN, HSN_FAKE_HUB}, folder.data(),
                           folder.socket());
  // The start's answer is about 600 kB, sent in some 6,000 pieces.
  const std::string start =
      R"({"type":"start","version":2,"at":0,"wall":0,"trusted":true,)"
      R"("seed":"0000000000000000000000000000000000000000000000000000000000000000"})";
  const auto started = hub.send_line(start, 1, true);
  REQUIRE(started.size() == 1);
  const lockstep::FromHub idle = lockstep::read_from_hub(started[0]);
  CHECK(started[0].size() > 600000);
  CHECK(idle.to == static_cast<std::int64_t>(start.size()));
  REQUIRE(idle.records.size() == 1);
  CHECK(idle.records[0].at("row").at("message").as_string().size() == 600000);
  // A line of 900 kB to the hub, far more than a socket's buffer, reaches it whole: the hub
  // counts it from its line end.
  const std::string padding(900000, 'a');
  const std::string long_line = R"({"type":"advance","to":0,"pad":")" + padding + "\"}";
  const auto advanced = hub.send_line(long_line, 1, false);
  REQUIRE(advanced.size() == 1);
  CHECK(lockstep::read_from_hub(advanced[0]).to == static_cast<std::int64_t>(long_line.size()));
  // Several lines in a row, each answered in pieces, are kept apart.
  for (int i = 0; i < 20; ++i) {
    const auto answer = hub.send_line(R"({"type":"advance","to":7})", 1, false);
    REQUIRE(answer.size() == 1);
    CHECK(lockstep::read_from_hub(answer[0]).to == 25);
  }
}

}  // namespace
}  // namespace hsn::test
