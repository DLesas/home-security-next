/**
 * The scripted sessions of section 11's recorded files (`hub/test/lockstep/*.session`): each
 * drives a `Controller` against a hub end, from an empty data folder, deterministically.
 */
import { Role } from "@hsn/protocol";
import { mono } from "../../src/core/model/time.ts";
import { Controller, type HubEnd, MINUTE, SECOND } from "./controller.ts";

/** The run's wall clock at true time 0: 2026-11-13 00:00 UTC. */
export const WALL_AT_ZERO = Date.UTC(2026, 10, 13);
export const SEED = "5eed".repeat(16);
const START = SECOND;

export function wallAt(at: number): number {
  return WALL_AT_ZERO + Math.floor(at / 1000);
}

/**
 * A gateway, a sensor and a siren provisioned over USB: the gateway added by itself (D100), the
 * site set, the sensor and the siren added with `hsn usb add`, the sensor's USB power then off.
 */
export async function provision(end: HubEnd): Promise<Controller> {
  const c = new Controller(end, START);
  await c.start(START, wallAt(START), true, SEED);
  c.plug("gateway1", Role.Gateway, START + 100_000);
  c.plug("sensor1", Role.Sensor, START + 100_000);
  c.plug("siren1", Role.Siren, START + 100_000);
  await c.runTo(START + 3 * SECOND);
  c.command({ kind: "siteSet", channel: 1, rate: 5, countdown: 10 });
  c.command({ kind: "siteWifi", name: "bench", password: "benchpass1" });
  await c.runTo(START + 4 * SECOND);
  c.command({ kind: "usbAdd", port: "sensor1:usb", name: "front" });
  await c.runTo(START + 10 * SECOND);
  c.command({ kind: "usbAdd", port: "siren1:usb", name: "hall" });
  await c.runTo(START + 16 * SECOND);
  c.unplug("sensor1");
  await c.runTo(START + MINUTE);
  return c;
}

/** Arms everything at `at` and waits a heartbeat for the sensor to learn it. */
async function armed(c: Controller, at: number): Promise<void> {
  c.command({ kind: "arm", sensors: "all", continue: false }, at);
  await c.runTo(at + SECOND);
}

/**
 * After provisioning: armed, the door opens, the sensor buzzes; at the countdown's end (10 s) the
 * siren sounds; `hsn disarm` silences it.
 */
export async function armedDoor(end: HubEnd): Promise<Controller> {
  const c = await provision(end);
  await armed(c, c.now);
  const opened = c.now + SECOND;
  c.board("sensor1")?.sensor?.door(mono(opened), true);
  await c.runTo(opened + 12 * SECOND);
  c.command({ kind: "disarm", sensors: "all" });
  await c.runTo(c.now + 5 * SECOND);
  c.board("sensor1")?.sensor?.door(mono(c.now + SECOND), false);
  await c.runTo(c.now + 10 * SECOND);
  return c;
}

/**
 * After provisioning: armed, the door opens, and 4 s into the countdown the hub stops cleanly; it
 * starts again 2 s later on the same folder and the siren still sounds at the countdown's end.
 */
export async function restartInCountdown(end: HubEnd): Promise<Controller> {
  const c = await provision(end);
  await armed(c, c.now);
  const opened = c.now + SECOND;
  c.board("sensor1")?.sensor?.door(mono(opened), true);
  await c.runTo(opened + 4 * SECOND);
  await c.stop(c.now);
  const back = c.now + 2 * SECOND;
  await c.runTo(back);
  await c.start(back, wallAt(back), true, SEED);
  await c.runTo(opened + 14 * SECOND);
  c.command({ kind: "disarm", sensors: "all" });
  await c.runTo(c.now + 5 * SECOND);
  return c;
}

/**
 * After provisioning: the gateway connects over Wi-Fi as well. The new session is proven by its
 * Started and the hub closes the gateway's USB link, which `idle.closed` names (version 2); then
 * an armed door's report and the siren's command go through the gateway on its new link.
 */
export async function gatewayReplaced(end: HubEnd): Promise<Controller> {
  const c = await provision(end);
  c.gatewayOverNetwork("gateway1", c.now + SECOND);
  await c.runTo(c.now + 5 * SECOND);
  await armed(c, c.now);
  const opened = c.now + SECOND;
  c.board("sensor1")?.sensor?.door(mono(opened), true);
  await c.runTo(opened + 12 * SECOND);
  c.command({ kind: "disarm", sensors: "all" });
  await c.runTo(c.now + 5 * SECOND);
  return c;
}

export const SESSIONS = {
  provisioning: provision,
  "armed-door": armedDoor,
  "restart-in-countdown": restartInCountdown,
  "gateway-replaced": gatewayReplaced,
} as const;
