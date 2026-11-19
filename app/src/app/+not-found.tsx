/**
 * A path the app has no page for, in place of Expo Router's own screen, which shows the path: a
 * link may carry a secret (`ui/system-path.ts`), so this page names no path at all.
 */
import { useTranslation } from "react-i18next";
import { Body, Page, TextLink } from "../ui/parts";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <Page title={t("notFound.title")}>
      <Body>{t("notFound.body")}</Body>
      <TextLink href="/" label={t("notFound.home")} testID="not-found-home" />
    </Page>
  );
}
