// The lockstep wire in C++ against the real hub (hub-design.md section 11, "The recorded
// sessions"): each recorded session replayed line by line to a real hub process on a Unix
// socket, every answer required to be the one recorded. Each line the controller sent is read
// strictly and written back to the same text; each answer read strictly and written back to the
// same value.

#include <doctest/doctest.h>

#include <fstream>
#include <string>
#include <vector>

#include "hsn/host/lockstep.hpp"
#include "lockstep_support.hpp"

namespace hsn::test {
namespace {

namespace lockstep = host::lockstep;
namespace json = host::json;

struct Step {
  std::string sent;
  std::vector<std::string> answers;
};

std::vector<Step> read_session(const std::string& name) {
  std::ifstream file(std::string(HSN_LOCKSTEP_SESSIONS) + "/" + name + ".session");
  REQUIRE(file.good());
  std::vector<Step> steps;
  std::string line;
  while (std::getline(file, line)) {
    if (line.rfind("> ", 0) == 0) {
      steps.push_back(Step{line.substr(2), {}});
    } else if (line.rfind("< ", 0) == 0) {
      REQUIRE_FALSE(steps.empty());
      steps.back().answers.push_back(line.substr(2));
    } else {
      REQUIRE(line.empty());
    }
  }
  return steps;
}

/** A hub answer, with its `wake` left out when the session's times are not the hub's own. */
json::Value without_wake(const json::Value& answer, bool compare_wake) {
  if (compare_wake || answer.find("wake") == nullptr) {
    return answer;
  }
  json::Value out = json::Value::object();
  for (const json::Value::Member& member : answer.as_object()) {
    if (member.first != "wake") {
      out.set(member.first, member.second);
    }
  }
  return out;
}

/**
 * Replays a session; returns how many answers were compared. `compare_wake` is false for a
 * session whose times are the bench's, not the hub's (burst-hang: hub-design.md section 11).
 */
std::size_t replay(const std::string& name, bool compare_wake = true) {
  lockstep::RunFolder folder;
  lockstep::HubProcess hub(hub_program(), folder.data(), folder.socket());
  std::size_t compared = 0;
  for (const Step& step : read_session(name)) {
    INFO(step.sent);
    const lockstep::ToHub message = lockstep::read_to_hub(step.sent);
    CHECK(lockstep::write(message) == step.sent);
    const auto answers =
        hub.send_line(step.sent, message.answers(), message.type == lockstep::ToHub::Type::start);
    REQUIRE(answers.size() == step.answers.size());
    for (std::size_t i = 0; i < answers.size(); ++i) {
      INFO(answers[i]);
      const json::Value got = json::parse(answers[i]);
      CHECK(without_wake(got, compare_wake) ==
            without_wake(json::parse(step.answers[i]), compare_wake));
      CHECK(json::parse(lockstep::write(lockstep::read_from_hub(answers[i]))) == got);
      compared += 1;
    }
  }
  return compared;
}

TEST_CASE("lockstep: the provisioning session replays against the real hub, answer for answer") {
  CHECK(replay("provisioning") > 10);
}

TEST_CASE("lockstep: the armed-door session replays against the real hub, answer for answer") {
  CHECK(replay("armed-door") > 10);
}

TEST_CASE("lockstep: the restart-in-countdown session replays across two hub processes") {
  CHECK(replay("restart-in-countdown") > 10);
}

TEST_CASE("lockstep: the gateway-replaced session replays, with the hub's close of a link") {
  CHECK(replay("gateway-replaced") > 10);
}

TEST_CASE("lockstep: the burst-hang session replays to its end, the long idle whole") {
  CHECK(replay("burst-hang", false) > 700);
}

}  // namespace
}  // namespace hsn::test
