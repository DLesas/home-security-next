/**
 * The camera screen (docs/app-design.md, "On a phone", rule 8): the title "Scan the code", one
 * line saying what to point at, then the camera's view: a square the width of the content column,
 * 12 px corners, nothing drawn over it (the fourth filled surface). Under it a quiet button "Type
 * the code instead", where there is a typed code, and "Light on" or "Light off". When a code is
 * read the view stops at once and the next page says what was found; a code that is not one of
 * ours gets an ochre notice, and the view runs on.
 *
 * Before the view, the camera's permission as rule 7 has it (`permission.tsx`). The camera itself
 * is the `Scanner` interface's (`platform/scanner.ts`), so this screen is the same over the real
 * camera and a stand-in.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type { Permission, Scanner } from "../platform/scanner";
import { Actions, Body, Button, Notice, NoticeText, Page, Stack } from "./parts";
import { type Instead, PermissionAsk, PermissionRefused } from "./permission";

/** What the screen shows: checking, no camera, the permission's three answers, or the view. */
export type ScanState =
  | { readonly kind: "checking" }
  | { readonly kind: "noCamera" }
  | { readonly kind: "ask" }
  | { readonly kind: "refused" }
  | { readonly kind: "view" };

/** The screen's state from the camera's presence and the permission as it stands. */
export function scanState(available: boolean, permission: Permission): ScanState {
  if (!available) return { kind: "noCamera" };
  if (permission.state === "granted") return { kind: "view" };
  // Asked and refused, but the system will ask again: the page asks again (rule 7's first page).
  if (permission.state === "undetermined" || permission.canAskAgain) return { kind: "ask" };
  return { kind: "refused" };
}

export function ScanScreen({
  scanner,
  point,
  onCode,
  instead,
  onOpenSettings,
  initial,
}: {
  readonly scanner: Scanner;
  /** The one line saying what to point at. */
  readonly point: string;
  /**
   * A code was read: null when it is taken (the page moves on), else the notice to show, and the
   * view runs on.
   */
  readonly onCode: (text: string) => string | null;
  /** "Type the code instead", where there is a typed code. */
  readonly instead?: Instead;
  readonly onOpenSettings: () => void;
  /** Where to start, for a page that already knows (tests); else the scanner is asked. */
  readonly initial?: ScanState;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ScanState>(initial ?? { kind: "checking" });
  const [light, setLight] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const taken = useRef(false);
  useEffect(() => {
    if (initial !== undefined) return;
    let live = true;
    void Promise.all([scanner.available(), scanner.permission()]).then(([available, asked]) => {
      if (live) setState(scanState(available, asked));
    });
    return () => {
      live = false;
    };
  }, [scanner, initial]);

  const ask = () => {
    void scanner.ask().then((answer) => {
      // A no: what will not work, "Open settings" and the other way (rule 7).
      setState({ kind: answer.state === "granted" ? "view" : "refused" });
    });
  };
  const scanned = (text: string) => {
    if (taken.current) return;
    const said = onCode(text);
    if (said === null) {
      // The view stops at once: the next page says what was found.
      taken.current = true;
      setState({ kind: "checking" });
    } else setNotice(said);
  };

  return (
    // What to point at is the title's introduction, 16 px under it, once the view shows.
    <Page title={t("scan.title")} {...(state.kind === "view" ? { intro: point } : {})}>
      {state.kind === "checking" ? null : state.kind === "noCamera" ? (
        <Stack>
          <Body testID="scan-no-camera">{t("scan.noCamera")}</Body>
          {instead === undefined ? null : (
            <Actions>
              <Button
                kind="quiet"
                label={instead.label}
                onPress={instead.onPress}
                testID="instead"
              />
            </Actions>
          )}
        </Stack>
      ) : state.kind === "ask" ? (
        <PermissionAsk
          sentence={t("permissions.camera")}
          allow={t("permissionPage.allowCamera")}
          onAllow={ask}
          testID="scan-ask"
        />
      ) : state.kind === "refused" ? (
        <PermissionRefused
          sentence={t("permissionPage.cameraRefused")}
          onOpenSettings={onOpenSettings}
          {...(instead === undefined ? {} : { instead })}
          testID="scan-refused"
        />
      ) : (
        <Stack>
          {notice === null ? null : (
            <Notice kind="warning" live="polite" testID="scan-notice">
              <NoticeText kind="warning">{notice}</NoticeText>
            </Notice>
          )}
          <View
            role="img"
            aria-label={t("scan.viewLabel")}
            className="aspect-square w-full overflow-hidden rounded-notice bg-ink"
          >
            <scanner.View onScanned={scanned} light={light} testID="scan-view" />
          </View>
          <Actions>
            {instead === undefined ? null : (
              <Button
                kind="quiet"
                label={instead.label}
                onPress={instead.onPress}
                testID="instead"
              />
            )}
            <Button
              kind="quiet"
              label={t(light ? "scan.lightOff" : "scan.lightOn")}
              onPress={() => {
                setLight(!light);
              }}
              testID="scan-light"
            />
          </Actions>
        </Stack>
      )}
    </Page>
  );
}
