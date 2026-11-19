import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { askBluetooth } from "../platform/ble";
import type { BleState } from "../platform/ble";
import { Body, Button, Actions, Page, Stack } from "../ui/parts";
import { PermissionAsk, PermissionRefused } from "../ui/permission";
import { usePhone } from "../ui/phone-parts";

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
  /** Begins the native permission check only after the button is pressed. */
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
