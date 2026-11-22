/** Selects the browser fallback for Bun and type-checks both platform bindings. */
import type { AlertPermissionPlatform } from "./alert-permission-types";
import type * as phone from "./alert-permission.native";
import type * as web from "./alert-permission.web";
import type { Split } from "./split";

export { alertPermission } from "./alert-permission.web";
export type AlertPermissionSplit = Split<AlertPermissionPlatform, typeof web, typeof phone>;
