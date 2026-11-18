// A *.web.ts file is the web build's: every browser object is allowed here.
// Expect: clean
export const seen: readonly unknown[] = [
  typeof window,
  typeof document,
  typeof navigator,
  typeof indexedDB,
  typeof localStorage,
  typeof BroadcastChannel,
  typeof Notification,
  typeof AudioContext,
  crypto.subtle,
  (globalThis as { readonly indexedDB?: unknown }).indexedDB,
];
