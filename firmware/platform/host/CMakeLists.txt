# hsn_host: a fake for every hardware interface, and on top of them the discrete-event Simulation,
# the shared radio Medium and the TestHub (design section 8); later the real-time runner and the
# bridge to the real hub. Ordinary C++: the core rules do not apply here.
add_library(hsn_host STATIC
  src/fake_clock.cpp
  src/fake_io.cpp
  src/fake_link.cpp
  src/fake_radio.cpp
  src/fake_random.cpp
  src/fake_retained.cpp
  src/fake_storage.cpp
  src/fake_waiter.cpp
  src/fake_watchdog.cpp
  src/host_board.cpp
  src/sim_time.cpp
  src/scheduler.cpp
  src/drift_clock.cpp
  src/packet_labels.cpp
  src/timeline.cpp
  src/lora_physics.cpp
  src/medium.cpp
  src/radio_bridge.cpp
  src/link_wire.cpp
  src/provisioning.cpp
  src/sim_device.cpp
  src/simulation.cpp
  src/replay_window.cpp
  src/hub_radio.cpp
  src/test_hub.cpp
  src/hub_sensors.cpp
  src/hub_move.cpp
  src/real_time.cpp
  src/pty_link.cpp
  src/bench_json.cpp
  src/bench_script.cpp
  src/wire_json.cpp
  src/lockstep.cpp
  src/remote_hub.cpp
  src/hub_sirens.cpp
  src/hub_gateways.cpp)
target_include_directories(hsn_host PUBLIC include)
target_link_libraries(hsn_host PUBLIC hsn_core hsn_psa)
hsn_warnings(hsn_host)
hsn_sanitizers(hsn_host)
