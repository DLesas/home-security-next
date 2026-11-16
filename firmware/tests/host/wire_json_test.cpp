// The lockstep wire's JSON (hub-design.md section 11, "Lockstep: the wire"): strict reading,
// JSON.stringify's writing, and each message read and written as the contract has it.

#include <doctest/doctest.h>

#include <string>

#include "hsn/host/lockstep.hpp"
#include "hsn/host/wire_json.hpp"

namespace hsn::test {
namespace {

using host::json::parse;
using host::json::Value;
using host::json::WireError;
using host::json::write;

TEST_CASE("the wire's JSON reads and writes what JSON.stringify writes") {
  const std::string text =
      R"({"a":1,"b":[true,false,null],"c":{"d":"e\"\\\n\u0001é"},"e":-9007199254740991,"f":[]})";
  const Value value = parse(text);
  CHECK(write(value) == text);
  CHECK(value.at("a").as_int() == 1);
  CHECK(value.at("c").at("d").as_string() == "e\"\\\n\x01\xC3\xA9");
  CHECK(value.at("e").as_int() == -9007199254740991);
  // White space between tokens; \u escapes and surrogate pairs are read as UTF-8.
  CHECK(parse(" { \"x\" :\t[ 1 , 2 ]\r\n} ") == parse(R"({"x":[1,2]})"));
  CHECK(parse(R"("\u00e9\ud83d\ude00\/")").as_string() == "\xC3\xA9\xF0\x9F\x98\x80/");
  // Objects compare whatever their members' order; arrays do not.
  CHECK(parse(R"({"a":1,"b":2})") == parse(R"({"b":2,"a":1})"));
  CHECK(parse("[1,2]") != parse("[2,1]"));
  CHECK(parse(R"({"a":1})") != parse(R"({"a":1,"b":2})"));
}

TEST_CASE("the wire's JSON refuses everything the contract does not allow") {
  for (const char* bad : {"",
                          "1.5",
                          "1e3",
                          "01",
                          "-0",
                          "9007199254740992",
                          "-9007199254740992",
                          "+1",
                          ".5",
                          R"({"a":1,"a":2})",
                          R"({"a":1,})",
                          "[1,]",
                          "[1 2]",
                          "{a:1}",
                          "'a'",
                          "\"a",
                          "\"\x01\"",
                          "\"\\x\"",
                          "\"\\ud800\"",
                          "\"\\udc00\"",
                          "\"\\ud800\\u0041\"",
                          "\"\xC3\"",
                          "\"\xC0\xAF\"",
                          "\"\xED\xA0\x80\"",
                          "\"\xF5\x80\x80\x80\"",
                          "true false",
                          "nul",
                          "{} x",
                          "NaN",
                          "Infinity",
                          "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]"
                          "]]]]]]]]]]]]]]]]]]]"
                          "]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]"}) {
    INFO(bad);
    CHECK_THROWS_AS(parse(bad), WireError);
  }
  CHECK_THROWS_AS(parse("1").as_string(), WireError);
  CHECK_THROWS_AS(parse("{}").at("x"), WireError);
  CHECK_THROWS_AS(Value(std::int64_t{9007199254740992}), WireError);
  CHECK(host::json::from_hex("00ff7a") == std::vector<std::uint8_t>{0x00, 0xFF, 0x7A});
  CHECK(host::json::to_hex({0x00, 0xFF, 0x7A}) == "00ff7a");
  for (const char* bad : {"0", "0F", "zz", "0 "}) {
    INFO(bad);
    CHECK_THROWS_AS(host::json::from_hex(bad), WireError);
  }
}

TEST_CASE("each lockstep message reads strictly and writes back as it came") {
  namespace lockstep = host::lockstep;
  for (
      const char* line : {
          R"({"type":"start","version":2,"at":1000000,"wall":1794528001000,"trusted":true,"seed":"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed"})",
          R"({"type":"start","version":2,"at":5,"wall":7,"trusted":false,"mono":3,"seed":"0000000000000000000000000000000000000000000000000000000000000000"})",
          R"({"type":"start","version":2,"at":5,"wall":7,"trusted":true,"seed":"0000000000000000000000000000000000000000000000000000000000000000","zone":"America/New_York"})",
          R"({"type":"advance","to":1100000})",
          R"({"type":"frame","link":"gateway1:usb","at":1102000,"bytes":"f10400"})",
          R"({"type":"linkUp","link":"siren1:network","kind":"network","at":11050000})",
          R"({"type":"linkDown","link":"sensor1:usb","at":17000000})",
          R"({"type":"control","at":4000000,"request":{"id":1,"actor":"bench","command":{"kind":"siteSet","channel":1,"rate":5,"countdown":10}}})",
          R"({"type":"clock","at":9,"wall":10,"trusted":false})",
          R"({"type":"stop","at":20000000})",
      }) {
    INFO(line);
    CHECK(lockstep::write(lockstep::read_to_hub(line)) == line);
  }
  for (
      const char* line : {
          R"({"type":"idle","to":1100000,"boot":1,"frames":[{"link":"a:usb","at":1100000,"bytes":"f101"}],"closed":[{"link":"a:usb","at":1100000,"reason":"gateway session replaced"}],"records":[{"kind":"decision","row":{"seq":1}}],"replies":[{"id":2,"reply":{"ok":true,"result":{"kind":"siteWifi"}}}],"wake":301100000})",
          R"({"type":"idle","to":5,"boot":2,"frames":[],"closed":[],"records":[{"kind":"rx","table":"event","row":{}}],"replies":[],"wake":null})",
          R"({"type":"stopped","at":7})",
          R"({"type":"error","message":"no","line":"x"})",
      }) {
    INFO(line);
    CHECK(lockstep::write(lockstep::read_from_hub(line)) == line);
  }
  for (
      const char* bad : {
          R"({"type":"start","version":1,"at":1,"wall":1,"trusted":true,"seed":"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed"})",
          R"({"type":"start","version":3,"at":1,"wall":1,"trusted":true,"seed":"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed"})",
          R"({"type":"start","version":2,"at":1,"wall":1,"trusted":true,"seed":"5eed"})",
          R"({"type":"start","version":2,"at":1,"wall":1,"trusted":true,"seed":"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed","zone":""})",
          R"({"type":"advance","to":-1})",
          R"({"type":"advance","to":1,"extra":0})",
          R"({"type":"advance"})",
          R"({"type":"frame","link":"","at":1,"bytes":"f1"})",
          R"({"type":"frame","link":"a","at":1,"bytes":""})",
          R"({"type":"frame","link":"a","at":1,"bytes":"F1"})",
          R"({"type":"linkUp","link":"a","kind":"radio","at":1})",
          R"({"type":"control","at":1,"request":{"id":1,"actor":"","command":{"kind":"x"}}})",
          R"({"type":"jump","at":1})",
      }) {
    INFO(bad);
    CHECK_THROWS_AS(lockstep::read_to_hub(bad), WireError);
  }
  for (
      const char* bad : {
          R"({"type":"idle","to":1,"boot":0,"frames":[],"closed":[],"records":[],"replies":[],"wake":null})",
          R"({"type":"idle","to":1,"boot":1,"frames":[],"closed":[],"records":[],"replies":[]})",
          R"({"type":"idle","to":1,"boot":1,"frames":[{"link":"a","at":1}],"closed":[],"records":[],"replies":[],"wake":null})",
          R"({"type":"idle","to":1,"boot":1,"frames":[],"closed":[],"records":[{"kind":"rx"}],"replies":[],"wake":null})",
          R"({"type":"idle","to":1,"boot":1,"frames":[],"records":[],"replies":[],"wake":null})",
          R"({"type":"idle","to":1,"boot":1,"frames":[],"closed":[{"link":"a","at":1}],"records":[],"replies":[],"wake":null})",
          R"({"type":"stopped","at":1,"boot":1})",
      }) {
    INFO(bad);
    CHECK_THROWS_AS(lockstep::read_from_hub(bad), WireError);
  }
}

}  // namespace
}  // namespace hsn::test
