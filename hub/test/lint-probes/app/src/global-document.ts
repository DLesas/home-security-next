// The browser's `document` only in a *.web.ts(x) file (m3-design.md section 2).
// Expect: no-restricted-globals "[web-global] document: the browser's"
export const kind = typeof document;
