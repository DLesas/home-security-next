/** The home screen (m2-design.md section 8): the current mode, Away and Disarmed, each sensor's state and door. */
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { ModePanel, SensorPanel } from "../ui/arming";
import { AddedNotices } from "../ui/devices";
import { Heading } from "../ui/parts";
import { SetupPrompt } from "../ui/setup";
import { styles } from "../ui/theme";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <View role="main" style={styles.main}>
      <Heading level={1}>{t("screens.home.title")}</Heading>
      <SetupPrompt />
      <AddedNotices />
      <ModePanel />
      <SensorPanel />
    </View>
  );
}
