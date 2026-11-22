/** This phone, under Settings on a phone (m3-design.md section 6). */
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { LINK_HOME } from "../ui/navigation";
import { Page } from "../ui/parts";
import { ThisPhoneScreen } from "../ui/this-phone";

/** Opens the phone's homes and lock controls. */
export default function Screen() {
  const { t } = useTranslation();
  return (
    <Page title={t("screens.thisPhone.title")}>
      <ThisPhoneScreen
        onLinkAnother={() => {
          router.push(LINK_HOME);
        }}
      />
    </Page>
  );
}
