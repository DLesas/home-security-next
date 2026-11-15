/**
 * What a browser that is not linked sees (m2-design.md sections 5 and 8): linking under way, why a
 * link failed, a field for a typed code, and what to do when this browser was removed or cannot
 * keep a key. The console's first link (`hsn open`) and a link address start by themselves from
 * the address; this screen only shows how it goes.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { typedSecret } from "../hub/fragment";
import type { LinkView } from "../hub/client";
import { LINK_FAILURE_KEYS } from "../state/words";
import { useHub, useLive, useLocal } from "./hub-context";
import { Body, Button, Field, Heading, Notice } from "./parts";
import { cleanName } from "./setup";
import { styles } from "./theme";

/** True when this screen, not the routes, is what the browser shows. */
export function needsLinkGate(connection: { readonly kind: string }, link: LinkView): boolean {
  return (
    link.kind === "linking" ||
    link.kind === "askingName" ||
    connection.kind === "notLinked" ||
    connection.kind === "removed" ||
    connection.kind === "noStorage" ||
    (link.kind === "failed" && connection.kind !== "open")
  );
}

export function LinkGate() {
  const { t } = useTranslation();
  const hub = useHub();
  const connection = useLive((s) => s.connection);
  const link = useLocal((s) => s.link);
  const [code, setCode] = useState("");
  const [badCode, setBadCode] = useState(false);
  const [name, setName] = useState("");
  const [badName, setBadName] = useState(false);

  if (connection.kind === "removed") {
    return (
      <View role="main" style={styles.main}>
        <Heading level={1}>{t("link.removedTitle")}</Heading>
        <Body>{t("link.removed")}</Body>
        <View style={styles.row}>
          <Button
            label={t("link.linkAgain")}
            onPress={() => void hub.forget()}
            testID="link-again"
          />
        </View>
      </View>
    );
  }
  if (connection.kind === "noStorage") {
    return (
      <View role="main" style={styles.main}>
        <Heading level={1}>{t("link.noStorageTitle")}</Heading>
        <Body>{t("link.noStorage")}</Body>
      </View>
    );
  }

  if (link.kind === "askingName") {
    const give = () => {
      const clean = cleanName(name);
      setBadName(clean === undefined);
      if (clean !== undefined) void hub.giveName(clean);
    };
    return (
      <View role="main" style={styles.main}>
        <Heading level={1}>{t("link.title")}</Heading>
        <Body>{t("link.askName")}</Body>
        <Field
          label={t("link.yourName")}
          value={name}
          onChange={setName}
          onSubmit={give}
          autoComplete="name"
          testID="link-person-name"
          {...(badName ? { error: t("editing.badName") } : {})}
        />
        <View style={styles.row}>
          <Button label={t("link.submitName")} onPress={give} testID="link-person-submit" />
        </View>
      </View>
    );
  }

  const submit = () => {
    const secret = typedSecret(code);
    if (secret === undefined) {
      setBadCode(true);
      return;
    }
    setBadCode(false);
    void hub.link(secret, "typed", { name: t("link.webName"), kind: "web" });
  };

  return (
    <View role="main" style={styles.main}>
      <Heading level={1}>{t("link.title")}</Heading>
      {link.kind === "linking" ? (
        <Notice kind="info" live="polite" testID="link-status">
          <Text style={styles.body}>{t("link.linking")}</Text>
        </Notice>
      ) : null}
      {link.kind === "failed" ? (
        <Notice kind="danger" live="polite" testID="link-status">
          <Text style={styles.body}>{t(LINK_FAILURE_KEYS[link.failure])}</Text>
          {link.from === "console" ? (
            <Text style={styles.body}>{t("link.fromConsole")}</Text>
          ) : null}
        </Notice>
      ) : null}
      <Body>{t("link.intro")}</Body>
      <Field
        label={t("link.codeLabel")}
        hint={t("link.codeHint")}
        value={code}
        onChange={(text) => {
          setCode(text);
          setBadCode(false);
        }}
        onSubmit={submit}
        autoComplete="off"
        testID="link-code"
        {...(badCode ? { error: t("link.failure.badCode") } : {})}
      />
      <View style={styles.row}>
        <Button
          label={t("link.submit")}
          onPress={submit}
          busy={link.kind === "linking"}
          testID="link-submit"
        />
      </View>
    </View>
  );
}
