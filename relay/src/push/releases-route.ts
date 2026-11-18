/**
 * The way from a joined relay link to the releases role (docs/m4-design.md sections 3 and 6,
 * D142): on the operated service, a self-hosted relay fills its release cache with `release.check`
 * and `release.get` over its relay link; the push process passes them, unchanged, to the releases
 * role through B2's forwarding socket (`relay/src/releases/forwarding.ts`, one socket per joined
 * link, named by the relay key XN proved and the link's address), and passes every answer back.
 * Budgets are the releases role's, behind the socket; the link's own caps are `relay-link.ts`'s.
 */
import { ReleaseForwarder } from "../releases/forwarding.ts";
import type { PushLog } from "./log.ts";

/** One joined link's way to the releases role. */
export interface ReleaseRoute {
  /** Passes one release frame through as it is; false when the way is not open. */
  forward(text: string): Promise<boolean>;
  close(): void;
}

/** Who the link is, for the releases role's budgets. */
export interface ReleasePeerOf {
  readonly identity: string;
  readonly address: string | null;
}

/**
 * Opens a link's route: `onAnswer` gets each answer (text or a binary piece) as it came, `onGone`
 * once when the route closes, whichever side closed it. Undefined when it could not be opened.
 */
export type OpenReleaseRoute = (
  peer: ReleasePeerOf,
  onAnswer: (answer: string | Uint8Array) => void,
  onGone: () => void,
) => ReleaseRoute | undefined;

/** Routes over the forwarding socket at `socketPath`, counting the sockets open. */
export interface ForwardedRoutes {
  readonly open: OpenReleaseRoute;
  /** Forwarding sockets not yet closed: for the tests that no link leaves one behind. */
  readonly live: () => number;
}

export function forwardedRoutes(socketPath: string, log: PushLog): ForwardedRoutes {
  let live = 0;
  return {
    live: () => live,
    open(peer, onAnswer, onGone) {
      let gone = false;
      const opened = ReleaseForwarder.open(socketPath, peer, onAnswer, () => {
        if (gone) return;
        gone = true;
        live -= 1;
        onGone();
      });
      if (opened.isErr()) {
        log.write("warning", "releasesUnreachable", {});
        return undefined;
      }
      live += 1;
      const forwarder = opened.value;
      return {
        forward: (text) => forwarder.forward(text),
        close: () => {
          forwarder.close();
        },
      };
    },
  };
}
