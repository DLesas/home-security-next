/**
 * The hub client for the screens: a React context, the live store through selectors, and an
 * action hook that sends one request and keeps its outcome for the screen to show in words.
 *
 * Selectors return what the store holds (never a new object), as Zustand needs for a stable view.
 */
import type { AppOpBody, AppOpName } from "@hsn/protocol/app";
import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import type { RequestOutcome } from "../hub/channel";
import type { HubClient, LocalState } from "../hub/client";
import type { LiveState } from "../state/live";

const HubContext = createContext<HubClient | undefined>(undefined);

export function HubProvider({
  client,
  children,
}: {
  readonly client: HubClient;
  readonly children: ReactNode;
}) {
  return <HubContext.Provider value={client}>{children}</HubContext.Provider>;
}

export function useHub(): HubClient {
  const client = useContext(HubContext);
  if (client === undefined) throw new Error("useHub outside HubProvider");
  return client;
}

export function useLive<T>(select: (state: LiveState) => T): T {
  return useStore(useHub().live, select);
}

export function useLocal<T>(select: (state: LocalState) => T): T {
  return useStore(useHub().local, select);
}

export interface Action<N extends AppOpName> {
  readonly busy: boolean;
  readonly outcome: RequestOutcome<N> | undefined;
  run(body: AppOpBody<N>): Promise<RequestOutcome<N>>;
  readonly clear: () => void;
}

/** One operation a screen sends, at most one at a time, with its last outcome. */
export function useAction<N extends AppOpName>(op: N): Action<N> {
  const hub = useHub();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RequestOutcome<N> | undefined>(undefined);
  const run = useCallback(
    async (body: AppOpBody<N>) => {
      setBusy(true);
      setOutcome(undefined);
      const result = await hub.request(op, body);
      setBusy(false);
      setOutcome(result);
      return result;
    },
    [hub, op],
  );
  const clear = useCallback(() => {
    setOutcome(undefined);
  }, []);
  return { busy, outcome, run, clear };
}

/**
 * A read, through TanStack Query, read again when the counter `stale` names moves (an event said
 * it changed) and whenever a new session opens; never while out of touch.
 */
export function useRead<N extends AppOpName>(
  op: N,
  body: AppOpBody<N>,
  stale: keyof LiveState["stale"] | undefined,
  enabled = true,
) {
  const hub = useHub();
  const counter = useLive((s) => (stale === undefined ? 0 : s.stale[stale]));
  const boot = useLive((s) => s.session?.boot ?? 0);
  const connected = useLive((s) => s.connection.kind === "open");
  return useQuery({
    queryKey: [op, JSON.stringify(body), counter, boot],
    queryFn: () => hub.request(op, body),
    enabled: connected && enabled,
  });
}
