/**
 * First-time setup (m2-design.md sections 7 and 8; AP0): the first person's name, the site's radio
 * (the channel by survey, the rate), the Wi-Fi details for devices, then the devices: the gateway
 * shown as added when it is plugged in (D100), sensors and sirens added over USB and named (PR5).
 * Each step is its own request and is saved when it is answered; nothing is held back for a final
 * "finish". What the hub refuses (a step only the hub computer may do, a rate fixed once a device
 * is paired) is shown as it answered.
 */
import { displayName } from "@hsn/protocol/app";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listOf } from "../state/words";
import { NewList, UsbAdd } from "./devices";
import { useAction, useHub, useLive } from "./hub-context";
import {
  Actions,
  Body,
  Button,
  Choice,
  Failure,
  Field,
  Heading,
  Notice,
  Section,
  TextLink,
} from "./parts";

/** A person's name as the app sends it: trimmed and in NFC (section 7, "Names"); undefined if the hub would refuse it. */
export function cleanName(text: string): string | undefined {
  const name = text.trim().normalize("NFC");
  return displayName.safeParse(name).success ? name : undefined;
}

/** `people.list`, read again whenever a `people` event comes. */
export function usePeople() {
  const hub = useHub();
  const stale = useLive((s) => s.stale.people);
  const connected = useLive((s) => s.connection.kind === "open");
  return useQuery({
    queryKey: ["people.list", stale],
    queryFn: () => hub.request("people.list", {}),
    enabled: connected,
  });
}

function PersonStep() {
  const { t, i18n } = useTranslation();
  const people = usePeople();
  const queries = useQueryClient();
  const create = useAction("person.create");
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const names = people.data?.ok === true ? people.data.body.people.map((p) => p.name) : [];
  const submit = () => {
    const clean = cleanName(name);
    if (clean === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void create.run({ name: clean }).then((outcome) => {
      if (outcome.ok) {
        setName("");
        void queries.invalidateQueries({ queryKey: ["people.list"] });
      }
    });
  };
  return (
    <Section label={t("setup.person.title")}>
      <Heading level={2}>{t("setup.person.title")}</Heading>
      <Body>{t("setup.person.intro")}</Body>
      {names.length > 0 ? (
        <Notice kind="ok">
          <Body>{t("setup.person.done", { names: listOf(names, i18n.language) })}</Body>
        </Notice>
      ) : null}
      {people.data !== undefined && !people.data.ok ? <Failure outcome={people.data} /> : null}
      <Field
        label={t("setup.person.label")}
        value={name}
        onChange={setName}
        onSubmit={submit}
        autoComplete="name"
        testID="setup-person"
        {...(invalid ? { error: t("setup.person.error") } : {})}
      />
      <Actions>
        <Button
          label={t("setup.person.submit")}
          onPress={submit}
          busy={create.busy}
          testID="setup-person-submit"
        />
      </Actions>
      {create.outcome !== undefined && !create.outcome.ok ? (
        <Failure outcome={create.outcome} />
      ) : null}
    </Section>
  );
}

const CHANNEL_KEYS = [
  "setup.site.channelValue.0",
  "setup.site.channelValue.1",
  "setup.site.channelValue.2",
] as const;

function SiteStep() {
  const { t } = useTranslation();
  const site = useLive((s) => s.site);
  const survey = useAction("site.survey");
  const setRate = useAction("site.set");
  const channel = site?.channel ?? null;
  const rates = useMemo(
    () => [0, 1, 2, 3, 4, 5].map((n) => ({ value: n, label: t("setup.site.rate", { n }) })),
    [t],
  );
  return (
    <Section label={t("setup.site.title")}>
      <Heading level={2}>{t("setup.site.title")}</Heading>
      <Body testID="setup-channel">
        {channel === null
          ? t("setup.site.channelNotChosen")
          : t("setup.site.channel", { channel: t(CHANNEL_KEYS[channel] ?? CHANNEL_KEYS[0]) })}
      </Body>
      <Body muted>{t("setup.site.surveyHint")}</Body>
      <Actions>
        <Button
          label={t("setup.site.survey")}
          busy={survey.busy}
          onPress={() => void survey.run({})}
          testID="setup-survey"
        />
      </Actions>
      {survey.outcome === undefined ? null : survey.outcome.ok ? (
        <Notice kind="ok" live="polite">
          <Body>
            {t("setup.site.surveyed", {
              channel: t(CHANNEL_KEYS[survey.outcome.body.channel] ?? CHANNEL_KEYS[0]),
            })}
          </Body>
        </Notice>
      ) : (
        <Failure outcome={survey.outcome} />
      )}
      <Choice
        label={t("setup.site.rateLabel")}
        options={rates}
        value={site?.rate}
        onChange={(rate) => void setRate.run({ rate })}
      />
      <Body muted>{t("setup.site.rateHint")}</Body>
      {setRate.outcome === undefined ? null : setRate.outcome.ok ? (
        <Notice kind="ok" live="polite">
          <Body>{t("setup.site.rateSaved", { n: setRate.outcome.body.rate })}</Body>
        </Notice>
      ) : (
        <Failure outcome={setRate.outcome} />
      )}
    </Section>
  );
}

export function WifiStep() {
  const { t } = useTranslation();
  const site = useLive((s) => s.site);
  const save = useAction("site.wifi");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = () => {
    if (name.trim() === "") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void save.run({ name: name.trim(), password }).then((outcome) => {
      if (outcome.ok) setPassword("");
    });
  };
  const current = save.outcome?.ok === true ? save.outcome.body.wifiName : (site?.wifiName ?? "");
  return (
    <Section label={t("setup.wifi.title")}>
      <Heading level={2}>{t("setup.wifi.title")}</Heading>
      <Body>{t("setup.wifi.intro")}</Body>
      <Body>
        {current === "" ? t("setup.wifi.currentNone") : t("setup.wifi.current", { name: current })}
      </Body>
      <Field
        label={t("setup.wifi.nameLabel")}
        value={name}
        onChange={setName}
        autoComplete="off"
        testID="setup-wifi-name"
        {...(invalid ? { error: t("setup.wifi.nameError") } : {})}
      />
      <Field
        label={t("setup.wifi.passwordLabel")}
        value={password}
        onChange={setPassword}
        secure
        autoComplete="new-password"
        testID="setup-wifi-password"
        onSubmit={submit}
      />
      <Actions>
        <Button
          label={t("setup.wifi.submit")}
          onPress={submit}
          busy={save.busy}
          testID="setup-wifi-submit"
        />
      </Actions>
      {save.outcome === undefined ? null : save.outcome.ok ? (
        <Notice kind="ok" live="polite">
          <Body>{t("setup.wifi.saved")}</Body>
        </Notice>
      ) : (
        <Failure outcome={save.outcome} />
      )}
    </Section>
  );
}

function DevicesStep() {
  const { t, i18n } = useTranslation();
  const devices = useLive((s) => s.devices);
  const gateways = useMemo(
    () =>
      Object.values(devices)
        .filter((d) => d.role === "gateway")
        .map((d) => d.name),
    [devices],
  );
  return (
    <Section label={t("setup.devices.title")}>
      <Heading level={2}>{t("setup.devices.title")}</Heading>
      <Body>{t("setup.devices.intro")}</Body>
      <Body testID="setup-gateways">
        {gateways.length === 0
          ? t("setup.devices.noGateway")
          : t("setup.devices.gateways", { names: listOf(gateways, i18n.language) })}
      </Body>
      <NewList />
    </Section>
  );
}

export function SetupSteps() {
  const { t } = useTranslation();
  return (
    <>
      <PersonStep />
      <SiteStep />
      <WifiStep />
      <DevicesStep />
      <UsbAdd />
      <TextLink href="/" label={t("setup.finish")} />
    </>
  );
}

/** On the home screen: setup is not finished while no person exists or no device is paired. */
export function SetupPrompt() {
  const { t } = useTranslation();
  const people = usePeople();
  const devices = useLive((s) => s.devices);
  const noPeople = people.data?.ok === true && people.data.body.people.length === 0;
  if (!noPeople && Object.keys(devices).length > 0) return null;
  if (people.data === undefined) return null;
  return (
    <Notice kind="info" testID="setup-prompt">
      <Body>{t("home.setupPrompt")}</Body>
      <TextLink href="/setup" label={t("home.setupLink")} />
    </Notice>
  );
}
