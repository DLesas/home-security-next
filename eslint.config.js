// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import hsn from "./tools/eslint-plugin-hsn/src/index.ts";

// The hub's layer rules (docs/hub-design.md section 1, and section 10 for `throw` and `try`).
// Each restriction has a probe in hub/test/lint-probes/, whose folders mirror hub/'s, so every
// glob below names a hub folder and the same folder under the probes. A test lints the probes
// (which the ordinary run ignores) and requires each to fail with exactly its rule and message.

const PROBES = "hub/test/lint-probes";
/** @param {string[]} globs paths under hub/ */
const hubAndProbes = (...globs) => globs.flatMap((glob) => [`hub/${glob}`, `${PROBES}/${glob}`]);

/** Names of @hsn/protocol the core may not use at all: they touch the runtime's crypto. */
const IMPURE_PROTOCOL_NAMES = [
  "sealPacket",
  "openPacket",
  "createAesCcm",
  "nodeAes128",
  "nodeSha256",
  "hubIdentity",
];
/** Names of @hsn/protocol that can throw: the core calls them only through protocol-safe.ts. */
const THROWING_PROTOCOL_NAMES = [
  "timeOnAirMs",
  "dataRateMask",
  "tenPpmUnitsFromPpm",
  "resumeSendCounter",
  "restoreSendCounter",
  "checkReplayWindow",
  "checkStrictlyHigher",
  "counterBinding",
  "welcomeBinding",
  "sessionBinding",
  "encodeMessage",
  "encodeSetupMessage",
  "encodePairingData",
  "fifteenSecondUnitsFromSeconds",
  "tenthsFromMilliseconds",
  "batteryCode",
  "fromHex",
];

const impureProtocol = {
  name: "@hsn/protocol",
  importNames: IMPURE_PROTOCOL_NAMES,
  message: "[core-impure] The core opens and seals only through deps.cipher (section 2).",
};
const throwingProtocol = {
  group: ["@hsn/protocol"],
  importNames: THROWING_PROTOCOL_NAMES,
  message:
    "[core-throwing] This can throw: use its wrapper in core/util/protocol-safe.ts (section 10).",
};

/**
 * Forbids every import source but the allowed ones, given as regular expressions.
 * @param {string} tag
 * @param {string} message
 * @param {string[]} allowed
 */
const onlyFrom = (tag, message, allowed) => ({
  regex: `^(?!(?:${allowed.join("|")}))`,
  message: `[${tag}] ${message}`,
});

// Allowed sources, as regular expressions. "No `..` after" keeps a path from climbing back out.
// `@hsn/protocol/app` is the app channel of M2 (m2-design.md section 5): pure, as the device
// protocol is.
const PROTOCOL = "@hsn/protocol(?:/app|/records)?$";
const NEVERTHROW = "neverthrow$";
const OWN_FOLDER = "\\./(?!.*\\.\\.)";
const CORE_MODEL_OR_UTIL = "\\.\\./(?:model|util)/(?!.*\\.\\.)";
const OTHER_MODULE_VIEW = "\\.\\./[a-z-]+/view\\.ts$";

// SPEC-QUESTION: section 1's table does not list core/util among what a module may import, but
// section 10 makes core/util/protocol-safe.ts the only way to the protocol's throwing functions;
// modules may import core/util.
const coreModuleImports = onlyFrom(
  "core-import",
  "A core module may import @hsn/protocol, neverthrow, core/model, core/util, its own folder and other modules' view.ts (section 1).",
  [PROTOCOL, NEVERTHROW, OWN_FOLDER, CORE_MODEL_OR_UTIL, OTHER_MODULE_VIEW],
);
const coreTopImports = onlyFrom(
  "core-import",
  "core/step.ts may import @hsn/protocol, neverthrow, core/model, core/util and the modules' own files (section 1).",
  [
    PROTOCOL,
    NEVERTHROW,
    "\\./(?:model|util)/(?!.*\\.\\.)",
    "\\./[a-z-]+/(?:state|handle|view|deadlines)\\.ts$",
  ],
);
const MODULE_STATE = "\\.\\./[a-z-]+/state\\.ts$";
const CONTROL_PROTOCOL_FROM_MODEL = "\\.\\./\\.\\./control-protocol/index\\.ts$";
const modelImports = onlyFrom(
  "core-import",
  "core/model may import @hsn/protocol, neverthrow, its own files, and types from the modules' state.ts and control-protocol (section 1).",
  [PROTOCOL, NEVERTHROW, OWN_FOLDER, MODULE_STATE, CONTROL_PROTOCOL_FROM_MODEL],
);
const modelTypeOnly = {
  regex: `^(?:${MODULE_STATE}|${CONTROL_PROTOCOL_FROM_MODEL})`,
  allowTypeImports: true,
  message: "[core-model-types] core/model takes only types from the modules and control-protocol.",
};
const utilImports = onlyFrom(
  "core-import",
  "core/util may import @hsn/protocol, neverthrow, core/model and its own files (section 1).",
  [PROTOCOL, NEVERTHROW, OWN_FOLDER, "\\.\\./model/(?!.*\\.\\.)"],
);

/**
 * @param {object[]} patterns
 * @param {{ throwing?: boolean }} [options]
 */
const coreImportRule = (patterns, { throwing = true } = {}) => [
  "error",
  { paths: [impureProtocol], patterns: throwing ? [throwingProtocol, ...patterns] : patterns },
];

const FORBIDDEN_IN_CORE = /** @type {const} */ ([
  ["Date", "time comes from the input's `now` (section 2)"],
  ["setTimeout", "timers are data in the state (section 2)"],
  ["setInterval", "timers are data in the state (section 2)"],
  ["performance", "time comes from the input's `now` (section 2)"],
  ["process", "the core reads nothing from the process (section 1)"],
  ["Bun", "the core does not depend on the runtime (section 1)"],
  ["crypto", "randomness comes from the input's entropy, ciphers from deps (section 2)"],
  ["console", "the core records through effects (section 10)"],
  ["Temporal", "calendar arithmetic is `deps.calendar` (m2-design.md section 2)"],
  ["Intl", "the core formats nothing for people and reads no locale (m2-design.md section 2)"],
]);

/** Locale-dependent methods, which read the host's locale: none in the core (m2-design.md section 2). */
const LOCALE_METHODS = [
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "localeCompare",
];

const throwAndTry = [
  {
    selector: "ThrowStatement",
    message: "[no-throw] Our own code does not throw: return a neverthrow Result (section 10).",
  },
  {
    selector: "TryStatement",
    message:
      "[no-try] `try` lives only in shell/safe/, core/util/protocol-safe.ts and shell/main.ts (section 10).",
  },
];
const dynamicImport = {
  selector: "ImportExpression",
  message: "[core-dynamic-import] The core imports nothing at run time (section 1).",
};

export default defineConfig(
  {
    ignores: [
      "**/node_modules/",
      "docs/",
      "spikes/",
      "firmware/build*/",
      `${PROBES}/`,
      "tools/*/test/fixtures/",
      "app/dist/",
      "app/.expo/",
      "app/test-results/",
      "app/playwright-report/",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  eslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Named explicitly so a change to the shared presets cannot drop them.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },

  // The app (m2-design.md section 8): every text from the locale (HB27, D58).
  {
    files: ["app/src/**/*.tsx"],
    plugins: { hsn },
    rules: { "hsn/no-literal-text": "error" },
  },

  // React's hooks, for all of the app (section 11, "Step 1, wave 2"): `eslint-plugin-react-hooks`
  // 7.1.1, pinned, the first release whose peer range takes ESLint 10.
  {
    files: ["app/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },

  // The app styles with class names from the theme (NativeWind v5, docs/app-design.md), never
  // `StyleSheet` (section 11, wave 2: the product owner's choice). Its probe mirrors app/src.
  {
    files: ["app/src/**/*.{ts,tsx}", `${PROBES}/app/src/**/*.ts`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react-native",
              importNames: ["StyleSheet"],
              message:
                "Style with class names from the theme (docs/app-design.md), through the parts in app/src/ui/parts.tsx.",
            },
          ],
        },
      ],
    },
  },

  // Every Result is used (section 10).
  {
    files: ["hub/**/*.ts", "tools/**/*.ts"],
    plugins: { hsn },
    rules: { "hsn/must-use-result": "error" },
  },

  // No `throw` and no `try` anywhere in the hub ...
  {
    files: ["hub/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...throwAndTry] },
  },

  // The core: no clocks, timers, process, runtime, crypto or console, no Math.random, no
  // dynamic import, and imports by the table of section 1.
  {
    files: hubAndProbes("src/core/**/*.ts"),
    rules: {
      "no-restricted-globals": [
        "error",
        ...FORBIDDEN_IN_CORE.map(([name, why]) => ({
          name,
          message: `[core-global] ${name}: ${why}.`,
        })),
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "[core-random] Randomness comes from the input's entropy (section 2).",
        },
        ...LOCALE_METHODS.map((property) => ({
          property,
          message: `[core-locale] ${property} reads the host's locale: the core's output is the same on every computer (m2-design.md section 2).`,
        })),
      ],
      "no-restricted-syntax": ["error", ...throwAndTry, dynamicImport],
    },
  },
  {
    files: hubAndProbes("src/core/*/**/*.ts"),
    ignores: hubAndProbes("src/core/model/**", "src/core/util/**"),
    rules: { "no-restricted-imports": coreImportRule([coreModuleImports]) },
  },
  {
    files: hubAndProbes("src/core/*.ts"),
    rules: { "no-restricted-imports": coreImportRule([coreTopImports]) },
  },
  {
    files: hubAndProbes("src/core/model/**/*.ts"),
    rules: { "no-restricted-imports": coreImportRule([modelImports, modelTypeOnly]) },
  },
  {
    files: hubAndProbes("src/core/util/**/*.ts"),
    rules: { "no-restricted-imports": coreImportRule([utilImports]) },
  },
  // ... except the one file that wraps the protocol's throwing functions.
  {
    files: hubAndProbes("src/core/util/protocol-safe.ts"),
    rules: {
      "no-restricted-imports": coreImportRule([utilImports], { throwing: false }),
      "no-restricted-syntax": ["error", dynamicImport],
    },
  },

  // Ports: interfaces over the core's model only (section 1). SPEC-QUESTION: they return
  // neverthrow results (section 3), which section 1's table does not allow them to import; they
  // may take neverthrow's types, and only its types.
  {
    files: hubAndProbes("src/ports/**/*.ts"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            onlyFrom(
              "ports-import",
              "Ports may import only core/model, their own files and neverthrow's types (section 1).",
              [OWN_FOLDER, "\\.\\./core/model/(?!.*\\.\\.)", NEVERTHROW],
            ),
            {
              group: ["neverthrow"],
              allowTypeImports: true,
              message: "[ports-types] Ports take only types from neverthrow.",
            },
          ],
        },
      ],
    },
  },

  // The database schema: Drizzle only (section 1).
  {
    files: hubAndProbes("src/db/**/*.ts"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            onlyFrom(
              "db-import",
              "db/ may import only drizzle-orm and its own files (section 1).",
              [OWN_FOLDER, "drizzle-orm(?:/|$)"],
            ),
          ],
        },
      ],
    },
  },

  // The control protocol: Zod only (section 1).
  {
    files: hubAndProbes("src/control-protocol/**/*.ts"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            onlyFrom(
              "control-protocol-import",
              "control-protocol/ may import only zod, its own files, @hsn/protocol/app and @hsn/protocol/records (section 1; m2-design.md section 6).",
              [OWN_FOLDER, "zod$", "@hsn/protocol/app$", "@hsn/protocol/records$"],
            ),
          ],
        },
      ],
    },
  },

  // The CLI: the control protocol, @hsn/protocol and node:net (section 1). SPEC-QUESTION: also
  // neverthrow, since section 10 has every part of hub/ return results and never throw.
  {
    files: hubAndProbes("cli/**/*.ts"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            onlyFrom(
              "cli-import",
              "The CLI may import control-protocol, @hsn/protocol, node:net and neverthrow, never core, shell or db (section 1), but the shell's two Windows files for hsn (section 9).",
              [
                OWN_FOLDER,
                "\\.\\./src/control-protocol/(?!.*\\.\\.)",
                "^\\.\\./src/shell/safe/control-socket-(peer|hsn)\\.ts$",
                PROTOCOL,
                "node:net$",
                NEVERTHROW,
              ],
            ),
          ],
        },
      ],
    },
  },
  // ... and, for the commands that carry a file (m2-design.md section 6), `files.ts` reads and
  // writes the user's file (node:fs, node:crypto) and `qr.ts` draws the restore's code (toqr);
  // `named-files.ts` opens a named file without following links, `elevated.ts` drops root and
  // reads the ids, `file-helper.ts` is the person's helper (section 9, "The privilege boundary").
  // The rest of the CLI still never touches a file, so it cannot open the database.
  {
    files: hubAndProbes(
      "cli/files.ts",
      "cli/qr.ts",
      "cli/named-files.ts",
      "cli/elevated.ts",
      "cli/file-helper.ts",
      "cli/windows-files.ts",
    ),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            onlyFrom(
              "cli-import",
              "cli/files.ts, cli/qr.ts and the named-file and elevation files may import as the CLI does, and node:fs, node:crypto, node:path and toqr (m2-design.md sections 6 and 9).",
              [
                OWN_FOLDER,
                "\\.\\./src/control-protocol/(?!.*\\.\\.)",
                PROTOCOL,
                "node:fs$",
                "node:crypto$",
                "node:path$",
                "^\\.\\./src/shell/safe/control-socket-hsn\\.ts$",
                "toqr$",
                NEVERTHROW,
              ],
            ),
          ],
        },
      ],
    },
  },

  // Where `try` and `throw` may appear (section 10).
  {
    files: hubAndProbes("src/shell/safe/**/*.ts", "src/shell/main.ts"),
    rules: { "no-restricted-syntax": "off" },
  },
);
