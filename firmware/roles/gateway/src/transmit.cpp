// Transmit requests and their results (protocol sections 2, 6 and 7; GW2, D104): a bounded queue
// with siren commands first; "at a given time" sent exactly then or skipped when the radio is
// busy; "as soon as possible" sent when the radio is free, no later than its latest moment; every
// send admitted against 10% of the hour on 869.525 MHz, with the last fifth kept for siren
// commands; exactly one result for every request while its connection lasts.

#include "hsn/device/services/airtime.hpp"
#include "hsn/device/services/radio_plan.hpp"
#include "hsn/device/services/radio_port.hpp"
#include "hsn/protocol/layout.hpp"
#include "hsn/roles/gateway/gateway_clock.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"

namespace hsn::roles::gateway {

void GatewayRole::on_transmit_request(const protocol::TransmitRequest& request,
                                      std::uint32_t counter, device::Instant now) {
  // A request this gateway cannot act on is answered "not valid" (protocol sections 3 and 6).
  if (!protocol::is_known<protocol::TransmitWhen>(request.when) ||
      !device::time_on_air(request.data_rate, request.packet.bytes.size()).has_value()) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::request_not_valid,
                      "request not valid", request.data_rate);
    answer(counter, protocol::TransmitOutcome::not_valid, now, now);
    return;
  }
  TransmitEntry entry;
  entry.counter = counter;
  entry.data_rate = request.data_rate;
  entry.power_dbm = request.power_dbm > kMaxTxPowerDbm ? kMaxTxPowerDbm : request.power_dbm;
  entry.siren_command = request.priority == protocol::TransmitPriority::siren_command;
  if (request.when == protocol::TransmitWhen::at_time) {
    entry.timing = TransmitTiming::at_time;
    entry.when = nearest_instant(now, request.gateway_time_micros);
  } else {
    entry.timing = TransmitTiming::as_soon_as_possible;
    entry.when = request.gateway_time_micros == 0
                     ? device::Instant::never()
                     : nearest_instant(now, request.gateway_time_micros);
  }
  if (TransmitQueue::too_late(entry, now)) {
    services_.log.add(now, device::LogLevel::info, gateway_log::request_too_late, "too late");
    answer(counter, protocol::TransmitOutcome::too_late, now, now);
    return;
  }
  if (queue_.full()) {
    const std::size_t displaced =
        entry.siren_command ? queue_.newest_routine() : TransmitQueue::kNone;
    if (displaced == TransmitQueue::kNone) {
      counts_.queue_full += 1;
      services_.log.add(now, device::LogLevel::warning, gateway_log::queue_full, "queue full",
                        static_cast<std::int32_t>(counter));
      answer(counter, protocol::TransmitOutcome::radio_busy, now, now);
      return;
    }
    // A siren command takes the place of the newest routine request (siren commands first).
    const std::uint32_t displaced_counter = queue_.entry(displaced).counter;
    counts_.displaced += 1;
    services_.log.add(now, device::LogLevel::warning, gateway_log::request_displaced,
                      "request displaced", static_cast<std::int32_t>(displaced_counter));
    answer(displaced_counter, protocol::TransmitOutcome::radio_busy, now, now);
    queue_.remove(displaced);
  }
  static_cast<void>(queue_.add(entry, request.packet.bytes));
  const std::size_t depth = queue_.size();
  if (depth > counts_.queue_highest) {
    counts_.queue_highest = static_cast<std::uint8_t>(depth);
  }
}

void GatewayRole::serve_queue(device::Instant now) {
  queue_.end_deferrals(now);
  // Each pass settles one request; there are never more than the queue holds.
  for (std::size_t pass = 0; pass <= kTransmitQueueSize; ++pass) {
    const std::size_t late = queue_.expired(now);
    if (late != TransmitQueue::kNone) {
      services_.log.add(now, device::LogLevel::info, gateway_log::request_too_late, "too late");
      answer(queue_.entry(late).counter, protocol::TransmitOutcome::too_late, now, now);
      queue_.remove(late);
      continue;
    }
    const std::size_t due = queue_.due_at_time(now);
    if (due != TransmitQueue::kNone) {
      // A moment reached too late (a slow flash write in the same event) was expired above.
      if (state_.radio.mode != RadioMode::listening) {
        // Receiving comes first, and one radio sends one packet: the moment is skipped.
        services_.log.add(now, device::LogLevel::info, gateway_log::request_radio_busy,
                          "radio busy", static_cast<std::int32_t>(state_.radio.mode));
        answer(queue_.entry(due).counter, protocol::TransmitOutcome::radio_busy, now, now);
        queue_.remove(due);
      } else {
        static_cast<void>(start_transmission(due, now));
      }
      continue;
    }
    if (state_.radio.mode != RadioMode::listening) {
      return;
    }
    const std::size_t next = queue_.next_as_soon_as_possible();
    if (next == TransmitQueue::kNone) {
      return;
    }
    static_cast<void>(start_transmission(next, now));
  }
}

bool GatewayRole::start_transmission(std::size_t index, device::Instant now) {
  const TransmitEntry entry = queue_.entry(index);
  const protocol::ByteView packet = queue_.packet(index);
  const device::Duration airtime =
      device::time_on_air(entry.data_rate, packet.size()).value_or(device::Duration{});
  // Siren commands may use the whole hour's budget; everything else four fifths (protocol
  // section 2).
  const device::TxClass tx_class =
      entry.siren_command ? device::TxClass::essential : device::TxClass::routine;
  const device::Admission admission =
      services_.airtime.admit(device::Band::g3, airtime, tx_class, now);
  if (!admission.allowed) {
    if (entry.siren_command && admission.past_limit &&
        entry.timing == TransmitTiming::as_soon_as_possible && admission.earliest > now &&
        !admission.earliest.is_never()) {
      // Urgent: past the legal hour it still goes, after D111's gap. It waits in the queue.
      queue_.defer(index, admission.earliest);
      return false;
    }
    services_.log.add(now, device::LogLevel::warning, gateway_log::request_no_airtime, "no airtime",
                      static_cast<std::int32_t>(entry.counter));
    answer(entry.counter, protocol::TransmitOutcome::no_airtime, now, now);
    queue_.remove(index);
    return false;
  }
  if (admission.past_limit) {
    // Every packet past the legal hour is a warning (D111); the gateway calls the budget itself.
    services_.log.add(now, device::LogLevel::warning, device::log_code::airtime_past_limit,
                      "past airtime limit", static_cast<std::int32_t>(entry.counter));
  }
  const device::HalError error = services_.hal.radio.transmit(
      device::RadioChannel{device::kReplyFrequencyHz, entry.data_rate}, entry.power_dbm, packet);
  queue_.remove(index);
  if (error != device::HalError::none) {
    services_.log.add(now, device::LogLevel::error, gateway_log::radio_call_failed,
                      "transmit failed", static_cast<std::int32_t>(error));
    answer(entry.counter, protocol::TransmitOutcome::radio_busy, now, now);
    listen(now);
    return false;
  }
  services_.airtime.record(device::Band::g3, now, airtime);
  RadioState& radio = state_.radio;
  radio.mode = RadioMode::transmitting;
  radio.sending = true;
  radio.request = entry.counter;
  radio.request_generation = state_.connection.generation;
  radio.sent_at = now;
  state_.timers.arm(GatewayTimer::radio_guard, now + airtime + device::kRadioGuardMargin);
  return true;
}

void GatewayRole::transmission_done(device::Instant now, std::uint8_t outcome) {
  RadioState& radio = state_.radio;
  if (!radio.sending) {
    return;
  }
  radio.sending = false;
  state_.timers.cancel(GatewayTimer::radio_guard);
  if (radio.request_generation != state_.connection.generation || !session_open()) {
    // The request's connection ended while it was on the air: its result has nowhere to go.
    counts_.results_lost += 1;
    services_.log.add(now, device::LogLevel::warning, gateway_log::result_lost, "result lost",
                      static_cast<std::int32_t>(radio.request));
    return;
  }
  answer(radio.request, outcome, radio.sent_at, now);
}

void GatewayRole::answer(std::uint32_t counter, std::uint8_t outcome, device::Instant sent_at,
                         device::Instant now) {
  protocol::TransmitResult result;
  result.request_counter = counter;
  result.result = outcome;
  result.sent_at_micros = clock_value(sent_at);
  // send_to_hub logs every failure itself; here it is also counted.
  if (!session_open() || !send_to_hub(result, now)) {
    counts_.results_lost += 1;
    services_.log.add(now, device::LogLevel::warning, gateway_log::result_lost, "result lost",
                      static_cast<std::int32_t>(counter));
    return;
  }
  if (outcome < kTransmitOutcomeCount) {
    counts_.results[outcome] += 1;
  }
}

void GatewayRole::drop_requests(device::Instant now) {
  // Requests belong to their connection: a result could not reach the hub after it (protocol
  // section 4, every packet bound to the session).
  const std::size_t dropped = queue_.clear();
  if (dropped > 0) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::requests_dropped,
                      "requests dropped", static_cast<std::int32_t>(dropped));
  }
}

}  // namespace hsn::roles::gateway
