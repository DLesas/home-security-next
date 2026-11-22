/** A test alert for a client the hub lets request its own push. */
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Version2Channel } from "../hub/client";
import { phoneRequest } from "../pairing/hub";
import { useHub, useLive } from "./hub-context";
import { Actions, Body, Button, Done, Heading, Notice, Section } from "./parts";
import { VersionTwoFailure } from "./version-two";

/** Adds the test alert to Notifications when this client can receive one. */
export function TestAlert() {
  const channel = useHub().v2;
  const session = useLive((s) => s.session);
  return channel !== undefined && session?.kind === "phone" ? (
    <TestAlertSection key={session.hub} channel={channel} />
  ) : null;
}

/** Sends one test and says whether the hub sent an alert. */
function TestAlertSection({ channel }: { readonly channel: Version2Channel }) {
  const { t } = useTranslation();
  const test = useMutation({ mutationFn: () => phoneRequest(channel, "push.test", {}) });
  const result = test.data;
  return (
    <Section label={t("notifications.test.title")}>
      <Heading level={2}>{t("notifications.test.title")}</Heading>
      <Actions>
        <Button
          label={t("notifications.test.send")}
          busy={test.isPending}
          onPress={() => {
            test.mutate();
          }}
        />
      </Actions>
      {result === undefined ? null : !result.ok ? (
        <VersionTwoFailure outcome={result} />
      ) : result.value.sent ? (
        <Done text={t("notifications.test.sent")} />
      ) : (
        <Notice kind="info" live="polite">
          <Body>{t("notifications.test.notSent")}</Body>
        </Notice>
      )}
    </Section>
  );
}
