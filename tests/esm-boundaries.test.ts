/**
 * Architectural ESM dependency-graph and leaf-import boundary tests (`src/*.ts`):
 * 1. Every `src/*.ts` file is explicitly partitioned into either `PURE_MODULES` or `RUNTIME_MODULES`,
 *    and pure policy/transform modules never transitively runtime-import `RUNTIME_MODULES`, bare or
 *    `node:` Node I/O built-ins, or computed dynamic imports.
 * 2. Internal `src/*.ts` imports and compat re-exports always point directly at the canonical defining leaf module
 *    (never through barrel re-exports, wildcard `export *`, or multi-hop re-export chains).
 * 3. Preserved compatibility re-exports maintain exact referential identity (`===`) with their leaf definitions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import ts from "typescript";

const srcDir = join(import.meta.dirname, "..", "src");

const PURE_MODULES = [
  "auth-lock-policy.ts",
  "callback-url.ts",
  "config-compat.ts",
  "connect-policy.ts",
  "debug-log-format.ts",
  "errors.ts",
  "jsonc.ts",
  "oauth-policy.ts",
  "schema-allof.ts",
  "schema-convert.ts",
  "schema-refs.ts",
  "secret-redaction.ts",
  "server-provenance.ts",
  "terminal-text.ts",
  "tool-names.ts",
  "tool-order.ts",
] as const;

const RUNTIME_MODULES = [
  "auth-challenge.ts",
  "auth-lock.ts",
  "authorize-browser.ts",
  "authorize-dialog.ts",
  "authorize-flow.ts",
  "callback-server.ts",
  "commands.ts",
  "config.ts",
  "connection-coordinator.ts",
  "debug-log.ts",
  "index.ts",
  "mcp-client.ts",
  "oauth-provider.ts",
  "oauth-state-store.ts",
  "oauth-status.ts",
  "register-commands.ts",
  "register-tools.ts",
  "resource-bridge.ts",
  "server-manager.ts",
  "server-status.ts",
  "session-lifecycle.ts",
  "startup-auth.ts",
  "stdio-process.ts",
  "tool-bridge.ts",
  "tool-content.ts",
  "tool-discovery.ts",
  "transport-factory.ts",
  "transport-order.ts",
] as const;

const BARE_NODE_BUILTINS = new Set(
  builtinModules.map((mod) => (mod.startsWith("node:") ? mod.slice(5) : mod)),
);

function normalizeNodeBuiltin(specifier: string): string | null {
  if (specifier.startsWith("node:")) return specifier;
  return BARE_NODE_BUILTINS.has(specifier) ? `node:${specifier}` : null;
}

function toTsFilename(specifier: string): string | null {
  if (!specifier.startsWith("./") || !specifier.endsWith(".js")) return null;
  return `${specifier.slice(2, -3)}.ts`;
}

interface ModuleGraphEntry {
  runtimeRelativeDeps: Set<string>;
  nodeBuiltinRuntimeDeps: Set<string>;
  hasComputedDynamicImport: boolean;
  wildcardReExports: Set<string>;
  /** Exported name -> source `.ts` file for bindings re-exported from another `./*.js` module. */
  reExportedFrom: Map<string, string>;
  /** Specifiers imported or re-exported from `./*.js`. */
  relativeBindings: Array<{
    targetFile: string;
    importedName: string;
    kind: "import" | "re-export";
  }>;
}

function parseModuleSource(file: string, code: string): ModuleGraphEntry {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const runtimeRelativeDeps = new Set<string>();
  const nodeBuiltinRuntimeDeps = new Set<string>();
  let hasComputedDynamicImport = false;
  const wildcardReExports = new Set<string>();
  const localImportedFrom = new Map<string, { targetFile: string; importedName: string }>();
  const reExportedFrom = new Map<string, string>();
  const relativeBindings: ModuleGraphEntry["relativeBindings"] = [];

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      const isStmtTypeOnly = Boolean(clause?.isTypeOnly);

      let hasRuntimeBinding = clause === undefined;
      if (clause && !isStmtTypeOnly) {
        if (clause.name) hasRuntimeBinding = true;
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            hasRuntimeBinding = true;
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if (!el.isTypeOnly) hasRuntimeBinding = true;
            }
          }
        }
      }

      const builtin = normalizeNodeBuiltin(spec);
      if (builtin && hasRuntimeBinding) {
        nodeBuiltinRuntimeDeps.add(builtin);
      }

      const targetTs = toTsFilename(spec);
      if (targetTs) {
        if (hasRuntimeBinding) {
          runtimeRelativeDeps.add(targetTs);
        }
        if (clause?.name) {
          localImportedFrom.set(clause.name.text, { targetFile: targetTs, importedName: "default" });
          relativeBindings.push({
            targetFile: targetTs,
            importedName: "default",
            kind: "import",
          });
        }
        if (clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            relativeBindings.push({
              targetFile: targetTs,
              importedName: "*",
              kind: "import",
            });
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              const importedName = (el.propertyName ?? el.name).text;
              localImportedFrom.set(el.name.text, { targetFile: targetTs, importedName });
              relativeBindings.push({
                targetFile: targetTs,
                importedName,
                kind: "import",
              });
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(stmt)) {
      const isStmtTypeOnly = stmt.isTypeOnly;
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        const builtin = normalizeNodeBuiltin(spec);
        if (builtin && !isStmtTypeOnly) {
          nodeBuiltinRuntimeDeps.add(builtin);
        }
        const targetTs = toTsFilename(spec);
        if (targetTs) {
          if (!stmt.exportClause || ts.isNamespaceExport(stmt.exportClause)) {
            wildcardReExports.add(targetTs);
            if (!isStmtTypeOnly) {
              runtimeRelativeDeps.add(targetTs);
            }
            if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
              reExportedFrom.set(stmt.exportClause.name.text, targetTs);
            }
            relativeBindings.push({
              targetFile: targetTs,
              importedName: "*",
              kind: "re-export",
            });
          } else if (ts.isNamedExports(stmt.exportClause)) {
            let hasRuntimeExport = false;
            for (const el of stmt.exportClause.elements) {
              const origName = (el.propertyName ?? el.name).text;
              const exportedName = el.name.text;
              reExportedFrom.set(exportedName, targetTs);
              relativeBindings.push({
                targetFile: targetTs,
                importedName: origName,
                kind: "re-export",
              });
              if (!isStmtTypeOnly && !el.isTypeOnly) {
                hasRuntimeExport = true;
              }
            }
            if (hasRuntimeExport) {
              runtimeRelativeDeps.add(targetTs);
            }
          }
        }
      } else if (!stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const localName = (el.propertyName ?? el.name).text;
          const exportedName = el.name.text;
          const origin = localImportedFrom.get(localName);
          if (origin) {
            reExportedFrom.set(exportedName, origin.targetFile);
          }
        }
      }
    } else if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      const origin = localImportedFrom.get(stmt.expression.text);
      if (origin) {
        reExportedFrom.set("default", origin.targetFile);
      }
    }
  }

  function walkDynamicImports(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const firstArg = node.arguments[0];
      if (firstArg && ts.isStringLiteralLike(firstArg)) {
        const spec = firstArg.text;
        const builtin = normalizeNodeBuiltin(spec);
        if (builtin) {
          nodeBuiltinRuntimeDeps.add(builtin);
        }
        const targetTs = toTsFilename(spec);
        if (targetTs) {
          runtimeRelativeDeps.add(targetTs);
          relativeBindings.push({
            targetFile: targetTs,
            importedName: "*",
            kind: "import",
          });
        }
      } else {
        hasComputedDynamicImport = true;
      }
    }
    ts.forEachChild(node, walkDynamicImports);
  }

  ts.forEachChild(sf, walkDynamicImports);

  return {
    runtimeRelativeDeps,
    nodeBuiltinRuntimeDeps,
    hasComputedDynamicImport,
    wildcardReExports,
    reExportedFrom,
    relativeBindings,
  };
}

function parseSrcGraph(): Map<string, ModuleGraphEntry> {
  const files = readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  const graph = new Map<string, ModuleGraphEntry>();
  for (const file of files) {
    const code = readFileSync(join(srcDir, file), "utf8");
    graph.set(file, parseModuleSource(file, code));
  }
  return graph;
}

function findPureModuleViolations(
  graph: ReadonlyMap<string, ModuleGraphEntry>,
  pureModules: readonly string[],
): string[] {
  const pureSet = new Set(pureModules);
  const violations: string[] = [];

  for (const pureFile of pureModules) {
    if (!graph.has(pureFile)) {
      violations.push(`missing expected pure module src/${pureFile}`);
      continue;
    }

    const visited = new Set<string>();
    const queue: Array<{ file: string; chain: string[] }> = [{ file: pureFile, chain: [pureFile] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.file)) continue;
      visited.add(current.file);

      const entry = graph.get(current.file);
      if (!entry) {
        violations.push(`unknown module in src/: ${current.file} (via ${current.chain.join(" -> ")})`);
        continue;
      }

      if (entry.hasComputedDynamicImport) {
        violations.push(
          `pure module ${pureFile} uses a non-literal dynamic import() via ${current.chain.join(" -> ")}`,
        );
      }

      for (const builtin of entry.nodeBuiltinRuntimeDeps) {
        // Only deterministic SHA-256 hashing (`node:crypto`) in tool-names.ts is permitted in pure modules.
        const allowedCrypto = current.file === "tool-names.ts" && builtin === "node:crypto";
        if (!allowedCrypto) {
          violations.push(
            `pure module ${pureFile} transitively imports Node built-in "${builtin}" via ${current.chain.join(" -> ")}`,
          );
        }
      }

      for (const dep of entry.runtimeRelativeDeps) {
        const nextChain = [...current.chain, dep];
        if (!pureSet.has(dep)) {
          violations.push(
            `pure module ${pureFile} transitively imports non-pure module "${dep}" via ${nextChain.join(" -> ")}`,
          );
          continue;
        }
        queue.push({ file: dep, chain: nextChain });
      }
    }
  }

  return violations;
}

function findLeafImportViolations(graph: ReadonlyMap<string, ModuleGraphEntry>): string[] {
  const violations: string[] = [];

  for (const [file, entry] of graph) {
    for (const wildcardTarget of entry.wildcardReExports) {
      violations.push(
        `src/${file} uses wildcard barrel re-export from "./${wildcardTarget.replace(/\.ts$/, ".js")}"`,
      );
    }

    for (const binding of entry.relativeBindings) {
      const target = graph.get(binding.targetFile);
      if (!target) {
        violations.push(`src/${file} references non-existent src/${binding.targetFile}`);
        continue;
      }
      if (binding.importedName === "*") {
        if (target.reExportedFrom.size > 0 || target.wildcardReExports.size > 0) {
          violations.push(
            `src/${file} (${binding.kind}) namespace-imports barrel "./${binding.targetFile.replace(/\.ts$/, ".js")}"`,
          );
        }
        continue;
      }
      const leafOrigin =
        target.reExportedFrom.get(binding.importedName) ??
        (target.wildcardReExports.size > 0 ? [...target.wildcardReExports][0] : undefined);
      if (leafOrigin) {
        violations.push(
          `src/${file} (${binding.kind}) pulls "${binding.importedName}" from barrel "./${binding.targetFile.replace(/\.ts$/, ".js")}" instead of leaf "./${leafOrigin.replace(/\.ts$/, ".js")}"`,
        );
      }
    }
  }

  return violations;
}

describe("ESM dependency boundaries and leaf imports", () => {
  const graph = parseSrcGraph();

  it("partitions every src/*.ts file into disjoint PURE_MODULES and RUNTIME_MODULES sets", () => {
    const actualFiles = readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    const pureSet = new Set<string>(PURE_MODULES);
    const runtimeSet = new Set<string>(RUNTIME_MODULES);

    const overlap = PURE_MODULES.filter((f) => runtimeSet.has(f));
    assert.deepEqual(overlap, [], "PURE_MODULES and RUNTIME_MODULES must be disjoint");

    const classified = [...new Set([...pureSet, ...runtimeSet])].sort();
    assert.deepEqual(
      classified,
      actualFiles,
      "Every src/*.ts file must be explicitly classified in either PURE_MODULES or RUNTIME_MODULES",
    );
  });

  it("keeps every pure policy/transform module free of transitive runtime or Node I/O imports", () => {
    assert.deepEqual(findPureModuleViolations(graph, PURE_MODULES), []);
  });

  it("points all internal src/*.ts imports and compat re-exports directly at canonical leaf modules", () => {
    assert.deepEqual(findLeafImportViolations(graph), []);
  });

  it("catches bare Node built-ins, non-pure relative deps, wildcard re-exports, dynamic imports, and barrel imports", () => {
    const synthetic = new Map<string, ModuleGraphEntry>([
      ["leaf.ts", parseModuleSource("leaf.ts", "export class LeafError extends Error {}")],
      [
        "barrel.ts",
        parseModuleSource("barrel.ts", 'export { LeafError } from "./leaf.js"; export const local = 1;'),
      ],
      ["runtime-io.ts", parseModuleSource("runtime-io.ts", "export async function fetchThing() {}")],
      ["pure-bare-fs.ts", parseModuleSource("pure-bare-fs.ts", 'import { readFile } from "fs/promises"; export { readFile };')],
      ["pure-nonpure-dep.ts", parseModuleSource("pure-nonpure-dep.ts", 'import { fetchThing } from "./runtime-io.js"; export { fetchThing };')],
      ["pure-star-reexport.ts", parseModuleSource("pure-star-reexport.ts", 'export * from "./runtime-io.js";')],
      ["pure-dyn-http.ts", parseModuleSource("pure-dyn-http.ts", 'export const load = () => import("http");')],
      ["pure-dyn-computed.ts", parseModuleSource("pure-dyn-computed.ts", "export const load = (p: string) => import(p);")],
      ["consumer-named.ts", parseModuleSource("consumer-named.ts", 'import { LeafError } from "./barrel.js"; export { LeafError };')],
      ["consumer-ns.ts", parseModuleSource("consumer-ns.ts", 'import * as barrel from "./barrel.js"; export { barrel };')],
    ]);

    const pureChecks = [
      ["pure-bare-fs.ts", /Node built-in "node:fs\/promises"/],
      ["pure-nonpure-dep.ts", /non-pure module "runtime-io\.ts"/],
      ["pure-star-reexport.ts", /non-pure module "runtime-io\.ts"/],
      ["pure-dyn-http.ts", /Node built-in "node:http"/],
      ["pure-dyn-computed.ts", /non-literal dynamic import\(\)/],
    ] as const;

    for (const [mod, pattern] of pureChecks) {
      const violations = findPureModuleViolations(synthetic, [mod, "leaf.ts"]);
      assert.ok(
        violations.some((v) => pattern.test(v)),
        `Expected violation matching ${String(pattern)} for ${mod}, got: ${JSON.stringify(violations)}`,
      );
    }

    const leafViolations = findLeafImportViolations(synthetic);
    assert.ok(leafViolations.some((v) => v.includes('src/pure-star-reexport.ts uses wildcard barrel re-export')));
    assert.ok(
      leafViolations.some((v) =>
        v.includes('src/consumer-named.ts (import) pulls "LeafError" from barrel "./barrel.js" instead of leaf "./leaf.js"'),
      ),
    );
    assert.ok(leafViolations.some((v) => v.includes('src/consumer-ns.ts (import) namespace-imports barrel "./barrel.js"')));
  });

  it("preserves referential identity (===) across all backwards-compatible re-exports", async () => {
    const errors = await import("../src/errors.js");
    const authLock = await import("../src/auth-lock.js");
    const authorizeBrowser = await import("../src/authorize-browser.js");
    const authorizeDialog = await import("../src/authorize-dialog.js");
    const authorizeFlow = await import("../src/authorize-flow.js");
    const oauthProvider = await import("../src/oauth-provider.js");
    const oauthPolicy = await import("../src/oauth-policy.js");
    const oauthStateStore = await import("../src/oauth-state-store.js");
    const oauthStatus = await import("../src/oauth-status.js");
    const debugLogFormat = await import("../src/debug-log-format.js");
    const secretRedaction = await import("../src/secret-redaction.js");
    const debugLog = await import("../src/debug-log.js");
    const startupAuth = await import("../src/startup-auth.js");
    const coordinator = await import("../src/connection-coordinator.js");
    const entry = await import("../src/index.js");
    const callbackUrl = await import("../src/callback-url.js");
    const callbackServer = await import("../src/callback-server.js");
    const sessionLifecycle = await import("../src/session-lifecycle.js");
    const commands = await import("../src/commands.js");
    const toolNames = await import("../src/tool-names.js");
    const toolContent = await import("../src/tool-content.js");
    const toolDiscovery = await import("../src/tool-discovery.js");
    const toolBridge = await import("../src/tool-bridge.js");

    assert.equal(authLock.AuthRequiredError, errors.AuthRequiredError);
    assert.equal(authLock.AuthLockError, errors.AuthLockError);
    assert.equal(oauthProvider.AuthRequiredError, errors.AuthRequiredError);
    assert.equal(oauthProvider.AuthLockError, errors.AuthLockError);
    assert.equal(oauthProvider.acquireAuthLock, authLock.acquireAuthLock);
    assert.equal(oauthProvider.DEFAULT_CALLBACK_PORT, oauthPolicy.DEFAULT_CALLBACK_PORT);
    assert.equal(oauthProvider.DEFAULT_REDIRECT_URL, oauthPolicy.DEFAULT_REDIRECT_URL);

    assert.equal(authorizeFlow.AuthCancelledError, errors.AuthCancelledError);
    assert.equal(authorizeFlow.openBrowser, authorizeBrowser.openBrowser);
    assert.equal(authorizeFlow.browserOpenCommand, authorizeBrowser.browserOpenCommand);
    assert.equal(authorizeFlow.waitForOAuthCallback, authorizeDialog.waitForOAuthCallback);
    assert.equal(authorizeFlow.authRetryOption, authorizeDialog.authRetryOption);
    assert.equal(authorizeFlow.authPasteOption, authorizeDialog.authPasteOption);
    assert.equal(authorizeFlow.authCancelOption, authorizeDialog.authCancelOption);

    assert.equal(oauthStateStore.canonicalServerUrl, oauthPolicy.canonicalServerUrl);
    assert.equal(oauthStateStore.urlsMatch, oauthPolicy.urlsMatch);
    assert.equal(
      oauthStateStore.isResourceCompatibleWithServerUrl,
      oauthPolicy.isResourceCompatibleWithServerUrl,
    );

    assert.equal(oauthProvider.getAuthStatus, oauthStatus.getAuthStatus);
    assert.equal(oauthProvider.resetAuth, oauthStatus.resetAuth);
    assert.equal(oauthProvider.invalidateStoredTokens, oauthStatus.invalidateStoredTokens);

    assert.equal(debugLogFormat.redactSecrets, secretRedaction.redactSecrets);
    assert.equal(debugLog.describeError, debugLogFormat.describeError);
    assert.equal(debugLog.sanitizeLogText, debugLogFormat.sanitizeLogText);
    assert.equal(debugLog.sanitizeLogFields, debugLogFormat.sanitizeLogFields);
    assert.equal(debugLog.buildLogEntry, debugLogFormat.buildLogEntry);
    assert.equal(debugLog.formatLogLine, debugLogFormat.formatLogLine);
    assert.equal(debugLog.SAFE_FIELD_NAMES, debugLogFormat.SAFE_FIELD_NAMES);
    assert.equal(debugLog.DEBUG_LOG_MAX_TEXT_LENGTH, debugLogFormat.DEBUG_LOG_MAX_TEXT_LENGTH);
    assert.equal(debugLog.DEBUG_LOG_MAX_SERVER_LENGTH, debugLogFormat.DEBUG_LOG_MAX_SERVER_LENGTH);
    assert.equal(debugLog.redactSecrets, secretRedaction.redactSecrets);

    assert.equal(coordinator.formatErrorMessage, startupAuth.formatErrorMessage);
    assert.equal(coordinator.startupAuthNowOption, startupAuth.startupAuthNowOption);
    assert.equal(coordinator.startupAuthLaterOption, startupAuth.startupAuthLaterOption);
    assert.equal(entry.startupAuthNowOption, startupAuth.startupAuthNowOption);
    assert.equal(entry.startupAuthLaterOption, startupAuth.startupAuthLaterOption);

    assert.equal(
      callbackServer.callbackServerConfigFromRedirectUrl,
      callbackUrl.callbackServerConfigFromRedirectUrl,
    );
    assert.equal(callbackServer.CALLBACK_PATH, callbackUrl.CALLBACK_PATH);
    assert.equal(callbackServer.DEFAULT_PORT, callbackUrl.DEFAULT_PORT);
    assert.equal(callbackServer.DEFAULT_HOST, callbackUrl.DEFAULT_HOST);

    assert.equal(commands.collectRegisteredServers, sessionLifecycle.collectRegisteredServers);
    assert.equal(commands.mergeWithRegisteredServers, sessionLifecycle.mergeWithRegisteredServers);

    assert.equal(toolBridge.buildToolName, toolNames.buildToolName);
    assert.equal(toolBridge.convertMcpContent, toolContent.convertMcpContent);
    assert.equal(toolBridge.listAllTools, toolDiscovery.listAllTools);
  });
});
