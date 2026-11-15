/** One device and its settings (m2-design.md section 8; AP4, AP5): see `ui/device-detail.tsx`. */
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { DeviceDetail } from "../../ui/device-detail";
import { Body, Heading } from "../../ui/parts";
import { styles } from "../../ui/theme";

export default function Screen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const device = Number(id);
  return (
    <View role="main" style={styles.main}>
      <Heading level={1}>{t("screens.device.title")}</Heading>
      {Number.isInteger(device) && device > 0 ? (
        <DeviceDetail id={device} />
      ) : (
        <Body>{t("deviceDetail.unknown")}</Body>
      )}
    </View>
  );
}
