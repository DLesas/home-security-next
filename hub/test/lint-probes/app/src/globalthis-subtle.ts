// `subtle` reached through `globalThis` is the same: only in a *.web.ts(x) file.
// Expect: no-restricted-syntax "[web-global] crypto.subtle: the browser's"
export const subtle: unknown = globalThis.crypto.subtle;
