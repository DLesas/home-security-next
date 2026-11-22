/** Permission and delivery status for the chosen home on a phone's Notifications screen. */
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { PhoneClient } from "../hub/phone-client";
import type { PhoneAlerts, PhoneAlertStatus } from "../hub/push";
import type { AlertPermission } from "../platform/alert-permission-types";
import { useHub, useLive } from "./hub-context";
import {
  Actions,
  Body,
  Button,
  Heading,
  Notice,
  NoticeText,
  Section,
  Stack,
  Toggle,
} from "./parts";

/** Picks the first delivery condition that applies to the chosen home. */
export function phoneAlertStatus({
  enabled,
  permission,
  available,
  stored,
  target,
}: Omit<PhoneAlertStatus, "hub" | "client">) {
  if (!enabled) return "off";
  if (permission !== "granted") return "permission";
  if (!available) return "unavailable";
  return stored && target?.registered && target.valid ? "ready" : "retry";
}

/** Adds the alert controls only for an authenticated phone that speaks version two. */
export function PhoneAlertsSection({ fallback }: { readonly fallback: ReactNode }) {
  const hub: PhoneClient["client"] = useHub();
  const session = useLive((state) => state.session);
  const home = useLive((state) => state.hub);
  const alerts = hub.phoneAlerts;
  return session?.kind === "phone" && hub.v2 && home?.proto === 2 && alerts?.permission ? (
    <HomeAlerts
      key={`${home.identity}:${String(session.client)}`}
      alerts={alerts}
      permission={alerts.permission}
      session={{ hub: home.identity, client: session.client }}
    />
  ) : (
    fallback
  );
}

/** Renders the latest status and runs the chosen home's actions. */
function HomeAlerts({
  alerts,
  permission,
  session,
}: {
  readonly alerts: PhoneAlerts;
  readonly permission: AlertPermission;
  readonly session: Pick<PhoneAlertStatus, "hub" | "client">;
}) {
  const { t } = useTranslation();
  const status = useStore(alerts.status);
  const changing = useRef(false);
  const [fault, setFault] = useState<"hub" | "storage" | "token" | null>(null);
  if (status?.hub !== session.hub || status.client !== session.client) return null;

  /** Keeps the switch at its saved value until the change completes. */
  function setEnabled(enabled: boolean) {
    if (changing.current) return;
    changing.current = true;
    setFault(null);
    void alerts.setEnabled(session.hub, session.client, enabled).then((result) => {
      changing.current = false;
      if (!result.ok) setFault(result.fault);
    });
  }

  const title = t("notifications.phoneAlerts.title");
  return (
    <Section label={title}>
      <Heading level={2}>{title}</Heading>
      <Body testID="phone-alert-status">
        {t(`notifications.phoneAlerts.status.${phoneAlertStatus(status)}`)}
      </Body>
      {status.permission === "notAsked" ? (
        <Stack>
          <Body>{t("notifications.phoneAlerts.explain")}</Body>
          <Actions>
            <Button label={t("notifications.phoneAlerts.allow")} onPress={alerts.ask} />
          </Actions>
        </Stack>
      ) : status.permission === "denied" ? (
        <Stack>
          <Body>{t("notifications.phoneAlerts.denied")}</Body>
          <Actions>
            <Button
              label={t("permissionPage.openSettings")}
              onPress={() => void permission.openSettings()}
            />
          </Actions>
        </Stack>
      ) : null}
      <Toggle
        label={t("notifications.phoneAlerts.switch")}
        value={status.enabled}
        onChange={setEnabled}
        testID="phone-alert-switch"
      />
      {fault === null ? null : (
        <Notice kind="danger" live="polite">
          <NoticeText kind="danger">
            {t(
              fault === "hub"
                ? "notifications.phoneAlerts.unreachable"
                : "notifications.phoneAlerts.saveFailed",
            )}
          </NoticeText>
        </Notice>
      )}
      {permission.openNotificationSettings ? (
        <Stack>
          <Body>{t("notifications.phoneAlerts.loud")}</Body>
          <Actions>
            <Button
              kind="quiet"
              label={t("notifications.phoneAlerts.notificationSettings")}
              onPress={() => void permission.openNotificationSettings?.()}
            />
          </Actions>
        </Stack>
      ) : null}
    </Section>
  );
}
