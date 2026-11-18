/**
 * The app's root (Expo Router): translation, the hub client, and over every screen the countdown
 * and alarm banner and the connection's notice; then linking with a code the page was opened
 * with (`src/entry.ts` took it out of the address first). A browser that is not linked sees the
 * link screen in place of the routes.
 */
import "../../global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Slot, usePathname } from "expo-router";
import { useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { ScrollView, View } from "react-native";
import { claimArrivedCode, startClient } from "../hub/start";
import type { StartedClient } from "../hub/start-types";
import { i18n, startI18n } from "../i18n";
import { AlarmBanner, ShellNotices, useAlarmRunning } from "../ui/banners";
import { HubProvider, useLive, useLocal } from "../ui/hub-context";
import { LinkGate, needsLinkGate } from "../ui/link-gate";
import { BottomBar, Pages, Rail } from "../ui/navigation";
import { Column } from "../ui/parts";

let started: StartedClient | undefined;
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

export default function RootLayout() {
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
    const hub = started.client;
    // In a browser, taken out of the address by `src/entry.ts` before the router loaded (section 5).
    const arrived = claimArrivedCode();
    // A link opened in the phone app is shown before it is used (m3-design.md section 3): not here.
    if (arrived?.from === "unreadable") hub.unreadable();
    else if (arrived !== undefined && arrived.from !== "deepLink") {
      const name = i18n.t(arrived.from === "console" ? "link.consoleName" : "link.webName");
      void hub.link(arrived.secret, arrived.from, { name, kind: "web" });
    }
    setClient(started);
  }, [ready]);
  if (!ready || client === undefined) return null;
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

/**
 * Every screen: the navigation (a bar at the bottom on a phone, a column at the left from 768 px)
 * and the content column; over the content the alarm or countdown, the notices every screen
 * shows, and the pages of the destination the person is in. Home shows the first as its state
 * field and the notices under it.
 */
function Shell() {
  const connection = useLive((s) => s.connection);
  const link = useLocal((s) => s.link);
  const home = usePathname() === "/";
  const running = useAlarmRunning();
  if (needsLinkGate(connection, link)) {
    return (
      <ScrollView className="flex-1 bg-limewash">
        <LinkGate />
      </ScrollView>
    );
  }
  return (
    <View className="flex-1 bg-limewash md:flex-row">
      <Rail />
      <ScrollView className="flex-1">
        <Column first={home || running}>
          {home ? null : (
            <>
              <AlarmBanner />
              <ShellNotices />
              <Pages />
            </>
          )}
          <Slot />
        </Column>
      </ScrollView>
      <BottomBar />
    </View>
  );
}
