// Web Crypto's `subtle` only in a *.web.ts(x) file (m3-design.md section 2).
// Expect: no-restricted-syntax "[web-global] crypto.subtle: the browser's"
export const subtle: unknown = crypto.subtle;
