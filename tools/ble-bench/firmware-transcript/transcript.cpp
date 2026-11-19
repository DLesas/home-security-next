// The firmware's side of tools/ble-bench/test/firmware-compare.test.ts: on the firmware's own host
// bench (firmware/platform/host/), a real sensor (roles/sensor's SensorRole, with the core's
// UpdateService) is offered a Bluetooth update by the test hub (TestHub::open_bluetooth) and the
// bench's ScriptPhone serves it, as in tests/host/update_roles_test.cpp. For each scenario it prints
// what went over the board's Bluetooth link, every frame the board sent in order, and the inputs
// that made them: the file, the device key and the nonce the session key derives from (and the key
// the hub derived), the address,
// the window, the hub's public signing key and identity, and the device randoms (inside the Hellos).
//
// The TypeScript board then runs on exactly those inputs and its frames must match byte for byte.
// The device key is one the test hub made for the run, never a real one. Build and run it as
// tools/ble-bench/README.md says ("Comparing with the firmware"); the output is the fixture
// tools/ble-bench/test/fixtures/firmware-transcripts.json.

#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "hsn/host/provisioning.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/script_phone.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/host/test_image.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"

namespace {

using namespace hsn;

std::string hex(const std::uint8_t* bytes, std::size_t size) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (std::size_t i = 0; i < size; ++i) {
    out.push_back(digits[bytes[i] >> 4]);
    out.push_back(digits[bytes[i] & 0x0F]);
  }
  return out;
}

template <typename Container>
std::string hex(const Container& bytes) {
  return hex(bytes.data(), bytes.size());
}

struct Scenario {
  const char* name;
  host::ScriptPhoneOptions options;
};

device::Instant at_s(std::int64_t s) {
  return device::Instant{} + device::seconds(s);
}

std::string run(const Scenario& scenario) {
  host::Simulation sim;
  host::TestHub hub(sim);
  host::DeviceSpec spec;
  spec.name = "door";
  spec.role = host::make_role<roles::sensor::SensorRole>(&host::HostBoard::sensor_io);
  host::SimDevice& door = sim.add_device(spec);
  hub.add_sensor(door);
  const protocol::FirmwareVersion version{1, 4, 0};
  const host::HubImage& image = hub.add_image(host::make_test_image(version, 13000));
  const host::BluetoothSession session = hub.open_bluetooth("door", image.id);
  host::ScriptPhone phone(sim, door, session, scenario.options);
  // Opening its cover sends a report the hub always answers: the sensor learns of it at once.
  door.set_input(device::Input::cover, true, at_s(2));
  door.set_input(device::Input::cover, false, at_s(170));
  sim.run_until(at_s(180));

  std::ostringstream out;
  out << "{\"name\":\"" << scenario.name << "\"";
  out << ",\"phone\":{\"mtu\":" << scenario.options.mtu
      << ",\"wrongTags\":" << scenario.options.wrong_tags
      << ",\"dropAfterData\":" << scenario.options.drop_after_data
      << ",\"reconnectAfterMs\":" << (scenario.options.reconnect_after.us / 1000)
      << ",\"corruptData\":" << scenario.options.corrupt_data << "}";
  out << ",\"address\":" << session.address;
  out << ",\"deviceKey\":\"" << hex(hub.key_of("door")) << "\"";
  out << ",\"nonce\":\"" << hex(session.nonce) << "\"";
  // K as the hub derived it (from the test hub's own key for this run): the test derives it again.
  out << ",\"sessionKey\":\"" << hex(session.session_key) << "\"";
  out << ",\"windowUnits\":" << static_cast<int>(session.window_units);
  out << ",\"imageId\":\"" << hex(session.image) << "\"";
  out << ",\"signingKey\":\"" << hex(hub.signing_key().public_key()) << "\"";
  // The identity the test hub pairs boards with (and puts in every header it makes) is
  // Provisioning's, not the one derived from its signing key.
  out << ",\"hubIdentity\":\"" << hex(host::Provisioning{}.hub_identity) << "\"";
  out << ",\"file\":\"" << hex(session.file) << "\"";
  out << ",\"fromBoard\":[";
  bool first = true;
  for (const host::FakeLink::Sent& sent : door.board().bluetooth.sent) {
    out << (first ? "" : ",") << "\"" << hex(sent.packet) << "\"";
    first = false;
  }
  out << "]";
  out << ",\"result\":{\"done\":"
      << (phone.done.has_value() ? std::to_string(static_cast<int>(phone.done->result)) : "null")
      << ",\"doneReason\":"
      << (phone.done.has_value() ? std::to_string(static_cast<int>(phone.done->reason)) : "null")
      << ",\"hellos\":" << phone.hellos.size() << ",\"opens\":" << phone.opens
      << ",\"wrongOpens\":" << phone.wrong_opens << ",\"connections\":" << phone.connections
      << ",\"dataFrames\":" << phone.data_frames << ",\"servedTo\":" << phone.served_to << "}";
  out << "}";
  return out.str();
}

}  // namespace

int main() {
  std::vector<Scenario> scenarios;
  scenarios.push_back({"a whole transfer", {}});
  {
    host::ScriptPhoneOptions options;
    options.wrong_tags = 2;
    scenarios.push_back({"two wrong tags, then the right one", options});
  }
  {
    host::ScriptPhoneOptions options;
    options.drop_after_data = 30;
    options.reconnect_after = device::seconds(1);
    scenarios.push_back({"a drop after 30 Data, and the resume", options});
  }
  {
    host::ScriptPhoneOptions options;
    options.corrupt_data = 5;
    scenarios.push_back({"the 5th Data corrupted", options});
  }
  {
    host::ScriptPhoneOptions options;
    options.wrong_tags = 5;
    options.reconnect_after = device::milliseconds(500);
    scenarios.push_back({"five wrong tags", options});
  }
  std::cout << "{\"schemaVersion\":1,\"description\":\"The frames a real sensor (the firmware's "
               "SensorRole and UpdateService on its host bench) sent to the bench's ScriptPhone in "
               "each scenario, with the inputs that made them. Made by "
               "tools/ble-bench/firmware-transcript/transcript.cpp.\",\"scenarios\":[";
  for (std::size_t i = 0; i < scenarios.size(); ++i) {
    std::cout << (i == 0 ? "" : ",") << run(scenarios[i]);
  }
  std::cout << "]}\n";
  return 0;
}
