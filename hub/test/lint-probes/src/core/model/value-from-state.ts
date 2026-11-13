// Lint probe: core/model may take only types from a module's state.ts.
// Expect: no-restricted-imports "[core-model-types]"
export { EMPTY_ALARM_SLICE } from "../alarm/state.ts";
