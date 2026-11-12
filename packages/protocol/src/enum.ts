/**
 * Enumerated fields (roles, actions, states, reasons, result codes) are decoded as the raw byte:
 * a value this version does not list still leaves the packet valid (section 3, "Enumerated
 * values"). Callers check with this one guard before acting on a value.
 */

/** True when `value` is one of the values of a constant object such as `SirenAction`. */
export function isEnumValue<const E extends Readonly<Record<string, number>>>(
  enumeration: E,
  value: number,
): value is E[keyof E] {
  return Object.values(enumeration).includes(value);
}
