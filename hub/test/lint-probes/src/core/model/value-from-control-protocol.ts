// Lint probe: core/model may take only types from control-protocol.
// Expect: no-restricted-imports "[core-model-types]"
export { controlCommand } from "../../control-protocol/index.ts";
