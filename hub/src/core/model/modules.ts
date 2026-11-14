/**
 * The core's modules, in the dispatcher's fixed order (hub-design.md section 2, "Modules and the
 * dispatcher"; m2-design.md section 2, "The modules, in order"). Every message goes to the
 * modules in this order. M2 adds seven (`people`, `layout`, `app`, `schedules`, `health`,
 * `notify`, `upkeep`) at fixed places; the thirteen of M1a keep their relative order.
 */
export const MODULE_ORDER = [
  "clock",
  "registry",
  "links",
  "setup",
  "control",
  "people",
  "layout",
  "app",
  "schedules",
  "gateways",
  "intake",
  "alarm",
  "site",
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
