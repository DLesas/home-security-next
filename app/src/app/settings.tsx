/**
 * Settings (docs/app-design.md "Layout"): an index of its eight pages, one row each with a line
 * saying what the page is for. The whole row opens the page. On a phone, "This phone" (its homes
 * and the app lock, m3-design.md section 6); on one that holds a backup key, "Restore a hub"
 * (section 4).
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DESTINATIONS, LINK_HOME, phoneSettingsPath, THIS_PHONE } from "../ui/navigation";
import { List, LinkRow, Page } from "../ui/parts";
import { PhoneLinkGate } from "../ui/phone-link";
import { ThisPhoneScreen } from "../ui/this-phone";
import { usePhone } from "../ui/phone-parts";

/** Whether this phone holds any backup key; false in a browser, which holds none. */
function useHoldsBackupKey(): boolean {
  const phone = usePhone();
  const [holds, setHolds] = useState(false);
  useEffect(() => {
    if (phone === undefined) return;
    let live = true;
    void phone.holdsBackupKey().then((held) => {
      if (live) setHolds(held);
    });
    return () => {
      live = false;
    };
  }, [phone]);
  return holds;
}

/** Opens Settings, its phone-specific page, or the existing phone link flow. */
export default function Screen() {
  const { t } = useTranslation();
  const settings = DESTINATIONS.find((d) => d.index === "/settings");
  const restore = useHoldsBackupKey();
  const phone = usePhone();
  const path = phoneSettingsPath("/settings", useLocalSearchParams().phone);
  if (phone !== undefined && path === LINK_HOME) {
    return (
      <PhoneLinkGate
        backFromStart={() => {
          router.replace("/settings");
        }}
      />
    );
  }
  if (phone !== undefined && path === THIS_PHONE) {
    return (
      <Page title={t("screens.thisPhone.title")}>
        <ThisPhoneScreen
          onLinkAnother={() => {
            router.push(LINK_HOME);
          }}
        />
      </Page>
    );
  }
  return (
    <Page title={t("screens.settings.title")}>
      <List label={t("screens.settings.title")}>
        {(settings?.pages ?? []).map(([href, label]) => (
          <LinkRow
            key={href}
            href={href}
            testID={`settings-${href.slice(1)}`}
            name={t(label)}
            detail={t(`settingsIndex${href.replace("/", ".")}`)}
          />
        ))}
        {phone === undefined ? null : (
          <LinkRow
            href={THIS_PHONE}
            testID="settings-this-phone"
            name={t("nav.thisPhone")}
            detail={t("settingsIndex.thisPhone")}
          />
        )}
        {restore ? (
          <LinkRow
            href="/restore"
            testID="settings-restore"
            name={t("nav.restore")}
            detail={t("settingsIndex.restore")}
          />
        ) : null}
      </List>
    </Page>
  );
}
