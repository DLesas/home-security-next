/**
 * Notifications (m2-design.md section 7, "Notifications"; D69, D75, D92, D102): the person's
 * notifications, read or not, marked read (routine, no `seq`); this browser's optional categories;
 * and, over every screen, the critical ones: a banner, a sound if the browser allows one (most only
 * after the page has been touched), and the browser's own notification if the person allowed it.
 * A web page is no substitute for push: a closed tab is told nothing (section 13), and the screen
 * says so.
 */
import {
  type NotificationObject,
  OPTIONAL_CATEGORIES,
  type OptionalCategory,
} from "@hsn/protocol/app";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { askNoticePermission, noticePermission, showNotice, tone } from "../platform/alerts";
import type { NoticePermission } from "../platform/alerts-types";
import { learnPrefs, markRead } from "../state/live";
import { deviceName, type Translate } from "../state/words";
import { formatTime } from "./format";
import { HERE } from "./words-here";
import { TestAlert } from "./test-alert";
import { useAction, useHub, useLive, useRead } from "./hub-context";
import {
  Actions,
  Body,
  Button,
  Done,
  Facts,
  Failure,
  Heading,
  List,
  ListItem,
  Notice,
  Section,
  Toggle,
} from "./parts";

type Devices = Parameters<typeof deviceName>[1];

/** A notification in words: its category, the device it names, and whether it came late. */
export function notificationWords(t: Translate, devices: Devices, n: NotificationObject): string {
  const what = t(`notifications.category.${n.category}`);
  const text =
    n.device === null
      ? what
      : t("notifications.about", { what, device: deviceName(t, devices, n.device) });
  return n.delayed ? `${text} ${t("notifications.delayed")}` : text;
}

function NotificationItem({
  n,
  onRead,
}: {
  readonly n: NotificationObject;
  readonly onRead: (seq: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const devices = useLive((s) => s.devices);
  const info = useLive((s) => s.hub);
  const at = formatTime(
    t,
    i18n.language,
    n.clockOk ? info : info === null ? null : { ...info, clockTrusted: false },
    n.atMs,
  );
  return (
    <ListItem testID={`notification-${String(n.seq)}`}>
      <Facts
        items={[
          at,
          n.critical ? t("notifications.critical") : undefined,
          n.read ? t("notifications.read") : t("notifications.unread"),
        ]}
      />
      <Body>{notificationWords(t, { devices }, n)}</Body>
      {n.read ? null : (
        <Actions>
          <Button
            kind="quiet"
            label={t("notifications.markRead")}
            onPress={() => {
              onRead(n.seq);
            }}
          />
        </Actions>
      )}
    </ListItem>
  );
}

function Categories() {
  const { t } = useTranslation();
  const hub = useHub();
  const prefs = useAction("notifications.prefs");
  const stored = useLive((s) => s.notificationPrefs);
  // What this browser is told now (the snapshot's, then each reply's); the toggles start from it.
  const [on, setOn] = useState<readonly OptionalCategory[] | undefined>();
  const shown = on ?? stored?.categories ?? OPTIONAL_CATEGORIES;
  return (
    <Section label={t("notifications.categoriesTitle", HERE)}>
      <Heading level={2}>{t("notifications.categoriesTitle", HERE)}</Heading>
      <Body>{t("notifications.categoriesIntro", HERE)}</Body>
      {OPTIONAL_CATEGORIES.map((category) => (
        <Toggle
          key={category}
          label={t(`notifications.category.${category}`)}
          value={shown.includes(category)}
          onChange={(value) => {
            setOn(value ? [...shown, category] : shown.filter((c) => c !== category));
          }}
        />
      ))}
      <Actions>
        <Button
          label={t("notifications.saveCategories")}
          busy={prefs.busy}
          testID="save-categories"
          onPress={() =>
            void prefs.run({ categories: shown }).then((outcome) => {
              if (outcome.ok) {
                hub.live.setState(learnPrefs(hub.live.getState(), outcome.body), true);
                setOn(undefined);
              }
            })
          }
        />
      </Actions>
      {prefs.outcome === undefined ? null : prefs.outcome.ok ? (
        <Done text={t("editing.saved")} />
      ) : (
        <Failure outcome={prefs.outcome} />
      )}
    </Section>
  );
}

function BrowserNotifications() {
  const { t } = useTranslation();
  const asked = noticePermission();
  const supported = asked !== "unsupported";
  const [permission, setPermission] = useState<NoticePermission>(supported ? asked : "denied");
  return (
    <Section label={t("notifications.browserTitle", HERE)}>
      <Heading level={2}>{t("notifications.browserTitle", HERE)}</Heading>
      <Body>{t("notifications.closedTab", HERE)}</Body>
      {!supported ? (
        <Body>{t("notifications.browserNone", HERE)}</Body>
      ) : permission === "granted" ? (
        <Body>{t("notifications.browserOn")}</Body>
      ) : permission === "denied" ? (
        <Body>{t("notifications.browserDenied")}</Body>
      ) : (
        <Actions>
          <Button
            kind="quiet"
            label={t("notifications.browserAsk")}
            onPress={() => void askNoticePermission().then(setPermission)}
          />
        </Actions>
      )}
    </Section>
  );
}

export function NotificationsScreen() {
  const { t } = useTranslation();
  const hub = useHub();
  const list = useRead("notifications.list", { limit: 100 }, "notifications");
  const read = useAction("notifications.read");
  const [readHere, setReadHere] = useState<readonly number[]>([]);
  const items = useMemo(
    () =>
      list.data?.ok === true
        ? list.data.body.notifications.map((n) =>
            readHere.includes(n.seq) ? { ...n, read: true } : n,
          )
        : [],
    [list.data, readHere],
  );
  const markSeqs = (seqs: readonly number[]) => {
    if (seqs.length === 0) return;
    void read.run({ seqs }).then((outcome) => {
      if (!outcome.ok) return;
      setReadHere((done) => [...done, ...seqs]);
      hub.live.setState(markRead(hub.live.getState(), seqs), true);
    });
  };
  const unread = items.filter((n) => !n.read).map((n) => n.seq);
  return (
    <>
      <Section label={t("notifications.listTitle")}>
        <Heading level={2}>{t("notifications.listTitle")}</Heading>
        {list.data !== undefined && !list.data.ok ? <Failure outcome={list.data} /> : null}
        {items.length === 0 ? <Body muted>{t("notifications.none")}</Body> : null}
        {unread.length === 0 ? null : (
          <Actions>
            <Button
              kind="quiet"
              label={t("notifications.markAllRead")}
              busy={read.busy}
              onPress={() => {
                markSeqs(unread);
              }}
              testID="mark-all-read"
            />
          </Actions>
        )}
        {read.outcome !== undefined && !read.outcome.ok ? <Failure outcome={read.outcome} /> : null}
        <List>
          {items.map((n) => (
            <NotificationItem
              key={n.seq}
              n={n}
              onRead={(seq) => {
                markSeqs([seq]);
              }}
            />
          ))}
        </List>
      </Section>
      <Categories />
      <BrowserNotifications />
      <TestAlert />
    </>
  );
}

/** The critical notifications not yet read, over every screen, said at once; a tone and the browser's notice for new ones. */
export function CriticalNotices() {
  const { t } = useTranslation();
  const hub = useHub();
  const all = useLive((s) => s.notifications);
  const devices = useLive((s) => s.devices);
  const read = useAction("notifications.read");
  const critical = useMemo(() => all.filter((n) => n.critical && !n.read), [all]);
  const told = useRef(new Set<number>());
  useEffect(() => {
    const fresh = critical.filter((n) => !told.current.has(n.seq));
    if (fresh.length === 0) return;
    for (const n of fresh) told.current.add(n.seq);
    tone();
    // The tag makes every tab's notice of one notification the same one.
    for (const n of fresh)
      showNotice(
        t("notifications.criticalTitle"),
        notificationWords(t, { devices }, n),
        String(n.seq),
      );
  }, [critical, devices, t]);
  if (critical.length === 0) return null;
  return (
    <Notice kind="danger" live="assertive" testID="critical-notices">
      <Heading level={2}>{t("notifications.criticalTitle")}</Heading>
      {critical.map((n) => (
        <Body key={n.seq}>{notificationWords(t, { devices }, n)}</Body>
      ))}
      <Actions>
        <Button
          kind="quiet"
          label={t("notifications.markRead")}
          busy={read.busy}
          onPress={() => {
            const seqs = critical.map((n) => n.seq);
            void read.run({ seqs }).then((outcome) => {
              if (outcome.ok) hub.live.setState(markRead(hub.live.getState(), seqs), true);
            });
          }}
        />
      </Actions>
      {read.outcome !== undefined && !read.outcome.ok ? <Failure outcome={read.outcome} /> : null}
    </Notice>
  );
}
