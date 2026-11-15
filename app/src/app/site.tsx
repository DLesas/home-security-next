/** The site screen (m2-design.md section 8): see `ui/site.tsx`. */
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { SiteScreen } from "../ui/site";
import { Heading } from "../ui/parts";
import { styles } from "../ui/theme";

export default function Screen() {
  const { t } = useTranslation();
  return (
    <View role="main" style={styles.main}>
      <Heading level={1}>{t("screens.site.title")}</Heading>
      <SiteScreen />
    </View>
  );
}
