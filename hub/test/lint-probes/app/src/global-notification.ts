// The browser's `Notification` only in a *.web.ts(x) file (m3-design.md section 2).
// Expect: no-restricted-globals "[web-global] Notification: the browser's"
export const kind = typeof Notification;
