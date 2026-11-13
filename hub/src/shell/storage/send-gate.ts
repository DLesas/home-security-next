/**
 * The send gate (hub-design.md section 4): every `send` effect passes here before it reaches a
 * link. It goes only if each hub counter it uses is below the highest resume point committed for
 * that device key; otherwise it is held back and the core is told `sendFailed {notDurable}`. So
 * "a counter is never reused" is a check the shell makes on every packet, whatever the core does.
 *
 * A turn whose "now" commit failed sends nothing at all: nothing leaves the hub until every
 * item written "now" that justified it is committed (section 4, "The rule"). The later turns'
 * sends, which depend on nothing uncommitted, pass as usual, which is how every key keeps
 * sending below its durable resume point while the disk is broken (section 4).
 */
import { err, ok, type Result } from "neverthrow";
import type { CounterUse } from "../../core/model/effects.ts";
import type { LinkError } from "../../ports/links.ts";
import type { Writer } from "../../ports/writer.ts";
import { linkError } from "../safe/link-error.ts";

const ORIGIN = "shell/storage/send-gate";

export type NotDurable = LinkError & { readonly code: "notDurable" };

function notDurable(message: string): NotDurable {
  return { ...linkError("notDurable", ORIGIN, message), code: "notDurable" };
}

/**
 * Whether a send may go: its turn's "now" items are committed (`turnCommitted`), and every
 * counter it uses is below its key's committed resume point.
 */
export function admitSend(
  writer: Pick<Writer, "durable">,
  counters: readonly CounterUse[],
  turnCommitted: boolean,
): Result<void, NotDurable> {
  if (!turnCommitted) return err(notDurable("its turn's commit failed"));
  for (const { device, counter } of counters) {
    const durable = writer.durable(device);
    if (durable === undefined || counter >= durable) {
      return err(
        notDurable(
          `counter ${counter} of device ${device} is not below its committed resume point ${durable ?? "(none)"}`,
        ),
      );
    }
  }
  return ok(undefined);
}
