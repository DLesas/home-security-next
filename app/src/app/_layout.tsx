/**
 * The app's root (Expo Router): translation, the app's faces (`ui/fonts-ready`: at once in a
 * browser, loaded at start on a phone), the hub client, and the frame around every screen
 * (`ui/shell`, per platform); then linking with a code the page was opened with (`src/entry.ts`
 * took it out of the address first). Until all are ready a browser shows nothing and a phone only
 * the page's colour. A development build may start a preview of the screens (`ui/preview.ts`).
 */
import "../../global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { Platform, View } from "react-native";
import { claimArrivedCode, startClient } from "../hub/start";
import type { StartedClient } from "../hub/start-types";
import { i18n, startI18n } from "../i18n";
import { installIntl } from "../platform/intl";
import { useFontsReady } from "../ui/fonts-ready";
import { HubProvider } from "../ui/hub-context";
import { previewAsked } from "../ui/preview-env";
import { Shell } from "../ui/shell";

// What the phone's engine lacks of `Intl`, in place before anything renders (`platform/intl`).
installIntl();

let started: StartedClient | undefined;
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

export default function RootLayout() {
  const fonts = useFontsReady();
  const [ready, setReady] = useState(i18n.isInitialized);
  const [client, setClient] = useState<StartedClient | undefined>(started);
  useEffect(() => {
    if (!ready) {
      void startI18n().then(() => {
        setReady(true);
      });
      return;
    }
    if (started !== undefined) return;
    started = startClient();
    // A development build's preview of the screens, never in a release bundle (`__DEV__` folds).
    if (__DEV__ && previewAsked()) {
      const real = started.client;
      void import("../ui/preview").then((preview) => {
        started = { client: preview.startPreview(real) };
        setClient(started);
      });
      return;
    }
    const hub = started.client;
    // In a browser, taken out of the address by `src/entry.ts` before the router loaded (section 5).
    // A link opened in the phone app is shown before it is used (m3-design.md section 3): the
    // phone's link pages claim it (`ui/phone-link.tsx`), not this.
    const arrived = Platform.OS === "web" ? claimArrivedCode() : undefined;
    if (arrived?.from === "unreadable") hub.unreadable();
    else if (arrived !== undefined && arrived.from !== "deepLink") {
      const name = i18n.t(arrived.from === "console" ? "link.consoleName" : "link.webName");
      void hub.link(arrived.secret, arrived.from, { name, kind: "web" });
    }
    setClient(started);
  }, [ready]);
  // A phone keeps its page colour while it starts (m3-design.md section 2, "Fonts").
  if (!ready || !fonts || client === undefined)
    return Platform.OS === "web" ? null : <View className="flex-1 bg-limewash" />;
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queries}>
        <HubProvider client={client.client}>
          <Shell />
        </HubProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

/** A screen that failed to render: ours, which shows no message (`ui/failed-screen.tsx`). */
export { ErrorBoundary } from "../ui/failed-screen";
