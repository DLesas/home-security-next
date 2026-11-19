import { type ReactNode, useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { askBluetooth, checkBluetooth } from "../platform/ble";
import type { BleState } from "../platform/ble";
import { Body, Button, Actions, Page, Stack } from "../ui/parts";
import { PermissionAsk, PermissionRefused } from "../ui/permission";
import { usePhone } from "../ui/phone-parts";

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
  const [state, setState] = useState<BleState | "checking" | undefined>("checking");

  /** Advances only when Bluetooth is both allowed and on. */
  const checked = useEffectEvent((answer: BleState | undefined) => {
    if (answer === "on") onReady();
    else setState(answer ?? (state === "checking" ? initial : state));
  });

  useEffect(() => {
    let current = true;
    void checkBluetooth().then((answer) => {
      if (current) checked(answer);
    });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    if (state !== "unauthorized") return;
    let current = true;
    const listener = AppState.addEventListener("change", (status) => {
      if (status === "active") {
        void checkBluetooth().then((answer) => {
          if (current) checked(answer);
        });
      }
    });
    return () => {
      current = false;
      listener.remove();
    };
  }, [state]);

  if (state === "checking") return null;
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
  readonly state: BleState | undefined;
  readonly onAnswer: (state: BleState) => void;
  readonly exit: ReactNode;
}) {
  const { t } = useTranslation();
  const phone = usePhone();
  /** Requests permission or rechecks the radio at the person’s request. */
  const ask = () => {
    void askBluetooth().then(onAnswer);
  };
  return (
    <Page title={t("bluetooth.title")}>
      {state === "unauthorized" ? (
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
          <Body>{t(state === "off" ? "bluetooth.off" : "bluetooth.unsupported")}</Body>
          {state === "off" ? (
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
