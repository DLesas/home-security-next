// The browser's `navigator` only in a *.web.ts(x) file (m3-design.md section 2).
// Expect: no-restricted-globals "[web-global] navigator: the browser's"
export const kind = typeof navigator;
