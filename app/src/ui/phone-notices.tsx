/**
 * What is wrong on the phone itself, said over every screen and on the link page (m3-design.md
 * section 2): the secure store's last fault, as a refusal is said (an ochre notice saying what
 * happened and what to do, docs/app-design.md "Wording"), and the system's refusal of the local
 * network, as a permission page says it after a no (rule 7: what will not work, "Open settings").
 * Nothing in a browser, which has no phone parts.
 */
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Actions, Button, Notice, NoticeText } from "./parts";
import { type PhoneParts, usePhone } from "./phone-parts";

export function PhoneNotices() {
  const phone = usePhone();
  return phone === undefined ? null : <Notices phone={phone} />;
}

function Notices({ phone }: { readonly phone: PhoneParts }) {
  const { t } = useTranslation();
  const vault = useStore(phone.vault, (s) => s.fault);
  const denied = useStore(phone.reach, (s) => s.localNetworkDenied);
  return (
    <>
      {vault === null ? null : (
        <Notice kind="warning" live="polite" testID="vault-notice">
          <NoticeText kind="warning">{t(`vault.${vault}`)}</NoticeText>
        </Notice>
      )}
      {denied ? (
        <Notice kind="warning" live="polite" testID="local-network-notice">
          <NoticeText kind="warning">{t("phoneLink.reach.localNetworkDenied")}</NoticeText>
          <Actions>
            <Button
              kind="quiet"
              label={t("permissionPage.openSettings")}
              onPress={phone.openSettings}
              testID="local-network-settings"
            />
          </Actions>
        </Notice>
      ) : null}
    </>
  );
}
