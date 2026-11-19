/** The device list with health (m2-design.md section 8; AP4), and adding boards over USB (PR5). */
import { Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { NewList, DeviceList, UsbAdd } from "../ui/devices";
import { Page, TextLink } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.devices.title")}>
      <DeviceList />
      <NewList />
      {Platform.OS === "web" ? (
        <UsbAdd />
      ) : (
        <TextLink href="/device/add" label={t("pairing.add")} />
      )}
    </Page>
  );
}
