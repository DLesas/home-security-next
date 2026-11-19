import { type ReactNode, useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { askBluetooth, checkBluetooth } from "../platform/ble";
import type { BleState } from "../platform/ble";
import { Body, Button, Actions, Page, Stack } from "../ui/parts";
import { PermissionAsk, PermissionRefused } from "../ui/permission";
import { usePhone } from "../ui/phone-parts";
import { radioClock } from "./radio";

type CheckAnswer = BleState | "checkFailed" | undefined;

/** Bounds a native or bridge check, and discards replies after the deadline or cleanup. */
function startBluetoothCheck(onAnswer: (answer: CheckAnswer) => void): () => void {
  let pending = true;
  const stop = radioClock.after(3000, () => {
    finish("checkFailed");
  });

  /** Settles the page once, whichever response comes first. */
  function finish(answer: CheckAnswer) {
    if (!pending) return;
    pending = false;
    stop();
    onAnswer(answer);
  }

  void Promise.resolve()
    .then(checkBluetooth)
    .then(finish, () => {
      finish("checkFailed");
    });
  return () => {
    pending = false;
    stop();
  };
}

/** Checks before showing a permission page when adding a device or updating firmware. */
export function BluetoothEntry({
  initial,
  onReady,
  exit,
}: {
  readonly initial?: BleState;
  readonly onReady: () => void;
  readonly exit: ReactNode;
}) {
  const [state, setState] = useState<CheckAnswer | "checking">("checking");

  /** Advances only when Bluetooth is both allowed and on. */
  const checked = useEffectEvent((answer: CheckAnswer) => {
    if (answer === "on") {
      onReady();
      return;
    }
    setState(answer ?? (state === "checking" ? initial : state));
  });

  useEffect(
    () =>
      startBluetoothCheck((answer) => {
        checked(answer);
      }),
    [],
  );
  useEffect(() => {
    if (state !== "unauthorized") return;
    let stop: (() => void) | undefined;
    const listener = AppState.addEventListener("change", (status) => {
      if (status === "active") {
        stop?.();
        stop = startBluetoothCheck((answer) => {
          checked(answer);
        });
      }
    });
    return () => {
      stop?.();
      listener.remove();
    };
  }, [state]);

  return (
    <BluetoothPermission
      state={state}
      exit={exit}
      onAnswer={(answer) => {
        if (answer === "on") onReady();
        else setState(answer);
      }}
    />
  );
}

/** Explains Bluetooth before asking, then gives one recovery for each radio state. */
export function BluetoothPermission({
  state,
  onAnswer,
  exit,
}: {
  readonly state: CheckAnswer | "checking";
  readonly onAnswer: (state: BleState) => void;
  readonly exit: ReactNode;
}) {
  const { t } = useTranslation();
  const phone = usePhone();
  /** Requests permission or rechecks the radio at the person’s request. */
  const ask = () => {
    void askBluetooth().then(onAnswer);
  };
  const title =
    state === "checking"
      ? "bluetooth.checking"
      : state === "checkFailed"
        ? "bluetooth.checkFailed"
        : "bluetooth.title";
  return (
    <Page title={t(title)}>
      {state === "checking" ? null : state === "unauthorized" ? (
        <PermissionRefused
          sentence={t("bluetooth.refused")}
          onOpenSettings={() => phone?.openSettings()}
        />
      ) : state === undefined ? (
        <PermissionAsk
          sentence={t("permissions.bluetooth")}
          allow={t("bluetooth.allow")}
          onAllow={ask}
        />
      ) : (
        <Stack>
          {state === "checkFailed" ? null : (
            <Body>{t(state === "off" ? "bluetooth.off" : "bluetooth.unsupported")}</Body>
          )}
          {state === "off" || state === "checkFailed" ? (
            <Actions>
              <Button label={t("bluetooth.checkAgain")} onPress={ask} />
            </Actions>
          ) : null}
        </Stack>
      )}
      {exit}
    </Page>
  );
}
