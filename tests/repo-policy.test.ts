/**
 * Guards the repository policy in `.github/rulesets/default-branch.json` (issue #132):
 * `main` takes changes only through a pull request with the required checks, and the
 * release flow approves the `pull_request` workflow runs for every required check context.
 *
 * The ruleset file only works while the release flow approves the workflows that produce
 * the contexts it requires: a required check from a workflow outside `REQUIRED_WORKFLOWS`
 * would stay `action_required` and leave every release PR pending forever. These
 * assertions keep the two in step without needing GitHub access.
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
  "test (windows-latest)": "ci.yml",
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

  it("requires the windows test now that it is blocking", () => {
    assert.ok(requiredContexts(readRuleset()).includes("test (windows-latest)"));
    // WHY: a job-level `continue-on-error` would make the required check pass while
    // the Windows leg is actually failing, silently restoring the issue #54 exemption.
    assert.ok(!readRepoFile(".github/workflows/ci.yml").includes("continue-on-error"));
  });

  it("has no bypass actors", () => {
    const ruleset = readRuleset();
    assert.ok(isRecord(ruleset));
    assert.deepEqual(ruleset["bypass_actors"], []);
  });
});

describe("release workflow approval coverage", () => {
  it("maps every required context to a workflow", () => {
    for (const context of requiredContexts(readRuleset())) {
      assert.ok(
        Object.hasOwn(CONTEXT_WORKFLOWS, context),
        `required check "${context}" has no entry in CONTEXT_WORKFLOWS — add the workflow that produces it`,
      );
    }
  });

  it("approves every workflow that produces a required context", () => {
    for (const [context, workflow] of Object.entries(CONTEXT_WORKFLOWS)) {
      assert.ok(
        REQUIRED_WORKFLOWS.includes(workflow),
        `"${context}" comes from ${workflow}, which REQUIRED_WORKFLOWS does not approve`,
      );
    }
  });

  it("approves only workflows that record pull_request runs", () => {
    // WHY: only pull_request runs attach their check runs to the release PR, so the
    // approve step is meaningless for a workflow without a pull_request trigger — and
    // workflow_dispatch runs never satisfy required PR status checks (#150).
    for (const workflow of REQUIRED_WORKFLOWS) {
      const contents = readRepoFile(`.github/workflows/${workflow}`);
      assert.match(contents, /^ {2}pull_request:/m, `${workflow} must declare pull_request`);
      assert.ok(
        !contents.includes("dispatches this workflow") && !contents.includes("dispatched by publish.yml"),
        `${workflow} must not claim publish.yml dispatches it (publish.yml approves pull_request runs instead)`,
      );
    }
    const release = readRepoFile("scripts/release.ts");
    for (const forbidden of ['"workflow", "run"', "/dispatches"]) {
      assert.ok(
        !release.includes(forbidden),
        `scripts/release.ts must approve pull_request runs rather than dispatching workflows (found ${forbidden})`,
      );
    }
  });

  it("declares merge_group and merge-queue-safe concurrency on every required workflow", () => {
    // WHY: when a merge queue is enabled (e.g. if the repo moves to an organization,
    // issue #138; omitted from default-branch.json while under a personal User account
    // because the GitHub rulesets API rejects merge_queue with HTTP 422 there), every
    // required status check must report on merge_group, key concurrency with github.ref
    // so non-PR events do not collapse to an empty group, and only cancel-in-progress
    // on pull_request so queued merge_group runs are not cancelled mid-flight.
    for (const workflow of REQUIRED_WORKFLOWS) {
      const contents = readRepoFile(`.github/workflows/${workflow}`);
      assert.match(contents, /^ {2}merge_group:/m, `${workflow} must declare merge_group`);
      assert.match(
        contents,
        /^concurrency:\n(?: {2}#.*\n)* {2}group: .*github\.ref.*\n(?: {2}#.*\n)* {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/m,
        `${workflow} concurrency must include github.ref in group and gate cancel-in-progress on pull_request`,
      );
    }
  });

  it("documents every required context in AGENTS.md", () => {
    const agents = readRepoFile("AGENTS.md");
    for (const context of requiredContexts(readRuleset())) {
      assert.ok(agents.includes(`\`${context}\``), `AGENTS.md does not mention the required check "${context}"`);
    }
  });
});

describe("release flow never writes main directly", () => {
  it("has no command that pushes a commit or branch to main", () => {
    // WHY: the ruleset requires a pull request, so the only accepted path onto `main`
    // is the release PR merge (issue #131). A direct push would also fail at runtime.
    const release = readRepoFile("scripts/release.ts");
    for (const forbidden of [":main", "refs/heads/main", "origin main"]) {
      assert.ok(
        !release.includes(forbidden),
        `scripts/release.ts must not push to main (found "${forbidden}"); land the release through the release PR`,
      );
    }
  });
});

describe("coverage and Qlty maintainability policy", () => {
  it("configures test:coverage in package.json to emit both spec to stdout and lcov to lcov.info", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
    const coverageScript = pkg.scripts["test:coverage"];
    assert.ok(coverageScript !== undefined, "package.json must declare a test:coverage script");
    assert.ok(coverageScript.includes("--test-reporter=spec"), "test:coverage must declare spec reporter");
    assert.ok(coverageScript.includes("--test-reporter-destination=stdout"), "spec reporter must output to stdout");
    assert.ok(coverageScript.includes("--test-reporter=lcov"), "test:coverage must declare lcov reporter");
    assert.ok(coverageScript.includes("--test-reporter-destination=lcov.info"), "lcov reporter must output to lcov.info");
    assert.ok(coverageScript.includes("--test-coverage-lines=95"), "coverage lines floor must stay 95%");
    assert.ok(coverageScript.includes("--test-coverage-branches=85"), "coverage branches floor must stay 85%");
    assert.ok(coverageScript.includes("--test-coverage-functions=83"), "coverage functions floor must stay 83%");
  });

  it("ignores lcov.info and Qlty cache directories in .gitignore", () => {
    const gitignore = readRepoFile(".gitignore");
    assert.match(gitignore, /^lcov\.info$/m, ".gitignore must ignore lcov.info");
    assert.match(gitignore, /^\.qlty\/\*$/m, ".gitignore must ignore .qlty/*");
    assert.match(gitignore, /^!\.qlty\/qlty\.toml$/m, ".gitignore must preserve .qlty/qlty.toml");
  });

  it("uploads lcov.info in ci.yml via SHA-pinned qltysh/qlty-action/coverage over OIDC with skip-errors enabled", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    assert.match(
      ci,
      /uses: qltysh\/qlty-action\/coverage@[0-9a-f]{40} # v\d+\.\d+\.\d+/,
      "ci.yml must pin qltysh/qlty-action/coverage with a 40-char SHA and version comment",
    );
    assert.match(ci, /id-token: write/, "check job must grant id-token: write for OIDC coverage upload");
    assert.match(ci, /oidc: true/, "coverage upload must authenticate via OIDC");
    assert.match(ci, /files: lcov\.info/, "coverage upload must specify lcov.info");
    assert.match(ci, /format: lcov/, "coverage upload must specify lcov format");
    assert.match(ci, /strip-prefix: \$\{\{ github\.workspace \}\}/, "coverage upload must strip github.workspace prefix");
    assert.match(ci, /skip-errors: true/, "coverage upload must set skip-errors: true");
  });

  it("declares the default plugin source and keeps third-party linters disabled in .qlty/qlty.toml", () => {
    const qltyToml = readRepoFile(".qlty/qlty.toml");
    assert.ok(
      qltyToml.includes('[[source]]\nname = "default"\ndefault = true'),
      '.qlty/qlty.toml must declare [[source]] name = "default" default = true so plugin definitions resolve',
    );
    assert.ok(
      qltyToml.includes("[smells.file_complexity]"),
      ".qlty/qlty.toml must configure [smells.file_complexity] rather than unsupported [rules]",
    );
    assert.ok(!qltyToml.includes("[rules]"), ".qlty/qlty.toml must not contain unsupported [rules] table");
    for (const linter of ["eslint", "semgrep", "gitleaks", "actionlint", "trufflehog", "osv-scanner"]) {
      assert.ok(
        qltyToml.includes(`name = "${linter}"\nmode = "disabled"`),
        `.qlty/qlty.toml must disable ${linter} to avoid duplicate linter runs`,
      );
    }
  });

  it("includes CI, Qlty Maintainability, and Code Coverage badges in README.md", () => {
    const readme = readRepoFile("README.md");
    assert.ok(readme.includes("actions/workflows/ci.yml/badge.svg?branch=main"), "README.md must include CI status badge");
    assert.ok(readme.includes("https://qlty.sh/gh/irahardianto/projects/pi-mcp-extension/maintainability.svg"));
    assert.ok(readme.includes("https://qlty.sh/gh/irahardianto/projects/pi-mcp-extension/coverage.svg"));
  });
});
