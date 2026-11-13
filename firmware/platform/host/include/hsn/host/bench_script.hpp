#pragma once

#include <functional>
#include <string>

#include "hsn/device/hal/link.hpp"
#include "hsn/host/pty_link.hpp"
#include "hsn/host/simulation.hpp"

namespace hsn::host {

/** What one script line did. */
struct ScriptResult {
  bool ok = true;
  /** The line was `quit`. */
  bool quit = false;
  /** Why the line was refused; nothing happened. */
  std::string error;
};

/**
 * The real-time bench's script (hub-design.md section 11, item 5): one command per line, words
 * separated by spaces, acting at the simulation's current instant (the driver delivers each line
 * at the instant it is read). Blank lines and lines starting with # do nothing.
 *
 *   door <device> open|close            cover <device> open|close
 *   button <device> press|release       hold <device> <seconds>
 *   usb-power <device> on|off           power-loss <device> [<seconds>, default 1]
 *   restart <device>                    cut <device> usb|network
 *   restore <device> usb|network        noise <channel 0-2> <dBm> <seconds>
 *   path-loss <device> <device> <dB>    quit
 */
class BenchScript {
public:
  /** Finds a device's link to the far end, or null. */
  using FindLink = std::function<PtyLink*(const std::string& device, device::LinkKind kind)>;

  BenchScript(Simulation& sim, FindLink find_link);

  /** Runs one line. */
  ScriptResult run(const std::string& line);

private:
  Simulation& sim_;
  FindLink find_link_;
};

}  // namespace hsn::host
