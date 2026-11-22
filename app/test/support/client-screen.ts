/** Mounts a page with React's client renderer so effects, state changes and presses run in Bun. */
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { dirname } from "node:path";

// Expo's plist reader already installs an XML DOM. React still needs browser event hooks for it.
/** Finds an installed package relative to the package that declares it. */
const resolveFrom = (name: string, from: string) => dirname(Bun.resolveSync(name, from));
const expo = resolveFrom("expo/package.json", import.meta.dir);
const plugins = resolveFrom("@expo/config-plugins/package.json", expo);
const plist = resolveFrom("@expo/plist/package.json", plugins);
const { DOMParser, XMLSerializer } = (await import(Bun.resolveSync("@xmldom/xmldom", plist))) as {
  DOMParser: typeof globalThis.DOMParser;
  XMLSerializer: typeof globalThis.XMLSerializer;
};

type Listener = EventListenerOrEventListenerObject;

/** Adds the event methods React uses to register and dispatch a press. */
function events(node: Node) {
  const listeners = new Map<string, Listener[]>();
  Object.assign(node, {
    addEventListener(
      type: string,
      listener: Listener,
      capture?: boolean | AddEventListenerOptions,
    ) {
      const key = capture === true ? `${type}:capture` : type;
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    },
    removeEventListener(type: string, listener: Listener, capture?: boolean) {
      const key = capture === true ? `${type}:capture` : type;
      listeners.set(
        key,
        (listeners.get(key) ?? []).filter((entry) => entry !== listener),
      );
    },
  });
  return listeners;
}

/** Creates one document and forwards click events along its React root. */
function documentForReact() {
  const document = new DOMParser().parseFromString(
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><div /></body></html>',
    "text/xml",
  );
  const container =
    document.documentElement.getElementsByTagName("div")[0] ?? document.createElement("div");
  const rootEvents = events(container);
  events(document);
  const create = (document as { createElement(tag: string): Element }).createElement.bind(document);
  const createNS = document.createElementNS.bind(document);
  const createText = document.createTextNode.bind(document);
  /** Supplies the browser properties React sets on an element. */
  function element(node: Element) {
    events(node);
    return Object.assign(node, { style: {}, focus: () => undefined });
  }
  Object.assign(document, {
    createElement: (tag: string) => element(create(tag)),
    createElementNS: (namespace: string | null, tag: string) => element(createNS(namespace, tag)),
  });
  document.createTextNode = (value) => {
    const node = createText(value);
    // React writes nodeValue. The XML DOM serializes the text node's data field.
    Object.defineProperty(node, "nodeValue", {
      get: () => node.data,
      set: (next: string) => {
        node.data = next;
      },
    });
    return node;
  };
  const window = { document, HTMLElement: Object, HTMLIFrameElement: Array };
  Object.defineProperty(document, "defaultView", { value: window });
  return {
    container,
    window,
    /** Dispatches a click through React's root event listeners. */
    click(target: Element) {
      const event = new Event("click", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      Object.assign(event, { button: 0, altKey: false });
      for (const key of ["click:capture", "click"]) {
        for (const listener of rootEvents.get(key) ?? []) {
          if (typeof listener === "function") listener.call(container, event);
          else listener.handleEvent(event);
        }
      }
    },
  };
}

/** Runs a test action and flushes React's effects and their promise continuations. */
export async function screenAct(run: () => void | Promise<void>): Promise<void> {
  await act(() => Promise.resolve().then(run));
}

/** Creates an isolated React root and restores Bun's globals when it is closed. */
export function clientScreen() {
  const dom = documentForReact();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, globals);
  const root = createRoot(dom.container);
  return {
    /** Reads the current HTML after React's effects have run. */
    html: () => new XMLSerializer().serializeToString(dom.container),
    /** Renders through React's actual client hooks. */
    render: (page: ReactElement) =>
      screenAct(() => {
        root.render(page);
      }),
    /** Presses an enabled button (or another control, by its role) by its accessible label. */
    press: async (label: string, role = "button") => {
      const button = Array.from(dom.container.getElementsByTagName("*")).find(
        (node) =>
          node.getAttribute("role") === role &&
          node.getAttribute("aria-label") === label &&
          node.getAttribute("aria-disabled") !== "true",
      );
      if (button === undefined) return false;
      await screenAct(() => {
        dom.click(button);
      });
      return true;
    },
    /** Releases effects and restores the previous globals. */
    close: () =>
      screenAct(() => {
        root.unmount();
      }).finally(() => {
        for (const [key, descriptor] of previous) {
          if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
          else Object.defineProperty(globalThis, key, descriptor);
        }
      }),
  };
}
