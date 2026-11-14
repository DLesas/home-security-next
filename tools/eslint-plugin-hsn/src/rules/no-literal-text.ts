/**
 * `hsn/no-literal-text` (m2-design.md section 8, "Accessibility and translation"; HB27, D58):
 * every text the app shows comes from i18next keys in `app/locales/`, never from the components.
 * Flagged in JSX: a text child with any letter in it, a string literal or template child, and a
 * string literal given to a prop people read (`title`, `label`, `placeholder`, the accessibility
 * labels and hints, `alt`). Not flagged: whitespace and punctuation alone, `{t("key")}`, any other
 * prop (`testID`, `href`, `role`, styles). An existing plugin was not taken: none found that
 * supports ESLint 10, as the design allowed for.
 */
import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(() => "docs/m2-design.md#accessibility-and-translation");

/** The props whose value a person reads or hears. */
const READ_PROPS: ReadonlySet<string> = new Set([
  "title",
  "label",
  "placeholder",
  "alt",
  "accessibilityLabel",
  "accessibilityHint",
  "aria-label",
  "aria-description",
  "aria-placeholder",
]);

/** Any letter, in any script: text a translator would translate. */
const LETTER = /\p{L}/u;

function propName(node: TSESTree.JSXAttribute): string {
  return node.name.type === AST_NODE_TYPES.JSXNamespacedName
    ? `${node.name.namespace.name}:${node.name.name.name}`
    : node.name.name;
}

export const noLiteralText = createRule({
  name: "no-literal-text",
  meta: {
    type: "problem",
    docs: { description: "Text the app shows comes from i18next keys, never from components." },
    schema: [],
    messages: {
      literal:
        'Text is shown through t("<key>") with the English in app/locales/en/ (HB27, m2-design.md section 8).',
    },
    defaultOptions: [],
  },
  create(context) {
    const report = (node: TSESTree.Node): void => {
      context.report({ node, messageId: "literal" });
    };
    const isText = (value: string): boolean => LETTER.test(value);
    return {
      JSXText(node) {
        if (isText(node.value)) report(node);
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === AST_NODE_TYPES.JSXAttribute) return;
        const e = node.expression;
        if (e.type === AST_NODE_TYPES.Literal && typeof e.value === "string" && isText(e.value))
          report(e);
        if (e.type === AST_NODE_TYPES.TemplateLiteral && e.quasis.some((q) => isText(q.value.raw)))
          report(e);
      },
      JSXAttribute(node) {
        if (!READ_PROPS.has(propName(node)) || node.value === null) return;
        const value = node.value;
        if (
          value.type === AST_NODE_TYPES.Literal &&
          typeof value.value === "string" &&
          isText(value.value)
        ) {
          report(value);
        }
        if (value.type === AST_NODE_TYPES.JSXExpressionContainer) {
          const e = value.expression;
          if (e.type === AST_NODE_TYPES.Literal && typeof e.value === "string" && isText(e.value))
            report(e);
          if (
            e.type === AST_NODE_TYPES.TemplateLiteral &&
            e.quasis.some((q) => isText(q.value.raw))
          )
            report(e);
        }
      },
    };
  },
});
