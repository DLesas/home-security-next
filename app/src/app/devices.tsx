/** The device list with health (m2-design.md section 8; AP4), and adding boards over USB (PR5). */
import { useTranslation } from "react-i18next";
import { NewList, DeviceList, UsbAdd } from "../ui/devices";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.devices.title")}>
      <DeviceList />
      <NewList />
      <UsbAdd />
    </Page>
  );
}
