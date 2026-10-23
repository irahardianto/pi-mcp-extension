/**
 * Ruleset drift audit for `.github/workflows/ruleset-audit.yml` (issue #135).
 *
 * AGENTS.md declares `.github/rulesets/*.json` the declarative source of truth for
 * branch and tag protection, but nothing verified that the live rulesets still match
 * those files. A ruleset edited in the GitHub UI or through the API (a temporary
 * emergency lift, a well-meaning tweak, a revert that only half-applies) used to drift
 * silently and weaken `main`'s protection until someone remembered to compare by hand.
 *
 * The audit answers two questions:
 *
 * 1. **Do the live rulesets match the files?** Every file in `.github/rulesets/` is
 *    fetched by name from the rulesets API and compared field by field: `name`,
 *    `target`, `enforcement`, `conditions`, `rules` (including `parameters`), and
 *    `bypass_actors`. API-only fields (`id`, `node_id`, `created_at`, `updated_at`,
 *    `_links`, `source`, `source_type`, `current_user_can_bypass`) are dropped on both
 *    sides before comparing, and rules are matched by `type` rather than by position.
 * 2. **Does every required check context still exist?** `required_status_checks`
 *    matches check contexts by exact string, so renaming a job in `ci.yml` would leave
 *    the ruleset requiring a context nobody reports — blocking every merge to `main`,
 *    including automated releases. The audit unions the check-run names of recent
 *    commits on `main` with those of recent pull-request heads (`pr-title` and
 *    `dependency-review` only run on pull requests) and fails when a required context
 *    is missing.
 *
 * Reading the rulesets API needs repository administration access, which the workflow
 * `GITHUB_TOKEN` does not have, so the audit takes a dedicated token
 * (`RULESET_AUDIT_TOKEN`, fine-grained "Administration: read" or a classic `repo`
 * token). Pull requests from forks never receive secrets: those runs skip the live
 * comparison with a warning and still verify the check contexts. Every other event
 * fails when the token is missing, so the weekly audit cannot quietly become a no-op.
 *
 * The pure parts (normalization, diffing, context extraction) are unit tested in
 * `tests/ruleset-audit.test.ts`; the GitHub client is a thin, injectable port.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripJsonComments } from "../src/jsonc.js";
import { sanitizeTerminalText } from "../src/terminal-text.js";

/** The directory holding the declarative ruleset files. */
export const RULESETS_DIRECTORY = ".github/rulesets";

/**
 * How many commits on `main` and how many pull-request heads to sample for check-run
 * names. The union only has to be wider than a single commit so a required context
 * still counts while the newest commit's runs are in flight.
 */
const RECENT_COMMIT_LIMIT = 5;
const RECENT_PULL_REQUEST_LIMIT = 5;

/** The rulesets API page size, and a hard cap so a server that ignores `page` cannot loop forever. */
const RULESETS_PAGE_SIZE = 100;
const MAX_RULESET_PAGES = 20;

/** The fields a ruleset file and the live API express in common. Everything else is API-only. */
const RULESET_FIELDS = ["name", "target", "enforcement", "conditions", "rules", "bypass_actors"] as const;

/** The placeholder for a field that exists on one side only. */
const MISSING = "<missing>";

/** One drifted field, with both sides rendered for the log. */
export interface RulesetDifference {
  /** Dotted path inside the ruleset, e.g. `rules.pull_request.parameters.required_approving_review_count`. */
  readonly path: string;
  /** The value the file declares (or `<missing>`). */
  readonly expected: string;
  /** The value the live ruleset reports (or `<missing>`). */
  readonly actual: string;
}

/** A parsed ruleset file. */
export interface RulesetFile {
  /** The file name inside `.github/rulesets/`, e.g. `default-branch.json`. */
  readonly fileName: string;
  /** The raw (comment-stripped) JSON, used for the human-readable name. */
  readonly ruleset: Record<string, unknown>;
  /** The field-by-field comparable form (`normalizeRuleset`). */
  readonly normalized: Record<string, unknown>;
}

/** The GitHub reads the audit needs. */
export interface GitHubApi {
  /** `GET /repos/{owner}/{repo}/rulesets` — the ruleset summaries. */
  listRulesets(): Promise<unknown>;
  /** `GET /repos/{owner}/{repo}/rulesets/{id}` — one ruleset with its rules and conditions. */
  getRuleset(id: number): Promise<unknown>;
  /** The newest commits on `main`, newest first. */
  mainCommitShas(limit: number): Promise<readonly string[]>;
  /** The head SHAs of the most recently updated closed pull requests. */
  pullRequestHeadShas(limit: number): Promise<readonly string[]>;
  /** `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` — the check-run names for a commit. */
  checkRunNames(sha: string): Promise<readonly string[]>;
}

export interface AuditOptions {
  /** The ruleset files checked out in the repository. */
  readonly rulesets: readonly RulesetFile[];
  readonly api: GitHubApi;
  /** Whether the live comparison can run (the workflow token). */
  readonly liveTokenAvailable: boolean;
  /** Fail instead of skipping when the live comparison cannot run (scheduled/non-fork runs). */
  readonly requireLiveAudit: boolean;
  readonly log?: (message: string) => void;
}

export interface AuditResult {
  /** Human-readable findings; empty means the audit passed. */
  readonly findings: readonly string[];
  /** The live comparison was skipped because no ruleset token was available (fork PR). */
  readonly liveAuditSkipped: boolean;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render a JSON value for a diff line, using `MISSING` for an absent field. */
function render(value: unknown): string {
  if (value === undefined) return MISSING;
  return JSON.stringify(value) ?? MISSING;
}

/** A stable text form: keys sorted, arrays sorted, so ordering never reads as drift. */
function canonicalText(value: unknown): string {
  return render(value);
}

/**
 * Canonicalize a ruleset fragment: object keys sorted, arrays sorted by their canonical
 * text. The API is free to return `rules` in another order or `include` lists in another
 * order without that counting as drift, while any value change still does.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => canonicalize(entry))
      .sort((left, right) => {
        const leftText = canonicalText(left);
        const rightText = canonicalText(right);
        return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
      });
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

/**
 * Rules compared by `type` rather than by array position: the API may return them in any
 * order, and a rule without `parameters` means "no parameters", not "parameters absent".
 */
function normalizeRules(value: unknown): unknown {
  if (!Array.isArray(value)) return canonicalize(value);
  const byType: Record<string, unknown> = {};
  for (const entry of value) {
    if (!isRecord(entry)) return canonicalize(value);
    const type = entry["type"];
    if (typeof type !== "string") return canonicalize(value);
    // WHY: keep the `parameters` level so a diff path mirrors the JSON the maintainer edits.
    byType[type] = { parameters: canonicalize(entry["parameters"] ?? {}) };
  }
  return canonicalize(byType);
}

/**
 * The comparable form of a ruleset (file or live): only the fields both sides express,
 * with keys and arrays canonicalized. Everything the API adds on its own (`id`,
 * `node_id`, timestamps, `_links`, `source`) is dropped here.
 */
export function normalizeRuleset(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("a ruleset must be a JSON object");
  const out: Record<string, unknown> = {};
  for (const field of RULESET_FIELDS) {
    const entry = value[field];
    if (entry === undefined) continue;
    out[field] = field === "rules" ? normalizeRules(entry) : canonicalize(entry);
  }
  return canonicalize(out) as Record<string, unknown>;
}

function collectDifferences(
  path: string,
  expected: unknown,
  actual: unknown,
  sink: RulesetDifference[],
): void {
  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const nextPath = path === "" ? key : `${path}.${key}`;
      const hasExpected = Object.hasOwn(expected, key);
      const hasActual = Object.hasOwn(actual, key);
      if (hasExpected && hasActual) {
        collectDifferences(nextPath, expected[key], actual[key], sink);
        continue;
      }
      sink.push({
        path: nextPath,
        expected: hasExpected ? render(expected[key]) : MISSING,
        actual: hasActual ? render(actual[key]) : MISSING,
      });
    }
    return;
  }
  if (canonicalText(expected) === canonicalText(actual)) return;
  sink.push({
    path: path === "" ? "(ruleset)" : path,
    expected: render(expected),
    actual: render(actual),
  });
}

/**
 * The fields that drifted between a ruleset file and the live ruleset. An empty array
 * means the live ruleset is semantically identical to the file (whitespace, key order,
 * array order and API-only fields do not matter).
 */
export function diffRulesets(fileRuleset: unknown, liveRuleset: unknown): RulesetDifference[] {
  const differences: RulesetDifference[] = [];
  collectDifferences("", normalizeRuleset(fileRuleset), normalizeRuleset(liveRuleset), differences);
  return differences;
}

/** The required check contexts of a normalized ruleset, sorted. */
export function requiredStatusContexts(normalized: Readonly<Record<string, unknown>>): readonly string[] {
  const rules = normalized["rules"];
  if (!isRecord(rules)) return [];
  const rule = rules["required_status_checks"];
  if (!isRecord(rule)) return [];
  const parameters = rule["parameters"];
  if (!isRecord(parameters)) return [];
  const checks = parameters["required_status_checks"];
  if (!Array.isArray(checks)) return [];
  const contexts: string[] = [];
  for (const check of checks) {
    if (!isRecord(check)) continue;
    const context = check["context"];
    if (typeof context === "string" && context !== "") contexts.push(context);
  }
  return contexts.sort();
}

/** The check-run names reported for a commit, deduplicated and sorted. */
export function checkRunNames(payload: unknown): readonly string[] {
  if (!isRecord(payload)) return [];
  const runs = payload["check_runs"];
  if (!Array.isArray(runs)) return [];
  const names = new Set<string>();
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const name = run["name"];
    if (typeof name === "string" && name !== "") names.add(name);
  }
  return [...names].sort();
}

/** Which required contexts none of the observed check-run names reports. */
export function missingContexts(
  required: readonly string[],
  observed: ReadonlySet<string>,
): readonly string[] {
  return required.filter((context) => !observed.has(context));
}

/** Parse one ruleset file, tolerating the JSONC comments the files may carry. */
export function parseRulesetFile(fileName: string, contents: string): RulesetFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(contents));
  } catch (error) {
    throw new Error(`${fileName} is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${fileName} must contain a JSON object`);
  const normalized = normalizeRuleset(parsed);
  const name = normalized["name"];
  if (typeof name !== "string" || name === "") {
    throw new Error(`${fileName} must declare a non-empty string "name"`);
  }
  return { fileName, ruleset: parsed, normalized };
}

/** Every ruleset file in the repository, sorted by file name. */
export function loadRulesetFiles(rootDir: string): readonly RulesetFile[] {
  const directory = path.join(rootDir, RULESETS_DIRECTORY);
  const fileNames = readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  if (fileNames.length === 0) {
    throw new Error(`no ruleset files found in ${directory}`);
  }
  return fileNames.map((fileName) =>
    parseRulesetFile(fileName, readFileSync(path.join(directory, fileName), "utf8")),
  );
}

/* -------------------------------------------------------------------------- */
/* GitHub client                                                              */
/* -------------------------------------------------------------------------- */

/** The subset of `fetch` the audit uses (injectable so tests never open a socket). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubApiOptions {
  /** `owner/repo`, from `GITHUB_REPOSITORY`. */
  readonly repository: string;
  /** The API root, from `GITHUB_API_URL` (GitHub Enterprise support). */
  readonly apiBase: string;
  /** Token with repository administration read access; required for the ruleset reads. */
  readonly rulesetToken: string | undefined;
  /** Token for the commit, check-run and pull-request reads (the workflow token works). */
  readonly readToken: string;
  /** Injectable for tests. */
  readonly fetchImpl?: FetchLike;
}

/** A short, terminal-safe rendering of an API error body. */
function describeFailureBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact === "") return "(empty body)";
  try {
    const parsed: unknown = JSON.parse(compact);
    if (isRecord(parsed) && typeof parsed["message"] === "string") {
      return sanitizeTerminalText(parsed["message"], { maxLength: 300 });
    }
  } catch {
    // WHY: not JSON — fall through to the raw-text rendering below.
  }
  return sanitizeTerminalText(compact, { maxLength: 300 });
}

/** A GitHub client backed by `fetch`, with no SDK or CLI dependency. */
export function createGitHubApi(options: GitHubApiOptions): GitHubApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase.replace(/\/+$/u, "");
  const request = async (endpoint: string, token: string): Promise<unknown> => {
    const url = `${apiBase}/repos/${options.repository}${endpoint}`;
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "pi-mcp-extension-ruleset-audit",
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `GET ${url} failed with ${String(response.status)}: ${describeFailureBody(body)}`,
      );
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`GET ${url} returned invalid JSON`);
    }
  };

  const read = async (endpoint: string): Promise<unknown> => request(endpoint, options.readToken);
  const readRulesets = async (endpoint: string): Promise<unknown> => {
    if (options.rulesetToken === undefined) {
      throw new Error("the ruleset comparison needs a ruleset token");
    }
    return request(endpoint, options.rulesetToken);
  };
  const shas = (payload: unknown, field: "sha" | "head"): readonly string[] => {
    if (!Array.isArray(payload)) return [];
    const result: string[] = [];
    for (const entry of payload) {
      if (!isRecord(entry)) continue;
      const value = field === "sha" ? entry["sha"] : isRecord(entry["head"]) ? entry["head"]["sha"] : undefined;
      if (typeof value === "string" && value !== "") result.push(value);
    }
    return result;
  };

  const listRulesets = async (): Promise<unknown[]> => {
    const summaries: unknown[] = [];
    for (let page = 1; page <= MAX_RULESET_PAGES; page += 1) {
      const payload = await readRulesets(
        `/rulesets?per_page=${String(RULESETS_PAGE_SIZE)}&page=${String(page)}`,
      );
      if (!Array.isArray(payload)) {
        throw new Error("the rulesets API did not return a JSON array");
      }
      summaries.push(...payload);
      if (payload.length < RULESETS_PAGE_SIZE) return summaries;
    }
    throw new Error(
      `the rulesets API returned more than ${String(MAX_RULESET_PAGES * RULESETS_PAGE_SIZE)} rulesets — pagination is not converging`,
    );
  };

  return {
    listRulesets,
    getRuleset: (id: number): Promise<unknown> => readRulesets(`/rulesets/${String(id)}`),
    async mainCommitShas(limit: number): Promise<readonly string[]> {
      return shas(await read(`/commits?sha=main&per_page=${String(limit)}`), "sha");
    },
    async pullRequestHeadShas(limit: number): Promise<readonly string[]> {
      return shas(
        await read(`/pulls?state=closed&sort=updated&direction=desc&per_page=${String(limit)}`),
        "head",
      );
    },
    async checkRunNames(sha: string): Promise<readonly string[]> {
      return checkRunNames(await read(`/commits/${sha}/check-runs?per_page=100&filter=latest`));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

function liveRulesetId(summaries: unknown, name: string): number | undefined {
  if (!Array.isArray(summaries)) {
    throw new Error("the rulesets API did not return a JSON array");
  }
  for (const summary of summaries) {
    if (!isRecord(summary)) continue;
    if (summary["name"] !== name) continue;
    const id = summary["id"];
    if (typeof id === "number") return id;
  }
  return undefined;
}

function liveRulesetNames(summaries: unknown): readonly string[] {
  if (!Array.isArray(summaries)) return [];
  return summaries.flatMap((summary) => {
    if (!isRecord(summary)) return [];
    const name = summary["name"];
    return typeof name === "string" ? [name] : [];
  });
}

function describeDifferences(fileName: string, name: string, differences: readonly RulesetDifference[]): string[] {
  if (differences.length === 0) return [];
  const lines = differences.map(
    (difference) => `    ${difference.path}: expected ${difference.expected}, live ${difference.actual}`,
  );
  return [
    `${fileName}: the live "${name}" ruleset differs from the file (${String(differences.length)} field(s)):\n${lines.join("\n")}`,
  ];
}

/** Compare every ruleset file with its live counterpart, in both directions. */
async function liveDriftFindings(
  rulesets: readonly RulesetFile[],
  api: GitHubApi,
  log: (message: string) => void,
): Promise<string[]> {
  const findings: string[] = [];
  const summaries = await api.listRulesets();
  const liveNames = new Set(liveRulesetNames(summaries));

  for (const ruleset of rulesets) {
    const name = ruleset.normalized["name"];
    if (typeof name !== "string") continue;
    const id = liveRulesetId(summaries, name);
    if (id === undefined) {
      findings.push(
        `${ruleset.fileName}: no live ruleset is named "${name}" (live rulesets: ${[...liveNames].sort().join(", ") || "none"})`,
      );
      continue;
    }
    liveNames.delete(name);
    const live = await api.getRuleset(id);
    findings.push(...describeDifferences(ruleset.fileName, name, diffRulesets(ruleset.ruleset, live)));
    log(`${ruleset.fileName} matches the live "${name}" ruleset (id ${String(id)})`);
  }

  for (const orphan of [...liveNames].sort()) {
    findings.push(
      `live ruleset "${orphan}" has no file in ${RULESETS_DIRECTORY}/ — add one so the repository declares it`,
    );
  }
  return findings;
}

/** Verify that every required check context is still reported by a recent commit. */
async function contextFindings(
  rulesets: readonly RulesetFile[],
  api: GitHubApi,
  log: (message: string) => void,
): Promise<string[]> {
  const required = [...new Set(rulesets.flatMap((ruleset) => requiredStatusContexts(ruleset.normalized)))].sort();
  if (required.length === 0) return [];

  const observed = new Set<string>();
  const mainShas = await api.mainCommitShas(RECENT_COMMIT_LIMIT);
  for (const sha of mainShas) {
    for (const name of await api.checkRunNames(sha)) observed.add(name);
  }
  // WHY: the pull-request sample exists only for the contexts that never run on `main`
  // (`pr-title`, `dependency-review`). A closed PR from a deleted fork can leave a head
  // SHA that no longer resolves in this repository; that sample contributes no names
  // instead of failing the whole audit. It is logged, never silently skipped.
  const pullRequestShas = await api.pullRequestHeadShas(RECENT_PULL_REQUEST_LIMIT);
  for (const sha of pullRequestShas) {
    try {
      for (const name of await api.checkRunNames(sha)) observed.add(name);
    } catch (error) {
      log(`skipping the check runs of pull-request head ${sha}: ${errorMessage(error)}`);
    }
  }

  const missing = missingContexts(required, observed);
  if (missing.length === 0) {
    log(
      `every required check context is reported by a recent commit (${String(mainShas.length)} commit(s) on main, ${String(pullRequestShas.length)} pull-request head(s) sampled)`,
    );
    return [];
  }
  return missing.map(
    (context) =>
      `required check context "${context}" is not reported by any check run on a recent commit — a renamed job would block every merge to main. Observed: ${[...observed].sort().join(", ") || "none"}`,
  );
}

/**
 * Run the audit. Findings are human-readable lines; the caller decides the exit code.
 * The live comparison is skipped (with `liveAuditSkipped`) only when the token is
 * unavailable and `requireLiveAudit` is false — the case of a pull request from a fork.
 */
export async function auditRulesets(options: AuditOptions): Promise<AuditResult> {
  const log = options.log ?? ((): void => undefined);
  const findings: string[] = [];

  if (!options.liveTokenAvailable) {
    if (options.requireLiveAudit) {
      findings.push(
        "RULESET_AUDIT_TOKEN is not set, so the live rulesets cannot be compared with .github/rulesets/. Create a token with repository administration read access and store it as the RULESET_AUDIT_TOKEN secret.",
      );
    } else {
      log(
        "skipping the live ruleset comparison: no RULESET_AUDIT_TOKEN (fork pull request, or the repository secret is not configured)",
      );
    }
  } else {
    findings.push(...(await liveDriftFindings(options.rulesets, options.api, log)));
  }

  findings.push(...(await contextFindings(options.rulesets, options.api, log)));
  return { findings, liveAuditSkipped: !options.liveTokenAvailable };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export interface CliOptions {
  readonly env: NodeJS.ProcessEnv;
  /** The repository checkout the ruleset files are read from. */
  readonly cwd: string;
  readonly log: (message: string) => void;
  /** Injectable for tests; the workflow uses the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /**
   * Surfaces a GitHub Actions annotation. Defaults to a `::warning::` line on stderr, so
   * a green PR check that skipped the live comparison is visible in the checks UI instead
   * of only in the step log.
   */
  readonly annotate?: (message: string) => void;
}

/**
 * Read the workflow environment, run the audit and return the process exit code.
 * Keeping the environment handling here (rather than inside the workflow's `run:` block)
 * means a missing token or a malformed ruleset file fails with a readable message
 * instead of a shell error.
 */
export async function runCli(options: CliOptions): Promise<number> {
  const log = options.log;
  const annotate = options.annotate ?? ((message: string) => console.error(`::warning::${message}`));
  try {
    const repository = nonEmpty(options.env["GITHUB_REPOSITORY"]);
    if (repository === undefined) {
      throw new Error("GITHUB_REPOSITORY is not set (expected owner/repo)");
    }
    const rulesetToken = nonEmpty(options.env["RULESET_AUDIT_TOKEN"]);
    const readToken = nonEmpty(options.env["GITHUB_TOKEN"]) ?? rulesetToken;
    if (readToken === undefined) {
      throw new Error("GITHUB_TOKEN is required to read commits and check runs");
    }
    const api = createGitHubApi({
      repository,
      apiBase: nonEmpty(options.env["GITHUB_API_URL"]) ?? "https://api.github.com",
      rulesetToken,
      readToken,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    const result = await auditRulesets({
      rulesets: loadRulesetFiles(options.cwd),
      api,
      liveTokenAvailable: rulesetToken !== undefined,
      requireLiveAudit: options.env["RULESET_AUDIT_REQUIRE_LIVE"] === "1",
      log,
    });
    if (result.liveAuditSkipped) {
      // WHY: on a pull request this check is green without having compared anything, so say
      // so next to the check itself rather than leaving the skip buried in the step log.
      annotate(
        "The live ruleset comparison was skipped (no RULESET_AUDIT_TOKEN). Dispatch the ruleset-audit workflow from main to compare the live rulesets with .github/rulesets/.",
      );
    }
    for (const finding of result.findings) log(finding);
    if (result.findings.length > 0) {
      log(`${String(result.findings.length)} finding(s) — the live repository drifted from .github/rulesets/`);
      return 1;
    }
    log(
      result.liveAuditSkipped
        ? "no findings (live comparison skipped)"
        : "no findings — the live rulesets match .github/rulesets/",
    );
    return 0;
  } catch (error) {
    log(`audit failed: ${errorMessage(error)}`);
    return 1;
  }
}

async function main(): Promise<number> {
  return runCli({
    env: process.env,
    cwd: process.cwd(),
    log: (message) => console.error(`[pi-mcp ruleset-audit] ${message}`),
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await main();
}
