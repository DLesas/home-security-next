/** The backup screen (m2-design.md section 8): see `ui/backup.tsx`. */
import { useTranslation } from "react-i18next";
import { BackupScreen } from "../ui/backup";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.backup.title")}>
      <BackupScreen />
    </Page>
  );
}
