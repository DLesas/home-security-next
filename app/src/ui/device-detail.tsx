/**
 * One device and its settings (m2-design.md sections 6 and 7; AP4, AP5, HB8): its readings and
 * health; renaming and removing (*manage system*); a sensor's countdown and heartbeat (*manage* of
 * it) and its link check, reply rate and frequency correction (*manage system*); a siren's longest
 * sound and a test; a gateway's settings. Each setting left empty is kept as it is. The hub checks
 * every permission and range and answers with the new settings version.
 *
 * The current values come with `device.show` and are shown beside each field, with the settings
 * version they make.
 */
import { Platform } from "react-native";
import { DeviceUpdateSection } from "../pairing/device-update-section";
import { APP_OPS, deviceNameValue, type DeviceObject } from "@hsn/protocol/app";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DeviceItemFacts } from "./devices";
import { groupsLeftWithout } from "./siren-choice";
import { SirenDialog } from "./siren-dialog";
import { useAction, useLive, useRead } from "./hub-context";
import {
  Actions,
  Body,
  Button,
  ConfirmButton,
  Done,
  Failure,
  Field,
  Heading,
  Section,
  TextLink,
} from "./parts";

/** A whole number typed in a field, `learn` where the setting has it, or nothing (keep as is). */
export function numberOrKeep(text: string, learn = false): number | "learn" | undefined | null {
  const clean = text.trim();
  if (clean === "") return undefined;
  if (learn && clean.toLowerCase() === "learn") return "learn";
  return /^-?\d+$/u.test(clean) ? Number(clean) : null;
}

type SettingsOp = "sensor.settings" | "siren.settings" | "gateway.settings";

interface SettingField {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly learn?: boolean;
}

/** A settings form: fields by name, each optional, checked by the operation's own schema before sending. */
function SettingsForm({
  op,
  base,
  fields,
  title,
  required,
  current,
}: {
  readonly op: SettingsOp;
  readonly base: Readonly<Record<string, number>>;
  readonly fields: readonly SettingField[];
  readonly title: string;
  readonly required?: boolean;
  /** The settings as the hub has them (`device.show`), shown beside each field. */
  readonly current?: Readonly<Record<string, number | string>> | undefined;
}) {
  const { t } = useTranslation();
  const save = useAction(op);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [bad, setBad] = useState(false);
  const submit = () => {
    const body: Record<string, number | "learn"> = { ...base };
    for (const field of fields) {
      const value = numberOrKeep(values[field.key] ?? "", field.learn === true);
      if (value === null) {
        setBad(true);
        return;
      }
      if (value !== undefined) body[field.key] = value;
    }
    const parsed = APP_OPS[op].body.safeParse(body);
    const changed = Object.keys(body).length > Object.keys(base).length;
    setBad(!parsed.success || (required !== true && !changed));
    if (parsed.success && (required === true || changed)) void save.run(parsed.data);
  };
  return (
    <Section label={title}>
      <Heading level={2}>{title}</Heading>
      <Body muted>{t("deviceDetail.keepEmpty")}</Body>
      {fields.map((field) => (
        <Field
          key={field.key}
          label={field.label}
          hint={
            current?.[field.key] === undefined
              ? field.hint
              : `${field.hint} ${t("deviceDetail.now", { value: String(current[field.key]) })}`
          }
          value={values[field.key] ?? ""}
          onChange={(text) => {
            setValues({ ...values, [field.key]: text });
          }}
          testID={`setting-${field.key}`}
        />
      ))}
      {bad ? <Body>{t("deviceDetail.badSetting")}</Body> : null}
      <Actions>
        <Button
          label={t("deviceDetail.saveSettings")}
          busy={save.busy}
          onPress={submit}
          testID={`save-${op}`}
        />
      </Actions>
      {save.outcome === undefined ? null : save.outcome.ok ? (
        <Done text={t("deviceDetail.settingsSaved", { version: save.outcome.body.version })} />
      ) : (
        <Failure outcome={save.outcome} />
      )}
    </Section>
  );
}

function SirenTest({ siren }: { readonly siren: number }) {
  const { t } = useTranslation();
  const test = useAction("siren.test");
  const [seconds, setSeconds] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <Section label={t("deviceDetail.testTitle")}>
      <Heading level={2}>{t("deviceDetail.testTitle")}</Heading>
      <Body>{t("deviceDetail.testIntro")}</Body>
      <Field
        label={t("deviceDetail.testSeconds")}
        hint={t("deviceDetail.keepEmptyDefault")}
        value={seconds}
        onChange={setSeconds}
      />
      {bad ? <Body>{t("deviceDetail.badSetting")}</Body> : null}
      <Actions>
        <ConfirmButton
          label={t("deviceDetail.test")}
          question={t("deviceDetail.testQuestion")}
          yes={t("deviceDetail.yesTest")}
          no={t("editing.no")}
          busy={test.busy}
          onConfirm={() => {
            const value = numberOrKeep(seconds);
            const ok =
              value === undefined || (typeof value === "number" && value >= 1 && value <= 0xffff);
            setBad(!ok);
            if (ok)
              void test.run({ siren, ...(typeof value === "number" ? { seconds: value } : {}) });
          }}
        />
      </Actions>
      {test.outcome === undefined ? null : test.outcome.ok ? (
        <Done text={t("deviceDetail.testing", { count: test.outcome.body.seconds })} />
      ) : (
        <Failure outcome={test.outcome} />
      )}
    </Section>
  );
}

function RenameRemove({ device }: { readonly device: DeviceObject }) {
  const { t } = useTranslation();
  const rename = useAction("device.rename");
  const remove = useAction("device.remove");
  const schedules = useLive((s) => s.schedules);
  const groups = useLive((s) => s.groups);
  const devices = useLive((s) => s.devices);
  // The groups that removing this siren leaves with none of their own (D144): asked first.
  const leftWithout = useMemo(
    () => groupsLeftWithout(Object.values(groups), devices, device.id),
    [groups, devices, device.id],
  );
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState(device.name);
  const [bad, setBad] = useState(false);
  const refs =
    remove.outcome !== undefined &&
    !remove.outcome.ok &&
    "error" in remove.outcome &&
    remove.outcome.error.code === "invalid"
      ? remove.outcome.error.detail.refs
      : undefined;
  return (
    <Section label={t("deviceDetail.nameTitle")}>
      <Heading level={2}>{t("deviceDetail.nameTitle")}</Heading>
      <Field
        label={t("deviceDetail.name")}
        hint={t("usb.nameHint")}
        value={name}
        onChange={setName}
        {...(bad ? { error: t("usb.nameError") } : {})}
      />
      <Actions>
        <Button
          label={t("deviceDetail.rename")}
          busy={rename.busy}
          onPress={() => {
            const clean = name.trim();
            const ok = deviceNameValue.safeParse(clean).success;
            setBad(!ok);
            if (ok) void rename.run({ device: device.id, name: clean });
          }}
        />
        {leftWithout.length === 0 ? (
          <ConfirmButton
            label={t("editing.delete", { name: device.name })}
            question={t("deviceDetail.removeQuestion", { name: device.name })}
            yes={t("people.yesRemove")}
            no={t("editing.no")}
            busy={remove.busy}
            onConfirm={() => void remove.run({ device: device.id })}
          />
        ) : (
          <Button
            kind="quiet"
            label={t("editing.delete", { name: device.name })}
            busy={remove.busy}
            onPress={() => {
              setAsking(true);
            }}
            testID="device-remove"
          />
        )}
      </Actions>
      {asking && leftWithout.length > 0 ? (
        <SirenDialog
          title={t("deviceDetail.removeQuestion", { name: device.name })}
          groups={leftWithout}
          confirm={t("sirens.remove")}
          busy={remove.busy}
          onConfirm={() => {
            setAsking(false);
            void remove.run({ device: device.id });
          }}
          onCancel={() => {
            setAsking(false);
          }}
        />
      ) : null}
      {rename.outcome === undefined ? null : rename.outcome.ok ? (
        <Done text={t("editing.saved")} />
      ) : (
        <Failure outcome={rename.outcome} />
      )}
      {remove.outcome === undefined ? null : remove.outcome.ok ? (
        <Done text={t("deviceDetail.removed", { name: device.name })} />
      ) : (
        <Failure outcome={remove.outcome} />
      )}
      {refs === undefined ? null : (
        <Body>
          {t("editing.usedBy", {
            schedules: refs
              .map((id) => schedules[id]?.name ?? t("common.scheduleNumber", { id }))
              .join(", "),
          })}
        </Body>
      )}
    </Section>
  );
}

export function DeviceDetail({ id }: { readonly id: number }) {
  const { t } = useTranslation();
  const stored = useLive((s) => s.devices[id]);
  const shown = useRead("device.show", { device: id }, undefined);
  const device = shown.data?.ok === true ? shown.data.body.device : stored;
  const current = shown.data?.ok === true ? shown.data.body.settings : undefined;
  if (device === undefined) {
    return shown.data !== undefined && !shown.data.ok ? (
      <Failure outcome={shown.data} />
    ) : (
      <Body muted>{t("deviceDetail.unknown")}</Body>
    );
  }
  return (
    <>
      <Section label={device.name}>
        <Heading level={2}>{device.name}</Heading>
        <DeviceItemFacts device={device} />
      </Section>
      {Platform.OS !== "web" &&
      (device.state === "resetByOwner" || device.state === "provisioning") ? (
        <Section label={t("pairing.addAgain")}>
          <Body>
            {t(device.state === "provisioning" ? "pairing.failure.unfinished" : "pairing.reset")}
          </Body>
          <TextLink href={`/device/add?previous=${device.id}`} label={t("pairing.addAgain")} />
        </Section>
      ) : null}
      <RenameRemove device={device} />
      {device.role === "sensor" ? (
        <>
          <DeviceUpdateSection device={device} />
          <SettingsForm
            op="sensor.settings"
            current={current}
            base={{ sensor: device.id }}
            title={t("deviceDetail.sensorTitle")}
            fields={[
              {
                key: "countdown",
                label: t("deviceDetail.countdown"),
                hint: t("deviceDetail.countdownHint"),
              },
              {
                key: "heartbeat",
                label: t("deviceDetail.heartbeat"),
                hint: t("deviceDetail.heartbeatHint"),
              },
            ]}
          />
          <SettingsForm
            op="sensor.settings"
            current={current}
            base={{ sensor: device.id }}
            title={t("deviceDetail.radioTitle")}
            fields={[
              {
                key: "linkCheck",
                label: t("deviceDetail.linkCheck"),
                hint: t("deviceDetail.linkCheckHint"),
              },
              {
                key: "replyRate",
                label: t("deviceDetail.replyRate"),
                hint: t("deviceDetail.learnHint"),
                learn: true,
              },
              {
                key: "correction",
                label: t("deviceDetail.correction"),
                hint: t("deviceDetail.learnHint"),
                learn: true,
              },
            ]}
          />
        </>
      ) : null}
      {device.role === "siren" ? (
        <>
          <SettingsForm
            op="siren.settings"
            current={current}
            base={{ siren: device.id }}
            title={t("deviceDetail.sirenTitle")}
            required
            fields={[{ key: "max", label: t("deviceDetail.max"), hint: t("deviceDetail.maxHint") }]}
          />
          <SirenTest siren={device.id} />
        </>
      ) : null}
      {device.role === "gateway" ? (
        <SettingsForm
          op="gateway.settings"
          current={current}
          base={{ gateway: device.id }}
          title={t("deviceDetail.gatewayTitle")}
          fields={[
            {
              key: "statusS",
              label: t("deviceDetail.statusS"),
              hint: t("deviceDetail.secondsHint"),
            },
            {
              key: "interferenceDb",
              label: t("deviceDetail.interferenceDb"),
              hint: t("deviceDetail.dbHint"),
            },
            {
              key: "interferenceS",
              label: t("deviceDetail.interferenceS"),
              hint: t("deviceDetail.secondsHint"),
            },
            {
              key: "powerDbm",
              label: t("deviceDetail.powerDbm"),
              hint: t("deviceDetail.powerHint"),
            },
            {
              key: "sirenPowerDbm",
              label: t("deviceDetail.sirenPowerDbm"),
              hint: t("deviceDetail.powerHint"),
            },
          ]}
        />
      ) : null}
    </>
  );
}
