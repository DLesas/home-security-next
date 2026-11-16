/**
 * Every command of hub-design.md section 9, as `hsn` is run, the command the hub gets, an answer,
 * and a line of its output: shared by the CLI's tests and the terminal-safety test.
 */
import type { CommandResult, ControlCommand } from "../../../src/core/model/control.ts";

export const STATUS: CommandResult = {
  kind: "status",
  sensors: [{ name: "front", arm: "armed", door: "closed", countdownSecondsLeft: null }],
  alarm: null,
  sirens: [
    {
      name: "hall",
      should: { kind: "off", secondsLeft: null },
      commanded: null,
      reported: { kind: "off", secondsLeft: null },
      wifi: "up",
      lora: "up",
    },
  ],
  gateways: [
    {
      name: "gw1",
      session: true,
      link: "/dev/ttyACM0",
      lastStatusMs: 0,
      noiseMedianDbm: -110,
      baselineDbm: -111.5,
    },
  ],
  lastCommitMs: null,
  stagedItems: 0,
  databaseBytes: null,
  historyShortened: false,
  longestTurnMs: 0,
};

/** Every command of section 9: the words, the command the hub gets, its answer, and a line of output. */
export const TABLE: readonly (readonly [string, ControlCommand, CommandResult, string])[] = [
  ["status", { kind: "status" }, STATUS, "front   armed  closed  -"],
  // The control socket fills in the loop's figure (0 with no loop behind it, as here).
  ["status", { kind: "status" }, STATUS, "longest turn: 0.0 ms since the last status"],
  [
    "arm --all",
    { kind: "arm", sensors: "all", continue: false },
    { kind: "arm", armed: ["front", "back"], waitsForDoorToClose: [] },
    "armed: front, back",
  ],
  [
    "arm front back --continue",
    { kind: "arm", sensors: ["front", "back"], continue: true },
    { kind: "arm", armed: ["front"], waitsForDoorToClose: ["back"] },
    "armed, waiting for the door to close: back",
  ],
  [
    "disarm --all",
    { kind: "disarm", sensors: "all" },
    { kind: "disarm", disarmed: ["front"], countdownsCancelled: ["front"], alarmEnded: true },
    "the alarm ended",
  ],
  [
    "disarm front",
    { kind: "disarm", sensors: ["front"] },
    { kind: "disarm", disarmed: ["front"], countdownsCancelled: [], alarmEnded: false },
    "disarmed: front",
  ],
  [
    "devices",
    { kind: "devices" },
    {
      kind: "devices",
      devices: [
        {
          name: "front",
          role: "sensor",
          address: 0x5e000001,
          state: "contacted",
          firmware: "1.2.3",
          lastSeenMs: null,
        },
      ],
    },
    "front  sensor  contacted  0x5e000001  1.2.3     never",
  ],
  [
    "device show front",
    { kind: "deviceShow", name: "front" },
    {
      kind: "deviceShow",
      device: {
        name: "front",
        role: "sensor",
        address: 1,
        state: "paired",
        firmware: null,
        lastSeenMs: null,
      },
      settings: null,
      reading: null,
    },
    "front: sensor, paired",
  ],
  [
    "device rename front porch",
    { kind: "deviceRename", from: "front", to: "porch" },
    { kind: "deviceRename", name: "porch" },
    "renamed to porch",
  ],
  [
    "device remove front",
    { kind: "deviceRemove", name: "front" },
    { kind: "deviceRemove", name: "front" },
    "removed front: its key is deleted, its history kept",
  ],
  [
    "usb list",
    { kind: "usbList" },
    {
      kind: "usbList",
      ports: [
        {
          port: "/dev/ttyACM0",
          identity: {
            role: 3,
            chipId: "a1b2c3d4e5f6",
            firmware: "0.1.0",
            paired: false,
            ours: false,
            hubIdentity: null,
            development: true,
          },
        },
      ],
    },
    "/dev/ttyACM0  gateway  a1b2c3d4e5f6  0.1.0     no      development",
  ],
  [
    "usb add /dev/ttyACM0 --name front --role sensor",
    { kind: "usbAdd", port: "/dev/ttyACM0", name: "front", role: "sensor" },
    {
      kind: "usbAdd",
      device: 3,
      name: "front",
      role: "sensor",
      address: 0x1a2b3c4d,
      chip: "a1b2c3d4e5f6",
    },
    "added front: sensor, device 3, address 0x1a2b3c4d, chip a1b2c3d4e5f6; it restarts, and is contacted at its first packet",
  ],
  [
    "usb add /dev/ttyACM0 --name gw",
    { kind: "usbAdd", port: "/dev/ttyACM0", name: "gw" },
    { kind: "usbAdd", device: 1, name: "gw", role: "gateway", address: 7, chip: "010203040506" },
    "added gw: gateway, device 1, address 0x00000007, chip 010203040506; it restarts, and is contacted at its first packet",
  ],
  [
    "usb erase /dev/ttyACM0",
    { kind: "usbErase", port: "/dev/ttyACM0" },
    { kind: "usbErase", port: "/dev/ttyACM0" },
    "Erase sent to /dev/ttyACM0; the board restarts unpaired",
  ],
  [
    "sensor set front countdown=45 heartbeat=12 link-check=5 reply-rate=DR3 correction=-12",
    {
      kind: "sensorSet",
      name: "front",
      countdown: 45,
      heartbeat: 12,
      linkCheck: 5,
      replyRate: 3,
      correction: -12,
    },
    { kind: "sensorSet", name: "front", version: 8 },
    "front: settings version 8",
  ],
  [
    "sensor set front reply-rate=learn correction=learn",
    { kind: "sensorSet", name: "front", replyRate: "learn", correction: "learn" },
    { kind: "sensorSet", name: "front", version: 9 },
    "front: settings version 9",
  ],
  [
    "siren set hall max=120",
    { kind: "sirenSet", name: "hall", max: 120 },
    { kind: "sirenSet", name: "hall", version: 4 },
    "hall: settings version 4",
  ],
  [
    "gateway set gw1 status=20 interference=12/40 power=20 siren-power=-3",
    {
      kind: "gatewaySet",
      name: "gw1",
      statusS: 20,
      interferenceDb: 12,
      interferenceS: 40,
      powerDbm: 20,
      sirenPowerDbm: -3,
    },
    { kind: "gatewaySet", name: "gw1", version: 3 },
    "gw1: settings version 3",
  ],
  [
    "gateway set gw1 power=14",
    { kind: "gatewaySet", name: "gw1", powerDbm: 14 },
    { kind: "gatewaySet", name: "gw1", version: 4 },
    "gw1: settings version 4",
  ],
  [
    'op mode.switch {"mode":1}',
    // As the hub receives it: the operation typed by its schema.
    { kind: "op", operation: { op: "mode.switch", body: { mode: 1 } } },
    { kind: "op", body: { armed: [3], disarmed: [], waiting: [] } },
    '{"armed":[3],"disarmed":[],"waiting":[]}',
  ],
  [
    "open",
    { kind: "consoleToken" },
    {
      kind: "consoleToken",
      url: "http://127.0.0.1:8445/#console=AAAAAAAAAAAAAAAAAAAAAA",
      expiresInMs: 120_000,
      token: 1,
    },
    "the console opened in the browser; its link works once",
  ],
  [
    "siren test hall",
    { kind: "sirenTest", name: "hall" },
    { kind: "sirenTest", name: "hall", seconds: 3 },
    "hall: testing for 3 s",
  ],
  [
    "siren test hall 10",
    { kind: "sirenTest", name: "hall", seconds: 10 },
    { kind: "sirenTest", name: "hall", seconds: 10 },
    "hall: testing for 10 s",
  ],
  [
    "site show",
    { kind: "siteShow" },
    {
      kind: "siteShow",
      site: {
        channel: 1,
        rate: 5,
        countdownS: 30,
        autoStopS: 300,
        wifiName: "home",
        replyPowerDbm: 22,
        sirenPowerDbm: 22,
      },
    },
    "channel: 868.3 MHz",
  ],
  [
    "site survey",
    { kind: "siteSurvey" },
    {
      kind: "siteSurvey",
      channel: 2,
      noise: [
        { channel: 0, medianDbm: -100 },
        { channel: 2, medianDbm: -112.25 },
      ],
    },
    "quietest: 868.5 MHz",
  ],
  [
    "site set channel=868.1 rate=DR2 countdown=20 auto-stop=200",
    { kind: "siteSet", channel: 0, rate: 2, countdown: 20, autoStop: 200 },
    {
      kind: "siteSet",
      site: {
        channel: 0,
        rate: 2,
        countdownS: 20,
        autoStopS: 200,
        wifiName: null,
        replyPowerDbm: 22,
        sirenPowerDbm: 22,
      },
    },
    "Wi-Fi: not set",
  ],
  [
    "site wifi --name home --password hunter2",
    { kind: "siteWifi", name: "home", password: "hunter2" },
    { kind: "siteWifi" },
    "the site's Wi-Fi details are set",
  ],
  [
    "site change rate=DR2",
    { kind: "siteChange", rate: 2 },
    { kind: "siteChange", channel: 1, rate: 2, sensors: 2 },
    "announcing 868.3 MHz, DR2 to 2 sensors",
  ],
  [
    "site change channel=868.5 rate=DR0",
    { kind: "siteChange", channel: 2, rate: 0 },
    { kind: "siteChange", channel: 2, rate: 0, sensors: 2 },
    "announcing 868.5 MHz, DR0 to 2 sensors",
  ],
  [
    "site change status",
    { kind: "siteChangeStatus" },
    {
      kind: "siteChangeStatus",
      move: {
        id: 1,
        stage: "announcing",
        channel: 1,
        rate: 2,
        forced: false,
        confirmed: 1,
        followed: 0,
        total: 2,
        waiting: [{ name: "front", sinceMs: 0 }],
        graceEndsMs: null,
      },
    },
    "confirmed: 1 of 2",
  ],
  [
    "site change cancel",
    { kind: "siteChangeCancel" },
    { kind: "siteChangeCancel", sensors: 2 },
    "cancelled; 2 sensors clear the next settings at their next reply",
  ],
  [
    "site change force",
    { kind: "siteChangeForce", yes: false },
    { kind: "siteChangeForce", switched: false, leftBehind: ["front"] },
    "run `hsn site change force --yes` to switch",
  ],
  [
    "site change force --yes",
    { kind: "siteChangeForce", yes: true },
    { kind: "siteChangeForce", switched: true, leftBehind: ["front"] },
    "switched; left behind, to be paired again: front",
  ],
];
