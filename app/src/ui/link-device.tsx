/**
 * Linking another device (m2-design.md section 5, "Linking"; D34, D61, D99, D120, D121): a code for
 * one more device of one's own, or for a new person (*manage users*, or anyone while user
 * management is off; the hub decides). As a link address (128 bits, for a browser on the home
 * network), a typed code (short, `XXXX-XXXX-XXXX`) or a QR code (for a phone, from M3). A code
 * works once, links at once, and expires (10 minutes ‡; an invite for someone not present, 24
 * hours). The person the code is for is told when it is used; a code can be cancelled.
 *
 * The QR code is drawn (`qr.tsx`), its text beside it.
 */
import { displayName } from "@hsn/protocol/app";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNow } from "./banners";
import { QrCode } from "./qr";
import { useAction, useLive } from "./hub-context";
import {
  Actions,
  Body,
  Button,
  Choice,
  Copyable,
  Done,
  Failure,
  Field,
  Heading,
  Section,
  Toggle,
} from "./parts";

type Form = "url" | "code" | "qr";

export function LinkDeviceScreen() {
  const { t } = useTranslation();
  const create = useAction("link.create");
  const cancel = useAction("link.cancel");
  // The hub computer's browser belongs to no person: it has no "device of mine" to link.
  const noOne = useLive((s) => s.session !== null && s.session.person === null);
  const [chosen, setKind] = useState<"ownDevice" | "newPerson">("ownDevice");
  const kind = noOne ? "newPerson" : chosen;
  const [form, setForm] = useState<Form>("url");
  const [invite, setInvite] = useState(false);
  const [name, setName] = useState("");
  const [madeAt, setMadeAt] = useState(0);
  const now = useNow(1000);
  const made =
    create.outcome?.ok === true && cancel.outcome?.ok !== true ? create.outcome.body : undefined;
  const leftS =
    made === undefined ? 0 : Math.max(0, Math.ceil((madeAt + made.expiresInMs - now) / 1000));
  const personName = name.trim().normalize("NFC");
  const nameOk = personName === "" || displayName.safeParse(personName).success;
  const make = () => {
    if (!nameOk) return;
    cancel.clear();
    void create
      .run({
        kind:
          kind === "ownDevice"
            ? "ownDevice"
            : { newPerson: personName === "" ? {} : { name: personName } },
        form,
        ...(invite ? { invite: true } : {}),
      })
      .then((o) => {
        if (o.ok) setMadeAt(Date.now());
      });
  };
  return (
    <>
      <Section label={t("linkDevice.makeTitle")}>
        <Heading level={2}>{t("linkDevice.makeTitle")}</Heading>
        {noOne ? (
          <Body testID="link-new-person-only">{t("linkDevice.newPersonOnly")}</Body>
        ) : (
          <Choice
            label={t("linkDevice.forWhom")}
            value={kind}
            onChange={setKind}
            options={[
              { value: "ownDevice", label: t("linkDevice.ownDevice") },
              { value: "newPerson", label: t("linkDevice.newPerson") },
            ]}
          />
        )}
        {kind === "newPerson" ? (
          <Field
            label={t("linkDevice.personName")}
            hint={t("linkDevice.personNameHint")}
            value={name}
            onChange={setName}
            {...(nameOk ? {} : { error: t("editing.badName") })}
          />
        ) : null}
        <Choice
          label={t("linkDevice.form")}
          value={form}
          onChange={setForm}
          options={[
            { value: "url", label: t("linkDevice.forms.url") },
            { value: "code", label: t("linkDevice.forms.code") },
            { value: "qr", label: t("linkDevice.forms.qr") },
          ]}
        />
        <Toggle label={t("linkDevice.invite")} value={invite} onChange={setInvite} />
        <Actions>
          <Button
            label={t("linkDevice.make")}
            busy={create.busy}
            onPress={make}
            testID="link-make"
          />
        </Actions>
        {create.outcome !== undefined && !create.outcome.ok ? (
          <Failure outcome={create.outcome} />
        ) : null}
      </Section>
      {made === undefined ? null : (
        <Section label={t("linkDevice.madeTitle")}>
          <Heading level={2}>{t("linkDevice.madeTitle")}</Heading>
          {made.url === undefined ? null : (
            <>
              <Body>{t("linkDevice.urlHow")}</Body>
              <Copyable testID="link-url">{made.url}</Copyable>
            </>
          )}
          {made.code === undefined ? null : (
            <>
              <Body>{t("linkDevice.codeHow")}</Body>
              <Copyable size="title" testID="link-code-made">
                {made.code}
              </Copyable>
            </>
          )}
          {made.qr === undefined ? null : (
            <>
              <Body>{t("linkDevice.qrHow")}</Body>
              <QrCode text={made.qr} label={t("linkDevice.qrLabel")} testID="link-qr-code" />
              <Copyable size="small" testID="link-qr">
                {made.qr}
              </Copyable>
            </>
          )}
          <Body>
            {leftS > 0
              ? t("linkDevice.expiresIn", { count: Math.ceil(leftS / 60) })
              : t("linkDevice.expired")}
          </Body>
          <Body muted>{t("linkDevice.once")}</Body>
          <Actions>
            <Button
              kind="quiet"
              label={t("linkDevice.cancel")}
              busy={cancel.busy}
              onPress={() => void cancel.run({ token: made.token })}
              testID="link-cancel"
            />
          </Actions>
        </Section>
      )}
      {cancel.outcome === undefined ? null : cancel.outcome.ok ? (
        <Done text={t("linkDevice.cancelled")} />
      ) : (
        <Failure outcome={cancel.outcome} />
      )}
    </>
  );
}
