/**
 * Settings (docs/app-design.md "Layout"): an index of its eight pages, one row each with a line
 * saying what the page is for. The whole row opens the page.
 */
import { useTranslation } from "react-i18next";
import { DESTINATIONS } from "../ui/navigation";
import { List, LinkRow, Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  const settings = DESTINATIONS.find((d) => d.index === "/settings");
  return (
    <Page title={t("screens.settings.title")}>
      <List label={t("screens.settings.title")}>
        {(settings?.pages ?? []).map(([href, label]) => (
          <LinkRow
            key={href}
            href={href}
            testID={`settings-${href.slice(1)}`}
            name={t(label)}
            detail={t(`settingsIndex${href.replace("/", ".")}`)}
          />
        ))}
      </List>
    </Page>
  );
}
