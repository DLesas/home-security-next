#include <cmath>

#include "hsn/protocol/radio.hpp"
#include "hsn/protocol/units.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::Error;

TEST_CASE("unlisted data rates have no spreading factor or time on air") {
  for (int data_rate = 6; data_rate < 256; ++data_rate) {
    const auto rate = static_cast<std::uint8_t>(data_rate);
    CHECK_FALSE(protocol::spreading_factor(rate).has_value());
    CHECK(protocol::time_on_air_microseconds(rate, 20).error() == Error::bad_value);
  }
  CHECK(protocol::time_on_air_microseconds(protocol::DataRate::dr5, 256).error() ==
        Error::too_long);
  CHECK(protocol::time_on_air_microseconds(protocol::DataRate::dr5, 255).ok());
}

TEST_CASE("time on air matches the table of section 2, in rounded milliseconds") {
  struct Row {
    std::size_t bytes;
    std::array<int, 4> milliseconds;  // SF7, SF9, SF10, SF12
  };
  const std::array<Row, 7> table{{
      {25, {62, 206, 412, 1483}},
      {32, {72, 247, 453, 1810}},
      {50, {98, 329, 616, 2302}},
      {18, {51, 185, 330, 1319}},
      {21, {57, 185, 371, 1483}},
      {28, {67, 226, 412, 1647}},
      {26, {62, 206, 412, 1647}},
  }};
  const std::array<std::uint8_t, 4> data_rates{protocol::DataRate::dr5, protocol::DataRate::dr3,
                                               protocol::DataRate::dr2, protocol::DataRate::dr0};
  for (const Row& row : table) {
    for (std::size_t i = 0; i < data_rates.size(); ++i) {
      const auto time = protocol::time_on_air_microseconds(data_rates[i], row.bytes);
      REQUIRE(time.ok());
      CHECK(std::lround(time.value() / 1000.0) == row.milliseconds[i]);
    }
  }
}

TEST_CASE("unlisted data rates have no event listen time") {
  for (int data_rate = 6; data_rate < 256; ++data_rate) {
    CHECK(protocol::event_listen_milliseconds(static_cast<std::uint8_t>(data_rate)).error() ==
          Error::bad_value);
  }
}

TEST_CASE("unit helpers at the edges of their inputs") {
  CHECK(protocol::battery_code_from_millivolts(0) == 0);
  CHECK(protocol::battery_code_from_millivolts(0xFFFFFFFFu) == 255);
  CHECK(protocol::millivolts_from_battery_code(255) == 5050);
  CHECK(protocol::fifteen_second_units_from_seconds(0xFFFFFFF0u) == std::nullopt);
  CHECK(protocol::fifteen_second_units_from_seconds(14) == std::nullopt);
  CHECK(protocol::tenths_from_milliseconds(0xFFFFFFFFu) == std::nullopt);
  CHECK(protocol::milliseconds_from_tenths(0xFFFF) == 6553500);
  CHECK(protocol::snr_hundredths_db_from_quarters(-128) == -3200);
}

TEST_CASE("enumerated values have one known-value helper") {
  CHECK(protocol::is_known<protocol::DataRate>(5));
  CHECK_FALSE(protocol::is_known<protocol::DataRate>(6));
  CHECK(protocol::is_known<protocol::Role>(3));
  CHECK_FALSE(protocol::is_known<protocol::Role>(0));
  CHECK(protocol::is_known<protocol::ButtonAction>(protocol::ButtonAction::short_press));
  CHECK_FALSE(protocol::is_known<protocol::ButtonAction>(9));
  CHECK(protocol::is_known<protocol::SirenAction>(3));
  CHECK_FALSE(protocol::is_known<protocol::SirenAction>(7));
  CHECK(protocol::is_known<protocol::SirenState>(2));
  CHECK(protocol::is_known<protocol::SirenReportReason>(3));
  CHECK(protocol::is_known<protocol::TransmitWhen>(1));
  CHECK_FALSE(protocol::is_known<protocol::TransmitWhen>(2));
  CHECK(protocol::is_known<protocol::TransmitPriority>(1));
  CHECK(protocol::is_known<protocol::TransmitOutcome>(4));
  CHECK_FALSE(protocol::is_known<protocol::TransmitOutcome>(5));
  CHECK(protocol::is_known<protocol::InterferenceEvent>(0));
  CHECK(protocol::is_known<protocol::SiteChannel>(2));
  CHECK_FALSE(protocol::is_known<protocol::SiteChannel>(3));
  CHECK(protocol::is_known<protocol::ProvisionOutcome>(2));
  CHECK_FALSE(protocol::is_known<protocol::ProvisionOutcome>(3));
}

}  // namespace
}  // namespace hsn::test
