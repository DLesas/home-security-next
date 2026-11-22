/** Version 2 reads and refusal wording shared by the settings screens. */
import { appError, type AppOpBodyV2, type AppOpNameV2 } from "@hsn/protocol/app";
import { useQuery } from "@tanstack/react-query";
import type { Version2Channel } from "../hub/client";
import { type HubOutcome, phoneRequest } from "../pairing/hub";
import { useLive } from "./hub-context";
import { Failure, Notice, NoticeText } from "./parts";

type SettingsRead = "relay.status" | "update.offers";
type SettingsFailure = Extract<HubOutcome<AppOpNameV2>, { ok: false }>;

/** Reads settings again after a hub event, permissions change, or new session. */
export function useVersionTwoRead<N extends SettingsRead>(
  client: Version2Channel | undefined,
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
