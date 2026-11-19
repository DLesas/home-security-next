/**
 * Every screen in a browser, the web build's side of `shell.tsx`: the navigation (a bar at the
 * bottom below 768 px, a column at the left from it) and the content column; over the content the
 * alarm or countdown, the notices every screen shows, and the pages of the destination the person
 * is in. Home shows the first as its state field and the notices under it. A browser that is not
 * linked sees the link screen in place of the routes.
 */
import { Slot, usePathname } from "expo-router";
import { ScrollView, View } from "react-native";
import { AlarmBanner, ShellNotices, useAlarmRunning } from "./banners";
import { useLive, useLocal } from "./hub-context";
import { LinkGate, needsLinkGate } from "./link-gate";
import { BottomBar, Pages, Rail } from "./navigation";
import { Column } from "./parts";

export function Shell() {
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
