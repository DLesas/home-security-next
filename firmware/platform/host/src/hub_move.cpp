// The test hub's move of the site to another channel or sending rate (protocol section 7,
// "Changing the site's channel or rate", D115), in its three steps: announce, switch, follow. The
// real hub's version is in docs/hub-design.md section 8; this one follows the same steps simply:
// no stall warnings, no silence grace, no restart in the middle.

#include <string>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/simulation_error.hpp"
#include "hsn/host/test_hub.hpp"

namespace hsn::host {
namespace {

/** A data rate as one bit of a mask. */
std::uint8_t rate_bit(std::uint8_t data_rate) {
  return static_cast<std::uint8_t>(1u << data_rate);
}

}  // namespace

std::uint16_t EventListenTable::operator[](std::size_t data_rate) const {
  const auto listen = protocol::event_listen_milliseconds(
      static_cast<std::uint8_t>(data_rate <= protocol::DataRate::dr5 ? data_rate : 0));
  return listen.value();
}

void TestHub::new_sensor_version(Known& sensor) {
  bump(sensor.version);
  sensor.reply_rate_of_version[sensor.version] = sensor.sensor.reply_data_rate;
  const bool announces = move_.stage == MoveStage::announcing;
  sensor.version_announces[sensor.version] = announces;
  if (announces) {
    sensor.announce_version = sensor.version;
    sensor.announce_send_rate = sensor.sensor.send_data_rate;
  }
}

void TestHub::announce_move(const SiteMove& move) {
  if (move_.stage != MoveStage::none) {
    throw SimulationError("the test hub is already moving the site");
  }
  bool rate_changes = false;
  if (move.send_data_rate.has_value()) {
    for (const Known& device : known_) {
      rate_changes = rate_changes ||
                     (device.role == protocol::Role::sensor &&
                      device.sensor.send_data_rate != *move.send_data_rate) ||
                     (device.role == protocol::Role::siren &&
                      device.siren.send_data_rate != *move.send_data_rate);
    }
  }
  const bool channel_changes =
      move.site_channel.has_value() && *move.site_channel != options_.site_channel;
  if (!rate_changes && !channel_changes) {
    throw SimulationError("the move would change nothing");
  }
  move_ = Move{};
  move_.stage = MoveStage::announcing;
  move_.target = move;
  move_.to_channel = move.site_channel.value_or(options_.site_channel);
  move_.to_rate = move.send_data_rate.value_or(0);
  const std::int64_t value =
      std::int64_t{move.site_channel.value_or(protocol::kStaysAsItIs)} * 256 +
      move.send_data_rate.value_or(protocol::kStaysAsItIs);
  decide(HubAction::move_requested, "", value);
  for (Known& device : known_) {
    device.move_confirmed = false;
    device.move_followed = false;
    if (device.role == protocol::Role::sensor) {
      device.version_announces.clear();
      new_sensor_version(device);
    }
  }
  // With no sensor to wait for, every sensor has confirmed: the switch is due at once.
  if (move_unconfirmed().empty()) {
    switch_when_free(false);
  }
}

bool TestHub::arrived_on_new(const Arrival& arrival) const {
  // A setting that does not move matches whatever it is.
  return (!move_.target.site_channel.has_value() || arrival.site_channel == move_.to_channel) &&
         (!move_.target.send_data_rate.has_value() || arrival.data_rate == move_.to_rate);
}

void TestHub::note_confirmation(Known& sensor, std::uint8_t held_version) {
  if (move_.stage != MoveStage::announcing || sensor.move_confirmed) {
    return;
  }
  const auto found = sensor.version_announces.find(held_version);
  if (found != sensor.version_announces.end() && found->second) {
    sensor.move_confirmed = true;
    decide(HubAction::move_confirmed, sensor.name);
    if (move_unconfirmed().empty()) {
      switch_when_free(false);
    }
  }
}

void TestHub::switch_when_free(bool forced) {
  move_.force = forced;
  if (switch_blocked()) {
    // Never during a countdown or an alarm: it waits for them to end (protocol section 7).
    if (!move_.switch_waiting) {
      move_.switch_waiting = true;
      decide(HubAction::move_switch_waiting, "");
    }
    return;
  }
  do_switch(forced && !move_unconfirmed().empty());
}

std::vector<std::string> TestHub::move_unconfirmed() const {
  std::vector<std::string> names;
  if (move_.stage != MoveStage::announcing) {
    return names;
  }
  for (const Known& device : known_) {
    if (device.role == protocol::Role::sensor && !device.move_confirmed) {
      names.push_back(device.name);
    }
  }
  return names;
}

bool TestHub::move_followed(const std::string& name) const {
  return known(name).move_followed;
}

bool TestHub::alarm_running() const {
  return alarm_ && sim_.now() < alarm_until_;
}

bool TestHub::switch_move(bool force) {
  if (move_.stage == MoveStage::switched) {
    // It switched by itself when the last sensor confirmed (protocol section 7, step 2).
    return true;
  }
  if (move_.stage != MoveStage::announcing) {
    throw SimulationError("there is no move announced to switch");
  }
  const std::vector<std::string> unconfirmed = move_unconfirmed();
  if (!force) {
    // The user's "force" without "--yes": it names who has not confirmed and changes nothing.
    for (const std::string& name : unconfirmed) {
      decide(HubAction::move_unconfirmed, name);
    }
    return false;
  }
  switch_when_free(true);
  return move_.stage == MoveStage::switched;
}

bool TestHub::switch_blocked() {
  bool countdown = false;
  for (const Known& device : known_) {
    countdown = countdown || device.countdown.active;
  }
  if (!countdown && alarm_running()) {
    // A countdown ending calls back; an alarm that ends by itself is checked when it does.
    sim_.schedule(alarm_until_, [this]() { retry_waiting_switch(); });
  }
  return countdown || alarm_running();
}

void TestHub::retry_waiting_switch() {
  if (move_.stage != MoveStage::announcing || !move_.switch_waiting || switch_blocked()) {
    return;
  }
  do_switch(move_.force && !move_unconfirmed().empty());
}

void TestHub::do_switch(bool forced) {
  for (const std::string& name : move_unconfirmed()) {
    decide(HubAction::move_forced, name);
  }
  move_.stage = MoveStage::switched;
  move_.switch_waiting = false;
  const bool rate_moves = move_.target.send_data_rate.has_value();
  options_.site_channel = move_.to_channel;
  site_frequency_hz_ =
      device::site_channel_frequency(move_.to_channel).value_or(site_frequency_hz_);
  if (rate_moves) {
    // A site has one sending rate: devices paired from now on get the new one alone.
    options_.allowed_data_rate_mask = rate_bit(move_.to_rate);
  }
  // Sensors: their next version names the new settings and announces nothing; their replies go
  // out only as packets arrive, so this changes nothing on the air yet.
  for (Known& device : known_) {
    if (device.role != protocol::Role::sensor) {
      continue;
    }
    if (rate_moves) {
      device.sensor.send_data_rate = move_.to_rate;
    }
    new_sensor_version(device);
  }
  // Gateways first, so they listen on the new settings at once; then sirens, on both paths.
  if (radio_ != nullptr) {
    radio_->retune(site_frequency_hz_,
                   rate_moves ? rate_bit(move_.to_rate) : options_.listen_data_rates);
  }
  for (std::size_t index = 0; index < known_.size(); ++index) {
    Known& gateway = known_[index];
    if (gateway.role != protocol::Role::gateway) {
      continue;
    }
    if (rate_moves) {
      gateway.gateway.listen_data_rate_mask = rate_bit(move_.to_rate);
    }
    bump(gateway.version);
    send_gateway_settings(index);
  }
  decide(HubAction::move_switched, "", forced ? 1 : 0);
  for (Known& device : known_) {
    if (device.role != protocol::Role::siren) {
      continue;
    }
    SirenConfig config = device.siren;
    if (rate_moves) {
      config.send_data_rate = move_.to_rate;
    }
    change_siren(device.name, config);
  }
  note_followed_all_done();
}

void TestHub::fill_move(const Known& sensor, const Arrival& arrival, protocol::Reply& reply) const {
  const bool announcing = move_.stage == MoveStage::announcing;
  const bool still_old = move_.stage == MoveStage::switched && !arrived_on_new(arrival);
  if (!announcing && !still_old) {
    return;
  }
  if (still_old) {
    // Heard on the old settings after the switch (a gateway not switched yet): the reply goes on
    // announcing, with the settings the sensor holds (protocol section 7, step 3).
    reply.settings_version = sensor.announce_version;
    reply.send_data_rate = sensor.announce_send_rate;
  }
  if (move_.target.site_channel.has_value()) {
    reply.next_site_channel = move_.to_channel;
  }
  if (move_.target.send_data_rate.has_value()) {
    reply.next_send_data_rate = move_.to_rate;
  }
}

void TestHub::note_followed(Known& device) {
  if (move_.stage != MoveStage::switched || device.move_followed) {
    return;
  }
  device.move_followed = true;
  decide(HubAction::device_followed, device.name);
  note_followed_all_done();
}

void TestHub::note_followed_all_done() {
  if (move_.stage != MoveStage::switched) {
    return;
  }
  for (const Known& device : known_) {
    // A sensor forced past, never having confirmed, cannot follow: it is named, not waited for.
    const bool waited_for = (device.role == protocol::Role::sensor && device.move_confirmed) ||
                            device.role == protocol::Role::siren;
    if (waited_for && !device.move_followed) {
      return;
    }
  }
  move_.stage = MoveStage::none;
  decide(HubAction::move_done, "");
}

void TestHub::cancel_move() {
  if (move_.stage != MoveStage::announcing) {
    throw SimulationError("only a move still announced can be cancelled");
  }
  move_ = Move{};
  decide(HubAction::move_cancelled, "");
  for (Known& device : known_) {
    device.move_confirmed = false;
    if (device.role == protocol::Role::sensor) {
      // A version announcing nothing: its replies clear the next settings (protocol section 7).
      new_sensor_version(device);
    }
  }
}

}  // namespace hsn::host
