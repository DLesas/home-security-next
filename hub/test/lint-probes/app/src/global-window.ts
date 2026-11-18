// The browser's `window` only in a *.web.ts(x) file (m3-design.md section 2).
// Expect: no-restricted-globals "[web-global] window: the browser's"
export const kind = typeof window;
