/** The history screen (m2-design.md section 8): see `ui/history.tsx`. */
import { useTranslation } from "react-i18next";
import { HistoryScreen } from "../ui/history";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.history.title")} intro={t("history.intro")}>
      <HistoryScreen />
    </Page>
  );
}
