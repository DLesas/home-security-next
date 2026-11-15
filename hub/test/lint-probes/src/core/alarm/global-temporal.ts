// Lint probe: the core may not use Temporal; calendar arithmetic is deps.calendar.
// Expect: no-restricted-globals "[core-global] Temporal:"
export const zone = (): unknown => Reflect.get(Temporal, "Now");
