/**
 * A screen that failed to render, in place of Expo Router's own, which shows the error's message
 * (the root layout exports it as its `ErrorBoundary`): a message may hold what a screen was given,
 * a link's secret among it, so this says only what happened and offers to try again. It stands
 * outside the root's providers, so it takes the translation directly.
 */
import type { ErrorBoundaryProps } from "expo-router";
import { View } from "react-native";
import { i18n } from "../i18n";
import { Actions, Body, Button, Column, Page } from "./parts";

export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <View className="flex-1 bg-limewash pt-safe">
      <Column first={false}>
        <Page title={i18n.t("failed.title")}>
          <Body>{i18n.t("failed.body")}</Body>
          <Actions>
            <Button label={i18n.t("failed.retry")} onPress={() => void retry()} />
          </Actions>
        </Page>
      </Column>
    </View>
  );
}
