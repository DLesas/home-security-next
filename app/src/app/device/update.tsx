/** Opens a sensor's phone-only Bluetooth transfer. */
import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { currentPhoneHub } from "../../pairing/phone-hub";
import { UpdatePage } from "../../pairing/update-page";
import { Page, TextLink } from "../../ui/parts";

/** Checks the device number before exposing the phone's update grant. */
export default function BluetoothUpdateScreen() {
  const { t } = useTranslation();
  const { device } = useLocalSearchParams<{ device?: string }>();
  const id = Number(device);
  const hub = currentPhoneHub();
  if (hub === undefined || !Number.isSafeInteger(id) || id <= 0)
    return (
      <Page title={t("bluetoothUpdate.title")} intro={t("bluetoothUpdate.usePhone")}>
        <TextLink href="/devices" label={t("nav.devices")} />
      </Page>
    );
  return <UpdatePage key={id} hub={hub} device={id} />;
}
