/** The schedules screen (m2-design.md section 8): see `ui/schedules.tsx`. */
import { useTranslation } from "react-i18next";
import { SchedulesScreen } from "../ui/schedules";
import { useLive } from "../ui/hub-context";
import { Page } from "../ui/parts";

export default function Screen() {
  const { t } = useTranslation();
  const zone = useLive((s) => s.hub?.timeZone);
  return (
    <Page
      title={t("screens.schedules.title")}
      intro={t("schedules.intro", { zone: zone ?? t("common.unknown") })}
    >
      <SchedulesScreen />
    </Page>
  );
}
