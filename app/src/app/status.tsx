/** The status screen (m2-design.md section 8): see `ui/status.tsx`. */
import { useTranslation } from "react-i18next";
import { StatusScreen } from "../ui/status";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.status.title")}>
      <StatusScreen />
    </Page>
  );
}
