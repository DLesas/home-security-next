/** The notifications screen (m2-design.md section 8): see `ui/notifications.tsx`. */
import { useTranslation } from "react-i18next";
import { NotificationsScreen } from "../ui/notifications";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.notifications.title")}>
      <NotificationsScreen />
    </Page>
  );
}
