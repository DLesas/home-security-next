/**
 * The hub's status (m2-design.md section 6): its versions, app identity, certificate fingerprint
 * (to compare with the one the hub computer's console shows, D105), time zone and clock; and, for
 * *manage system*, the database: the last commit, what is staged, its size, whether history was
 * shortened, and what may be missing after a restart. The hub decides who sees the second part.
 */
import { useTranslation } from "react-i18next";
import { formatTime } from "./format";
import { useRead } from "./hub-context";
import { Body, Copyable, Failure, Heading, Section } from "./parts";

export function StatusScreen() {
  const { t, i18n } = useTranslation();
  const info = useRead("hub.info", {}, "hub");
  const status = useRead("hub.status", {}, "hub");
  const hub = info.data?.ok === true ? info.data.body : null;
  const db = status.data?.ok === true ? status.data.body : undefined;
  return (
    <>
      <Section label={t("status.hubTitle")}>
        <Heading level={2}>{t("status.hubTitle")}</Heading>
        {info.data !== undefined && !info.data.ok ? <Failure outcome={info.data} /> : null}
        {hub === null ? null : (
          <>
            <Body>{t("status.versions", { hub: hub.hub, proto: hub.proto })}</Body>
            <Body>{t("status.identity", { identity: hub.identity })}</Body>
            <Copyable>{t("status.fingerprint", { fingerprint: hub.fingerprint })}</Copyable>
            <Body>{t("status.zone", { zone: hub.timeZone })}</Body>
            <Body>{t(hub.clockTrusted ? "status.clockTrusted" : "time.untrusted")}</Body>
            <Body>{t("status.boot", { boot: hub.boot })}</Body>
          </>
        )}
      </Section>
      <Section label={t("status.databaseTitle")}>
        <Heading level={2}>{t("status.databaseTitle")}</Heading>
        {status.data !== undefined && !status.data.ok ? <Failure outcome={status.data} /> : null}
        {db === undefined ? null : (
          <>
            <Body>
              {db.lastCommitMs === null
                ? t("status.noCommit")
                : t("status.lastCommit", {
                    time: formatTime(t, i18n.language, hub, db.lastCommitMs),
                  })}
            </Body>
            <Body>{t("status.staged", { count: db.stagedItems })}</Body>
            <Body>
              {db.databaseBytes === null
                ? t("status.sizeUnknown")
                : t("status.size", { megabytes: (db.databaseBytes / 1_000_000).toFixed(1) })}
            </Body>
            {db.historyShortened ? <Body>{t("status.shortened")}</Body> : null}
            {db.missingAfterRestartMs === null ? null : (
              <Body>
                {t("status.missing", {
                  time: formatTime(t, i18n.language, hub, db.missingAfterRestartMs),
                })}
              </Body>
            )}
          </>
        )}
      </Section>
    </>
  );
}
