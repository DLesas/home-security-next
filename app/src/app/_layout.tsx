/**
 * The app's root (Expo Router): translation first, then the screens. Step 0's stub; owner A7
 * adds the channel client (`src/hub/`), the live store (`src/state/`) and the banner (`src/ui/`).
 */
import { Slot } from "expo-router";
import { useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n, startI18n } from "../i18n";

export default function RootLayout() {
  const [ready, setReady] = useState(i18n.isInitialized);
  useEffect(() => {
    if (!ready) {
      void startI18n().then(() => {
        setReady(true);
      });
    }
  }, [ready]);
  if (!ready) return null;
  return (
    <I18nextProvider i18n={i18n}>
      <Slot />
    </I18nextProvider>
  );
}
