/** The site screen (m2-design.md section 8): see `ui/site.tsx`. */
import { useTranslation } from "react-i18next";
import { SiteScreen } from "../ui/site";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.site.title")}>
      <SiteScreen />
    </Page>
  );
}
