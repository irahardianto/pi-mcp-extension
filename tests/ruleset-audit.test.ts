/**
 * Tests for scripts/ruleset-audit.ts — the drift audit behind
 * .github/workflows/ruleset-audit.yml (issue #135).
 *
 * The pure functions (normalization, diffing, context extraction) are tested directly.
 * The CLI is driven end to end with a fake `fetch`, so the environment handling, the
 * token separation (ruleset vs. read token) and the exit codes are covered without
 * opening a socket.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditRulesets,
  checkRunNames,
  createGitHubApi,
  diffRulesets,
  loadRulesetFiles,
  missingContexts,
  normalizeRuleset,
  parseRulesetFile,
  requiredStatusContexts,
  runCli,
  type FetchLike,
  type GitHubApi,
  type RulesetFile,
} from "../scripts/ruleset-audit.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-mcp-ruleset-audit-"));
  temporaryDirectories.push(directory);
  return directory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REQUIRED_CONTEXTS = [
  "check (22)",
  "check (24)",
  "dependency-review",
  "gitleaks",
  "pr-title",
  "semgrep",
  "test (macos-latest)",
  "test (windows-latest)",
  "workflow-lint",
] as const;

/** The live `default-branch` ruleset as the API reports it (defaults included). */
function liveDefaultBranch(): Record<string, unknown> {
  return {
    id: 25409171,
    node_id: "RRS_example",
    source: "owner/repo",
    source_type: "Repository",
    created_at: "2026-10-19T21:02:16.339+07:00",
    updated_at: "2026-10-23T08:12:51.541+07:00",
    current_user_can_bypass: "never",
    _links: { self: { href: "https://api.github.com/repos/owner/repo/rulesets/25409171" } },
    name: "default-branch",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      // WHY: the API lists the parameter rules in its own order, not the file's.
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: REQUIRED_CONTEXTS.map((context) => ({ context })),
          strict_required_status_checks_policy: true,
        },
      },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash", "rebase"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_extra_approval_for_unattributed_changes: true,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
          required_reviewers: [],
        },
      },
    ],
    bypass_actors: [],
  };
}

/** The live `release-tags` ruleset as the API reports it. */
function liveReleaseTags(): Record<string, unknown> {
  return {
    id: 25409549,
    node_id: "RRS_example",
    source: "owner/repo",
    source_type: "Repository",
    created_at: "2026-10-19T21:06:09.666+07:00",
    updated_at: "2026-10-19T21:06:09.738+07:00",
    current_user_can_bypass: "always",
    _links: { self: { href: "https://api.github.com/repos/owner/repo/rulesets/25409549" } },
    name: "release-tags",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
  };
}

/**
 * A minimal file-shaped ruleset for the diff tests. `liveView()` adds the API-only
 * fields the live response carries, so the pair is semantically identical.
 */
function fileRuleset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "default-branch",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          allowed_merge_methods: ["squash", "rebase"],
        },
      },
    ],
    bypass_actors: [],
    ...overrides,
  };
}

/** The same ruleset as the live API would return it: file fields plus API-only noise. */
function liveView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    node_id: "RRS_example",
    source: "owner/repo",
    source_type: "Repository",
    created_at: "2026-10-19T21:02:16.339+07:00",
    updated_at: "2026-10-23T08:12:51.541+07:00",
    current_user_can_bypass: "never",
    _links: { self: { href: "https://api.github.com/repos/owner/repo/rulesets/1" } },
    ...fileRuleset(overrides),
  };
}

/** The pull_request rule parameters of a live-shaped ruleset (mutation helper). */
function pullRequestParameters(ruleset: Record<string, unknown>): Record<string, unknown> {
  const rules = ruleset["rules"];
  assert.ok(Array.isArray(rules), "ruleset must have a rules array");
  const rule = rules.find((entry) => isRecord(entry) && entry["type"] === "pull_request");
  assert.ok(isRecord(rule), "ruleset must have a pull_request rule");
  const parameters = rule["parameters"];
  assert.ok(isRecord(parameters), "pull_request rule must have parameters");
  return parameters;
}

/** The check-run names the audit samples: push-event jobs on `main`, PR-only jobs on a PR head. */
const MAIN_COMMIT_SHA = "a".repeat(40);
const PULL_REQUEST_HEAD_SHA = "b".repeat(40);
const CONTEXTS_ON_MAIN = REQUIRED_CONTEXTS.filter(
  (context) => context !== "pr-title" && context !== "dependency-review",
);
const CONTEXTS_ON_PULL_REQUEST = ["pr-title", "dependency-review"];

function rulesetFileFrom(fileName: string, ruleset: Record<string, unknown>): RulesetFile {
  return { fileName, ruleset, normalized: normalizeRuleset(ruleset) };
}

/** The two ruleset files as `loadRulesetFiles` would return them. */
function defaultRulesetFiles(): RulesetFile[] {
  return [
    rulesetFileFrom("default-branch.json", {
      name: "default-branch",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_linear_history" },
        {
          type: "required_status_checks",
          parameters: {
            do_not_enforce_on_create: false,
            required_status_checks: REQUIRED_CONTEXTS.map((context) => ({ context })),
            strict_required_status_checks_policy: true,
          },
        },
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["squash", "rebase"],
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_extra_approval_for_unattributed_changes: true,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: false,
            required_reviewers: [],
          },
        },
      ],
      bypass_actors: [],
    }),
    rulesetFileFrom("release-tags.json", {
      name: "release-tags",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    }),
  ];
}

function fakeApi(options: {
  summaries?: unknown;
  details?: Record<number, unknown>;
  mainShas?: readonly string[];
  pullRequestShas?: readonly string[];
  checkRuns?: Record<string, readonly string[]>;
}): GitHubApi {
  return {
    listRulesets: async () => options.summaries ?? [],
    getRuleset: async (id) => {
      const detail = options.details?.[id];
      if (detail === undefined) throw new Error(`no fake ruleset ${String(id)}`);
      return detail;
    },
    mainCommitShas: async () => options.mainShas ?? [],
    pullRequestHeadShas: async () => options.pullRequestShas ?? [],
    checkRunNames: async (sha) => options.checkRuns?.[sha] ?? [],
  };
}

/** A fake GitHub: routes by URL suffix, records the Authorization header of every call. */
interface RecordedCall {
  readonly url: string;
  readonly authorization: string | undefined;
}

interface Route {
  readonly match: RegExp;
  readonly body: unknown;
  readonly status?: number;
}

function fakeFetch(routes: readonly Route[], calls: RecordedCall[] = []): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") ?? undefined });
    const route = routes.find((entry) => entry.match.test(url));
    if (route === undefined) {
      return new Response(JSON.stringify({ message: `unexpected request: ${url}` }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
}

function checkRunPayload(names: readonly string[]): unknown {
  return { total_count: names.length, check_runs: names.map((name) => ({ name })) };
}

describe("normalizeRuleset", () => {
  it("drops API-only fields", () => {
    assert.deepEqual(normalizeRuleset(liveView()), normalizeRuleset(fileRuleset()));
    assert.deepEqual(Object.keys(normalizeRuleset(liveDefaultBranch())).sort(), [
      "bypass_actors",
      "conditions",
      "enforcement",
      "name",
      "rules",
      "target",
    ]);
  });

  it("orders rules by type and treats a rule without parameters as empty", () => {
    const withParameters = normalizeRuleset({
      rules: [{ type: "pull_request", parameters: {} }, { type: "deletion" }],
    });
    const withoutParameters = normalizeRuleset({
      rules: [{ type: "deletion" }, { type: "pull_request" }],
    });
    assert.deepEqual(withParameters, withoutParameters);
    assert.deepEqual(Object.keys(withParameters["rules"] as Record<string, unknown>), [
      "deletion",
      "pull_request",
    ]);
  });

  it("sorts arrays so ordering is never drift", () => {
    const left = normalizeRuleset({ conditions: { ref_name: { include: ["a", "b"], exclude: [] } } });
    const right = normalizeRuleset({ conditions: { ref_name: { include: ["b", "a"], exclude: [] } } });
    assert.deepEqual(left, right);
  });

  it("rejects a non-object ruleset", () => {
    assert.throws(() => normalizeRuleset([]), /must be a JSON object/);
    assert.throws(() => normalizeRuleset("nope"), /must be a JSON object/);
  });
});

describe("diffRulesets", () => {
  it("ignores API-only fields, rule order, and array order", () => {
    const live = liveView();
    const rules = live["rules"];
    assert.ok(Array.isArray(rules));
    live["rules"] = [...rules].reverse();
    live["conditions"] = { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } };
    assert.deepEqual(diffRulesets(fileRuleset(), live), []);
  });

  it("reports a changed enforcement value", () => {
    assert.deepEqual(diffRulesets(fileRuleset(), liveView({ enforcement: "evaluate" })), [
      { path: "enforcement", expected: '"active"', actual: '"evaluate"' },
    ]);
  });

  it("reports a changed target or name", () => {
    assert.deepEqual(diffRulesets(fileRuleset(), liveView({ target: "tag" })), [
      { path: "target", expected: '"branch"', actual: '"tag"' },
    ]);
    assert.deepEqual(diffRulesets(fileRuleset(), liveView({ name: "renamed" })), [
      { path: "name", expected: '"default-branch"', actual: '"renamed"' },
    ]);
  });

  it("reports a changed conditions include list", () => {
    assert.deepEqual(
      diffRulesets(
        fileRuleset(),
        liveView({ conditions: { ref_name: { include: ["~ALL"], exclude: [] } } }),
      ),
      [
        {
          path: "conditions.ref_name.include",
          expected: '["~DEFAULT_BRANCH"]',
          actual: '["~ALL"]',
        },
      ],
    );
  });

  it("reports a changed rule parameter", () => {
    const live = liveView();
    pullRequestParameters(live)["required_approving_review_count"] = 1;
    assert.deepEqual(diffRulesets(fileRuleset(), live), [
      {
        path: "rules.pull_request.parameters.required_approving_review_count",
        expected: "0",
        actual: "1",
      },
    ]);
  });

  it("reports a parameter the live ruleset grew (a new API default)", () => {
    const live = liveView();
    pullRequestParameters(live)["require_extra_approval_for_unattributed_changes"] = true;
    assert.deepEqual(diffRulesets(fileRuleset(), live), [
      {
        path: "rules.pull_request.parameters.require_extra_approval_for_unattributed_changes",
        expected: "<missing>",
        actual: "true",
      },
    ]);
  });

  it("reports a parameter the file declares but the live ruleset lost", () => {
    const live = liveView();
    delete pullRequestParameters(live)["required_approving_review_count"];
    assert.deepEqual(diffRulesets(fileRuleset(), live), [
      {
        path: "rules.pull_request.parameters.required_approving_review_count",
        expected: "0",
        actual: "<missing>",
      },
    ]);
  });

  it("reports a rule type that exists on one side only", () => {
    const live = liveView();
    const rules = live["rules"];
    assert.ok(Array.isArray(rules));
    rules.push({ type: "update" });
    assert.deepEqual(diffRulesets(fileRuleset(), live), [
      { path: "rules.update", expected: "<missing>", actual: '{"parameters":{}}' },
    ]);

    const shrunk = liveView();
    shrunk["rules"] = [{ type: "deletion" }];
    assert.deepEqual(diffRulesets(fileRuleset(), shrunk), [
      {
        path: "rules.pull_request",
        expected:
          '{"parameters":{"allowed_merge_methods":["rebase","squash"],"required_approving_review_count":0}}',
        actual: "<missing>",
      },
    ]);
  });

  it("reports changed bypass actors", () => {
    assert.deepEqual(
      diffRulesets(
        fileRuleset(),
        liveView({
          bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
        }),
      ),
      [
        {
          path: "bypass_actors",
          expected: "[]",
          actual: '[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]',
        },
      ],
    );
  });

  it("reports every field a file omits entirely", () => {
    const differences = diffRulesets({ name: "default-branch" }, liveView());
    assert.deepEqual(
      differences.map((difference) => difference.path),
      ["bypass_actors", "conditions", "enforcement", "rules", "target"],
    );
  });
});

describe("parseRulesetFile", () => {
  it("tolerates JSONC comments", () => {
    const parsed = parseRulesetFile(
      "commented.json",
      `{
        // WHY: a maintainer note must not break the audit.
        "name": "commented", /* inline */
        "target": "branch"
      }`,
    );
    assert.equal(parsed.ruleset["name"], "commented");
    assert.equal(parsed.normalized["target"], "branch");
  });

  it("rejects invalid JSON with the file name", () => {
    assert.throws(() => parseRulesetFile("broken.json", "{"), /broken\.json is not valid JSON/);
  });

  it("rejects a non-object root", () => {
    assert.throws(() => parseRulesetFile("array.json", "[]"), /must contain a JSON object/);
  });

  it("rejects a missing or empty name", () => {
    assert.throws(() => parseRulesetFile("no-name.json", "{}"), /non-empty string "name"/);
    assert.throws(() => parseRulesetFile("empty-name.json", '{"name":""}'), /non-empty string "name"/);
    assert.throws(() => parseRulesetFile("number-name.json", '{"name":7}'), /non-empty string "name"/);
  });
});

describe("loadRulesetFiles", () => {
  it("loads both checked-in rulesets", () => {
    const files = loadRulesetFiles(repoRoot);
    assert.deepEqual(
      files.map((file) => file.fileName),
      ["default-branch.json", "release-tags.json"],
    );
    assert.deepEqual(requiredStatusContexts(files[0]?.normalized ?? {}), [...REQUIRED_CONTEXTS]);
  });

  it("matches the checked-in files to the live API shape", () => {
    // WHY: this is the file half of the audit guard. The live API returns default
    // parameters the files must state explicitly, so a parameter GitHub adds later (or a
    // maintainer deletes from a file) shows up here before the first scheduled run.
    const files = loadRulesetFiles(repoRoot);
    const live: Record<string, Record<string, unknown>> = {
      "default-branch.json": liveDefaultBranch(),
      "release-tags.json": liveReleaseTags(),
    };
    for (const file of files) {
      const detail = live[file.fileName];
      assert.ok(detail !== undefined, `${file.fileName} has no live fixture`);
      assert.deepEqual(diffRulesets(file.ruleset, detail), [], `${file.fileName} drifted from the live fixture`);
    }
  });

  it("throws when the directory has no ruleset files", () => {
    const directory = temporaryDirectory();
    mkdirSync(path.join(directory, ".github", "rulesets"), { recursive: true });
    assert.throws(() => loadRulesetFiles(directory), /no ruleset files found/);
  });

  it("reads only .json files, sorted by name", () => {
    const directory = temporaryDirectory();
    const rulesets = path.join(directory, ".github", "rulesets");
    mkdirSync(rulesets, { recursive: true });
    writeFileSync(path.join(rulesets, "b.json"), '{"name":"b"}');
    writeFileSync(path.join(rulesets, "a.json"), '{"name":"a"}');
    writeFileSync(path.join(rulesets, "README.md"), "ignored");
    assert.deepEqual(
      loadRulesetFiles(directory).map((file) => file.fileName),
      ["a.json", "b.json"],
    );
  });
});

describe("checkRunNames", () => {
  it("extracts, deduplicates, and sorts names", () => {
    assert.deepEqual(
      checkRunNames({
        check_runs: [{ name: "b" }, { name: "a" }, { name: "b" }, { name: 7 }, null, { name: "" }],
      }),
      ["a", "b"],
    );
  });

  it("returns nothing for a malformed payload", () => {
    assert.deepEqual(checkRunNames(undefined), []);
    assert.deepEqual(checkRunNames(null), []);
    assert.deepEqual(checkRunNames({}), []);
    assert.deepEqual(checkRunNames({ check_runs: "nope" }), []);
  });
});

describe("missingContexts", () => {
  it("returns the required contexts nothing reports", () => {
    const observed = new Set(["check (22)", "semgrep"]);
    assert.deepEqual(missingContexts(["check (22)", "pr-title", "semgrep"], observed), ["pr-title"]);
    assert.deepEqual(missingContexts(["check (22)"], observed), []);
  });
});

describe("auditRulesets", () => {
  const summaries = [
    { id: 1, name: "default-branch", target: "branch", enforcement: "active" },
    { id: 2, name: "release-tags", target: "tag", enforcement: "active" },
  ];
  const details = { 1: liveDefaultBranch(), 2: liveReleaseTags() };
  const checkRuns = {
    [MAIN_COMMIT_SHA]: CONTEXTS_ON_MAIN,
    [PULL_REQUEST_HEAD_SHA]: CONTEXTS_ON_PULL_REQUEST,
  };

  it("passes when the live rulesets match and every context is reported", async () => {
    const logged: string[] = [];
    const result = await auditRulesets({
      rulesets: defaultRulesetFiles(),
      api: fakeApi({
        summaries,
        details,
        mainShas: [MAIN_COMMIT_SHA],
        pullRequestShas: [PULL_REQUEST_HEAD_SHA],
        checkRuns,
      }),
      liveTokenAvailable: true,
      requireLiveAudit: true,
      log: (message) => logged.push(message),
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.liveAuditSkipped, false);
    assert.ok(logged.some((message) => message.includes("matches the live")));
    assert.ok(logged.some((message) => message.includes("every required check context")));
  });

  it("reports drift with the field path", async () => {
    const drifted = liveDefaultBranch();
    drifted["enforcement"] = "disabled";
    const result = await auditRulesets({
      rulesets: defaultRulesetFiles(),
      api: fakeApi({
        summaries,
        details: { 1: drifted, 2: liveReleaseTags() },
        mainShas: [MAIN_COMMIT_SHA],
        pullRequestShas: [PULL_REQUEST_HEAD_SHA],
        checkRuns,
      }),
      liveTokenAvailable: true,
      requireLiveAudit: true,
    });
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0] ?? "", /default-branch\.json: the live "default-branch" ruleset/);
    assert.match(result.findings[0] ?? "", /enforcement: expected "active", live "disabled"/);
  });

  it("reports a file with no live ruleset", async () => {
    const result = await auditRulesets({
      rulesets: defaultRulesetFiles(),
      api: fakeApi({
        summaries: [summaries[0]],
        details: { 1: liveDefaultBranch() },
        mainShas: [MAIN_COMMIT_SHA],
        pullRequestShas: [PULL_REQUEST_HEAD_SHA],
        checkRuns,
      }),
      liveTokenAvailable: true,
      requireLiveAudit: true,
    });
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0] ?? "", /no live ruleset is named "release-tags"/);
  });

  it("reports a live ruleset with no file", async () => {
    const result = await auditRulesets({
      rulesets: [defaultRulesetFiles()[0] as RulesetFile],
      api: fakeApi({
        summaries,
        details,
        mainShas: [MAIN_COMMIT_SHA],
        pullRequestShas: [PULL_REQUEST_HEAD_SHA],
        checkRuns,
      }),
      liveTokenAvailable: true,
      requireLiveAudit: true,
    });
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0] ?? "", /live ruleset "release-tags" has no file in \.github\/rulesets\//);
  });

  it("reports a required context no recent commit reports", async () => {
    const result = await auditRulesets({
      rulesets: defaultRulesetFiles(),
      // WHY: without the pull-request heads the PR-only contexts look dead; the union must include them.
      api: fakeApi({
        summaries,
        details,
        mainShas: [MAIN_COMMIT_SHA],
        pullRequestShas: [],
        checkRuns: { [MAIN_COMMIT_SHA]: CONTEXTS_ON_MAIN },
      }),
      liveTokenAvailable: true,
      requireLiveAudit: true,
    });
    assert.equal(result.findings.length, 2);
    for (const context of CONTEXTS_ON_PULL_REQUEST) {
      assert.ok(
        result.findings.some((finding) => finding.includes(`required check context "${context}"`)),
        `missing finding for ${context}`,
      );
    }
  });

  it("tolerates a pull-request head whose check runs cannot be read", async () => {
    const logged: string[] = [];
    const base = fakeApi({
      summaries,
      details,
      mainShas: [MAIN_COMMIT_SHA],
      pullRequestShas: [PULL_REQUEST_HEAD_SHA],
      // WHY: every context is already reported by the main sample, so the unreadable
      // pull-request head only has to be skipped, not made up for.
      checkRuns: { [MAIN_COMMIT_SHA]: [...REQUIRED_CONTEXTS] },
    });
    const api: GitHubApi = {
      ...base,
      checkRunNames: async (sha) => {
        if (sha === PULL_REQUEST_HEAD_SHA) throw new Error("404 Not Found");
        return base.checkRunNames(sha);
      },
    };
    const result = await auditRulesets({
      rulesets: defaultRulesetFiles(),
      api,
      liveTokenAvailable: true,
      requireLiveAudit: true,
      log: (message) => logged.push(message),
    });
    assert.deepEqual(result.findings, []);
    assert.ok(logged.some((message) => message.includes("skipping the check runs of pull-request head")));
  });

  it("fails on a scheduled run when the ruleset token is missing", async () => {
    const result = await auditRulesets({
      rulesets: defaultRulesetFiles(),
      api: fakeApi({
        mainShas: [MAIN_COMMIT_SHA],
        pullRequestShas: [PULL_REQUEST_HEAD_SHA],
        checkRuns,
      }),
      liveTokenAvailable: false,
      requireLiveAudit: true,
    });
    assert.equal(result.liveAuditSkipped, true);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0] ?? "", /RULESET_AUDIT_TOKEN is not set/);
  });

  it("skips the live comparison without failing on a fork pull request", async () => {
    const logged: string[] = [];
    const result = await auditRulesets({
      rulesets: defaultRulesetFiles(),
      api: fakeApi({
        mainShas: [MAIN_COMMIT_SHA],
        pullRequestShas: [PULL_REQUEST_HEAD_SHA],
        checkRuns,
      }),
      liveTokenAvailable: false,
      requireLiveAudit: false,
      log: (message) => logged.push(message),
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.liveAuditSkipped, true);
    assert.ok(logged.some((message) => message.includes("skipping the live ruleset comparison")));
  });
});

describe("createGitHubApi", () => {
  it("uses the ruleset token for rulesets and the read token for commits", async () => {
    const calls: RecordedCall[] = [];
    const api = createGitHubApi({
      repository: "owner/repo",
      apiBase: "https://api.example.test/",
      rulesetToken: "ruleset-token",
      readToken: "read-token",
      fetchImpl: fakeFetch(
        [
          { match: /\/repos\/owner\/repo\/rulesets\?per_page=100&page=1$/, body: [{ id: 11, name: "default-branch" }] },
          { match: /\/repos\/owner\/repo\/rulesets\/11$/, body: { name: "default-branch" } },
          { match: /\/repos\/owner\/repo\/commits\?sha=main&per_page=1$/, body: [{ sha: MAIN_COMMIT_SHA }] },
          {
            match: /\/repos\/owner\/repo\/pulls\?state=closed.*per_page=1$/,
            body: [{ head: { sha: PULL_REQUEST_HEAD_SHA } }],
          },
          {
            match: new RegExp(`/repos/owner/repo/commits/${MAIN_COMMIT_SHA}/check-runs`),
            body: checkRunPayload(["check (22)"]),
          },
        ],
        calls,
      ),
    });

    assert.deepEqual(await api.listRulesets(), [{ id: 11, name: "default-branch" }]);
    assert.deepEqual(await api.getRuleset(11), { name: "default-branch" });
    assert.deepEqual(await api.mainCommitShas(1), [MAIN_COMMIT_SHA]);
    assert.deepEqual(await api.pullRequestHeadShas(1), [PULL_REQUEST_HEAD_SHA]);
    assert.deepEqual(await api.checkRunNames(MAIN_COMMIT_SHA), ["check (22)"]);

    for (const call of calls) {
      const expected = call.url.includes("/rulesets") ? "Bearer ruleset-token" : "Bearer read-token";
      assert.equal(call.authorization, expected, `wrong token for ${call.url}`);
      assert.ok(call.url.startsWith("https://api.example.test/repos/owner/repo/"), call.url);
    }
  });

  it("paginates the ruleset list", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `ruleset-${String(index + 1)}` }));
    const secondPage = [{ id: 101, name: "ruleset-101" }, { id: 102, name: "ruleset-102" }];
    const requestedPages: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestedPages.push(url);
      const page = new URL(url).searchParams.get("page");
      return new Response(JSON.stringify(page === "1" ? firstPage : secondPage), { status: 200 });
    };
    const paginated = createGitHubApi({
      repository: "owner/repo",
      apiBase: "https://api.github.com",
      rulesetToken: "token",
      readToken: "token",
      fetchImpl,
    });
    assert.equal((await paginated.listRulesets() as unknown[]).length, 102);
    assert.deepEqual(requestedPages.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);
  });

  it("surfaces the API error message", async () => {
    const api = createGitHubApi({
      repository: "owner/repo",
      apiBase: "https://api.github.com",
      rulesetToken: "token",
      readToken: "token",
      fetchImpl: fakeFetch([
        {
          match: /\/rulesets\?per_page=100&page=1$/,
          status: 403,
          body: { message: "Resource not accessible by integration" },
        },
      ]),
    });
    await assert.rejects(api.listRulesets(), /403: Resource not accessible by integration/);
  });

  it("refuses to read rulesets without a ruleset token", async () => {
    const api = createGitHubApi({
      repository: "owner/repo",
      apiBase: "https://api.github.com",
      rulesetToken: undefined,
      readToken: "token",
      fetchImpl: fakeFetch([]),
    });
    await assert.rejects(api.listRulesets(), /needs a ruleset token/);
  });

  it("reports an invalid JSON body", async () => {
    const api = createGitHubApi({
      repository: "owner/repo",
      apiBase: "https://api.github.com",
      rulesetToken: "token",
      readToken: "token",
      fetchImpl: async () => new Response("not json", { status: 200 }),
    });
    await assert.rejects(api.listRulesets(), /returned invalid JSON/);
  });
});

describe("runCli", () => {
  const successfulRoutes: Route[] = [
    {
      match: /\/repos\/owner\/repo\/rulesets\?per_page=100&page=1$/,
      body: [
        { id: 1, name: "default-branch" },
        { id: 2, name: "release-tags" },
      ],
    },
    { match: /\/repos\/owner\/repo\/rulesets\/1$/, body: liveDefaultBranch() },
    { match: /\/repos\/owner\/repo\/rulesets\/2$/, body: liveReleaseTags() },
    { match: /\/repos\/owner\/repo\/commits\?sha=main/, body: [{ sha: MAIN_COMMIT_SHA }] },
    { match: /\/repos\/owner\/repo\/pulls\?/, body: [{ head: { sha: PULL_REQUEST_HEAD_SHA } }] },
    {
      match: new RegExp(`/repos/owner/repo/commits/${MAIN_COMMIT_SHA}/check-runs`),
      body: checkRunPayload(CONTEXTS_ON_MAIN),
    },
    {
      match: new RegExp(`/repos/owner/repo/commits/${PULL_REQUEST_HEAD_SHA}/check-runs`),
      body: checkRunPayload(CONTEXTS_ON_PULL_REQUEST),
    },
  ];

  it("exits 0 when the checked-in files match the live rulesets", async () => {
    const logged: string[] = [];
    const code = await runCli({
      env: {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_TOKEN: "read-token",
        RULESET_AUDIT_TOKEN: "ruleset-token",
        RULESET_AUDIT_REQUIRE_LIVE: "1",
      },
      cwd: repoRoot,
      log: (message) => logged.push(message),
      fetchImpl: fakeFetch(successfulRoutes),
    });
    assert.equal(code, 0);
    assert.ok(logged.some((message) => message.includes("no findings")));
  });

  it("exits 1 when a required context is missing", async () => {
    const logged: string[] = [];
    const code = await runCli({
      env: {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_TOKEN: "read-token",
        RULESET_AUDIT_TOKEN: "ruleset-token",
      },
      cwd: repoRoot,
      log: (message) => logged.push(message),
      fetchImpl: fakeFetch(
        successfulRoutes.map((route) =>
          route.match.source.includes("check-runs")
            ? { ...route, body: checkRunPayload(["check (22)"]) }
            : route,
        ),
      ),
    });
    assert.equal(code, 1);
    assert.ok(logged.some((message) => message.includes("finding(s)")));
  });

  it("exits 1 when GITHUB_REPOSITORY is missing", async () => {
    const logged: string[] = [];
    const code = await runCli({
      env: { GITHUB_TOKEN: "read-token" },
      cwd: repoRoot,
      log: (message) => logged.push(message),
      fetchImpl: fakeFetch([]),
    });
    assert.equal(code, 1);
    assert.match(logged.join("\n"), /GITHUB_REPOSITORY is not set/);
  });

  it("exits 1 when no token is available", async () => {
    const logged: string[] = [];
    const code = await runCli({
      env: { GITHUB_REPOSITORY: "owner/repo" },
      cwd: repoRoot,
      log: (message) => logged.push(message),
      fetchImpl: fakeFetch([]),
    });
    assert.equal(code, 1);
    assert.match(logged.join("\n"), /GITHUB_TOKEN is required/);
  });

  it("exits 1 on a scheduled run without the ruleset token, without calling the rulesets API", async () => {
    const logged: string[] = [];
    const calls: RecordedCall[] = [];
    const code = await runCli({
      env: {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_TOKEN: "read-token",
        RULESET_AUDIT_REQUIRE_LIVE: "1",
      },
      cwd: repoRoot,
      log: (message) => logged.push(message),
      fetchImpl: fakeFetch(successfulRoutes, calls),
    });
    assert.equal(code, 1);
    assert.match(logged.join("\n"), /RULESET_AUDIT_TOKEN is not set/);
    assert.ok(calls.every((call) => !call.url.includes("/rulesets")));
  });

  it("exits 0 on a fork pull request without the ruleset token", async () => {
    const logged: string[] = [];
    const annotations: string[] = [];
    const code = await runCli({
      env: { GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "read-token" },
      cwd: repoRoot,
      log: (message) => logged.push(message),
      annotate: (message) => annotations.push(message),
      fetchImpl: fakeFetch(successfulRoutes),
    });
    assert.equal(code, 0);
    assert.ok(logged.some((message) => message.includes("live comparison skipped")));
    // WHY: a green PR check must say that it skipped the live comparison, not look like a pass.
    assert.equal(annotations.length, 1);
    assert.match(annotations[0] ?? "", /live ruleset comparison was skipped/);
  });

  it("does not annotate a run that compared the live rulesets", async () => {
    const annotations: string[] = [];
    const code = await runCli({
      env: {
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_TOKEN: "read-token",
        RULESET_AUDIT_TOKEN: "ruleset-token",
        RULESET_AUDIT_REQUIRE_LIVE: "1",
      },
      cwd: repoRoot,
      log: () => undefined,
      annotate: (message) => annotations.push(message),
      fetchImpl: fakeFetch(successfulRoutes),
    });
    assert.equal(code, 0);
    assert.deepEqual(annotations, []);
  });
});
