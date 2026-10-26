import js from "@eslint/js";
import tseslint from "typescript-eslint";

function getEnclosingIdentifierName(node) {
  let curr = node;
  let parent = curr.parent;
  while (
    parent &&
    (parent.type === "TSAsExpression" ||
      parent.type === "TSTypeAssertion" ||
      parent.type === "TSNonNullExpression")
  ) {
    curr = parent;
    parent = curr.parent;
  }
  if (!parent) return undefined;
  if (parent.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name;
  }
  if (parent.type === "MethodDefinition" || parent.type === "Property") {
    if (parent.key?.type === "Identifier") return parent.key.name;
    if (parent.key?.type === "PrivateIdentifier") return `#${parent.key.name}`;
    if (parent.key?.type === "Literal") return String(parent.key.value);
  }
  if (parent.type === "PropertyDefinition") {
    if (parent.key?.type === "Identifier") return parent.key.name;
    if (parent.key?.type === "PrivateIdentifier") return `#${parent.key.name}`;
  }
  if (parent.type === "AssignmentExpression") {
    if (parent.left?.type === "Identifier") return parent.left.name;
    if (parent.left?.type === "MemberExpression" && parent.left.property?.type === "Identifier") {
      return parent.left.property.name;
    }
  }
  if (parent.type === "ExportDefaultDeclaration") {
    return "<default export>";
  }
  return undefined;
}

function getFunctionName(node) {
  if (node.id?.name) {
    return node.id.name;
  }
  const enclosingName = getEnclosingIdentifierName(node);
  if (enclosingName) {
    return enclosingName;
  }
  return "<anonymous>";
}

export const CONTROL_FLOW_NODE =
  ":matches(IfStatement:not(IfStatement > IfStatement.alternate), ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement, SwitchStatement, TryStatement, ConditionalExpression)";

export const MAX_CONTROL_FLOW_DEPTH_SELECTOR = Array.from(
  { length: 5 },
  () => CONTROL_FLOW_NODE,
).join(" ");

const COGNITIVE_CONTROL_NODES = [
  "IfStatement",
  "SwitchStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "ConditionalExpression",
];

const COGNITIVE_FUNCTION_NODES = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
];

function isElseIfStatement(node) {
  const parent = node.parent;
  return parent?.type === "IfStatement" && parent.alternate === node;
}

function hasFinalElseClause(node) {
  return node.alternate !== null && node.alternate !== undefined && node.alternate.type !== "IfStatement";
}

function isSameOperatorSequenceMember(node) {
  const parent = node.parent;
  return parent?.type === "LogicalExpression" && parent.operator === node.operator;
}

function calledName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier") {
    return callee.property.name;
  }
  return undefined;
}

/**
 * Cognitive complexity in the style Qlty's `function_complexity` smell reports: control-flow
 * structures cost `1 + nestingDepth`, `else`/`else if` branches add 1 without deepening nesting,
 * each contiguous run of identical `&&` / `||` / `??` operators adds 1, and direct recursion adds
 * 1. Nested closures deepen nesting and roll their own complexity up into the enclosing function,
 * so a helper that only exists to dodge the limit does not hide the complexity.
 */
export const maxCognitiveComplexityRule = {
  meta: {
    type: "suggestion",
    schema: [
      {
        type: "object",
        properties: { max: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
    ],
    messages: {
      tooComplex:
        "Function '{{name}}' has cognitive complexity {{count}}, above the maximum of {{max}}. Extract nested branches, loops, and inline callbacks into named helper functions.",
    },
  },
  create(context) {
    const max = context.options[0]?.max ?? 15;
    const frames = [];

    function currentFrame() {
      return frames[frames.length - 1];
    }

    function enterFunction(node) {
      const parent = currentFrame();
      frames.push({
        node,
        name: getFunctionName(node),
        score: 0,
        depth: parent ? parent.depth + 1 : 0,
      });
    }

    function exitFunction() {
      const frame = frames.pop();
      if (!frame) return;
      const parent = currentFrame();
      if (parent) {
        parent.score += frame.score;
        return;
      }
      // WHY: Qlty attributes a nested closure's complexity to its enclosing function and does not
      // report anonymous/default-exported functions at all; skip them here too so `npm run lint`
      // and `qlty:function-complexity` agree, instead of failing the extension entry point that
      // Qlty never flags.
      if (frame.name === "<anonymous>" || frame.name === "<default export>") return;
      if (frame.score > max) {
        context.report({
          node: frame.node,
          messageId: "tooComplex",
          data: {
            name: frame.name,
            count: String(frame.score),
            max: String(max),
          },
        });
      }
    }

    function enterControlFlow(node) {
      const frame = currentFrame();
      if (!frame) return;
      if (isElseIfStatement(node)) {
        frame.score += 1;
        return;
      }
      frame.score += 1 + frame.depth;
      if (node.type === "IfStatement" && hasFinalElseClause(node)) {
        frame.score += 1;
      }
      frame.depth += 1;
    }

    function exitControlFlow(node) {
      const frame = currentFrame();
      if (!frame || isElseIfStatement(node)) return;
      frame.depth -= 1;
    }

    const visitors = {
      "FunctionDeclaration:exit": exitFunction,
      "FunctionExpression:exit": exitFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      LogicalExpression(node) {
        const frame = currentFrame();
        if (!frame || isSameOperatorSequenceMember(node)) return;
        frame.score += 1;
      },
      CallExpression(node) {
        const frame = currentFrame();
        if (!frame) return;
        if (calledName(node.callee) === frame.name) {
          frame.score += 1;
        }
      },
    };

    for (const type of COGNITIVE_FUNCTION_NODES) {
      visitors[type] = enterFunction;
    }

    for (const type of COGNITIVE_CONTROL_NODES) {
      visitors[type] = enterControlFlow;
      visitors[`${type}:exit`] = exitControlFlow;
    }

    return visitors;
  },
};

export const maxReturnStatementsRule = {
  meta: {
    type: "suggestion",
    schema: [
      {
        type: "object",
        properties: { max: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
    ],
    messages: {
      tooMany:
        "Function '{{name}}' has too many return statements ({{count}}). Maximum allowed is {{max}}. Extract cohesive helper functions or named handlers instead of accumulating branches or inline callbacks.",
    },
  },
  create(context) {
    const max = context.options[0]?.max ?? 4;
    const stack = [];
    function enterFunction(node) {
      stack.push({ node, directReturns: 0, totalReturns: 0 });
    }
    function exitFunction(node) {
      const current = stack.pop();
      if (!current) return;
      if (stack.length > 0) {
        stack[stack.length - 1].totalReturns += current.totalReturns;
        if (current.directReturns > max) {
          context.report({
            node,
            messageId: "tooMany",
            data: {
              name: getFunctionName(node),
              count: String(current.directReturns),
              max: String(max),
            },
          });
        }
      } else if (current.totalReturns > max) {
        context.report({
          node,
          messageId: "tooMany",
          data: {
            name: getFunctionName(node),
            count: String(current.totalReturns),
            max: String(max),
          },
        });
      }
    }
    return {
      FunctionDeclaration: enterFunction,
      FunctionExpression: enterFunction,
      ArrowFunctionExpression: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      "FunctionExpression:exit": exitFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      ReturnStatement() {
        if (stack.length > 0) {
          stack[stack.length - 1].directReturns += 1;
          stack[stack.length - 1].totalReturns += 1;
        }
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: ["node_modules/**", ".semgrep/**"],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: [
                "test",
                "it",
                "describe",
                "suite",
                "subtest",
                "before",
                "after",
                "beforeEach",
                "afterEach",
              ],
            },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/only-throw-error": "error",
      // WHY: Forwarding an already-caught rejection (typed unknown) must not rewrap it, which would change error identity.
      "@typescript-eslint/prefer-promise-reject-errors": [
        "error",
        { allowThrowingUnknown: true },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-empty-function": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "max-depth": ["error", 4],
      "no-restricted-syntax": [
        "error",
        {
          selector: MAX_CONTROL_FLOW_DEPTH_SELECTOR,
          message:
            "Control flow is nested too deeply (level >= 5). Decompose into focused helper functions or flatten branches with early returns.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: {
      "pi-mcp": {
        rules: {
          "max-return-statements": maxReturnStatementsRule,
          "max-cognitive-complexity": maxCognitiveComplexityRule,
        },
      },
    },
    rules: {
      "no-console": ["error", { allow: ["error"] }],
      "pi-mcp/max-return-statements": ["error", { max: 4 }],
      "pi-mcp/max-cognitive-complexity": ["error", { max: 15 }],
      complexity: ["error", { max: 15 }],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
