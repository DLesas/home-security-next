/**
 * Text on every screen follows the phone's text size up to twice the app's own sizes, and no
 * further (docs/app-design.md, "On a phone", rule 4): React Native's `maxFontSizeMultiplier` on
 * every text and field. Every screen takes `Text` and `TextInput` from here, never from
 * `react-native`. A browser ignores the property (React Native Web drops it), so the web build is
 * unchanged.
 */
import type { ComponentProps } from "react";
import { Text as NativeText, TextInput as NativeTextInput } from "react-native";

/** The largest text size the app follows: 200% of its own (rule 4). */
export const TEXT_SCALE_MAX = 2;

export function Text(props: ComponentProps<typeof NativeText>) {
  return <NativeText maxFontSizeMultiplier={TEXT_SCALE_MAX} {...props} />;
}

export function TextInput(props: ComponentProps<typeof NativeTextInput>) {
  return <NativeTextInput maxFontSizeMultiplier={TEXT_SCALE_MAX} {...props} />;
}
