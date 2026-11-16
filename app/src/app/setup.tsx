/** First-time setup (m2-design.md section 8): the first person, the radio, the Wi-Fi, the devices. */
import { useTranslation } from "react-i18next";
import { Page } from "../ui/parts";
import { SetupSteps } from "../ui/setup";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.setup.title")} intro={t("setup.intro")}>
      <SetupSteps />
    </Page>
  );
}
