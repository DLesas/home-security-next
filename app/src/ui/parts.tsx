/**
 * The app's building blocks (docs/app-design.md), each written once and styled only by the theme's
 * tokens: text in its roles, the page and its sections, buttons, inputs, notices, list rows, radio
 * groups and checkboxes. Space separates; a filled surface is used only for notices and inputs
 * (and the home screen's state field). Every control is at least 48 px high, has a role and a
 * label, and shows a 3 px focus ring with a 3 px gap when the keyboard reaches it. Every text they
 * show is given to them already translated.
 */
import { Link } from "expo-router";
import { type ComponentRef, type ReactNode, type Ref, useId, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AppError } from "@hsn/protocol/app";
import type { LocalFault } from "../hub/faults";
import { failureWords } from "../state/words";
import { useLive } from "./hub-context";

/**
 * Space for a checkbox or a radio (WAI-ARIA's key for them): React Native Web presses on Enter for
 * every role but on Space only for buttons. `onKeyDown` is a web prop React Native's types lack, so
 * it goes in as a plain object, for these two controls only.
 */
function spaceToPress(press: () => void): object {
  return {
    onKeyDown: (event: { readonly key: string; preventDefault(): void }) => {
      if (event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      press();
    },
  };
}

/** The keyboard's focus ring: 3 px, a 3 px gap, `ink` on pale surfaces, `limewash` on dark ones. */
export const RING_PALE =
  "web:focus-visible:outline-3 web:focus-visible:outline-offset-3 web:focus-visible:outline-ink";
const RING_DARK =
  "web:focus-visible:outline-3 web:focus-visible:outline-offset-3 web:focus-visible:outline-limewash";

// ----- Text -----

/** Secondary text: 15 / 22, `stone`. */
const SECONDARY = "max-w-line font-text text-small text-stone";

export function Heading({
  level,
  children,
}: {
  readonly level: 1 | 2 | 3;
  readonly children: ReactNode;
}) {
  const role =
    level === 1
      ? "font-heavy text-title"
      : level === 2
        ? "font-strong text-section"
        : "font-strong text-body";
  return (
    <Text role="heading" aria-level={level} className={`${role} text-ink`}>
      {children}
    </Text>
  );
}

/** Body text; `muted` for secondary text. At most about 65 characters to a line. */
export function Body({
  children,
  muted = false,
  testID,
}: {
  readonly children: ReactNode;
  readonly muted?: boolean;
  readonly testID?: string;
}) {
  return (
    <Text testID={testID} className={muted ? SECONDARY : "max-w-line font-text text-body text-ink"}>
      {children}
    </Text>
  );
}

/** Facts about one thing, one to a line, in secondary text (not run together with dots). */
export function Facts({ items }: { readonly items: readonly (string | undefined)[] }) {
  return (
    <View className="gap-1">
      {items
        .filter((x) => x !== undefined)
        .map((fact) => (
          <Text key={fact} className={SECONDARY}>
            {fact}
          </Text>
        ))}
    </View>
  );
}

const COPYABLE = {
  title: "text-title text-ink",
  body: "text-body text-ink",
  small: "text-small text-stone",
} as const;

/**
 * Characters a person must copy exactly (a link code, an address, a fingerprint), in Atkinson
 * Hyperlegible Mono: `title` for a code to type, `small` for a long one beside its QR code.
 */
export function Copyable({
  children,
  size = "body",
  testID,
}: {
  readonly children: ReactNode;
  readonly size?: keyof typeof COPYABLE;
  readonly testID?: string;
}) {
  return (
    <Text selectable testID={testID} className={`max-w-line font-code ${COPYABLE[size]}`}>
      {children}
    </Text>
  );
}

/** A link in running text or under a notice: words, underlined, at least 48 px high. */
export function TextLink({
  href,
  label,
  testID,
}: {
  readonly href: string;
  readonly label: string;
  readonly testID?: string;
}) {
  return (
    <Link
      href={href}
      testID={testID}
      className={`min-h-target self-start py-3 font-strong text-body text-ink underline ${RING_PALE}`}
    >
      {label}
    </Link>
  );
}

// ----- Page and sections -----

/**
 * The content column every screen sits in: the page gutter (24 px on a phone, 48 px from 768 px),
 * then at most 640 px, left aligned beside the navigation.
 */
export function Column({
  children,
  first,
}: {
  readonly children: ReactNode;
  readonly first: boolean;
}) {
  return (
    <View className="w-full px-6 md:px-12">
      {/* `first`: the home screen's state field meets the top edge on a phone. */}
      <View className={`w-full max-w-column gap-6 pb-16 md:pt-12 ${first ? "" : "pt-6"}`}>
        {children}
      </View>
    </View>
  );
}

/**
 * A screen: its title (with its introduction 16 px under it, as part of the title), then sections
 * set apart by space (48 px on a phone, 64 px from 768 px). `top` stands above the title (the home
 * screen's state field, which stands in for it).
 */
export function Page({
  title,
  intro,
  top,
  children,
}: {
  readonly title?: string;
  readonly intro?: string;
  readonly top?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View role="main" className="gap-12 md:gap-16">
      {top}
      {title === undefined ? null : (
        <View className="gap-4">
          <Heading level={1}>{title}</Heading>
          {intro === undefined ? null : <Body>{intro}</Body>}
        </View>
      )}
      {children}
    </View>
  );
}

/** Said to a screen reader and not shown: what is shown changes too often to be read out. */
export function Spoken({ children }: { readonly children: ReactNode }) {
  return (
    <View role="status" aria-live="polite" className="absolute h-px w-px overflow-hidden">
      <Text>{children}</Text>
    </View>
  );
}

/** A section: a region with its heading, its content 16 px below. No box: space sets it apart. */
export function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View role="region" aria-label={label} className="gap-4">
      {children}
    </View>
  );
}

/** Items one above the other with room between: the fields of a form, the parts of a section. */
export function Stack({ children }: { readonly children: ReactNode }) {
  return <View className="gap-6">{children}</View>;
}

/** Buttons side by side, wrapping on a narrow screen, left aligned. */
export function Actions({ children }: { readonly children: ReactNode }) {
  return <View className="flex-row flex-wrap items-center gap-3">{children}</View>;
}

// ----- Lists -----

/** A list: rows with a hairline between them. `live`: new rows are said politely when they come. */
export function List({
  children,
  label,
  live = false,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly live?: boolean;
}) {
  return (
    <View
      role="list"
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(live ? { "aria-live": "polite" } : {})}
      className="border-t border-line"
    >
      {children}
    </View>
  );
}

/** One item of a list: at least 56 px high, 16 px above and below, a hairline below. */
export function ListItem({
  children,
  testID,
}: {
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}) {
  return (
    <View role="listitem" testID={testID} className="min-h-row gap-3 border-b border-line py-4">
      {children}
    </View>
  );
}

/**
 * A row: the name at the left, the state at the right, a hairline below; at least 56 px high with
 * 16 px above and below its text. `children` holds what goes under it (details, actions).
 */
export function ListRow({
  name,
  state,
  children,
  testID,
}: {
  readonly name: ReactNode;
  readonly state?: ReactNode;
  readonly children?: ReactNode;
  readonly testID?: string;
}) {
  return (
    <ListItem testID={testID}>
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Text className="font-strong text-body text-ink">{name}</Text>
        {state === undefined ? null : (
          <Text className="font-text text-body text-stone">{state}</Text>
        )}
      </View>
      {children}
    </ListItem>
  );
}

/**
 * A row that opens a page: the whole row is the link. Its name at the left with a line beneath, its
 * state in words at the right; the link's accessible name is its words, so it says all three.
 */
export function LinkRow({
  href,
  name,
  detail,
  state,
  testID,
}: {
  readonly href: string;
  readonly name: string;
  readonly detail?: string;
  readonly state?: string;
  readonly testID?: string;
}) {
  return (
    <View role="listitem" testID={testID}>
      <Link href={href} asChild>
        <Pressable
          role="link"
          className={`min-h-row flex-row flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line py-4 ${RING_PALE}`}
        >
          <View className="gap-1">
            <Text className="font-strong text-body text-ink underline">{name}</Text>
            {detail === undefined ? null : <Text className={SECONDARY}>{detail}</Text>}
          </View>
          {state === undefined ? null : (
            <Text className="font-text text-body text-stone">{state}</Text>
          )}
        </Pressable>
      </Link>
    </View>
  );
}

/**
 * A row of news that needs no action: the message at the left, a "Dismiss" text button at the
 * right (its accessible name says what it dismisses).
 */
export function NewsRow({
  text,
  dismiss,
  dismissLabel,
  onDismiss,
  testID,
}: {
  readonly text: string;
  readonly dismiss: string;
  readonly dismissLabel: string;
  readonly onDismiss: () => void;
  readonly testID?: string;
}) {
  return (
    <ListItem testID={testID}>
      <View className="flex-row items-center justify-between gap-6">
        <Text className="max-w-line flex-1 font-text text-body text-ink">{text}</Text>
        <TextButton label={dismiss} accessibleLabel={dismissLabel} onPress={onDismiss} />
      </View>
    </ListItem>
  );
}

/** An action that reads as a link: words, underlined, at least 48 px high. */
export function TextButton({
  label,
  accessibleLabel,
  onPress,
}: {
  readonly label: string;
  readonly accessibleLabel?: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      aria-label={accessibleLabel ?? label}
      onPress={onPress}
      className={`min-h-target justify-center rounded-button ${RING_PALE}`}
    >
      <Text className="font-strong text-body text-ink underline">{label}</Text>
    </Pressable>
  );
}

// ----- Buttons -----

export type ButtonKind = "main" | "quiet" | "danger" | "night" | "nightQuiet";

const BUTTON: Readonly<Record<ButtonKind, { readonly box: string; readonly text: string }>> = {
  // Every kind has the same 2 px edge, so their words line up.
  main: { box: `border-2 border-transparent bg-spruce ${RING_PALE}`, text: "text-limewash" },
  quiet: { box: `border-2 border-stone ${RING_PALE}`, text: "text-ink" },
  danger: { box: `border-2 border-transparent bg-signal ${RING_PALE}`, text: "text-limewash" },
  // On the night and alarm fields: pale on dark.
  night: { box: `border-2 border-transparent bg-limewash ${RING_DARK}`, text: "text-spruce" },
  nightQuiet: { box: `border-2 border-limewash ${RING_DARK}`, text: "text-limewash" },
};

export function Button({
  label,
  onPress,
  kind = "main",
  busy = false,
  disabled = false,
  wide = false,
  testID,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly kind?: ButtonKind;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  /** Full width (the state field's actions on a phone). */
  readonly wide?: boolean;
  readonly testID?: string | undefined;
}) {
  const { t } = useTranslation();
  const off = disabled || busy;
  const look = BUTTON[kind];
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={off}
      aria-busy={busy}
      disabled={off}
      onPress={onPress}
      testID={testID}
      className={`min-h-target justify-center rounded-button px-6 ${look.box} ${wide ? "w-full md:w-auto md:self-start" : "self-start"} ${off ? "opacity-60" : ""}`}
    >
      <Text className={`font-strong text-body ${look.text}`}>
        {busy ? t("common.busy") : label}
      </Text>
    </Pressable>
  );
}

// ----- Notices -----

export type NoticeKind = "info" | "ok" | "warning" | "danger";

const NOTICE: Readonly<Record<NoticeKind, { readonly box: string; readonly text: string }>> = {
  info: { box: "bg-sage border-l-4 border-stone", text: "text-ink" },
  ok: { box: "bg-fern-surface border-l-4 border-fern", text: "text-fern" },
  warning: { box: "bg-ochre-surface border-l-4 border-ochre", text: "text-ochre" },
  // A refusal is a warning to act on: the same pale ochre (red is the alarm's alone).
  danger: { box: "bg-ochre-surface border-l-4 border-ochre", text: "text-ochre" },
};

/**
 * A notice. `live` makes a screen reader say it when it appears: `polite` for results, `assertive`
 * only for what cannot wait (the alarm, a countdown).
 */
export function Notice({
  kind,
  children,
  live,
  testID,
}: {
  readonly kind: NoticeKind;
  readonly children: ReactNode;
  readonly live?: "polite" | "assertive";
  readonly testID?: string;
}) {
  return (
    <View
      testID={testID}
      className={`gap-3 rounded-notice px-4 py-4 ${NOTICE[kind].box}`}
      {...(live === undefined
        ? {}
        : { "aria-live": live, role: live === "assertive" ? "alert" : "status" })}
    >
      {children}
    </View>
  );
}

/** A notice's sentence, coloured as its notice is. */
export function NoticeText({
  kind,
  children,
}: {
  readonly kind: NoticeKind;
  readonly children: ReactNode;
}) {
  return <Text className={`max-w-line font-text text-body ${NOTICE[kind].text}`}>{children}</Text>;
}

/**
 * A question that needs an answer before anything happens: a sheet of `chalk` with its heading,
 * reached by focus when it appears (`ref`, `tabIndex`).
 */
export function Dialog({
  title,
  children,
  ref,
  testID,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly ref?: Ref<ComponentRef<typeof View>>;
  readonly testID?: string;
}) {
  return (
    <View
      ref={ref}
      role="alertdialog"
      aria-label={title}
      tabIndex={-1}
      testID={testID}
      className={`gap-4 rounded-notice border-2 border-stone bg-chalk px-6 py-6 ${RING_PALE}`}
    >
      <Heading level={2}>{title}</Heading>
      {children}
    </View>
  );
}

/** A failed request's outcome in words, said when it appears. */
export function Failure({
  outcome,
  testID,
}: {
  readonly outcome:
    | { readonly ok: false; readonly error: AppError }
    | { readonly ok: false; readonly local: LocalFault };
  readonly testID?: string;
}) {
  const { t, i18n } = useTranslation();
  const devices = useLive((s) => s.devices);
  return (
    <Notice kind="danger" live="polite" testID={testID ?? "failure"}>
      <NoticeText kind="danger">{failureWords(t, i18n.language, { devices }, outcome)}</NoticeText>
    </Notice>
  );
}

/** A reply that succeeded, said politely. */
export function Done({ text, testID }: { readonly text: string; readonly testID?: string }) {
  return (
    <Notice kind="ok" live="polite" {...(testID === undefined ? {} : { testID })}>
      <NoticeText kind="ok">{text}</NoticeText>
    </Notice>
  );
}

// ----- Inputs -----

/** A control's name, above it. */
export function Label({
  id,
  children,
}: {
  readonly id?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <Text nativeID={id} className="font-strong text-body text-ink">
      {children}
    </Text>
  );
}

/** A label above its control, and a hint or an error below the label. */
function Labelled({
  label,
  labelId,
  hint,
  hintId,
  error,
  errorId,
  children,
}: {
  readonly label: string;
  readonly labelId?: string;
  readonly hint?: string | undefined;
  readonly hintId?: string;
  readonly error?: string | undefined;
  readonly errorId?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Label id={labelId}>{label}</Label>
      {hint === undefined ? null : (
        <Text nativeID={hintId} className="max-w-line font-text text-small text-stone">
          {hint}
        </Text>
      )}
      {children}
      {error === undefined ? null : (
        <Text nativeID={errorId} className="max-w-line font-strong text-small text-ochre">
          {error}
        </Text>
      )}
    </View>
  );
}

export function Field({
  label,
  hint,
  error,
  value,
  onChange,
  secure = false,
  autoComplete,
  testID,
  onSubmit,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly secure?: boolean;
  readonly autoComplete?: "name" | "off" | "new-password";
  readonly testID?: string;
  readonly onSubmit?: () => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [
    hint === undefined ? undefined : hintId,
    error === undefined ? undefined : errorId,
  ]
    .filter((x) => x !== undefined)
    .join(" ");
  return (
    <Labelled label={label} hint={hint} hintId={hintId} error={error} errorId={errorId}>
      <TextInput
        aria-label={label}
        aria-describedby={described === "" ? undefined : described}
        aria-invalid={error !== undefined}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        autoComplete={autoComplete}
        autoCorrect={false}
        autoCapitalize="none"
        onSubmitEditing={onSubmit}
        testID={testID}
        className={`min-h-target w-full max-w-column rounded-input border-2 bg-chalk px-4 font-text text-body text-ink ${error === undefined ? "border-stone" : "border-ochre"} web:focus:outline-3 web:focus:outline-offset-3 web:focus:outline-ink`}
      />
    </Labelled>
  );
}

/** One choice of a few. */
export function Choice<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T | undefined;
  readonly onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <Labelled label={label} labelId={`${id}-label`}>
      <View role="radiogroup" aria-labelledby={`${id}-label`} className="flex-row flex-wrap gap-3">
        {options.map((option) => (
          <Radio
            key={String(option.value)}
            label={option.label}
            checked={option.value === value}
            onPress={() => {
              onChange(option.value);
            }}
          />
        ))}
      </View>
    </Labelled>
  );
}

function Radio({
  label,
  checked,
  onPress,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      {...spaceToPress(onPress)}
      role="radio"
      aria-checked={checked}
      aria-label={label}
      onPress={onPress}
      className={`min-h-target justify-center rounded-button px-4 ${checked ? "bg-spruce" : "border-2 border-stone"} ${RING_PALE}`}
    >
      <Text className={`font-strong text-body ${checked ? "text-limewash" : "text-ink"}`}>
        {checked ? `✓ ${label}` : label}
      </Text>
    </Pressable>
  );
}

/**
 * A checkbox, drawn: a 24 px square with a `stone` edge, filled `spruce` with a `limewash` tick when
 * on, in a 48 px target with its label. The label says what being on means.
 */
export function Toggle({
  label,
  value,
  onChange,
  testID,
}: {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly testID?: string;
}) {
  return (
    <Pressable
      {...spaceToPress(() => {
        onChange(!value);
      })}
      role="checkbox"
      aria-checked={value}
      aria-label={label}
      testID={testID}
      onPress={() => {
        onChange(!value);
      }}
      className={`min-h-target flex-row items-center gap-3 self-start rounded-button pr-2 ${RING_PALE}`}
    >
      <View
        aria-hidden
        className={`h-6 w-6 items-center justify-center border-2 ${value ? "border-spruce bg-spruce" : "border-stone bg-chalk"}`}
      >
        {/* The tick: two edges of a small box, turned. */}
        {value ? (
          <View className="-mt-1 h-3 w-2 rotate-45 border-r-2 border-b-2 border-limewash" />
        ) : null}
      </View>
      <Text className="font-text text-body text-ink">{label}</Text>
    </Pressable>
  );
}

/** Several of a few: a labelled group of checkboxes. */
export function CheckList<T extends string | number>({
  label,
  options,
  values,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly values: readonly T[];
  readonly onChange: (values: readonly T[]) => void;
}) {
  return (
    <View role="group" aria-label={label} className="gap-1">
      <Label>{label}</Label>
      {options.map((option) => (
        <Toggle
          key={String(option.value)}
          label={option.label}
          value={values.includes(option.value)}
          onChange={(on) => {
            onChange(on ? [...values, option.value] : values.filter((v) => v !== option.value));
          }}
        />
      ))}
    </View>
  );
}

/**
 * A step that cannot be undone, asked twice: the button, then the question with Yes and No. The
 * hub refuses what it refuses; this only keeps a slip of the finger from deleting.
 */
export function ConfirmButton({
  label,
  question,
  yes,
  no,
  onConfirm,
  busy = false,
  testID,
}: {
  readonly label: string;
  readonly question: string;
  readonly yes: string;
  readonly no: string;
  readonly onConfirm: () => void;
  readonly busy?: boolean;
  readonly testID?: string | undefined;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button
        kind="quiet"
        label={label}
        busy={busy}
        testID={testID}
        onPress={() => {
          setAsking(true);
        }}
      />
    );
  }
  return (
    <View role="group" aria-label={question} className="w-full">
      <Notice kind="warning">
        <NoticeText kind="warning">{question}</NoticeText>
        <Actions>
          <Button
            kind="danger"
            label={yes}
            testID={testID === undefined ? undefined : `${testID}-yes`}
            onPress={() => {
              setAsking(false);
              onConfirm();
            }}
          />
          <Button
            kind="quiet"
            label={no}
            onPress={() => {
              setAsking(false);
            }}
          />
        </Actions>
      </Notice>
    </View>
  );
}
