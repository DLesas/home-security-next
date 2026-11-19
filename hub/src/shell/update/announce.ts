/**
 * A switch the hub makes itself, announced to the relay first (docs/m4-design.md section 4,
 * "Announcing a restart"; D96): an update's (`switchUpdate`) or a restore's (`switchRestore`).
 * The relay client sends `restarting {reason, withinMs}` and resolves once `restartingAck` comes,
 * 2 s ‡ have passed, or at once with the link down; then the switch goes on as M2 built it (the
 * clean stop, the file work that waits for it, exit 70), so the relay raises no hub-offline alert
 * for the restart.
 *
 * The loop has stopped before this runs (`HubLoop`'s `stop`): nothing more is taken while it
 * waits, so nothing can start that the switch's interlocks would have held it back for. The wait
 * is bounded here too, by the same 2 s ‡, so the switch happens on time whatever the relay client
 * does, and exactly once.
 */
import { RELAY_LIMITS } from "@hsn/protocol/relay";
import type { Timers } from "../app/channel.ts";
import type { RestartReason } from "../relay/client.ts";

/** The relay client's side of it (`RelayClient.announceRestart`). */
export interface RestartAnnouncer {
  announceRestart(reason: RestartReason): Promise<void>;
}

/**
 * Announces the restart, then runs `switchNow` once: when the announcement resolves, when it
 * rejects (it never should), or after `RELAY_LIMITS.restartAckWaitMs`, whichever comes first.
 * Without a relay client it runs at once. The promise resolves once `switchNow` has run.
 */
export function switchAfterAnnouncing(
  relay: RestartAnnouncer | undefined,
  reason: RestartReason,
  timers: Timers,
  switchNow: () => void,
): Promise<void> {
  if (relay === undefined) {
    switchNow();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const go = (): void => {
      if (done) return;
      done = true;
      cancel();
      switchNow();
      resolve();
    };
    const cancel = timers.after(RELAY_LIMITS.restartAckWaitMs, go);
    void relay.announceRestart(reason).then(go, go);
  });
}
