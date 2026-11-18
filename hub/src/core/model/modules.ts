/**
 * The core's modules, in the dispatcher's fixed order (hub-design.md section 2, "Modules and the
 * dispatcher"; m2-design.md section 2, "The modules, in order"). Every message goes to the
 * modules in this order. M2 adds seven (`people`, `layout`, `app`, `schedules`, `health`,
 * `notify`, `upkeep`) at fixed places; the thirteen of M1a keep their relative order. The joint
 * step 0 of M3 and M4 (docs/m3-m4-plan.md) adds two: `relay` right after `people`, whose
 * `clientRemoved` it acts on (m4-design section 4), and `firmware` after `alarm` and `site`, whose
 * views it reads, and before `sensors`, which reads its offers when it builds a reply
 * (m3-updates-design section 4).
 */
export const MODULE_ORDER = [
  "clock",
  "registry",
  "links",
  "setup",
  "control",
  "people",
  "relay",
  "layout",
  "app",
  "schedules",
  "gateways",
  "intake",
  "alarm",
  "site",
  "firmware",
  "sensors",
  "slots",
  "sirens",
  "health",
  "notify",
  "upkeep",
  "audit",
] as const;

export type ModuleName = (typeof MODULE_ORDER)[number];

/** The modules M2 adds (m2-design.md section 2), each a stub in step 0 that changes nothing. */
export const M2_MODULES = [
  "people",
  "layout",
  "app",
  "schedules",
  "health",
  "notify",
  "upkeep",
] as const;
export type M2ModuleName = (typeof M2_MODULES)[number];

/** The modules the joint step 0 of M3 and M4 adds, each a stub that changes nothing until step 1. */
export const M3M4_MODULES = ["firmware", "relay"] as const;
export type M3M4ModuleName = (typeof M3M4_MODULES)[number];
