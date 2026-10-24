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
    files: ["src/**/*.ts"],
    plugins: {
      "pi-mcp": {
        rules: {
          "max-return-statements": maxReturnStatementsRule,
        },
      },
    },
    rules: {
      "no-console": ["error", { allow: ["error"] }],
      "pi-mcp/max-return-statements": ["error", { max: 4 }],
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
