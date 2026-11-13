// Lint probe: the core may not import at run time.
// Expect: no-restricted-syntax "[core-dynamic-import]"
export const load = (): Promise<unknown> => import("./other.ts");
