/** The groups screen (m2-design.md section 8): see `ui/groups.tsx`. */
import { useTranslation } from "react-i18next";
import { GroupsScreen } from "../ui/groups";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.groups.title")} intro={t("groups.intro")}>
      <GroupsScreen />
    </Page>
  );
}
