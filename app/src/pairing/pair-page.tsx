/** The household's steps for adding one board. The code never becomes route state. */
import { deviceNameValue } from "@hsn/protocol/app";
import { Role } from "@hsn/protocol/messages";
import {
  type BoardQr,
  readBoardQr,
  readPairingCode,
  type PairingCodeText,
} from "@hsn/protocol/pairing";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { bleCentral, type BleState } from "../platform/ble";
import { useLive } from "../ui/hub-context";
import {
  Actions,
  Body,
  Button,
  CheckList,
  Field,
  Notice,
  NoticeText,
  Page,
  Stack,
  TextLink,
} from "../ui/parts";
import { usePhone } from "../ui/phone-parts";
import { ScanScreen } from "../ui/scan";
import { useFlowAwake } from "./awake";
import type { PhoneHub } from "./hub";
import {
  addBoard,
  type Candidate,
  findPairingBoards,
  type OpenBoard,
  pairingFlow,
  pairingRoles,
} from "./pair-device";
import { BluetoothEntry } from "./permission";
import {
  pairBackground,
  type PairPageName,
  retryAfter,
  searchFault,
  showsNoContact,
} from "./pair-steps";
import { radioClock } from "./radio";

/** Maps the board's wire role into a locale key. */
function roleKey(role: number): "sensor" | "siren" | "gateway" {
  return role === Role.Siren ? "siren" : role === Role.Gateway ? "gateway" : "sensor";
}

/** Runs discovery, authentication and provisioning while the native route stays in front. */
export function PairPage({
  hub,
  initialCode,
  previousName,
}: {
  readonly hub: PhoneHub;
  readonly initialCode?: BoardQr;
  readonly previousName?: string;
}) {
  const { t } = useTranslation();
  const phone = usePhone();
  const [flow] = useState(() => pairingFlow(bleCentral, radioClock));
  const [page, setPage] = useState<PairPageName>(
    initialCode === undefined ? "choose" : "permission",
  );
  const [role, setRole] = useState<Role | undefined>();
  const [retryRadio, setRetryRadio] = useState<BleState>();
  const qr = useRef(initialCode);
  const [candidates, setCandidates] = useState<readonly Candidate[]>([]);
  const [candidate, setCandidate] = useState<Candidate>();
  const board = useRef<OpenBoard | undefined>(undefined);
  const operation = useRef<AbortController | undefined>(undefined);
  const [failure, setFailure] = useState<string>();
  const [text, setText] = useState("");
  const [name, setName] = useState(previousName ?? "");
  const [groups, setGroups] = useState<readonly number[]>([]);
  const [device, setDevice] = useState<number>();
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const catalogue = useLive((s) => s.groups);
  const current = useLive((s) => (device === undefined ? undefined : s.devices[device]));
  const mode = useLive((s) => {
    const id = s.mode?.mode;
    return id === undefined || id === null ? undefined : s.modes[id];
  });
  const kind = roleKey(candidate?.version.role ?? role ?? Role.Sensor);
  const keepAwake = !["choose", "open", "permission", "done", "failure"].includes(page);
  useFlowAwake(keepAwake);
  const exit = <TextLink href="/devices" label={t("nav.devices")} />;

  useEffect(
    () => () => {
      operation.current?.abort();
      board.current?.session.close();
      qr.current = undefined;
    },
    [],
  );

  useEffect(() => {
    const effect = pairBackground(page);
    if (effect === "none") return;
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      operation.current?.abort();
      board.current?.session.close();
      board.current = undefined;
      qr.current = undefined;
      setText("");
      setFailure(effect);
      setPage("failure");
    });
    return () => {
      listener.remove();
    };
  }, [page]);

  useEffect(() => {
    if (page !== "waiting") return;
    if (current?.state === "contacted") {
      setTimedOut(false);
      setPage("done");
      return;
    }
    return radioClock.after(60_000, () => {
      setTimedOut(true);
      setPage("done");
    });
  }, [page, current?.state]);

  /** Replaces any cancelled operation when the person starts another attempt. */
  function begin(): AbortSignal {
    operation.current?.abort();
    const next = new AbortController();
    operation.current = next;
    return next.signal;
  }

  /** Connects to the chosen board and verifies the code before asking for its name. */
  async function authenticate(chosen: Candidate, code: PairingCodeText) {
    const signal = begin();
    setFailure(undefined);
    setText("");
    setPage("checking");
    const opened = await flow.open(chosen, code, signal);
    if (signal.aborted) return;
    if (!opened.ok) {
      setFailure(searchFault[opened.fault]);
      setPage("failure");
      return;
    }
    board.current = opened.value;
    qr.current = undefined;
    if (!name) setName(t(`pairing.defaultName.${roleKey(opened.value.version.role)}`));
    setPage("name");
  }

  /** Uses the complete clear-text chip id to verify a scanned board, including name collisions. */
  async function find(code = qr.current) {
    const signal = begin();
    setFailure(undefined);
    setPage("find");
    const found = await findPairingBoards(bleCentral, radioClock, signal, role, code);
    if (signal.aborted) return;
    if (!found.ok) {
      setFailure(searchFault[found.fault]);
      setPage("failure");
      return;
    }
    const first = found.value[0];
    if (first === undefined) return;
    if (found.value.length === 1) {
      setCandidate(first);
      setPage("found");
    } else {
      setCandidates(found.value);
      setPage("chooseBoard");
    }
  }

  /** Validates a typed code locally without using a board's attempt. */
  function submitCode() {
    const code = readPairingCode(text);
    if (code === undefined || candidate === undefined) {
      setFailure("mistyped");
      return;
    }
    void authenticate(candidate, code);
  }

  /** Applies the name and group choices only after the board accepts its setup. */
  async function submitName() {
    const open = board.current;
    const cleaned = name.trim();
    if (open === undefined) return;
    if (!deviceNameValue.safeParse(cleaned).success) {
      setFailure("invalidName");
      return;
    }
    const signal = operation.current?.signal ?? begin();
    setPage("adding");
    setFailure(undefined);
    const result = await addBoard(hub, open, cleaned, groups, signal);
    board.current = undefined;
    if (signal.aborted) return;
    if (result.kind === "refused") {
      setFailure(result.reason);
      setPage("failure");
      return;
    }
    setGroupsFailed(result.groupsFailed);
    setDevice(result.device.id);
    setPage("waiting");
  }

  /** Displays the same physical label as the board, using its probed role and chip. */
  const label = (item: Candidate) =>
    t(`pairing.label.${roleKey(item.version.role)}`, {
      chip: item.version.chip.slice(-4).toUpperCase(),
    });

  if (page === "permission")
    return (
      <BluetoothEntry
        {...(retryRadio === undefined ? {} : { initial: retryRadio })}
        onReady={() => void find()}
        exit={exit}
      />
    );
  if (page === "scan" && phone !== undefined) {
    return (
      <ScanScreen
        scanner={phone.scanner}
        point={t("pairing.point")}
        onOpenSettings={phone.openSettings}
        instead={{
          label: t("scan.typeInstead"),
          onPress: () => {
            setPage("type");
          },
        }}
        onCode={(value) => {
          const read = readBoardQr(value);
          if (read === undefined) return t("scan.notOurs");
          if (
            candidate?.version.chip !==
            [...read.chipId].map((byte) => byte.toString(16).padStart(2, "0")).join("")
          )
            return t("pairing.wrongBoard");
          qr.current = read;
          void authenticate(candidate, read.code);
          return null;
        }}
      />
    );
  }

  if (page === "choose")
    return (
      <Page title={t("pairing.add")} intro={t("pairing.choose")}>
        <Actions>
          {pairingRoles.map((value) => (
            <Button
              key={value}
              kind="quiet"
              label={t(`pairing.role.${roleKey(value)}`)}
              onPress={() => {
                setRole(value);
                setPage("open");
              }}
            />
          ))}
        </Actions>
        {exit}
      </Page>
    );

  if (page === "open")
    return (
      <Page title={t("pairing.open")} intro={t("pairing.openHint")}>
        <Actions>
          <Button
            label={t("pairing.findAction")}
            onPress={() => {
              setRetryRadio(undefined);
              setPage("permission");
            }}
          />
        </Actions>
        {exit}
      </Page>
    );

  if (page === "chooseBoard")
    return (
      <Page title={t("pairing.which")} intro={t("pairing.whichHint")}>
        <Actions>
          {candidates.map((item) => (
            <Button
              key={item.advert.id}
              kind="quiet"
              label={label(item)}
              onPress={() => {
                setCandidate(item);
                setPage("found");
              }}
            />
          ))}
        </Actions>
        {exit}
      </Page>
    );

  if (page === "found" && candidate !== undefined)
    return (
      <Page
        title={label(candidate)}
        intro={t("pairing.firmware", { version: candidate.version.firmware })}
      >
        <Stack>
          <Body>{t("pairing.codeLife")}</Body>
          <Actions>
            {qr.current === undefined ? (
              <>
                <Button
                  label={t("pairing.scanAction")}
                  onPress={() => {
                    setPage("scan");
                  }}
                />
                <Button
                  kind="quiet"
                  label={t("pairing.typeAction")}
                  onPress={() => {
                    setPage("type");
                  }}
                />
              </>
            ) : (
              <Button
                label={t("pairing.checkAction")}
                onPress={() => {
                  const read = qr.current;
                  if (read !== undefined) void authenticate(candidate, read.code);
                }}
              />
            )}
          </Actions>
        </Stack>
        {exit}
      </Page>
    );

  if (page === "type")
    return (
      <Page title={t("pairing.typeAction")} intro={t("pairing.codeLife")}>
        <Stack>
          <Field
            label={t("pairing.code")}
            value={text}
            onChange={(value) => {
              setText(value);
              setFailure(undefined);
            }}
            secure
            autoComplete="off"
            onSubmit={submitCode}
            testID="pair-code"
            {...(failure === "mistyped" ? { error: t("pairing.failure.mistyped") } : {})}
          />
          <Actions>
            <Button label={t("pairing.checkAction")} onPress={submitCode} />
          </Actions>
        </Stack>
        {exit}
      </Page>
    );

  if (page === "name") {
    const groupOptions = Object.values(catalogue)
      .filter((group) => kind === "sensor" || group.sirens !== "all")
      .map((group) => ({ value: group.id, label: group.name }));
    return (
      <Page
        title={t(`pairing.name.${kind}`)}
        intro={t("pairing.firmware", { version: candidate?.version.firmware ?? "" })}
      >
        <Stack>
          <Field
            label={t("pairing.nameLabel")}
            value={name}
            onChange={(value) => {
              setName(value);
              setFailure(undefined);
            }}
            onSubmit={() => void submitName()}
            testID="pair-name"
            {...(failure === "invalidName" ? { error: t("pairing.failure.invalidName") } : {})}
          />
          {kind !== "gateway" && groupOptions.length > 0 ? (
            <CheckList
              label={t("pairing.groups")}
              options={groupOptions}
              values={groups}
              onChange={setGroups}
            />
          ) : null}
          <Actions>
            <Button label={t(`pairing.submit.${kind}`)} onPress={() => void submitName()} />
          </Actions>
        </Stack>
        {exit}
      </Page>
    );
  }

  if (page === "failure") {
    const reason = failure ?? "radioFailed";
    const left = candidate === undefined ? 0 : flow.remaining(candidate.version.chip);
    return (
      <Page title={t("pairing.problem")}>
        <Stack>
          <Notice kind="warning" live="polite">
            <NoticeText kind="warning">
              {t(`pairing.failure.${reason}`, {
                count: left,
                defaultValue: t("pairing.failure.radioFailed"),
              })}
            </NoticeText>
          </Notice>
          <Actions>
            {reason === "alreadyOurs" ? null : (
              <Button
                label={t(
                  reason === "wrongCode"
                    ? "pairing.tryCode"
                    : reason === "tooManyTries"
                      ? "pairing.windowOpen"
                      : reason === "noWifi"
                        ? "pairing.wifiAction"
                        : "pairing.tryAgain",
                )}
                onPress={() => {
                  const retry = retryAfter(reason, candidate?.version.chip);
                  if (retry.reopen !== undefined) flow.reopened(retry.reopen);
                  if (retry.page === "find") void find();
                  else if (retry.page === "permission") {
                    setRetryRadio(reason === "off" ? "off" : "unauthorized");
                    setPage("permission");
                  } else {
                    setFailure(undefined);
                    setPage(retry.page);
                  }
                }}
              />
            )}
            {reason === "noWifi" ? <TextLink href="/site" label={t("pairing.wifiLink")} /> : null}
          </Actions>
        </Stack>
        {exit}
      </Page>
    );
  }

  const noContact = showsNoContact(timedOut, current?.state);
  if (page === "done")
    return (
      <Page
        title={t(noContact ? "pairing.noContact" : `pairing.added.${kind}`)}
        intro={t(noContact ? `pairing.noContactHint.${kind}` : "pairing.working")}
      >
        <Stack>
          {kind === "sensor" && mode !== undefined && mode.fixed !== "disarmed" ? (
            <Body>{t("pairing.disarmed")}</Body>
          ) : null}
          {groupsFailed ? <Body>{t("pairing.groupsFailed")}</Body> : null}
          {device === undefined ? null : (
            <TextLink href={`/device/${device}`} label={t("pairing.showDevice")} />
          )}
          {exit}
        </Stack>
      </Page>
    );

  const title =
    page === "find"
      ? "pairing.looking"
      : page === "checking"
        ? "pairing.checking"
        : page === "adding"
          ? "pairing.adding"
          : `pairing.waiting.${kind}`;
  return (
    <Page title={t(title)} intro={t("pairing.stay")}>
      {exit}
    </Page>
  );
}
