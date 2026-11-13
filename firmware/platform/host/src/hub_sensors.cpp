// The test hub's sensor rules (protocol sections 6 and 7): replies with the right binding and
// timing, the countdown per sensor with late reports, arming, and the disarmed notice twice.

#include <algorithm>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/test_hub.hpp"

namespace hsn::host {
namespace {

/** Whole seconds from `now` to `until`, rounded up, limited to 0–limit. */
std::int64_t seconds_left(device::Instant now, device::Instant until, std::int64_t limit) {
  if (until <= now) {
    return 0;
  }
  const std::int64_t left = ((until - now).us + 999999) / 1000000;
  return std::min(left, limit);
}

}  // namespace

device::Duration TestHub::event_listen_time(std::uint8_t data_rate) const {
  return device::milliseconds(options_.event_listen_ms[data_rate]);
}

void TestHub::arm() {
  armed_ = true;
  for (Known& device : known_) {
    if (device.role == protocol::Role::sensor) {
      new_sensor_version(device);
    }
  }
  decide(HubAction::armed, "");
}

void TestHub::disarm() {
  armed_ = false;
  decide(HubAction::disarmed, "");
  for (std::size_t index = 0; index < known_.size(); ++index) {
    Known& sensor = known_[index];
    if (sensor.role != protocol::Role::sensor) {
      continue;
    }
    new_sensor_version(sensor);
    Countdown& countdown = sensor.countdown;
    if (!countdown.active) {
      continue;
    }
    countdown.active = false;
    countdown.generation += 1;
    // Twice, 2 s apart, bound to the newest accepted report of the opening (protocol section 4).
    const std::uint32_t bound_to = countdown.newest_counter;
    const std::uint8_t data_rate = countdown.reply_data_rate;
    const std::size_t gateway = countdown.gateway;
    send_disarmed_notice(index, bound_to, data_rate, gateway);
    sim_.schedule(sim_.now() + options_.disarmed_notice_gap,
                  [this, index, bound_to, data_rate, gateway]() {
                    send_disarmed_notice(index, bound_to, data_rate, gateway);
                  });
  }
  if (alarm_) {
    alarm_ = false;
    for (Known& siren : known_) {
      if (siren.role == protocol::Role::siren) {
        command_siren(siren.name, protocol::SirenAction::off, 0);
      }
    }
  }
  retry_waiting_switch();
}

std::uint8_t TestHub::reply_rate(const Known& sensor, std::uint8_t held_version,
                                 std::uint8_t arrival_rate, bool at_arrival_rate) const {
  // A sensor that fell back listens at the rate it sent at, and says so with flag bit 7
  // (protocol section 7, "Data rate"). Otherwise it listens at the reply rate of the settings
  // it holds, which may not be the newest; with none, at its own rate (section 2).
  if (at_arrival_rate) {
    return arrival_rate;
  }
  if (held_version == sensor.version) {
    return sensor.sensor.reply_data_rate;
  }
  const auto found = sensor.reply_rate_of_version.find(held_version);
  return found != sensor.reply_rate_of_version.end() ? found->second : arrival_rate;
}

std::uint16_t TestHub::next_heartbeat_tenths(std::size_t index, device::Instant ended_at) const {
  // Slots spread every sensor evenly over the interval (protocol section 7, heartbeat slots).
  std::size_t position = 0;
  std::size_t count = 0;
  for (std::size_t i = 0; i < known_.size(); ++i) {
    if (known_[i].role == protocol::Role::sensor) {
      position = i == index ? count : position;
      count += 1;
    }
  }
  const std::int64_t interval = known_[index].sensor.heartbeat_interval_units * 15000000LL;
  if (interval == 0 || count == 0) {
    return 0;
  }
  const std::int64_t slot =
      interval * static_cast<std::int64_t>(position) / static_cast<std::int64_t>(count);
  const std::int64_t earliest = static_cast<std::int64_t>(ended_at.us) + interval / 2;
  const std::int64_t periods = (earliest - slot + interval - 1) / interval;
  const std::int64_t next = slot + std::max<std::int64_t>(periods, 0) * interval;
  const std::int64_t tenths = (next - static_cast<std::int64_t>(ended_at.us) + 50000) / 100000;
  return static_cast<std::uint16_t>(std::min<std::int64_t>(tenths, 0xFFFF));
}

void TestHub::on_sensor_packet(std::size_t index, const Opened& opened, const Arrival& arrival) {
  Known& sensor = known_[index];
  const protocol::ByteView body(opened.body.data(), opened.body.size());
  protocol::SensorStatus status;
  std::uint8_t held_version = 0;
  bool wanted = false;
  switch (opened.type) {
    case protocol::message_type::heartbeat:
    case protocol::message_type::door_changed:
    case protocol::message_type::cover_changed: {
      // The three share one body; the codec is instantiated per message type.
      protocol::Heartbeat decoded;
      static_cast<void>(protocol::decode_body(body, decoded));
      status = decoded;
      break;
    }
    case protocol::message_type::button: {
      protocol::Button button;
      static_cast<void>(protocol::decode_body(body, button));
      status = button;
      break;
    }
    case protocol::message_type::started: {
      protocol::Started started;
      static_cast<void>(protocol::decode_body(body, started));
      held_version = started.settings_version;
      note_confirmation(sensor, held_version);
      // The hub always replies to a sensor's Started (protocol section 6).
      reply_to_sensor(index, arrival, held_version, opened.counter, false, false);
      if (move_.stage == MoveStage::switched && arrived_on_new(arrival)) {
        note_followed(sensor);
      }
      return;
    }
    default:
      return;
  }
  held_version = status.settings_version;
  note_confirmation(sensor, held_version);
  wanted = status.flags.reply_wanted || held_version != sensor.version;
  // Until a reply goes, a fallen-back sensor listens at its sending rate after any packet.
  sensor.listening_at_send_rate = status.flags.listening_at_send_rate;
  if (status.flags.local_alarm_sounded) {
    decide(HubAction::local_alarm_reported, sensor.name);
  }
  if (opened.type == protocol::message_type::door_changed && status.flags.door_open) {
    door_opened(index, status, opened.counter, arrival);
  }
  // The first packet on the new settings is answered at the rate it came at (protocol section 7).
  const bool first_on_new =
      move_.stage == MoveStage::switched && arrived_on_new(arrival) && !sensor.move_followed;
  if (wanted) {
    reply_to_sensor(index, arrival, held_version, opened.counter,
                    opened.type == protocol::message_type::heartbeat,
                    status.flags.listening_at_send_rate || first_on_new);
  }
  if (first_on_new) {
    note_followed(sensor);
  }
}

void TestHub::door_opened(std::size_t index, const protocol::SensorStatus& status,
                          std::uint32_t counter, const Arrival& arrival) {
  Known& sensor = known_[index];
  if (!armed_) {
    decide(HubAction::report_while_disarmed, sensor.name);
    return;
  }
  const device::Instant now = sim_.now();
  Countdown& countdown = sensor.countdown;
  if (countdown.active) {
    // Another try of the same opening, or a new opening while it runs: the countdown goes on,
    // and the notice binds to the newest report.
    countdown.newest_counter = counter;
    decide(HubAction::countdown_continued, sensor.name, seconds_left(now, countdown.ends_at, 255));
    return;
  }
  // The countdown counts from when the door opened: the report's end less its age (D106).
  const device::Instant opened_at =
      arrival.ended_at + device::Duration{-device::seconds(status.event_age_seconds).us};
  const device::Instant ends_at = opened_at + device::seconds(sensor.sensor.countdown_seconds);
  const device::Instant sirens_stop = ends_at + device::seconds(options_.alarm_seconds);
  if (now < ends_at) {
    countdown.active = true;
    countdown.opened_at = opened_at;
    countdown.ends_at = ends_at;
    countdown.newest_counter = counter;
    countdown.generation += 1;
    const std::uint64_t generation = countdown.generation;
    sim_.schedule(ends_at, [this, index, generation]() { countdown_ended(index, generation); });
    decide(HubAction::countdown_started, sensor.name, seconds_left(now, ends_at, 255));
  } else if (now < sirens_stop) {
    const std::int64_t left = seconds_left(now, sirens_stop, 0xFFFF);
    decide(HubAction::late_report_sirens, sensor.name, left);
    alarm_ = true;
    alarm_until_ = now + device::seconds(left);
    sound_sirens(static_cast<std::uint16_t>(left));
  } else {
    decide(HubAction::late_report_notification, sensor.name,
           static_cast<std::int64_t>(opened_at.us / 1000000));
  }
}

void TestHub::countdown_ended(std::size_t index, std::uint64_t generation) {
  Known& sensor = known_[index];
  Countdown& countdown = sensor.countdown;
  if (!countdown.active || countdown.generation != generation) {
    return;
  }
  countdown.active = false;
  if (!armed_) {
    retry_waiting_switch();
    return;
  }
  alarm_ = true;
  alarm_until_ = sim_.now() + device::seconds(options_.alarm_seconds);
  decide(HubAction::alarm, sensor.name);
  sound_sirens(options_.alarm_seconds);
  retry_waiting_switch();
}

void TestHub::sound_sirens(std::uint16_t seconds) {
  // Only sirens not already sounding for this alarm are commanded: every door here adds every
  // siren, so within one alarm each siren gets one command (protocol section 7, D95).
  for (Known& siren : known_) {
    if (siren.role == protocol::Role::siren && sim_.now() >= siren.sounding_until) {
      command_siren(siren.name, protocol::SirenAction::sound_alarm,
                    std::min(seconds, siren.siren.max_sound_seconds));
    }
  }
}

void TestHub::reply_to_sensor(std::size_t index, const Arrival& arrival, std::uint8_t held_version,
                              std::uint32_t answered, bool heartbeat, bool at_arrival_rate) {
  Known& sensor = known_[index];
  const device::Instant now = sim_.now();
  const std::uint8_t data_rate =
      reply_rate(sensor, held_version, arrival.data_rate, at_arrival_rate);
  protocol::Reply reply;
  reply.settings_version = sensor.version;
  reply.flags.armed = armed_;
  Countdown& countdown = sensor.countdown;
  if (countdown.active) {
    reply.flags.countdown_started = true;
    reply.countdown_remaining_seconds =
        static_cast<std::uint8_t>(seconds_left(now, countdown.ends_at, 255));
    if (countdown.newest_counter == answered) {
      // The notice goes the way this reply goes.
      countdown.reply_data_rate = data_rate;
      countdown.gateway = arrival.gateway;
    }
  }
  reply.countdown_seconds = sensor.sensor.countdown_seconds;
  reply.heartbeat_interval_units = sensor.sensor.heartbeat_interval_units;
  reply.link_check_every = sensor.sensor.link_check_every;
  reply.send_data_rate = sensor.sensor.send_data_rate;
  reply.reply_data_rate = sensor.sensor.reply_data_rate;
  reply.next_heartbeat_tenths =
      heartbeat && options_.heartbeat_slots ? next_heartbeat_tenths(index, arrival.ended_at) : 0;
  reply.clock_correction_ten_ppm = sensor.sensor.clock_correction_ten_ppm;
  fill_move(sensor, arrival, reply);

  Downlink downlink;
  downlink.packet =
      seal(sensor, reply, protocol::Binding::sensor_packet(answered), protocol::PacketLimit::radio);
  downlink.type = protocol::message_type::reply;
  downlink.counter = sensor.next_counter - 1;
  downlink.to = index;
  downlink.data_rate = data_rate;
  downlink.ended_at = arrival.ended_at;
  downlink.gateway_time = arrival.gateway_time;
  downlink.gateway = arrival.gateway;
  if (heartbeat) {
    // At the fixed reply moment after the heartbeat's end (protocol section 7).
    downlink.fixed_moment = true;
    downlink.offset = options_.reply_moment;
  } else {
    // As soon as possible, but still inside the sensor's event listening.
    const auto airtime = device::time_on_air(data_rate, downlink.packet.size());
    downlink.limited = true;
    downlink.offset = event_listen_time(arrival.data_rate) - airtime.value_or(device::Duration{});
  }
  // A sensor that hears this reply holds these settings and listens at their reply rate.
  sensor.replied_version = sensor.version;
  sensor.listening_at_send_rate = false;
  decide(HubAction::reply, sensor.name, downlink.counter);
  send_radio(downlink);
}

void TestHub::send_disarmed_notice(std::size_t index, std::uint32_t bound_to,
                                   std::uint8_t data_rate, std::size_t gateway) {
  Known& sensor = known_[index];
  Downlink downlink;
  downlink.packet = seal(sensor, protocol::DisarmedNotice{},
                         protocol::Binding::sensor_packet(bound_to), protocol::PacketLimit::radio);
  downlink.type = protocol::message_type::disarmed_notice;
  downlink.counter = sensor.next_counter - 1;
  downlink.to = index;
  downlink.data_rate = data_rate;
  downlink.gateway = gateway;
  decide(HubAction::disarmed_notice, sensor.name, bound_to);
  send_radio(downlink);
}

}  // namespace hsn::host
