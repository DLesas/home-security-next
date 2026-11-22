/**
 * What a phone that is not linked sees (m3-design.md section 3), in place of the browser's link
 * screen (`link-gate.tsx`): "Link this phone", with the camera ("Scan the code") or the field
 * ("Type the code": a typed code, or a link address pasted). A code scanned or typed links at
 * once, the person having just chosen to; a code opened in the app from another app is shown
 * first ("Link this phone to the home at 192.168.1.20?"). Before the first link, the local
 * network permission's page where the phone needs one (rule 7). Then, as in a browser: linking,
 * the name the hub asks for, the failure in words, and "This phone was removed".
 *
 * A restore code scanned here goes to restoring (section 4, "recognised by its prefix too").
 * Android's back button steps back through these pages before it leaves the app.
 */
import { receivePairingCode } from "../pairing/code-arrival";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler } from "react-native";
import type { CodeSource } from "../hub/client";
import { type PhoneCode, type PhoneLinkSecret, readCode, type RestoreCode } from "../hub/finder";
import type { ArrivedCode } from "../hub/start-types";
import type { Permission } from "../platform/scanner";
import { useHub, useLive, useLocal } from "./hub-context";
import { Actions, Body, Button, Field, Notice, NoticeText, Page, Stack } from "./parts";
import { PermissionAsk, PermissionRefused } from "./permission";
import { PhoneNotices } from "./phone-notices";
import { type PhoneParts, usePhone } from "./phone-parts";
import { codeNotice, phoneFailureKey } from "./phone-words";
import { PhoneRestore } from "./phone-restore";
import { ScanScreen } from "./scan";
import { cleanName } from "./setup";

/** A code that links: its secret, with where it says the hub is, and where it came from. */
export interface LinkCode {
  readonly secret: PhoneLinkSecret;
  readonly from: CodeSource;
}

/** The link code a code read on the phone is, if it is one. */
export function linkCodeOf(code: PhoneCode): LinkCode | undefined {
  if (code.kind === "link") return { secret: code.secret, from: code.from };
  if (code.kind === "typed") return { secret: code.secret, from: "typed" };
  return undefined;
}

/** Where in linking the phone is, beyond what the hub client's link view says. */
export type LinkStep =
  | { readonly kind: "start" }
  | { readonly kind: "scan" }
  | { readonly kind: "type" }
  | { readonly kind: "pair" }
  /** A code from another app, shown before it is used. */
  | { readonly kind: "confirm"; readonly code: LinkCode }
  /** The local network permission's page, before the link (rule 7). */
  | { readonly kind: "network"; readonly code: LinkCode; readonly refused: boolean }
  | { readonly kind: "restore"; readonly code: RestoreCode | null };

/** The page a code opened from another app leads to (section 3, "Deep links"). */
export function stepForArrival(arrived: ArrivedCode): LinkStep {
  if (arrived.from !== "deepLink") return { kind: "start" };
  const read = readCode(arrived.text);
  if (!read.ok) return { kind: "start" };
  if (read.value.kind === "pair" && receivePairingCode(read.value.text)) return { kind: "pair" };
  if (read.value.kind === "restore") return { kind: "restore", code: read.value.restore };
  const code = linkCodeOf(read.value);
  return code === undefined ? { kind: "start" } : { kind: "confirm", code };
}

/** The address a link code names first, for "Link this phone to the home at …?". */
export function firstAddress(code: LinkCode): string | null {
  return code.secret.reach?.addresses[0] ?? null;
}

/** Back from a step: to the first page, or out (null) from it. */
export function stepBack(step: LinkStep): LinkStep | null {
  return step.kind === "start" ? null : { kind: "start" };
}

/** Lets steps handle Back first, then hands it to the caller's page. */
function useBackThroughSteps(
  step: LinkStep,
  setStep: (step: LinkStep) => void,
  backFromStart: (() => void) | undefined,
): void {
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      const back = stepBack(step);
      if (back === null) {
        if (backFromStart === undefined) return false;
        backFromStart();
        return true;
      }
      setStep(back);
      return true;
    });
    return () => {
      handler.remove();
    };
  }, [step, setStep, backFromStart]);
}

interface LinkGateOptions {
  readonly initial?: LinkStep;
  readonly backFromStart?: () => void;
}

/** Reuses the phone linking flow with the caller's optional exit from its first step. */
export function PhoneLinkGate(options: LinkGateOptions) {
  const phone = usePhone();
  return phone === undefined ? null : <Gate phone={phone} {...options} />;
}

/** Runs the link flow with the phone's own permission, camera and hub interfaces. */
function Gate({ phone, initial, backFromStart }: LinkGateOptions & { readonly phone: PhoneParts }) {
  const { t } = useTranslation();
  const hub = useHub();
  const connection = useLive((s) => s.connection);
  const link = useLocal((s) => s.link);
  const [step, setStep] = useState<LinkStep>(() => {
    if (initial !== undefined) return initial;
    const arrived = phone.arrived.claim();
    return arrived === undefined ? { kind: "start" } : stepForArrival(arrived);
  });
  useBackThroughSteps(step, setStep, backFromStart);
  useEffect(
    () =>
      phone.arrived.subscribe((arrived) => {
        setStep(stepForArrival(arrived));
      }),
    [phone],
  );

  const request = useCallback(
    () => ({
      name: t(phone.os === "ios" ? "phoneLink.name.ios" : "phoneLink.name.android"),
      kind: "phone" as const,
    }),
    [phone.os, t],
  );
  const linkNow = useCallback(
    (code: LinkCode) => {
      setStep({ kind: "start" });
      void phone.linker.link(code.secret, code.from, request());
    },
    [phone, request],
  );
  /** Before the link, the local network's page where the permission is not yet given. */
  const go = useCallback(
    (code: LinkCode) => {
      void phone.localNetwork.permission().then((p: Permission) => {
        if (p.state === "granted") linkNow(code);
        else setStep({ kind: "network", code, refused: p.state === "denied" && !p.canAskAgain });
      });
    },
    [phone, linkNow],
  );

  if (connection.kind === "removed") {
    return (
      <Page title={t("phoneLink.removedTitle")}>
        <Body>{t("phoneLink.removed", { home: t("phoneLink.yourHome") })}</Body>
        <Actions>
          <Button
            label={t("phoneLink.linkAgain")}
            onPress={() => void hub.forget()}
            testID="link-again"
          />
        </Actions>
      </Page>
    );
  }
  if (connection.kind === "noStorage") {
    return (
      <Page title={t("phoneLink.noStorageTitle")}>
        <Body>{t("phoneLink.noStorage")}</Body>
      </Page>
    );
  }
  if (link.kind === "askingName") return <AskName />;

  switch (step.kind) {
    case "scan":
      return (
        <ScanScreen
          scanner={phone.scanner}
          point={t("scan.pointLink")}
          onOpenSettings={phone.openSettings}
          instead={{
            label: t("scan.typeInstead"),
            onPress: () => {
              setStep({ kind: "type" });
            },
          }}
          onCode={(text) => {
            const read = readCode(text);
            if (!read.ok) return t(codeNotice(read.fault));
            if (read.value.kind === "restore") {
              setStep({ kind: "restore", code: read.value.restore });
              return null;
            }
            if (read.value.kind === "pair" && receivePairingCode(read.value.text)) {
              setStep({ kind: "pair" });
              return null;
            }
            const code = linkCodeOf(read.value);
            if (code === undefined) return t("scan.notOurs");
            go(code);
            return null;
          }}
        />
      );
    case "pair":
      return (
        <Page title={t("pairing.add")} intro={t("pairing.linkFirst")}>
          <Actions>
            <Button
              label={t("phoneLink.title")}
              onPress={() => {
                setStep({ kind: "start" });
              }}
            />
          </Actions>
        </Page>
      );
    case "restore":
      return <PhoneRestore code={step.code} />;
    case "confirm": {
      const address = firstAddress(step.code);
      return (
        <Page
          title={t("phoneLink.confirmTitle")}
          intro={
            address === null ? t("phoneLink.confirmNoAddress") : t("phoneLink.confirm", { address })
          }
        >
          <Actions>
            <Button
              label={t("phoneLink.submit")}
              onPress={() => {
                go(step.code);
              }}
              testID="link-confirm-yes"
            />
            <Button
              kind="quiet"
              label={t("phoneLink.cancel")}
              onPress={() => {
                setStep({ kind: "start" });
              }}
            />
          </Actions>
        </Page>
      );
    }
    case "network":
      return (
        <Page title={t("phoneLink.networkTitle")}>
          {step.refused ? (
            <PermissionRefused
              sentence={t("permissionPage.localNetworkRefused")}
              onOpenSettings={phone.openSettings}
              testID="network-refused"
            />
          ) : (
            <PermissionAsk
              sentence={t("permissions.localNetwork")}
              allow={t("permissionPage.allowLocalNetwork")}
              testID="network-ask"
              onAllow={() => {
                void phone.localNetwork.ask().then((answer) => {
                  if (answer.state === "granted") linkNow(step.code);
                  else setStep({ ...step, refused: true });
                });
              }}
            />
          )}
        </Page>
      );
    case "type":
      return (
        <Start>
          <TypeCode
            onCode={go}
            onScan={() => {
              setStep({ kind: "scan" });
            }}
          />
        </Start>
      );
    case "start":
      return (
        <Start>
          <Actions>
            <Button
              label={t("phoneLink.scan")}
              onPress={() => {
                setStep({ kind: "scan" });
              }}
              testID="link-scan"
            />
            <Button
              kind="quiet"
              label={t("phoneLink.type")}
              onPress={() => {
                setStep({ kind: "type" });
              }}
              testID="link-type"
            />
          </Actions>
        </Start>
      );
  }
}

/** The first page: its title and introduction, how linking goes, and the ways in. */
function Start({ children }: { readonly children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Page title={t("phoneLink.title")} intro={t("phoneLink.intro")}>
      <PhoneNotices />
      <LinkStatus />
      {children}
    </Page>
  );
}

function LinkStatus() {
  const { t } = useTranslation();
  const phone = usePhone();
  const link = useLocal((s) => s.link);
  if (link.kind === "linking") {
    return (
      <Notice kind="info" live="polite" testID="link-status">
        <NoticeText kind="info">{t("phoneLink.linking")}</NoticeText>
      </Notice>
    );
  }
  if (link.kind !== "failed") return null;
  return (
    <Notice kind="danger" live="polite" testID="link-status">
      <NoticeText kind="danger">
        {t(phoneFailureKey(link.failure, phone?.linker.reachFault()))}
      </NoticeText>
    </Notice>
  );
}

/** A typed code or a pasted link address; it links at once when it reads. */
function TypeCode({
  onCode,
  onScan,
}: {
  readonly onCode: (code: LinkCode) => void;
  readonly onScan: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const read = readCode(text);
    const code = read.ok ? linkCodeOf(read.value) : undefined;
    if (code !== undefined) {
      setError(null);
      onCode(code);
      return;
    }
    // A typed code that does not read is mistyped; another code is said as the camera says it.
    setError(
      read.ok
        ? t("phoneLink.code.notLink")
        : read.fault === "notOurs"
          ? t("link.failure.badCode")
          : t(codeNotice(read.fault)),
    );
  };
  return (
    <Stack>
      <Field
        label={t("phoneLink.codeLabel")}
        hint={t("phoneLink.codeHint")}
        value={text}
        onChange={(value) => {
          setText(value);
          setError(null);
        }}
        onSubmit={submit}
        autoComplete="off"
        testID="link-code"
        {...(error === null ? {} : { error })}
      />
      <Actions>
        <Button label={t("phoneLink.submit")} onPress={submit} testID="link-submit" />
        <Button
          kind="quiet"
          label={t("phoneLink.scanInstead")}
          onPress={onScan}
          testID="link-scan-instead"
        />
      </Actions>
    </Stack>
  );
}

/** The hub asks for the new person's name (message 2's `askName`). */
function AskName() {
  const { t } = useTranslation();
  const hub = useHub();
  const [name, setName] = useState("");
  const [bad, setBad] = useState(false);
  const give = () => {
    const clean = cleanName(name);
    setBad(clean === undefined);
    if (clean !== undefined) void hub.giveName(clean);
  };
  return (
    <Page title={t("phoneLink.title")}>
      <Body>{t("link.askName")}</Body>
      <Stack>
        <Field
          label={t("link.yourName")}
          value={name}
          onChange={setName}
          onSubmit={give}
          autoComplete="name"
          testID="link-person-name"
          {...(bad ? { error: t("editing.badName") } : {})}
        />
        <Actions>
          <Button label={t("phoneLink.submit")} onPress={give} testID="link-person-submit" />
        </Actions>
      </Stack>
    </Page>
  );
}
