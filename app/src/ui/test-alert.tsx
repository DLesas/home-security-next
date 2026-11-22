/** A test alert for a client the hub lets request its own push. */
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { phoneRequest } from "../pairing/hub";
import { useLive } from "./hub-context";
import { Actions, Body, Button, Done, Heading, Notice, Section } from "./parts";
import { type VersionTwoClient, VersionTwoFailure, useVersionTwo } from "./version-two";

/** Adds the test alert to Notifications when this client can receive one. */
export function TestAlert() {
  const channel = useVersionTwo();
  const home = useLive((s) => s.session?.hub);
  return channel?.testAlert === true ? <TestAlertSection key={home} channel={channel} /> : null;
}

/** Sends one test and says whether the hub sent an alert. */
function TestAlertSection({ channel }: { readonly channel: VersionTwoClient }) {
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
