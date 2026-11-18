/**
 * Which module owns each app operation (m2-design.md section 2's module table, section 6): an
 * `opRequest` goes to its owner, which checks, makes and answers it. Frozen by step 0, so the
 * request routing of control and app cannot disagree.
 */
import type { AppOpNameV2 } from "@hsn/protocol/app";
import {
  M2_MODULES,
  type M2ModuleName,
  M3M4_MODULES,
  type M3M4ModuleName,
  type ModuleName,
} from "./modules.ts";

/**
 * The owner of each operation (m2-design.md section 11, "The four readings of ownership"): one of
 * M2's modules, which takes it as an `opRequest`; an M1a module that owns the same change for
 * `hsn`, which `app` reaches with that module's own request message (section 2, "Requests for
 * M1a's modules"); or the shell, which answers `fileChunk` itself (section 6).
 */
export const OP_OWNERS: Readonly<Record<AppOpNameV2, ModuleName | "shell">> = {
  snapshot: "app",
  subscribe: "app",
  "hub.info": "app",
  "hub.status": "app",
  // The keepalive is the shell's (section 5): the channel sends `ping` and answers `pong`.
  pong: "shell",
  fileChunk: "shell",
  "device.list": "app",
  "device.show": "app",
  "mode.switch": "layout",
  arm: "layout",
  disarm: "layout",
  "group.create": "layout",
  "group.update": "layout",
  "group.delete": "layout",
  "mode.create": "layout",
  "mode.update": "layout",
  "mode.delete": "layout",
  "schedule.create": "schedules",
  "schedule.update": "schedules",
  "schedule.delete": "schedules",
  "notifications.list": "notify",
  "notifications.read": "notify",
  "notifications.prefs": "notify",
  "people.list": "people",
  "person.create": "people",
  "person.rename": "people",
  "person.remove": "people",
  "permissions.set": "people",
  "userManagement.set": "people",
  "clients.list": "people",
  "client.rename": "people",
  "client.remove": "people",
  "link.create": "people",
  "link.cancel": "people",
  "device.rename": "registry",
  "device.remove": "registry",
  "sensor.settings": "sensors",
  "siren.settings": "sirens",
  "siren.test": "sirens",
  "gateway.settings": "gateways",
  "usb.list": "setup",
  "usb.add": "setup",
  "usb.erase": "setup",
  "site.show": "site",
  "site.set": "site",
  "site.wifi": "site",
  "site.survey": "site",
  "site.change": "site",
  "site.changeStatus": "site",
  "history.query": "app",
  "backup.key": "upkeep",
  "backup.status": "upkeep",
  "backup.settings": "upkeep",
  "backup.now": "upkeep",
  "backup.export": "upkeep",
  "restore.start": "upkeep",
  "update.status": "upkeep",
  "update.upload": "upkeep",
  "update.approve": "upkeep",
  "update.cancel": "upkeep",

  // Channel version 2 (docs/m3-m4-plan.md, the joint step 0).
  // The phone design (m3-design section 10): H1 builds `pair.*` in setup and `presence.set` and
  // `hub.info`'s fields in app; A8 the backup key's fix in upkeep.
  "pair.prepare": "setup",
  "pair.finish": "setup",
  "presence.set": "app",
  "backup.keyHeld": "upkeep",
  // The relay design (m4-design section 9).
  "push.register": "relay",
  "push.unregister": "relay",
  "push.test": "relay",
  "relay.status": "relay",
  "relay.set": "relay",
  "update.offers": "upkeep",
  "update.fetch": "upkeep",
  // The updates design (m3-updates-design section 4).
  "firmware.list": "firmware",
  "firmware.offers": "firmware",
  "firmware.fetch": "firmware",
  "firmware.upload": "firmware",
  "firmware.remove": "firmware",
  "firmware.bluetooth": "firmware",
  "firmware.download": "firmware",
  "rollout.start": "firmware",
  "rollout.pause": "firmware",
  "rollout.resume": "firmware",
  "rollout.cancel": "firmware",
  "rollout.status": "firmware",
};

const M2_OWNERS: ReadonlySet<string> = new Set<M2ModuleName>(M2_MODULES);
const M3M4_OWNERS: ReadonlySet<string> = new Set<M3M4ModuleName>(M3M4_MODULES);

function isM2(owner: string): owner is M2ModuleName {
  return M2_OWNERS.has(owner);
}

function isM3M4(owner: string): owner is M3M4ModuleName {
  return M3M4_OWNERS.has(owner);
}

/** The operation's owner when it is one of M2's modules, the ones `opRequest` reaches. */
export function m2OwnerOf(op: AppOpNameV2): M2ModuleName | undefined {
  const owner = OP_OWNERS[op];
  return isM2(owner) ? owner : undefined;
}

/** The operation's owner when it is `firmware` or `relay`, the ones `v2OpRequest` reaches. */
export function m3m4OwnerOf(op: AppOpNameV2): M3M4ModuleName | undefined {
  const owner = OP_OWNERS[op];
  return isM3M4(owner) ? owner : undefined;
}
