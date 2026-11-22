/**
 * Making a WebSocket, which can throw (a URL the platform will not open): the one `try` of the
 * relay's path (`relay.ts`), kept in a `safe/` folder as docs/m3-m4-plan.md rule 3 has it.
 */

/** The socket `make` gives for `url`, or undefined when making it threw. */
export function openSocket<S>(make: (url: string) => S, url: string): S | undefined {
  try {
    return make(url);
  } catch {
    return undefined;
  }
}
