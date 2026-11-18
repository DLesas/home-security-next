// The browser's `BroadcastChannel` only in a *.web.ts(x) file (m3-design.md section 2).
// Expect: no-restricted-globals "[web-global] BroadcastChannel: the browser's"
export const kind = typeof BroadcastChannel;
