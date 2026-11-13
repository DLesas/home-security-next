/**
 * `hsn/must-use-result` (hub-design.md section 10, "The rule that every result is used"): a
 * neverthrow `Result`, `Ok`, `Err` or `ResultAsync`, the protocol package's `Result`, or a
 * `Promise` of any of these, must not be dropped.
 *
 * Flagged, when the value's type is or contains one of them: an expression statement (a call,
 * `await x;`, an optional call `a?.b();`, `r.map(f);`), the operand of `void`, any but the
 * last operand of a comma expression, and the concise body of an arrow function whose
 * contextual return type is `void` (`items.forEach((i) => save(i))`). Not flagged: a value
 * returned, assigned, declared, passed, put in a literal, tested, or consumed by a method
 * (`match`, `isOk`), since all of those use it; `noUnusedLocals` catches a variable never read.
 */
import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

/** Where each rule is specified: a path inside this repository, from its root. */
const RULE_DOCS: Readonly<Record<string, string>> = {
  "must-use-result": "docs/hub-design.md#the-rule-that-every-result-is-used",
};

const createRule = ESLintUtils.RuleCreator((name) => RULE_DOCS[name] ?? "docs/hub-design.md");

/** neverthrow's result types, matched by name and by being declared inside the package. */
const NEVERTHROW_NAMES: ReadonlySet<string> = new Set(["Result", "Ok", "Err", "ResultAsync"]);
const NEVERTHROW_FILE =
  /[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?neverthrow[\\/]/;
/** The protocol package's `Result`, in its source or through the workspace link. */
const PROTOCOL_RESULT_FILE = /(?:packages[\\/]protocol|@hsn[\\/]protocol)[\\/]src[\\/]result\.ts$/;

function declaredIn(symbol: ts.Symbol | undefined, file: RegExp): boolean {
  return (symbol?.declarations ?? []).some((d) => file.test(d.getSourceFile().fileName));
}

/** True when `type` is one of the result types, or a union or Promise holding one. */
function isResultType(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (depth > 5) return false;
  const alias = type.aliasSymbol;
  if (alias !== undefined) {
    if (NEVERTHROW_NAMES.has(alias.name) && declaredIn(alias, NEVERTHROW_FILE)) return true;
    if (alias.name === "Result" && declaredIn(alias, PROTOCOL_RESULT_FILE)) return true;
  }
  const symbol = type.getSymbol();
  if (
    symbol !== undefined &&
    NEVERTHROW_NAMES.has(symbol.name) &&
    declaredIn(symbol, NEVERTHROW_FILE)
  ) {
    return true;
  }
  if (type.isUnion()) return type.types.some((member) => isResultType(checker, member, depth + 1));
  if (symbol?.name === "Promise") {
    const awaited = checker.getAwaitedType(type);
    return awaited !== undefined && awaited !== type && isResultType(checker, awaited, depth + 1);
  }
  return false;
}

export const mustUseResult = createRule({
  name: "must-use-result",
  meta: {
    type: "problem",
    docs: { description: "Require every neverthrow or protocol Result to be used." },
    messages: {
      unused:
        "This Result is dropped: handle it (match, isOk, map then use the result), return it or pass it on.",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function check(node: TSESTree.Node): void {
      if (isResultType(checker, services.getTypeAtLocation(node))) {
        context.report({ node, messageId: "unused" });
      }
    }

    /** True when the arrow's contextual type returns `void`, so a concise body is thrown away. */
    function returnsVoidByContext(arrow: TSESTree.ArrowFunctionExpression): boolean {
      const tsNode = services.esTreeNodeToTSNodeMap.get(arrow);
      const contextual = checker.getContextualType(tsNode);
      if (contextual === undefined) return false;
      return contextual
        .getCallSignatures()
        .some((signature) => (signature.getReturnType().flags & ts.TypeFlags.Void) !== 0);
    }

    return {
      ExpressionStatement(node) {
        // An assignment uses its value; `void x` is checked through its operand.
        const { expression } = node;
        if (expression.type === AST_NODE_TYPES.AssignmentExpression) return;
        if (expression.type === AST_NODE_TYPES.UnaryExpression && expression.operator === "void") {
          return;
        }
        check(expression);
      },
      UnaryExpression(node) {
        if (node.operator === "void") check(node.argument);
      },
      SequenceExpression(node) {
        for (const operand of node.expressions.slice(0, -1)) check(operand);
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== AST_NODE_TYPES.BlockStatement && returnsVoidByContext(node)) {
          check(node.body);
        }
      },
    };
  },
});
