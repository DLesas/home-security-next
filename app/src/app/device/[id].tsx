/** One device and its settings (m2-design.md section 8; AP4, AP5): see `ui/device-detail.tsx`. */
import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { DeviceDetail } from "../../ui/device-detail";
import { Body, Page } from "../../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const device = Number(id);
  return (
    <Page title={t("screens.device.title")}>
      {Number.isInteger(device) && device > 0 ? (
        <DeviceDetail id={device} />
      ) : (
        <Body>{t("deviceDetail.unknown")}</Body>
      )}
    </Page>
  );
}
