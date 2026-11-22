/**
 * The lock page (m3-design.md section 6, "App lock"): in place of every screen while the app is
 * locked, the state field included. The title "Locked" and one button, "Unlock", named after what
 * the phone has ("Unlock with Face ID"); the system's sheet accepts the phone's passcode instead.
 * A cancelled check says nothing; a failed one says so, under the button. Nothing asks by itself:
 * the person presses Unlock.
 */
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { type AppLock, unlockKey } from "./app-lock";
import { Actions, Button, Notice, NoticeText, Page } from "./parts";

/** Shows the only action available while the app is locked. */
export function LockPage({ lock, os }: { readonly lock: AppLock; readonly os: "ios" | "android" }) {
  const { t } = useTranslation();
  const state = useStore(lock.store);
  return (
    <Page title={t("lock.lockedTitle")}>
      <Actions>
        <Button
          label={t(unlockKey(state.ability, os))}
          busy={state.checking}
          testID="unlock"
          onPress={() =>
            void lock.unlock({ prompt: t("lock.prompt"), cancel: t("editing.cancel") })
          }
        />
      </Actions>
      {state.said === null ? null : (
        <Notice kind="danger" live="polite" testID="unlock-said">
          <NoticeText kind="danger">{t(`lock.said.${state.said}`)}</NoticeText>
        </Notice>
      )}
    </Page>
  );
}

/** Mounts app content only while the screen lock is open. */
export function LockGate({
  lock,
  os,
  frame,
  children,
}: {
  readonly lock: AppLock;
  readonly os: "ios" | "android";
  readonly frame: (page: ReactNode) => ReactNode;
  readonly children: ReactNode;
}) {
  const phase = useStore(lock.store, (state) => state.phase);
  useEffect(() => {
    void lock.start();
  }, [lock]);
  if (phase === "open") return children;
  return frame(phase === "locked" ? <LockPage lock={lock} os={os} /> : null);
}
