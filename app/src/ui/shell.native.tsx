/**
 * Every screen on a phone, the phone's side of `shell.tsx` (docs/app-design.md, "On a phone"):
 *
 * - **Safe areas** (rule 1). A band as tall as the status bar sits at the top in the colour of what
 *   meets it: the state field's look on Home (day, night, alarm), the alarm or countdown band
 *   over another screen, else the page. So the field fills the space behind the status bar in its
 *   own colour and its text starts below it. The bottom bar sits above the home indicator, its
 *   `limewash` reaching the screen's edge. Written with `pt-safe` and `pb-safe`, never as numbers.
 *   The app is in portrait on phones (rule 10), so there are no side insets to add to the gutters.
 * - **The status bar** (rule 2): dark text on the day field and every page, light on night and
 *   alarm.
 * - **Back** (rule 3): Android's back button goes from a page to its destination's first page or
 *   index, from there to Home, and from Home out of the app (`backTarget`). The routes stay in
 *   Expo Router's `Slot`.
 * - **The keyboard** (rule 5): the scroll view keeps to the space above the keyboard, and the
 *   field being typed in is scrolled into it with room for its form's action (`keyboard.ts`).
 * - **Linking** (m3-design.md section 3): the phone's link pages in place of the routes while the
 *   phone is not linked, with the phone's parts (`phone-parts.tsx`). After "Link another home",
 *   back to This phone (`afterLinking`).
 * - **Homes** (section 6): when another home is chosen, every read the screens made of the last
 *   one is dropped, so nothing of one home is shown as the other's.
 */
import { useQueryClient } from "@tanstack/react-query";
import { router, Slot, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { type ComponentRef, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import {
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { hasPairingCode } from "../pairing/code-arrival";
import { AlarmBanner, ShellNotices, useAlarmRunning } from "./banners";
import { useHub, useLive, useLocal } from "./hub-context";
import { needsLinkGate } from "./link-gate";
import { BottomBar, Pages, backTarget } from "./navigation";
import { Column } from "./parts";
import { PhoneLinkGate } from "./phone-link";
import { PhoneProvider } from "./phone-parts";
import { REVEAL_BELOW, revealOffset } from "./keyboard";
import { phonePartsFor } from "./stand-ins";
import { livePhoneParts } from "./phone-wiring.native";
import { BAND, statusBarStyle, type Top, topOf } from "./top";
import { useStore } from "zustand";
import { LockGate } from "./lock-page";
import type { PhoneParts } from "./phone-parts";
import { afterLinking } from "./this-phone";

/** What meets the top on the screen at `home` (`top.ts`). */
function useTop(home: boolean): Top {
  return useLive((s) => topOf(s, home));
}

/** Android's back button through the destinations, while the routes are shown. */
function useBackRule(path: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      const to = backTarget(path);
      if (to === null) return false;
      router.replace(to);
      return true;
    });
    return () => {
      handler.remove();
    };
  }, [path, active]);
}

/**
 * The scroll view, kept above the keyboard, which scrolls the field being typed in into view with
 * its form's action, and starts at the top of each new page.
 */
function KeyboardFrame({
  page,
  children,
}: {
  readonly page: string;
  readonly children: ReactNode;
}) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const content = useRef<ComponentRef<typeof View>>(null);
  const offset = useRef(0);
  const visible = useRef(0);
  const reveal = useCallback(() => {
    const input = TextInput.State.currentlyFocusedInput();
    const into = content.current;
    if (input == null || into === null) return;
    input.measureLayout(
      into,
      (_x, top, _width, height) => {
        const to = revealOffset({
          top,
          height,
          offset: offset.current,
          visible: visible.current,
          below: REVEAL_BELOW,
        });
        if (to !== null) scroll.current?.scrollTo({ y: to, animated: true });
      },
      () => undefined,
    );
  }, []);
  useEffect(() => {
    // After the keyboard is up and the view has shrunk above it.
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      setTimeout(reveal, 60);
    });
    return () => {
      shown.remove();
    };
  }, [reveal]);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [page]);
  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1">
      <ScrollView
        ref={scroll}
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onScroll={(event) => {
          offset.current = event.nativeEvent.contentOffset.y;
        }}
        onLayout={(event) => {
          visible.current = event.nativeEvent.layout.height;
        }}
      >
        <View ref={content}>{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Keeps the lock outside the router, state field, notices and navigation. */
export function Shell() {
  const hub = useHub();
  const parts = useMemo(() => phonePartsFor(hub, livePhoneParts), [hub]);
  const queries = useQueryClient();
  useEffect(
    () =>
      hub.live.subscribe((state, before) => {
        if (before.session !== null && state.session === null) void queries.resetQueries();
      }),
    [hub, queries],
  );
  return (
    <PhoneProvider parts={parts}>
      <LockGate lock={parts.lock} os={parts.os} frame={lockedFrame}>
        <UnlockedShell parts={parts} />
      </LockGate>
    </PhoneProvider>
  );
}

/** Shows the normal phone surface with only the lock page in its content column. */
function lockedFrame(page: ReactNode) {
  return (
    <View className="flex-1 bg-limewash">
      <StatusBar style={statusBarStyle("page")} />
      <View testID="status-band" className="pt-safe bg-limewash" />
      <KeyboardFrame page="lock">
        <Column first={false}>{page}</Column>
      </KeyboardFrame>
    </View>
  );
}

/** Shows the existing phone frame and routes while the app's screens are open. */
function UnlockedShell({ parts }: { readonly parts: PhoneParts }) {
  const hub = useHub();
  const connection = useLive((s) => s.connection);
  const link = useLocal((s) => s.link);
  const path = usePathname();
  const home = path === "/";
  const top = useTop(home);
  const removing = useStore(parts.homes.store, (s) => s.removing);
  const gate =
    path !== "/link-home" &&
    !(path === "/this-phone" && removing !== null) &&
    needsLinkGate(connection, link);
  const running = useAlarmRunning();
  const linkBefore = useRef(link.kind);
  useBackRule(path, !gate);
  useEffect(() => {
    const to = afterLinking(linkBefore.current, link.kind, path);
    linkBefore.current = link.kind;
    if (to !== null) router.replace(to);
  }, [link.kind, path]);
  useEffect(() => {
    if (!gate && path !== "/device/add" && hasPairingCode()) router.replace("/device/add");
  }, [gate, path]);
  const shown: Top = gate ? "page" : top;
  return (
    <View className="flex-1 bg-limewash">
      <StatusBar style={statusBarStyle(shown)} />
      <View
        testID="status-band"
        className={`pt-safe transition-colors duration-400 motion-reduce:transition-none ${BAND[shown]}`}
      />
      <KeyboardFrame page={gate ? "link" : path}>
        {gate ? (
          <Column first={false}>
            <PhoneLinkGate />
          </Column>
        ) : (
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
        )}
      </KeyboardFrame>
      <View className="bg-limewash pb-safe">{gate ? null : <BottomBar />}</View>
    </View>
  );
}
