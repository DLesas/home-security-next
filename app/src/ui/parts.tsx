/**
 * The app's few building blocks, each usable by keyboard and screen reader: headings with their
 * level, buttons with a role, a label and a visible focus ring, fields whose label is tied to the
 * input, notices whose kind is said in words as well as shown by a border, and radio groups.
 * Every text they show is given to them already translated.
 */
import { type ReactNode, useId, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AppError } from "@hsn/protocol/app";
import type { LocalFault } from "../hub/faults";
import { failureWords } from "../state/words";
import { useLive } from "./hub-context";
import { colour, styles } from "./theme";

/** Whether a control has the keyboard's focus, to draw the focus ring (WCAG 2.4.7). */
function useFocusRing() {
  const [focused, setFocused] = useState(false);
  return {
    focused,
    handlers: {
      onFocus: () => {
        setFocused(true);
      },
      onBlur: () => {
        setFocused(false);
      },
    },
  };
}

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

export function Heading({
  level,
  children,
}: {
  readonly level: 1 | 2 | 3;
  readonly children: ReactNode;
}) {
  const style = level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3;
  return (
    <Text role="heading" aria-level={level} style={style}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted = false,
}: {
  readonly children: ReactNode;
  readonly muted?: boolean;
}) {
  return <Text style={muted ? styles.muted : styles.body}>{children}</Text>;
}

export function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View role="region" aria-label={label} style={styles.section}>
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = "main",
  busy = false,
  disabled = false,
  testID,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly kind?: "main" | "quiet" | "danger";
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly testID?: string | undefined;
}) {
  const { t } = useTranslation();
  const ring = useFocusRing();
  const off = disabled || busy;
  return (
    <Pressable
      {...ring.handlers}
      role="button"
      aria-label={label}
      aria-disabled={off}
      aria-busy={busy}
      disabled={off}
      onPress={onPress}
      testID={testID}
      style={[
        styles.button,
        kind === "quiet" && styles.buttonQuiet,
        kind === "danger" && styles.buttonDanger,
        ring.focused && styles.focused,
        off && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          kind === "quiet" && styles.buttonQuietText,
          kind === "danger" && styles.buttonDangerText,
        ]}
      >
        {busy ? t("common.busy") : label}
      </Text>
    </Pressable>
  );
}

export type NoticeKind = "info" | "ok" | "warning" | "danger";

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
  const style =
    kind === "ok"
      ? styles.noticeOk
      : kind === "warning"
        ? styles.noticeWarning
        : kind === "danger"
          ? styles.noticeDanger
          : styles.noticeInfo;
  return (
    <View
      style={[styles.notice, style]}
      testID={testID}
      {...(live === undefined
        ? {}
        : { "aria-live": live, role: live === "assertive" ? "alert" : "status" })}
    >
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
      <Text style={styles.body}>{failureWords(t, i18n.language, { devices }, outcome)}</Text>
    </Notice>
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
    <View style={{ gap: 4 }}>
      <Text style={styles.h3}>{label}</Text>
      {hint === undefined ? null : (
        <Text nativeID={hintId} style={styles.muted}>
          {hint}
        </Text>
      )}
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
        style={styles.input}
      />
      {error === undefined ? null : (
        <Text nativeID={errorId} style={[styles.body, { color: colour.danger }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

/** A radio group: one choice of a few, by arrow keys or by pressing. */
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
    <View style={{ gap: 4 }}>
      <Text nativeID={`${id}-label`} style={styles.h3}>
        {label}
      </Text>
      <View role="radiogroup" aria-labelledby={`${id}-label`} style={styles.row}>
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
    </View>
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
  const ring = useFocusRing();
  return (
    <Pressable
      {...ring.handlers}
      {...spaceToPress(onPress)}
      role="radio"
      aria-checked={checked}
      aria-label={label}
      onPress={onPress}
      style={[styles.button, !checked && styles.buttonQuiet, ring.focused && styles.focused]}
    >
      <Text style={[styles.buttonText, !checked && styles.buttonQuietText]}>
        {checked ? `✓ ${label}` : label}
      </Text>
    </Pressable>
  );
}

/** A checkbox: on or off, said by its state as well as its mark. */
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
  const ring = useFocusRing();
  return (
    <Pressable
      {...ring.handlers}
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
      style={[styles.row, { minHeight: 44 }, ring.focused && styles.focused]}
    >
      <Text style={[styles.body, { fontWeight: "700" }]} aria-hidden>
        {value ? "☑" : "☐"}
      </Text>
      <Text style={styles.body}>{label}</Text>
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
    <View role="group" aria-label={label} style={{ gap: 2 }}>
      <Text style={styles.h3}>{label}</Text>
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
    <View role="group" aria-label={question} style={[styles.notice, styles.noticeWarning]}>
      <Text style={styles.body}>{question}</Text>
      <View style={styles.row}>
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
      </View>
    </View>
  );
}

/** A reply that succeeded, said politely. */
export function Done({ text, testID }: { readonly text: string; readonly testID?: string }) {
  return (
    <Notice kind="ok" live="polite" {...(testID === undefined ? {} : { testID })}>
      <Text style={styles.body}>{text}</Text>
    </Notice>
  );
}
