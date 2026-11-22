/** This phone, under Settings on a phone (m3-design.md section 6). */
import { useTranslation } from "react-i18next";
import { Body, Page } from "../ui/parts";
import { usePhone } from "../ui/phone-parts";

/** Opens the phone's own settings page. */
export default function Screen() {
  const { t } = useTranslation();
  const phone = usePhone();
  return (
    <Page title={t("screens.thisPhone.title")}>
      {phone === undefined ? <Body>{t("thisPhone.phoneOnly")}</Body> : null}
    </Page>
  );
}
