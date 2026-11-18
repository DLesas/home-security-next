// A browser object reached through `globalThis`, cast or not, only in a *.web.ts(x) file.
// Expect: no-restricted-syntax "[web-global] globalThis's browser objects: the browser's"
export const found: unknown = (globalThis as { readonly indexedDB?: unknown }).indexedDB;
