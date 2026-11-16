/**
 * What the hub says of itself (\`hub\` events, section 6): an update staged, refused or switching,
 * a backup's result, the database failing and recovered, near its size, history shortened. Each
 * said politely once, over every screen, until dismissed; a failing database stays said until the
 * hub says it recovered, since changes are refused meanwhile.
 */
import { useTranslation } from "react-i18next";
import { dismissHubNotice, type HubWhat } from "../state/live";
import { useHub, useLive } from "./hub-context";
import { Actions, Body, Button, Notice, Stack } from "./parts";

export const HUB_NOTICE_KEYS: Readonly<Record<HubWhat, string>> = {
  updateStaged: "hubNotice.updateStaged",
  updateRefused: "hubNotice.updateRefused",
  updateSwitching: "hubNotice.updateSwitching",
  backup: "hubNotice.backup",
  databaseFailing: "hubNotice.databaseFailing",
  databaseRecovered: "hubNotice.databaseRecovered",
  databaseSize: "hubNotice.databaseSize",
  historyShortened: "hubNotice.historyShortened",
};

export function HubNotices() {
  const { t } = useTranslation();
  const hub = useHub();
  const notices = useLive((s) => s.hubNotices);
  const failing = useLive((s) => s.databaseFailing);
  const shown = notices.filter((n) => n.what !== "databaseFailing");
  if (!failing && shown.length === 0) return null;
  return (
    <Stack>
      {failing ? (
        <Notice kind="danger" live="polite" testID="database-failing">
          <Body>{t(HUB_NOTICE_KEYS.databaseFailing)}</Body>
        </Notice>
      ) : null}
      {shown.map((n) => (
        <Notice
          key={n.what}
          kind={n.what === "updateRefused" || n.what === "databaseSize" ? "warning" : "info"}
          live="polite"
          testID={`hub-notice-${n.what}`}
        >
          <Body>{t(HUB_NOTICE_KEYS[n.what])}</Body>
          <Actions>
            <Button
              kind="quiet"
              label={t("common.dismiss")}
              onPress={() => {
                hub.live.setState(dismissHubNotice(hub.live.getState(), n.what), true);
              }}
            />
          </Actions>
        </Notice>
      ))}
    </Stack>
  );
}
