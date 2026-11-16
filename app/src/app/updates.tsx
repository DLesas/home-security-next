/** The updates screen (m2-design.md section 8): see `ui/updates.tsx`. */
import { useTranslation } from "react-i18next";
import { UpdatesScreen } from "../ui/updates";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.updates.title")}>
      <UpdatesScreen />
    </Page>
  );
}
