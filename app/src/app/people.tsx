/** The people screen (m2-design.md section 8): see `ui/people.tsx`. */
import { useTranslation } from "react-i18next";
import { PeopleScreen } from "../ui/people";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.people.title")}>
      <PeopleScreen />
    </Page>
  );
}
