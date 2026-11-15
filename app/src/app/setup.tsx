/** First-time setup (m2-design.md section 8): the first person, the radio, the Wi-Fi, the devices. */
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Heading } from "../ui/parts";
import { SetupSteps } from "../ui/setup";
import { styles } from "../ui/theme";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <View role="main" style={styles.main}>
      <Heading level={1}>{t("screens.setup.title")}</Heading>
      <SetupSteps />
    </View>
  );
}
