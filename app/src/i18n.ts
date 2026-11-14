/**
 * Translation (m2-design.md section 8, "Accessibility and translation"; HB27, D58): every text
 * the app shows is an i18next key with its English in `locales/en/`. The lint rule
 * `hsn/no-literal-text` refuses text written in components.
 */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import common from "../locales/en/common.json";

export const LANGUAGES = ["en"] as const;

export const i18n = i18next.createInstance();

/** Starts i18next with English; plurals and values by ICU-style options of i18next. */
export function startI18n(): Promise<unknown> {
  return i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { common } },
    defaultNS: "common",
    interpolation: { escapeValue: false },
  });
}
