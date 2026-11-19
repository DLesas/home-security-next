/**
 * Renders a component as the web build does (React Native Web), with English, a hub client whose
 * live store the test sets, and a query client: for the screens' tests.
 */
import "./render";
import type { ReactElement } from "react";
import type { LiveState } from "../../src/state/live";
import type { LinkView, LocalState } from "../../src/hub/client";
import { manualTimers } from "./timers";

/** Provides the same test context for static and interactive screen rendering. */
export async function screenWorld(live: Partial<LiveState>, link?: LinkView) {
  const { createElement } = await import("react");
  const { I18nextProvider } = await import("react-i18next");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { i18n, startI18n } = await import("../../src/i18n");
  const { HubProvider } = await import("../../src/ui/hub-context");
  const { createHubClient } = await import("../../src/hub/client");
  const { memoryRecordStore } = await import("../../src/platform/client-key");
  const { EMPTY_LIVE, createLiveStore } = await import("../../src/state/live");
  const { createStore } = await import("zustand/vanilla");
  if (!i18n.isInitialized) await startI18n();
  // A client that never connects: the screens render from the store the test gives.
  const made = createHubClient({
    connect: () => Promise.resolve(undefined),
    records: memoryRecordStore(),
    timers: manualTimers(),
    app: "0.1.0",
  });
  // A server render reads a store's initial state, so the stores are made with the test's state.
  const client = {
    ...made,
    live: createLiveStore({ ...EMPTY_LIVE, connection: { kind: "open" }, ...live }),
    local: createStore<LocalState>()(() => ({ link: link ?? { kind: "idle" } })),
  };
  const queries = new QueryClient();
  return {
    client,
    /** Wraps the page in the test's hub, query client and English translations. */
    wrap: (element: ReactElement) =>
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client: queries },
          createElement(HubProvider, { client, children: element }),
        ),
      ),
  };
}

/** Renders a screen with a fixed live store and the test's usual contexts. */
export async function renderWith(
  element: ReactElement,
  live: Partial<LiveState>,
  link?: LinkView,
): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup((await screenWorld(live, link)).wrap(element));
}

/** The text a person reads in some HTML: tags out, entities back. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&#x27;|&#39;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/\s+/gu, " ")
    .trim();
}
