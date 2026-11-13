/**
 * The settings a new sensor's first version carries (hub-design.md section 9, "Adding a device
 * over USB": its settings with version 1; protocol.md §8): the values the protocol's timing table
 * gives, and the firmware's own defaults (`sensor_constants.hpp`), so a sensor paired with them
 * needs no reply to keep its rhythm.
 */

/** Heartbeat interval: 3 minutes, 12 units of 15 s (§8, D52, DS4). */
export const DEFAULT_HEARTBEAT_UNITS = 12;
/** Link check: a reply on every 5th heartbeat (§7, §8, D72). */
export const DEFAULT_LINK_CHECK_EVERY = 5;
/** No clock correction until slots has measured one (§6, section 8). */
export const DEFAULT_CORRECTION_UNITS = 0;
