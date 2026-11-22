/** The hub's relay, from its status and setting operations. */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { phoneRequest } from "../pairing/hub";
import { formatTime } from "./format";
import { useLive } from "./hub-context";
import { Actions, Body, Button, Done, Field, Heading, Section } from "./parts";
import {
  deniedSettings,
  type VersionTwoClient,
  VersionTwoFailure,
  useVersionTwo,
  useVersionTwoRead,
} from "./version-two";

/** Shows relay settings only when the client can ask the hub for them. */
export function RelaySettings() {
  const channel = useVersionTwo();
  const home = useLive((s) => s.session?.hub);
  return channel === undefined ? null : <RelaySection key={home} channel={channel} />;
}

/** Shows the relay's status and lets a manager set its address or return to the default. */
function RelaySection({ channel }: { readonly channel: VersionTwoClient }) {
  const { t, i18n } = useTranslation();
  const info = useLive((s) => s.hub);
  const status = useVersionTwoRead(channel, "relay.status", {});
  const [address, setAddress] = useState("");
  const [empty, setEmpty] = useState(false);
  const setting = useMutation({
    mutationFn: (url: string | null) => phoneRequest(channel, "relay.set", { url }),
    onSuccess: (outcome) => {
      if (!outcome.ok) return;
      setAddress("");
      void status.refetch();
    },
  });
  const read = status.data;
  if (read === undefined || deniedSettings(read)) return null;
  const outcome = setting.data;
  const current = read.ok ? read.value : undefined;

  /** Leaves all address validation to the hub after trimming and checking for empty input. */
  function save() {
    if (setting.isPending) return;
    const url = address.trim();
    setEmpty(url === "");
    if (url === "") setting.reset();
    else setting.mutate(url);
  }

  const reason =
    outcome?.ok === false && "error" in outcome && outcome.error.code === "invalid"
      ? outcome.error.detail.reason
      : undefined;
  const fieldFailure =
    reason === "format"
      ? t("relay.format")
      : reason === "notLocal"
        ? t("relay.notLocal")
        : undefined;
  return (
    <Section label={t("relay.title")}>
      <Heading level={2}>{t("relay.title")}</Heading>
      {current === undefined ? (
        read.ok ? null : (
          <VersionTwoFailure outcome={read} />
        )
      ) : (
        <>
          <Body>{t(current.url === null ? "relay.none" : `relay.state.${current.state}`)}</Body>
          <Body>{t(current.isDefault ? "relay.default" : "relay.custom")}</Body>
          {current.url === null ? null : <Body>{t("relay.address", { url: current.url })}</Body>}
          <Body>
            {current.sinceMs === null
              ? t("relay.sinceBoot")
              : t("relay.since", { time: formatTime(t, i18n.language, info, current.sinceMs) })}
          </Body>
          {current.lastError === undefined ? null : (
            <Body>
              {t("relay.lastError", {
                error: t(`relay.error.${current.lastError}`, {
                  defaultValue: t("relay.error.unknown"),
                }),
              })}
            </Body>
          )}
          <Field
            label={t("relay.customAddress")}
            value={address}
            autoComplete="off"
            onChange={(text) => {
              setAddress(text);
              setEmpty(false);
            }}
            onSubmit={save}
            {...(empty ? { error: t("relay.empty") } : {})}
          />
          <Actions>
            <Button label={t("relay.save")} onPress={save} busy={setting.isPending} />
            <Button
              kind="quiet"
              label={t("relay.useDefault")}
              busy={setting.isPending}
              onPress={() => {
                setEmpty(false);
                setting.mutate(null);
              }}
            />
          </Actions>
          {outcome === undefined ? null : outcome.ok ? (
            <Done text={t("relay.saved")} />
          ) : (
            <VersionTwoFailure
              outcome={outcome}
              {...(fieldFailure === undefined ? {} : { text: fieldFailure })}
            />
          )}
        </>
      )}
    </Section>
  );
}
