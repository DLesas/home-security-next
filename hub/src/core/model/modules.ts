/**
 * The thirteen modules of the core, in the dispatcher's fixed order (hub-design.md section 2,
 * "Modules and the dispatcher"). Every message goes to the modules in this order.
 */
export const MODULE_ORDER = [
  "clock",
  "registry",
  "links",
  "setup",
  "control",
  "gateways",
  "intake",
  "alarm",
  "site",
  "sensors",
  "slots",
  "sirens",
  "audit",
] as const;

export type ModuleName = (typeof MODULE_ORDER)[number];
