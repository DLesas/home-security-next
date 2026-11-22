/**
 * The chosen home's name on Home, with more than one home on this phone (m3-design.md section 6,
 * "Several hubs"): a line above the state sentence, inside the state field and in its colours,
 * with "Change" leading to This phone's homes. The name never enters the state sentence (AD, "The
 * alarm sentence"). Nothing with one home, and nothing in a browser.
 */
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { type Look, LOOK } from "./banners";
import type { Homes } from "./homes";
import { TextLink } from "./parts";
import { usePhone } from "./phone-parts";
import { Text } from "./text";

/** The chosen home's name, when this phone holds more than one; else null. */
export function chosenHomeName(state: {
  readonly homes: readonly { readonly identity: string; readonly name: string }[];
  readonly chosen: string | null;
}): string | null {
  if (state.homes.length < 2) return null;
  return state.homes.find((h) => h.identity === state.chosen)?.name ?? null;
}

/** Renders the phone-only home selector using the surrounding state field’s colours. */
export function HomeLine({ look }: { readonly look: Look }) {
  const phone = usePhone();
  return phone === undefined ? null : <Line homes={phone.homes} look={look} />;
}

/** Renders a name and Change once multiple homes are linked. */
function Line({ homes, look }: { readonly homes: Homes; readonly look: Look }) {
  const { t } = useTranslation();
  const name = useStore(homes.store, chosenHomeName);
  if (name === null) return null;
  return (
    <View testID="home-line" className="flex-row flex-wrap items-center gap-x-4">
      <Text className={`shrink font-strong text-body ${LOOK[look].text}`}>{name}</Text>
      <TextLink href="/this-phone" label={t("homes.change")} onDark={look !== "day"} />
    </View>
  );
}
