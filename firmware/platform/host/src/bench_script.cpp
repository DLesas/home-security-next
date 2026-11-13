#include "hsn/host/bench_script.hpp"

#include <sstream>
#include <vector>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/simulation_error.hpp"

namespace hsn::host {
namespace {

/** Reads a decimal number; false when the word is not one. */
bool number(const std::string& word, double& out) {
  std::istringstream in(word);
  in >> out;
  return !in.fail() && in.eof();
}

ScriptResult refuse(const std::string& why) {
  ScriptResult result;
  result.ok = false;
  result.error = why;
  return result;
}

device::Duration seconds_of(double seconds) {
  return device::microseconds(static_cast<std::int64_t>(seconds * 1e6));
}

}  // namespace

BenchScript::BenchScript(Simulation& sim, FindLink find_link)
    : sim_(sim), find_link_(std::move(find_link)) {}

ScriptResult BenchScript::run(const std::string& line) {
  std::istringstream in(line);
  std::vector<std::string> words;
  for (std::string word; in >> word;) {
    words.push_back(word);
  }
  if (words.empty() || words[0][0] == '#') {
    return {};
  }
  const std::string& verb = words[0];
  if (verb == "quit") {
    ScriptResult result;
    result.quit = true;
    return result;
  }
  const auto needs = [&](std::size_t count) { return words.size() == count; };
  const device::Instant now = sim_.now();
  if (verb == "noise") {
    double channel = 0;
    double dbm = 0;
    double seconds = 0;
    if (!needs(4) || !number(words[1], channel) || !number(words[2], dbm) ||
        !number(words[3], seconds) || seconds <= 0) {
      return refuse("usage: noise <channel 0-2> <dBm> <seconds>");
    }
    // Range-checked before the cast: a negative or large double does not convert to uint8_t.
    const bool whole = channel >= 0 && channel <= 255 && channel == static_cast<int>(channel);
    const auto frequency =
        whole ? device::site_channel_frequency(static_cast<std::uint8_t>(channel)) : std::nullopt;
    if (!frequency.has_value()) {
      return refuse("no site channel " + words[1]);
    }
    sim_.medium().script_noise(*frequency, now, now + seconds_of(seconds), dbm);
    return {};
  }
  if (words.size() < 2) {
    return refuse("unknown command or missing device: " + line);
  }
  SimDevice* device = nullptr;
  try {
    device = &sim_.device(words[1]);
  } catch (const SimulationError&) {
    return refuse("no device " + words[1]);
  }
  const auto level = [&](const char* on, const char* off, device::Input input) -> ScriptResult {
    if (!needs(3) || (words[2] != on && words[2] != off)) {
      return refuse(std::string("usage: ") + verb + " <device> " + on + "|" + off);
    }
    device->set_input(input, words[2] == on, now);
    return {};
  };
  if (verb == "door") {
    return level("open", "close", device::Input::door);
  }
  if (verb == "cover") {
    return level("open", "close", device::Input::cover);
  }
  if (verb == "button") {
    return level("press", "release", device::Input::button);
  }
  if (verb == "usb-power") {
    return level("on", "off", device::Input::external_power);
  }
  if (verb == "hold") {
    double seconds = 0;
    if (!needs(3) || !number(words[2], seconds) || seconds <= 0) {
      return refuse("usage: hold <device> <seconds>");
    }
    device->hold_button(now, now + seconds_of(seconds));
    return {};
  }
  if (verb == "power-loss") {
    double seconds = 1;
    if (words.size() > 3 || (words.size() == 3 && (!number(words[2], seconds) || seconds <= 0))) {
      return refuse("usage: power-loss <device> [<seconds>]");
    }
    device->power_loss(now, seconds_of(seconds));
    return {};
  }
  if (verb == "restart") {
    if (!needs(2)) {
      return refuse("usage: restart <device>");
    }
    device->restart(now);
    return {};
  }
  if (verb == "cut" || verb == "restore") {
    if (!needs(3) || (words[2] != "usb" && words[2] != "network")) {
      return refuse("usage: " + verb + " <device> usb|network");
    }
    PtyLink* link =
        find_link_(words[1], words[2] == "usb" ? device::LinkKind::usb : device::LinkKind::network);
    if (link == nullptr) {
      return refuse(words[1] + " has no " + words[2] + " link");
    }
    if (verb == "cut") {
      link->cut();
    } else {
      link->restore();
    }
    return {};
  }
  if (verb == "path-loss") {
    double db = 0;
    if (!needs(4) || !number(words[3], db)) {
      return refuse("usage: path-loss <device> <device> <dB>");
    }
    SimDevice* other = nullptr;
    try {
      other = &sim_.device(words[2]);
    } catch (const SimulationError&) {
      return refuse("no device " + words[2]);
    }
    sim_.medium().set_path_loss(device->station(), other->station(), db);
    return {};
  }
  return refuse("unknown command: " + verb);
}

}  // namespace hsn::host
