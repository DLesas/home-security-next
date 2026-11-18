// The browser's notifications reached through `globalThis` are the same: only in *.web.ts(x).
// Expect: no-restricted-syntax "[web-global] globalThis's browser objects: the browser's"
export const found: unknown = globalThis.Notification;
