/**
 * The types of `intl.ts`'s pair, and what it puts in place, apart from React Native so it can be
 * tested. The app joins names with `Intl.ListFormat` ("front-door, back-door, and hall-siren";
 * `state/words.ts`'s `listOf`). React Native 0.88.1's Hermes has no `Intl.ListFormat` (nor
 * `Intl.PluralRules`, for which i18next has its own English rule), seen on the iOS simulator: every
 * screen that names devices in a sentence failed to render ("undefined cannot be used as a
 * constructor"). The phone puts in its place a list format for the app's one language, English,
 * the long conjunction a browser gives for `en`, before anything renders. An engine that has its
 * own keeps it.
 */
/** Where `Intl.ListFormat` is looked for and put: `globalThis.Intl`, or a stand-in in tests. */
export interface IntlScope {
  ListFormat?: unknown;
}

export interface IntlStart {
  /** Makes `Intl.ListFormat` available on `scope`; "engine" when it had its own. */
  readonly installIntl: (scope?: IntlScope) => "engine" | "platform";
}

/** English's long conjunction, as `new Intl.ListFormat("en", {style: "long", type: "conjunction"})`. */
export function joinEnglish(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0] ?? ""} and ${items[1] ?? ""}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1] ?? ""}`;
}

/** The stand-in: `format` joins as English does, whatever the options, the app's only use. */
export class EnglishListFormat {
  format(list: Iterable<string>): string {
    return joinEnglish([...list]);
  }
}

/**
 * Puts `EnglishListFormat` on `scope` unless it has its own. English is the app's one language
 * (`i18n.ts`'s `LANGUAGES`); a second one needs a list format of its own here, or the engine's.
 */
export function installListFormat(scope: IntlScope): "engine" | "platform" {
  if (typeof scope.ListFormat === "function") return "engine";
  scope.ListFormat = EnglishListFormat;
  return "platform";
}
