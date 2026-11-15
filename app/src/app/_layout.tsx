/**
 * The app's root (Expo Router): translation, the hub client, and over every screen the countdown
 * and alarm banner and the connection's notice; then linking with a code the page was opened
 * with (`src/entry.ts` took it out of the address first). A browser that is not linked sees the
 * link screen in place of the routes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, Slot } from "expo-router";
import { useEffect, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { claimArrivedCode } from "../hub/arrival";
import { type BrowserClient, startBrowserClient } from "../hub/browser";
import { i18n, startI18n } from "../i18n";
import { AlarmBanner, ConnectionNotice } from "../ui/banners";
import { HubProvider, useLive, useLocal } from "../ui/hub-context";
import { LinkGate, needsLinkGate } from "../ui/link-gate";
import { HubNotices } from "../ui/hub-notices";
import { CriticalNotices } from "../ui/notifications";
import { styles } from "../ui/theme";

/** The screens, in section 8's order after the "done when" ones. */
const NAV = [
  ["/", "nav.home"],
  ["/devices", "nav.devices"],
  ["/groups", "nav.groups"],
  ["/modes", "nav.modes"],
  ["/schedules", "nav.schedules"],
  ["/history", "nav.history"],
  ["/people", "nav.people"],
  ["/link", "nav.link"],
  ["/notifications", "nav.notifications"],
  ["/site", "nav.site"],
  ["/backup", "nav.backup"],
  ["/updates", "nav.updates"],
  ["/status", "nav.status"],
  ["/setup", "nav.setup"],
] as const;

let started: BrowserClient | undefined;
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

export default function RootLayout() {
  const [ready, setReady] = useState(i18n.isInitialized);
  const [client, setClient] = useState<BrowserClient | undefined>(started);
  useEffect(() => {
    if (!ready) {
      void startI18n().then(() => {
        setReady(true);
      });
      return;
    }
    if (started !== undefined) return;
    started = startBrowserClient();
    const hub = started.client;
    // Taken out of the address by `src/entry.ts` before the router loaded (section 5).
    const arrived = claimArrivedCode();
    if (arrived?.from === "unreadable") hub.unreadable();
    else if (arrived !== undefined) {
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

function Shell() {
  const { t } = useTranslation();
  const connection = useLive((s) => s.connection);
  const link = useLocal((s) => s.link);
  if (needsLinkGate(connection, link)) {
    return (
      <ScrollView style={styles.page}>
        <LinkGate />
      </ScrollView>
    );
  }
  return (
    <ScrollView style={styles.page}>
      <AlarmBanner />
      <CriticalNotices />
      <HubNotices />
      <View role="navigation" aria-label={t("nav.label")} style={styles.nav}>
        {NAV.map(([href, key]) => (
          <Link key={href} href={href} style={styles.navLink}>
            {t(key)}
          </Link>
        ))}
      </View>
      <View style={[styles.main, { paddingBottom: 0 }]}>
        <ConnectionNotice />
      </View>
      <Slot />
    </ScrollView>
  );
}
