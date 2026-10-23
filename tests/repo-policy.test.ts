/**
 * Guards the repository policy in `.github/rulesets/default-branch.json` (issue #132):
 * `main` takes changes only through a pull request with the required checks, and the
 * release flow dispatches a workflow for every required check context.
 *
 * The ruleset file only works while the release flow produces the contexts it
 * requires: a required check that no dispatched workflow reports would leave every
 * release PR pending forever. These assertions keep the two in step without needing
 * GitHub access.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripJsonComments } from "../src/jsonc.js";
import { REQUIRED_WORKFLOWS } from "../scripts/release.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readRuleset(): unknown {
  // WHY: parse the ruleset through the same JSONC tolerator the runtime uses
  // for `mcp.json`, so a future maintainer can add `// WHY: …` style comments to
  // `.github/rulesets/default-branch.json` (mirroring the convention used
  // throughout `src/`) without breaking these tests. The functions below
  // narrow `unknown` into the rule parameters and required contexts.
  const parsed: unknown = JSON.parse(stripJsonComments(readRepoFile(".github/rulesets/default-branch.json")));
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parameters of a rule (an empty object for rules without parameters). */
function ruleParameters(ruleset: unknown, type: string): Record<string, unknown> {
  assert.ok(isRecord(ruleset), "ruleset must be a JSON object");
  const rules = ruleset["rules"];
  assert.ok(Array.isArray(rules), "ruleset must have a rules array");
  const rule = rules.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry["type"] === type);
  assert.ok(rule !== undefined, `ruleset is missing the ${type} rule`);
  const parameters = rule["parameters"];
  if (parameters === undefined) return {};
  assert.ok(isRecord(parameters), `${type} parameters must be an object`);
  return parameters;
}

/** The required check contexts, in file order. */
function requiredContexts(ruleset: unknown): string[] {
  const parameters = ruleParameters(ruleset, "required_status_checks");
  const checks = parameters["required_status_checks"];
  assert.ok(Array.isArray(checks), "required_status_checks.required_status_checks must be an array");
  return checks.map((check) => {
    assert.ok(isRecord(check), "each required status check must be an object");
    const context = check["context"];
    assert.ok(typeof context === "string", "each required status check needs a string context");
    return context;
  });
}

/**
 * Which workflow produces each required check context. `ci.yml` produces several
 * contexts, so the mapping is per context rather than per workflow.
 */
const CONTEXT_WORKFLOWS: Readonly<Record<string, string>> = {
  "check (22)": "ci.yml",
  "check (24)": "ci.yml",
  "test (macos-latest)": "ci.yml",
  "workflow-lint": "workflow-lint.yml",
  "pr-title": "pr-title.yml",
  "gitleaks": "secret-scan.yml",
  "semgrep": "semgrep.yml",
  "dependency-review": "dependency-review.yml",
};

const EXPECTED_REQUIRED_CONTEXTS: readonly string[] = Object.keys(CONTEXT_WORKFLOWS).sort();

describe("default-branch ruleset policy", () => {
  it("protects main against deletion, force pushes, and non-linear history", () => {
    const ruleset = readRuleset();
    ruleParameters(ruleset, "deletion");
    ruleParameters(ruleset, "non_fast_forward");
    ruleParameters(ruleset, "required_linear_history");
    assert.ok(isRecord(ruleset));
    assert.equal(ruleset["enforcement"], "active");
  });

  it("requires a pull request but no approval, so a solo maintainer can merge", () => {
    const parameters = ruleParameters(readRuleset(), "pull_request");
    assert.equal(parameters["required_approving_review_count"], 0);
    assert.equal(parameters["require_code_owner_review"], false);
    assert.equal(parameters["dismiss_stale_reviews_on_push"], false);
    assert.equal(parameters["require_last_push_approval"], false);
    assert.equal(parameters["required_review_thread_resolution"], false);
    // WHY: the release flow merges with `gh pr merge --squash`, and linear history
    // already rejects merge commits; rebase stays available for stacked PRs.
    const mergeMethods = parameters["allowed_merge_methods"];
    assert.ok(Array.isArray(mergeMethods), "allowed_merge_methods must be an array");
    assert.ok(mergeMethods.includes("squash"), "squash merge must stay allowed for the release flow");
  });

  it("requires branches to be up to date and the full set of PR checks", () => {
    const parameters = ruleParameters(readRuleset(), "required_status_checks");
    assert.equal(parameters["strict_required_status_checks_policy"], true);
    assert.deepEqual(requiredContexts(readRuleset()).sort(), [...EXPECTED_REQUIRED_CONTEXTS]);
  });

  it("does not require the non-blocking windows test", () => {
    assert.ok(!requiredContexts(readRuleset()).includes("test (windows-latest)"));
  });

  it("has no bypass actors", () => {
    const ruleset = readRuleset();
    assert.ok(isRecord(ruleset));
    assert.deepEqual(ruleset["bypass_actors"], []);
  });
});

describe("release workflow dispatch coverage", () => {
  it("maps every required context to a workflow", () => {
    for (const context of requiredContexts(readRuleset())) {
      assert.ok(
        Object.hasOwn(CONTEXT_WORKFLOWS, context),
        `required check "${context}" has no entry in CONTEXT_WORKFLOWS — add the workflow that produces it`,
      );
    }
  });

  it("dispatches every workflow that produces a required context", () => {
    for (const [context, workflow] of Object.entries(CONTEXT_WORKFLOWS)) {
      assert.ok(
        REQUIRED_WORKFLOWS.includes(workflow),
        `"${context}" comes from ${workflow}, which REQUIRED_WORKFLOWS does not dispatch`,
      );
    }
  });

  it("only dispatches workflows that can be dispatched by hand", () => {
    for (const workflow of REQUIRED_WORKFLOWS) {
      const contents = readRepoFile(`.github/workflows/${workflow}`);
      assert.match(contents, /^ {2}workflow_dispatch:/m, `${workflow} must declare workflow_dispatch`);
    }
  });

  it("documents every required context in AGENTS.md", () => {
    const agents = readRepoFile("AGENTS.md");
    for (const context of requiredContexts(readRuleset())) {
      assert.ok(agents.includes(`\`${context}\``), `AGENTS.md does not mention the required check "${context}"`);
    }
  });
});
