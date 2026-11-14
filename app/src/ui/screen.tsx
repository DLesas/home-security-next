/**
 * Step 0's screen frame: a heading and the "not built yet" line, both from the locale, with the
 * heading's role for screen readers (m2-design.md section 8). Owner A7 replaces the screens.
 */
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";

/** `titleKey`: the screen title's i18next key. */
export function StubScreen({ titleKey }: { readonly titleKey: string }) {
  const { t } = useTranslation();
  return (
    <View role="main">
      <Text role="heading" aria-level={1} testID="screen-title">
        {t(titleKey)}
      </Text>
      <Text testID="screen-status">{t("notBuilt")}</Text>
    </View>
  );
}
