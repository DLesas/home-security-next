/**
 * The control commands and replies the core receives and makes (hub-design.md sections 2 and
 * 9). Their one definition is the Zod schemas of `control-protocol/`; the core takes the types
 * only, so it never loads Zod. SPEC-QUESTION: section 1 lets the core import only its model,
 * `@hsn/protocol` and `neverthrow`, yet `HubEvent` and `Effect` carry these types; the lint
 * rules let `core/model/` import types, and only types, from `control-protocol/`.
 */
export type {
  CommandResult,
  ControlCommand,
  ControlCommandKind,
  ControlError,
  ControlReply,
  RecordJson,
} from "../../control-protocol/index.ts";
