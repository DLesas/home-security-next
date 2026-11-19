/** Starts the phone's add-device flow, including a code read from a link. */
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { claimPairingCode } from "../../pairing/code-arrival";
import { PairPage } from "../../pairing/pair-page";
import { currentPhoneHub } from "../../pairing/phone-hub";
import { useLive } from "../../ui/hub-context";
import { Page, TextLink } from "../../ui/parts";

/** Resolves any kept name without putting board credentials in the route. */
export default function AddDeviceScreen() {
  const { t } = useTranslation();
  const { previous } = useLocalSearchParams<{ previous?: string }>();
  const kept = useLive((s) => (previous === undefined ? undefined : s.devices[Number(previous)]));
  const [code] = useState(claimPairingCode);
  const hub = currentPhoneHub();
  if (Platform.OS === "web" || hub === undefined)
    return (
      <Page title={t("pairing.add")} intro={t("pairing.phoneOnly")}>
        <TextLink href="/devices" label={t("nav.devices")} />
      </Page>
    );
  return (
    <PairPage
      hub={hub}
      {...(code === undefined ? {} : { initialCode: code })}
      {...(kept === undefined ? {} : { previousName: kept.name })}
    />
  );
}
