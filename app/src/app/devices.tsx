/** The device list with health (m2-design.md section 8; AP4), and adding boards over USB (PR5). */
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { AddedNotices, DeviceList, UsbAdd } from "../ui/devices";
import { Heading } from "../ui/parts";
import { styles } from "../ui/theme";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <View role="main" style={styles.main}>
      <Heading level={1}>{t("screens.devices.title")}</Heading>
      <AddedNotices />
      <DeviceList />
      <UsbAdd />
    </View>
  );
}
