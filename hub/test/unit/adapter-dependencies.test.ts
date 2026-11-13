/**
 * The adapters' libraries install and load under Bun (hub-design.md sections 3 and 10; spike S1's
 * versions). Each test only imports its package: no port is opened and nothing is advertised.
 */
import { expect, test } from "bun:test";

test("hono loads: the WebSocket /device and app server (section 3)", async () => {
  expect((await import("hono")).Hono).toBeFunction();
});

test("serialport loads: the USB links to gateways (section 3)", async () => {
  expect((await import("serialport")).SerialPort).toBeFunction();
});

test("bonjour-service loads: mDNS advertising of the hub (§10)", async () => {
  expect((await import("bonjour-service")).Bonjour).toBeFunction();
});
