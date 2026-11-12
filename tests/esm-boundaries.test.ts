/**
 * Architectural ESM dependency-graph and leaf-import boundary tests (`src/*.ts`):
 * 1. Pure policy/transform modules never transitively import runtime I/O adapters or Node I/O built-ins.
 * 2. Internal `src/*.ts` imports and compat re-exports always point directly at the canonical defining leaf module
 *    (never through barrel re-exports or multi-hop re-export chains).
 * 3. Preserved compatibility re-exports maintain exact referential identity (`===`) with their leaf definitions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

const FORBIDDEN_IO_MODULES = new Set([
  "auth-lock.ts",
  "authorize-browser.ts",
  "authorize-flow.ts",
  "callback-server.ts",
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
  "session-lifecycle.ts",
  "stdio-process.ts",
  "tool-bridge.ts",
  "transport-factory.ts",
  "transport-order.ts",
]);

interface ModuleGraphEntry {
  runtimeRelativeDeps: Set<string>;
  nodeBuiltinRuntimeDeps: Set<string>;
  /** Exported name -> source `.ts` file for bindings re-exported from another `./*.js` module. */
  reExportedFrom: Map<string, string>;
  /** Specifiers imported or re-exported from `./*.js`: `{ targetFile, importedName, isTypeOnly }`. */
  relativeBindings: Array<{
    targetFile: string;
    importedName: string;
    kind: "import" | "re-export";
  }>;
}

function toTsFilename(specifier: string): string | null {
  if (!specifier.startsWith("./") || !specifier.endsWith(".js")) return null;
  return `${specifier.slice(2, -3)}.ts`;
}

function parseSrcGraph(): Map<string, ModuleGraphEntry> {
  const files = readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  const graph = new Map<string, ModuleGraphEntry>();

  for (const file of files) {
    const code = readFileSync(join(srcDir, file), "utf8");
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const runtimeRelativeDeps = new Set<string>();
    const nodeBuiltinRuntimeDeps = new Set<string>();
    const localImportedFrom = new Map<string, string>();
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

        if (spec.startsWith("node:") && hasRuntimeBinding) {
          nodeBuiltinRuntimeDeps.add(spec);
        }

        const targetTs = toTsFilename(spec);
        if (targetTs) {
          if (hasRuntimeBinding) {
            runtimeRelativeDeps.add(targetTs);
          }
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              const importedName = (el.propertyName ?? el.name).text;
              localImportedFrom.set(el.name.text, targetTs);
              relativeBindings.push({
                targetFile: targetTs,
                importedName,
                kind: "import",
              });
            }
          }
        }
      } else if (ts.isExportDeclaration(stmt)) {
        const isStmtTypeOnly = stmt.isTypeOnly;
        if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const spec = stmt.moduleSpecifier.text;
          const targetTs = toTsFilename(spec);
          if (targetTs && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
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
        } else if (!stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            const localName = (el.propertyName ?? el.name).text;
            const exportedName = el.name.text;
            const originTs = localImportedFrom.get(localName);
            if (originTs) {
              reExportedFrom.set(exportedName, originTs);
            }
          }
        }
      }
    }

    graph.set(file, {
      runtimeRelativeDeps,
      nodeBuiltinRuntimeDeps,
      reExportedFrom,
      relativeBindings,
    });
  }

  return graph;
}

describe("ESM dependency boundaries and leaf imports", () => {
  const graph = parseSrcGraph();

  it("keeps every pure policy/transform module free of transitive runtime I/O imports", () => {
    for (const pureFile of PURE_MODULES) {
      assert.ok(graph.has(pureFile), `missing expected pure module src/${pureFile}`);

      const visited = new Set<string>();
      const queue: Array<{ file: string; chain: string[] }> = [{ file: pureFile, chain: [pureFile] }];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.file)) continue;
        visited.add(current.file);

        const entry = graph.get(current.file);
        assert.ok(entry, `unknown module in src/: ${current.file}`);

        for (const builtin of entry.nodeBuiltinRuntimeDeps) {
          // Only deterministic SHA-256 hashing (`node:crypto`) in tool-names.ts is permitted in pure modules.
          const allowedCrypto = current.file === "tool-names.ts" && builtin === "node:crypto";
          assert.ok(
            allowedCrypto,
            `pure module ${pureFile} transitively imports Node built-in "${builtin}" via ${current.chain.join(" -> ")}`,
          );
        }

        for (const dep of entry.runtimeRelativeDeps) {
          const nextChain = [...current.chain, dep];
          assert.ok(
            !FORBIDDEN_IO_MODULES.has(dep),
            `pure module ${pureFile} transitively imports runtime I/O module "${dep}" via ${nextChain.join(" -> ")}`,
          );
          queue.push({ file: dep, chain: nextChain });
        }
      }
    }
  });

  it("points all internal src/*.ts imports and compat re-exports directly at canonical leaf modules", () => {
    const violations: string[] = [];

    for (const [file, entry] of graph) {
      for (const binding of entry.relativeBindings) {
        const target = graph.get(binding.targetFile);
        assert.ok(target, `${file} references non-existent src/${binding.targetFile}`);
        const leafOrigin = target.reExportedFrom.get(binding.importedName);
        if (leafOrigin) {
          violations.push(
            `src/${file} (${binding.kind}) pulls "${binding.importedName}" from barrel "./${binding.targetFile.replace(/\.ts$/, ".js")}" instead of leaf "./${leafOrigin.replace(/\.ts$/, ".js")}"`,
          );
        }
      }
    }

    assert.deepEqual(violations, []);
  });

  it("preserves referential identity (===) on backwards-compatible re-exports", async () => {
    const errors = await import("../src/errors.js");
    const authLock = await import("../src/auth-lock.js");
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

    assert.equal(authLock.AuthRequiredError, errors.AuthRequiredError);
    assert.equal(authLock.AuthLockError, errors.AuthLockError);
    assert.equal(oauthProvider.AuthRequiredError, errors.AuthRequiredError);
    assert.equal(oauthProvider.AuthLockError, errors.AuthLockError);

    assert.equal(oauthStateStore.canonicalServerUrl, oauthPolicy.canonicalServerUrl);
    assert.equal(oauthStateStore.urlsMatch, oauthPolicy.urlsMatch);
    assert.equal(
      oauthStateStore.isResourceCompatibleWithServerUrl,
      oauthPolicy.isResourceCompatibleWithServerUrl,
    );

    assert.equal(oauthProvider.getAuthStatus, oauthStatus.getAuthStatus);
    assert.equal(oauthProvider.resetAuth, oauthStatus.resetAuth);
    assert.equal(oauthProvider.invalidateStoredTokens, oauthStatus.invalidateStoredTokens);

    assert.equal(debugLog.describeError, debugLogFormat.describeError);
    assert.equal(debugLog.sanitizeLogText, debugLogFormat.sanitizeLogText);
    assert.equal(debugLog.redactSecrets, secretRedaction.redactSecrets);

    assert.equal(coordinator.formatErrorMessage, startupAuth.formatErrorMessage);
    assert.equal(coordinator.startupAuthNowOption, startupAuth.startupAuthNowOption);
    assert.equal(entry.startupAuthNowOption, startupAuth.startupAuthNowOption);
    assert.equal(entry.startupAuthLaterOption, startupAuth.startupAuthLaterOption);

    assert.equal(
      callbackServer.callbackServerConfigFromRedirectUrl,
      callbackUrl.callbackServerConfigFromRedirectUrl,
    );
    assert.equal(callbackServer.CALLBACK_PATH, callbackUrl.CALLBACK_PATH);

    assert.equal(commands.collectRegisteredServers, sessionLifecycle.collectRegisteredServers);
    assert.equal(commands.mergeWithRegisteredServers, sessionLifecycle.mergeWithRegisteredServers);
  });
});
