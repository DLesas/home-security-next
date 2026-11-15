/** The updates screen (m2-design.md section 8): see `ui/updates.tsx`. */
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { UpdatesScreen } from "../ui/updates";
import { Heading } from "../ui/parts";
import { styles } from "../ui/theme";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <View role="main" style={styles.main}>
      <Heading level={1}>{t("screens.updates.title")}</Heading>
      <UpdatesScreen />
    </View>
  );
}
