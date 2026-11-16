/** The modes screen (m2-design.md section 8): see `ui/modes.tsx`. */
import { useTranslation } from "react-i18next";
import { ModesScreen } from "../ui/modes";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.modes.title")} intro={t("modes.intro")}>
      <ModesScreen />
    </Page>
  );
}
