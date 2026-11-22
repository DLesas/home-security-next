/** A channel capability supplied by the app's wiring, shared by the settings screens. */
import { appError, type AppOpBodyV2, type AppOpNameV2 } from "@hsn/protocol/app";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { type HubOutcome, type PhoneHub, phoneRequest } from "../pairing/hub";
import { useLive } from "./hub-context";
import { Failure, Notice, NoticeText } from "./parts";

export interface VersionTwoClient extends Pick<PhoneHub, "forward"> {
  /** Whether this client can ask the hub to send a test alert to itself. */
  readonly testAlert: boolean;
}

const VersionTwoContext = createContext<VersionTwoClient | undefined>(undefined);
type SettingsRead = "relay.status" | "update.offers";
type SettingsFailure = Extract<HubOutcome<AppOpNameV2>, { ok: false }>;

/** Supplies the version 2 channel to shared screens when the client has one. */
export function VersionTwoProvider({
  client,
  children,
}: {
  readonly client: VersionTwoClient | undefined;
  readonly children: ReactNode;
}) {
  return <VersionTwoContext.Provider value={client}>{children}</VersionTwoContext.Provider>;
}

/** Returns the channel capability when the current client supports these operations. */
export function useVersionTwo() {
  return useContext(VersionTwoContext);
}

/** Reads settings again after a hub event, permissions change, or new session. */
export function useVersionTwoRead<N extends SettingsRead>(
  client: VersionTwoClient | undefined,
  op: N,
  body: AppOpBodyV2<N>,
) {
  const session = useLive((s) => s.session);
  const connected = useLive((s) => s.connection.kind === "open");
  const hubRevision = useLive((s) => s.stale.hub);
  const peopleRevision = useLive((s) => s.stale.people);
  return useQuery({
    queryKey: [op, session?.hub, session?.client, session?.boot, hubRevision, peopleRevision],
    queryFn: () =>
      client === undefined
        ? Promise.resolve({ ok: false, local: "offline" } as const)
        : phoneRequest(client, op, body),
    enabled: connected && session !== null && client !== undefined,
    placeholderData: (previous, query) => {
      const key = query?.queryKey;
      return key?.[1] === session?.hub &&
        key?.[2] === session?.client &&
        key?.[3] === session?.boot &&
        key?.[5] === peopleRevision
        ? previous
        : undefined;
    },
  });
}

/** Says whether the hub withheld a section from this person. */
export function deniedSettings(outcome: HubOutcome<SettingsRead> | undefined): boolean {
  return outcome?.ok === false && "error" in outcome && outcome.error.code === "unauthorized";
}

/** Shows a refusal using the screen's words or the shared request errors. */
export function VersionTwoFailure({
  outcome,
  text,
}: {
  readonly outcome: SettingsFailure;
  readonly text?: string;
}) {
  if (text !== undefined) {
    return (
      <Notice kind="danger" live="polite">
        <NoticeText kind="danger">{text}</NoticeText>
      </Notice>
    );
  }
  if ("local" in outcome) return <Failure outcome={outcome} />;
  if (outcome.error.code === "busy") {
    return <Failure outcome={{ ok: false, error: outcome.error }} />;
  }
  const parsed = appError.safeParse(outcome.error);
  return (
    <Failure
      outcome={{
        ok: false,
        error: parsed.success ? parsed.data : { code: "unavailable", detail: {} },
      }}
    />
  );
}
