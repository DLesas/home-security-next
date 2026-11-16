/** The link screen (m2-design.md section 8): see `ui/link-device.tsx`. */
import { useTranslation } from "react-i18next";
import { LinkDeviceScreen } from "../ui/link-device";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.link.title")} intro={t("linkDevice.intro")}>
      <LinkDeviceScreen />
    </Page>
  );
}
