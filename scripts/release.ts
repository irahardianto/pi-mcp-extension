/**
 * Release orchestration for `.github/workflows/publish.yml`.
 *
 * The release job publishes the package to npm and lands the `chore: release vX.Y.Z`
 * commit plus the `vX.Y.Z` tag on `main` through a pull request. The ordering between
 * those two actions is what keeps npm and git in sync:
 *
 * 1. The release commit and its tag land on `main` **first**.
 * 2. Only then is the package published to npm.
 *
 * WHY: the default-branch ruleset requires a pull request with the status checks,
 * and required status checks block direct pushes to `main` for everyone — on a
 * user-owned repo the GitHub Actions app cannot be a ruleset bypass actor (the API
 * returns 422). The release therefore pushes `release/v<version>`, opens
 * `chore: release v<version>`, and squash-merges the PR once the required workflows
 * passed on the branch. Only `pull_request`-event runs attach their check runs to a
 * PR, and the release PR is created by the job's `GITHUB_TOKEN`: GitHub records the
 * PR's `pull_request` workflow runs but never executes them (conclusion
 * `action_required`, no check runs), and `GITHUB_TOKEN` may not approve a workflow
 * run. `PullRequestPort.approveRequiredWorkflows` therefore approves each of those
 * runs with a dedicated PAT (`RELEASE_APPROVE_TOKEN`) so they execute and their
 * check runs satisfy the ruleset; the flow waits for exactly the run on the pushed
 * head, so an earlier attempt's run can never stand in for the current one.
 *
 * The squash merge creates a new commit on GitHub that this clone has never seen, so
 * the flow fetches again before creating the tag: `git tag v<version>` fails on an
 * object it does not have.
 *
 * If `main` moves while the release runs, the merge is rejected — non-fast-forward,
 * or a stale branch under the ruleset's required-up-to-date policy. Because nothing
 * has been published yet, the release is simply retried on the new `main` tip (the
 * release commit is recreated there). The published tarball is therefore always
 * exactly the tree that landed, and npm never holds a version that `main` does not
 * know about.
 *
 * The job is also self-healing: if a previous run left npm and git out of sync
 * (npm has a version without a tag, or a tag exists that was never published), the
 * next run repairs the divergence instead of skipping the release forever.
 *
 * Everything is expressed against the `GitPort` / `PullRequestPort` / `NpmPort`
 * interfaces so the flow can be unit tested against a real git repository with fake
 * GitHub and registry ports (see `tests/release.test.ts`).
 *
 * WHY: this module is executed by Node directly (`node scripts/release.ts`) and must
 * therefore use erasable TypeScript syntax only — Node strips the types at runtime and
 * the release job never installs dependencies (no `npm ci` with a write token).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type BumpLevel = "none" | "patch" | "minor" | "major";

export interface CommitInfo {
  readonly subject: string;
  readonly body: string;
}

/** Everything the release flow needs from git. */
export interface GitPort {
  /** Refresh remote-tracking branches and tags. */
  fetch(): void;
  /** The commit the release is based on (the tip of `origin/main`). */
  baseSha(): string;
  /** The `version` field of `package.json` at a ref, if it exists. */
  versionAt(ref: string): string | undefined;
  /** All `v*` tags known locally. */
  listTags(): string[];
  /** The closest tag reachable from a ref. */
  nearestTag(ref: string): string | undefined;
  /** Commits after `tag` (all commits up to `base` when `tag` is undefined). */
  commitsSince(tag: string | undefined, base: string): CommitInfo[];
  /** The subject line of a commit. */
  subjectAt(sha: string): string;
  /** The newest commit whose `package.json` carries the given version. */
  commitForVersion(version: string): string | undefined;
  /** Move the working tree to a commit. */
  resetHard(sha: string): void;
  /** Check out a commit without attaching to a branch. */
  checkoutDetached(sha: string): void;
  /** Write the new version into `package.json`, `package-lock.json` and `CHANGELOG.md`. */
  stageVersion(version: string, date: string): void;
  /** Commit the staged version bump and return the new commit sha. */
  commitRelease(version: string): string;
  /** Create (or move) the `v<version>` tag. */
  tag(version: string, sha: string): void;
  /** Push the `v<version>` tag. Throws when the remote rejects the push. */
  pushTag(version: string): void;
}

/** Everything the release flow needs from npm. */
export interface NpmPort {
  /** Every version currently published to the registry. */
  publishedVersions(): string[];
  /** Publish the current working tree. */
  publish(): void;
  /** Rehearse a publish without touching the registry. */
  publishDryRun(): void;
}

/**
 * Everything the release flow needs from the GitHub pull-request machinery.
 *
 * The production adapter talks to `gh`; the tests simulate the merge against a real
 * (local) git remote. A rejected merge means `main` moved while the release ran (or
 * the PR conflicts); the flow recreates the release commit on the new tip and
 * retries the whole branch/PR/checks/merge dance (see `landReleaseOnMain`).
 */
export interface PullRequestPort {
  /** Push the release commit to `refs/heads/release/v<version>` (forced: a retried attempt reuses the branch). */
  pushReleaseBranch(version: string, sha: string): void;
  /** Open the `chore: release v<version>` PR, or reuse the open PR for the branch (retitled); returns its number. */
  openReleasePullRequest(version: string): number;
  /** Approve the `pull_request` runs the release PR's bot authorship leaves pending, so they execute and attach to the PR. */
  approveRequiredWorkflows(branch: string, headSha: string): void;
  /** Wait until every approved workflow run finished successfully. Throws otherwise. */
  waitForRequiredChecks(branch: string, headSha: string): void;
  /** Squash-merge the release PR (deleting the branch) and return the merge commit sha on `main`. */
  mergeReleasePullRequest(prNumber: number, version: string): string;
}

export interface ReleaseOptions {
  readonly git: GitPort;
  readonly pullRequests: PullRequestPort;
  readonly npm: NpmPort;
  /** Rehearse only: never commit, tag, push or publish. */
  readonly dryRun?: boolean;
  /** Clock injection point (tests pin it). */
  readonly now?: () => Date;
  /** How often a rejected release-PR merge is retried on a newer `main`. */
  readonly maxPushAttempts?: number;
  readonly log?: (message: string) => void;
}

export interface ReleaseOutcome {
  /** A new release commit and tag landed on `main` (through the release PR). */
  readonly released: boolean;
  /** The version in `main` is on npm. */
  readonly published: boolean;
  /** A pre-existing divergence between npm and git was repaired. */
  readonly repaired: boolean;
  /** The version this run dealt with. */
  readonly version?: string;
}

const DEFAULT_MAX_PUSH_ATTEMPTS = 3;
const RELEASE_COMMIT_PREFIX = "chore: release v";
/** How often the thin `gh` adapter polls for a recorded workflow run to settle. */
const RUN_APPEAR_ATTEMPTS = 20;
/** Poll interval (seconds) for the release PR's workflow runs. */
const RUN_POLL_SECONDS = 15;

/**
 * The workflows whose `pull_request` runs the release PR records. Together they
 * produce exactly the check contexts required by `.github/rulesets/default-branch.json`:
 * `check (22)`, `check (24)`, `test (macos-latest)`, and `test (windows-latest)`
 * (ci.yml), `workflow-lint`, `pr-title`, `gitleaks` (secret-scan.yml), `semgrep`,
 * and `dependency-review`.
 * Keep this list in step with the ruleset's required checks; `tests/repo-policy.test.ts`
 * fails when a required context has no workflow whose run the flow approves.
 */
export const REQUIRED_WORKFLOWS: readonly string[] = [
  "ci.yml",
  "workflow-lint.yml",
  "pr-title.yml",
  "secret-scan.yml",
  "semgrep.yml",
  "dependency-review.yml",
];

/** The release branch name for a version. */
export function releaseBranchName(version: string): string {
  return `release/v${version}`;
}

/** The subset of `gh run list --json databaseId,headSha,event,status,conclusion` this module needs. */
export interface WorkflowRun {
  readonly databaseId: number;
  readonly headSha?: string;
  readonly event?: string;
  readonly status?: string;
  readonly conclusion?: string;
}

/**
 * Pick the run the release PR's own activity recorded for `headSha`.
 *
 * Only `pull_request`-event runs attach their check runs to the release PR, and the
 * flow's branch push / PR creation records exactly one of them per required workflow
 * on the pushed head. The head pins the attempt: a retried release force-pushes a new
 * commit before it can merge, so an earlier attempt's run — or a manually dispatched
 * `workflow_dispatch` run — can never stand in for this attempt's checks.
 */
export function selectPullRequestRun(
  runs: readonly WorkflowRun[],
  headSha: string,
): WorkflowRun | undefined {
  let newest: WorkflowRun | undefined;
  for (const run of runs) {
    if (run.event !== "pull_request") continue;
    if (run.headSha !== headSha) continue;
    if (newest === undefined || run.databaseId > newest.databaseId) newest = run;
  }
  return newest;
}

/**
 * Whether a run is one GitHub recorded but never executes: the `pull_request` runs a
 * `GITHUB_TOKEN`-authored PR leaves pending, in `action_required` until a PAT
 * approves them (which `GITHUB_TOKEN` may not do).
 */
export function isAwaitingApproval(run: WorkflowRun): boolean {
  return run.conclusion === "action_required";
}

/**
 * Whether a recorded run has settled into a state the flow can act on: it is queued
 * or running (someone already approved it), or completed with a real conclusion.
 * A freshly recorded run may briefly report neither.
 */
export function isSettled(run: WorkflowRun): boolean {
  if (run.status === undefined || run.status === "") return false;
  return run.status !== "completed" || (run.conclusion !== undefined && run.conclusion !== "");
}

/** Decode `gh run list` JSON output, ignoring anything malformed. */
function parseWorkflowRuns(raw: string): WorkflowRun[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // WHY: an unreadable answer means "no run has appeared yet"; the poll loop retries.
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const runs: WorkflowRun[] = [];
  for (const entry of decoded) {
    if (!isJsonObject(entry)) continue;
    const databaseId = entry["databaseId"];
    if (typeof databaseId !== "number") continue;
    // WHY: a run missing its head or event cannot be proven to be the run this flow
    // must approve, so keep only what was actually returned.
    const run: {
      databaseId: number;
      headSha?: string;
      event?: string;
      status?: string;
      conclusion?: string;
    } = { databaseId };
    const headSha = entry["headSha"];
    if (typeof headSha === "string") run.headSha = headSha;
    const event = entry["event"];
    if (typeof event === "string") run.event = event;
    const status = entry["status"];
    if (typeof status === "string") run.status = status;
    const conclusion = entry["conclusion"];
    if (typeof conclusion === "string") run.conclusion = conclusion;
    runs.push(run);
  }
  return runs;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The bump level for a set of commits. The rules are unchanged: a breaking
 * subject or a `BREAKING CHANGE:` body is major, `feat:` is minor, `fix:` and
 * `perf:` are patch, everything else is none.
 */
export function detectBump(commits: readonly CommitInfo[]): BumpLevel {
  for (const commit of commits) {
    if (/^[a-z]+(\(.+\))?!:/.test(commit.subject)) return "major";
    // WHY: the previous implementation matched the marker in the whole commit message
    // (subject and body), so a `BREAKING CHANGE:` subject counts as well.
    if (/^BREAKING[ -]CHANGE:/.test(commit.subject)) return "major";
    if (/^BREAKING[ -]CHANGE:/m.test(commit.body)) return "major";
  }
  for (const commit of commits) {
    if (/^feat(\(.+\))?:/.test(commit.subject)) return "minor";
  }
  for (const commit of commits) {
    if (/^(fix|perf)(\(.+\))?:/.test(commit.subject)) return "patch";
  }
  return "none";
}

/** Apply a bump level to a semantic version. */
export function bumpVersion(version: string, bump: BumpLevel): string {
  const parts = version.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "none":
      return version;
  }
}

/** Compare two `x.y.z` versions. */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < 3; index += 1) {
    const leftValue = Number.parseInt(leftParts[index] ?? "0", 10) || 0;
    const rightValue = Number.parseInt(rightParts[index] ?? "0", 10) || 0;
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

/** `YYYY-MM-DD` in UTC, the format used by the changelog headings. */
export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A no-op used as the default logger. */
function noop(): void {
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Process helpers                                                            */
/* -------------------------------------------------------------------------- */

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  } = {},
): RunResult {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number | undefined;
      stdout?: string | undefined;
      stderr?: string | undefined;
    };
    const result: RunResult = {
      status: typeof failure.status === "number" ? failure.status : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
    if (options.allowFailure !== true) {
      throw new Error(
        `\`${command} ${args.join(" ")}\` failed with exit code ${result.status}: ${result.stderr.trim()}`,
      );
    }
    return result;
  }
}

/**
 * WHY: the push needs an `Authorization` header for the GitHub remote. Passing it
 * through `GIT_CONFIG_*` keeps the token out of the process arguments, where it would
 * be visible in `ps` output.
 */
function pushEnvironment(): NodeJS.ProcessEnv {
  // WHY: RELEASE_TOKEN keeps the credential away from the npm CLI, which runs in the
  // same step. GITHUB_TOKEN is accepted as a fallback for local runs.
  const token = process.env["RELEASE_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (token === undefined || token === "") return {};
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: header,
  };
}

/**
 * WHY: the flow is synchronous and dependency-free; the thin `gh` adapter below is
 * the only place that waits, and it does so through a child `sleep` so no timers or
 * libraries are needed (the release job runs on ubuntu-latest).
 */
function sleep(seconds: number): void {
  execFileSync("sleep", [String(seconds)], { stdio: "ignore" });
}

/** The `owner/repo` slug, derived from the `origin` remote (used for `gh api` paths). */
function repoSlug(cwd: string): string {
  const result = run("git", ["remote", "get-url", "origin"], { cwd, allowFailure: true });
  const url = result.stdout.trim();
  const match = url.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/);
  if (result.status !== 0 || match === null || match[1] === undefined) {
    throw new Error(`could not derive the repository slug from the origin remote (${url || "no remote"})`);
  }
  return match[1];
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/** A git adapter backed by the real `git` binary. */
export function createGit(cwd: string): GitPort {
  const git = (
    args: readonly string[],
    options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
  ): RunResult => {
    const runOptions: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      allowFailure?: boolean;
    } = { cwd, env: options.env ?? process.env };
    if (options.allowFailure !== undefined) runOptions.allowFailure = options.allowFailure;
    return run("git", args, runOptions);
  };
  const trimmed = (args: readonly string[]): string => git(args).stdout.trim();

  const versionAt = (ref: string): string | undefined => {
    const result = git(["show", `${ref}:package.json`], { allowFailure: true });
    if (result.status !== 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!isJsonObject(parsed)) return undefined;
      const version = parsed["version"];
      return typeof version === "string" ? version : undefined;
    } catch {
      // WHY: a ref without a readable package.json simply has no version.
      return undefined;
    }
  };

  const ensureIdentity = (): void => {
    if (git(["config", "user.name"], { allowFailure: true }).status === 0) return;
    git(["config", "user.name", "github-actions[bot]"]);
    git(["config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
  };

  const baseSha = (): string => {
    const result = git(["rev-parse", "origin/main"], { allowFailure: true });
    if (result.status === 0) {
      const sha = result.stdout.trim();
      if (sha !== "") return sha;
    }
    return trimmed(["rev-parse", "HEAD"]);
  };

  const commitForVersion = (version: string): string | undefined => {
    const result = git(
      ["log", "--format=%H", `-S${JSON.stringify(version)}`, "origin/main", "--", "package.json"],
      { allowFailure: true },
    );
    if (result.status !== 0) return undefined;
    for (const sha of result.stdout.split("\n")) {
      const candidate = sha.trim();
      if (candidate === "") continue;
      if (versionAt(candidate) === version) return candidate;
    }
    return undefined;
  };

  return {
    fetch(): void {
      git(["fetch", "--force", "--tags", "origin"]);
    },
    baseSha,
    versionAt,
    listTags(): string[] {
      return trimmed(["tag", "--list", "v*"])
        .split("\n")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");
    },
    nearestTag(ref: string): string | undefined {
      const result = git(["describe", "--tags", "--abbrev=0", ref], { allowFailure: true });
      if (result.status !== 0) return undefined;
      const tag = result.stdout.trim();
      return tag === "" ? undefined : tag;
    },
    commitsSince(tag: string | undefined, base: string): CommitInfo[] {
      const range = tag === undefined ? base : `${tag}..${base}`;
      const raw = trimmed(["log", range, "--pretty=format:%s%x1f%b%x1e"]);
      if (raw === "") return [];
      return raw
        .split("\x1e")
        .map((entry) => entry.replace(/^\n+/, ""))
        .filter((entry) => entry.trim() !== "")
        .map((entry) => {
          const [subject = "", body = ""] = entry.split("\x1f");
          return { subject, body };
        });
    },
    subjectAt(sha: string): string {
      return trimmed(["log", "-1", "--pretty=format:%s", sha]);
    },
    commitForVersion,
    resetHard(sha: string): void {
      git(["reset", "--hard", sha]);
    },
    checkoutDetached(sha: string): void {
      git(["checkout", "--detach", sha]);
    },
    stageVersion(version: string, date: string): void {
      writeVersion(path.join(cwd, "package.json"), version);
      writeVersion(path.join(cwd, "package-lock.json"), version);
      writeChangelogHeading(path.join(cwd, "CHANGELOG.md"), version, date);
    },
    commitRelease(version: string): string {
      ensureIdentity();
      for (const file of ["package.json", "package-lock.json", "CHANGELOG.md"]) {
        git(["add", "-A", "--", file], { allowFailure: true });
      }
      // WHY: `git diff --cached --quiet` only reports the staged version bump. A dirty
      // working tree (untracked build output, for example) must not turn into a commit.
      if (git(["diff", "--cached", "--quiet"], { allowFailure: true }).status === 0) {
        return trimmed(["rev-parse", "HEAD"]);
      }
      git(["-c", "commit.gpgsign=false", "commit", "-m", `${RELEASE_COMMIT_PREFIX}${version}`]);
      return trimmed(["rev-parse", "HEAD"]);
    },
    tag(version: string, sha: string): void {
      git(["tag", "-f", `v${version}`, sha]);
    },
    pushTag(version: string): void {
      git(["push", "origin", `v${version}`], { env: { ...process.env, ...pushEnvironment() } });
    },
  };
}

/**
 * A `PullRequestPort` backed by the `gh` CLI (available on GitHub runners).
 *
 * WHY: the flow itself never talks to `gh`; this adapter is the only I/O seam, so the
 * tests drive the flow with a fake port (see tests/release.test.ts) and the adapter
 * is exercised for real only by an actual release.
 */
export function createPullRequests(cwd: string): PullRequestPort {
  // WHY: gh reads GH_TOKEN; RELEASE_TOKEN keeps the credential away from the npm CLI
  // that runs in the same job (see pushEnvironment).
  const token = process.env["RELEASE_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  const ghEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GH_TOKEN: token ?? "" });
  const gh = (args: readonly string[], allowFailure = false): RunResult =>
    run("gh", [...args], { cwd, env: ghEnv(), allowFailure });
  const ok = (args: readonly string[]): string => {
    const result = gh(args, true);
    if (result.status !== 0) {
      throw new Error(`\`gh ${args.join(" ")}\` failed with exit code ${result.status}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  };
  // WHY: the run each branch/workflow approved, keyed for the wait step. The head sha
  // pins the attempt, so no baseline bookkeeping is needed: a retried release
  // force-pushes a new commit, and only this attempt's `pull_request` run on the
  // pushed head counts.
  const approvedRuns = new Map<string, number>();
  const runKey = (branch: string, workflow: string): string => `${branch}\u0000${workflow}`;
  const listRuns = (workflow: string, branch: string): WorkflowRun[] =>
    parseWorkflowRuns(
      ok([
        "run",
        "list",
        "--workflow",
        workflow,
        "--branch",
        branch,
        "--limit",
        "50",
        "--json",
        "databaseId,headSha,event,status,conclusion",
      ]),
    );
  // WHY: approving a workflow run needs a PAT — GitHub rejects GITHUB_TOKEN (a
  // workflow must never approve runs, including its own PR's), and RELEASE_TOKEN *is*
  // the job's GITHUB_TOKEN. The token must not reach the npm CLI (see
  // pushEnvironment); it is only ever passed to `gh`.
  const approveToken = process.env["RELEASE_APPROVE_TOKEN"];
  const approveRun = (runId: number): void => {
    if (approveToken === undefined) {
      throw new Error(
        "RELEASE_APPROVE_TOKEN is not set: the release PR's pull_request runs cannot be approved (a fine-grained PAT with Actions write access is required; GITHUB_TOKEN may not approve workflow runs)",
      );
    }
    const result = run(
      "gh",
      ["api", "--method", "POST", `repos/${repoSlug(cwd)}/actions/runs/${runId}/approve`],
      { cwd, env: { ...process.env, GH_TOKEN: approveToken }, allowFailure: true },
    );
    if (result.status !== 0) {
      throw new Error(
        `\`gh api repos/${repoSlug(cwd)}/actions/runs/${runId}/approve\` failed with exit code ${result.status}: ${result.stderr.trim()}`,
      );
    }
  };

  return {
    pushReleaseBranch(version: string, sha: string): void {
      // WHY: --force: a previously failed attempt may have left the branch behind;
      // release/* branches are not protected by any ruleset.
      run("git", ["push", "--force", "origin", `${sha}:refs/heads/${releaseBranchName(version)}`], {
        cwd,
        env: { ...process.env, ...pushEnvironment() },
      });
    },
    openReleasePullRequest(version: string): number {
      const title = `${RELEASE_COMMIT_PREFIX}${version}`;
      // WHY: the body is static; the release commit itself carries the version bump.
      const body =
        "Automated release PR. The publish workflow approves this branch's required status-check runs (they sit pending because the PR is opened with GITHUB_TOKEN) and squash-merges once they pass.";
      const created = gh(
        ["pr", "create", "--base", "main", "--head", releaseBranchName(version), "--title", title, "--body", body],
        true,
      );
      if (created.status === 0) {
        const url = created.stdout.trim();
        const number = Number.parseInt(url.slice(url.lastIndexOf("/") + 1), 10);
        if (Number.isInteger(number)) return number;
        throw new Error(`unexpected \`gh pr create\` output: ${url}`);
      }
      // WHY: a retry after a rejected merge reuses the branch; retitle the open PR so
      // the squash-merge subject always matches the released version.
      const listed = ok([
        "pr",
        "list",
        "--head",
        releaseBranchName(version),
        "--state",
        "open",
        "--json",
        "number",
        "--jq",
        ".[0].number // empty",
      ]);
      if (listed === "") {
        throw new Error(`could not create or find the release PR: ${created.stderr.trim()}`);
      }
      const prNumber = Number.parseInt(listed, 10);
      if (!Number.isInteger(prNumber)) {
        throw new Error(`unexpected \`gh pr list\` output: ${listed}`);
      }
      ok(["pr", "edit", String(prNumber), "--title", title, "--body", body]);
      return prNumber;
    },
    approveRequiredWorkflows(branch: string, headSha: string): void {
      for (const workflow of REQUIRED_WORKFLOWS) {
        // WHY: the run is recorded a second or two after the PR activity that caused
        // it; poll until the run on the pushed head settles into a state the flow can
        // act on.
        let run: WorkflowRun | undefined;
        for (let attempt = 0; attempt < RUN_APPEAR_ATTEMPTS && run === undefined; attempt += 1) {
          const candidate = selectPullRequestRun(listRuns(workflow, branch), headSha);
          if (candidate !== undefined && isSettled(candidate)) run = candidate;
          else sleep(RUN_POLL_SECONDS);
        }
        if (run === undefined) {
          throw new Error(
            `workflow ${workflow} has no pull_request run on ${branch} at ${headSha.slice(0, 8)} — the release PR's checks cannot be satisfied`,
          );
        }
        approvedRuns.set(runKey(branch, workflow), run.databaseId);
        // WHY: only a run GitHub recorded but never executes needs approving; one
        // already queued, running, or completed is watched as-is.
        if (isAwaitingApproval(run)) approveRun(run.databaseId);
      }
    },
    waitForRequiredChecks(branch: string, headSha: string): void {
      for (const workflow of REQUIRED_WORKFLOWS) {
        const runId = approvedRuns.get(runKey(branch, workflow));
        if (runId === undefined) {
          throw new Error(`workflow ${workflow} on ${branch}@${headSha.slice(0, 8)} was not approved`);
        }
        // WHY: --exit-status fails this step when the run fails.
        ok(["run", "watch", String(runId), "--exit-status", "--interval", String(RUN_POLL_SECONDS)]);
      }
    },
    mergeReleasePullRequest(prNumber: number, version: string): string {
      ok([
        "pr",
        "merge",
        String(prNumber),
        "--squash",
        "--delete-branch",
        "--subject",
        `${RELEASE_COMMIT_PREFIX}${version}`,
      ]);
      const mergeSha = ok(["api", `repos/${repoSlug(cwd)}/pulls/${prNumber}`, "--jq", ".merge_commit_sha // empty"]);
      if (mergeSha === "") {
        throw new Error(`no merge commit for PR #${prNumber}`);
      }
      return mergeSha;
    },
  };
}

function writeVersion(file: string, version: string): void {
  if (!existsSync(file)) return;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isJsonObject(parsed)) return;
  parsed["version"] = version;
  if (file.endsWith("package-lock.json")) {
    const packages = parsed["packages"];
    if (isJsonObject(packages)) {
      const root = packages[""];
      if (isJsonObject(root)) root["version"] = version;
    }
  }
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

function writeChangelogHeading(file: string, version: string, date: string): void {
  if (!existsSync(file)) return;
  const changelog = readFileSync(file, "utf8");
  if (changelog.includes(`## [${version}]`)) return;
  const marker = "## [Unreleased]";
  const heading = `\n\n## [${version}] - ${date}`;
  const index = changelog.indexOf(marker);
  if (index < 0) {
    writeFileSync(file, `${changelog.trimEnd()}\n${heading.trimStart()}\n`);
    return;
  }
  const updated = `${changelog.slice(0, index + marker.length)}${heading}${changelog.slice(index + marker.length)}`;
  writeFileSync(file, updated);
}

/** An npm adapter backed by the real `npm` binary. */
export function createNpm(cwd: string): NpmPort {
  const parsed: unknown = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  if (!isJsonObject(parsed) || typeof parsed["name"] !== "string") {
    throw new Error("package.json does not contain a package name");
  }
  const packageName = parsed["name"];
  return {
    publishedVersions(): string[] {
      const result = run("npm", ["view", packageName, "versions", "--json"], {
        cwd,
        allowFailure: true,
      });
      if (result.status !== 0) return [];
      try {
        const decoded: unknown = JSON.parse(result.stdout);
        if (Array.isArray(decoded)) {
          return decoded.filter((entry): entry is string => typeof entry === "string");
        }
        if (typeof decoded === "string") return [decoded];
        return [];
      } catch {
        // WHY: an unparsable registry answer means "no published versions known".
        return [];
      }
    },
    publish(): void {
      run("npm", ["publish", "--access", "public", "--provenance"], { cwd });
    },
    publishDryRun(): void {
      run("npm", ["publish", "--access", "public", "--provenance", "--dry-run"], { cwd });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Release flow                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Land the release commit for `version` on `main` through a pull request.
 *
 * The release commit is created on the current `origin/main` tip, pushed to
 * `release/v<version>`, and squash-merged once the required workflows passed on
 * the branch. A rejected merge means `main` moved while the release ran: the
 * release commit is recreated on the new tip (the bump is *not* recomputed; a
 * commit that lands mid-release is picked up by the next run's scan) and the
 * branch, PR and checks are retried.
 */
function landReleaseOnMain(
  git: GitPort,
  pullRequests: PullRequestPort,
  version: string,
  date: string,
  attempts: number,
  log: (message: string) => void,
): string {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    git.fetch();
    const base = git.baseSha();
    git.resetHard(base);
    git.stageVersion(version, date);
    const sha = git.commitRelease(version);
    const branch = releaseBranchName(version);
    pullRequests.pushReleaseBranch(version, sha);
    const prNumber = pullRequests.openReleasePullRequest(version);
    pullRequests.approveRequiredWorkflows(branch, sha);
    pullRequests.waitForRequiredChecks(branch, sha);
    let mergeSha: string;
    try {
      mergeSha = pullRequests.mergeReleasePullRequest(prNumber, version);
    } catch (error) {
      log(
        `merge of the release PR #${prNumber} was rejected (attempt ${attempt}/${attempts}) — retrying on the latest main`,
      );
      if (attempt === attempts) throw error;
      continue;
    }
    // WHY: a squash merge creates a brand-new commit on GitHub. This clone has never
    // seen it, and `git tag <sha>` refuses an object it does not have, so fetch the
    // commit that landed before creating the tag. The version check doubles as proof
    // that the fetched commit is the release tree and not an unrelated sha.
    git.fetch();
    const mergedVersion = git.versionAt(mergeSha);
    if (mergedVersion !== version) {
      throw new Error(
        `the release PR merged as ${mergeSha}, whose package.json reports ${
          mergedVersion ?? "no version"
        } instead of ${version}`,
      );
    }
    return mergeSha;
  }
  throw new Error("could not land the release on main");
}

/**
 * Push a tag, retrying a rejected push. The tag never moves: it points at the commit
 * that is already on `main`.
 */
function pushTagWithRetry(
  git: GitPort,
  version: string,
  sha: string,
  attempts: number,
  log: (message: string) => void,
): void {
  git.tag(version, sha);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      git.pushTag(version);
      return;
    } catch (error) {
      log(`push of the release tag was rejected (attempt ${attempt}/${attempts})`);
      if (attempt === attempts) throw error;
    }
  }
}

/**
 * Run the release flow.
 *
 * The flow is deliberately split into three phases so that any divergence between npm
 * and git is repaired before a new version is released:
 *
 * 1. **Repair (npm ahead of git)** — npm holds a version that git has no tag for
 *    (a release that published but could not push). The release commit and tag are
 *    recreated so git catches up with npm.
 * 2. **Repair (git ahead of npm)** — the tip of `main` carries a release commit whose
 *    version is not on npm (a release that pushed but could not publish, or a tag push
 *    that failed). The missing tag is created and the version is published.
 * 3. **Release** — the commits since the last tag decide the bump. The release commit
 *    and its tag land on `main` (through the release PR) first; only then is the
 *    package published.
 */
export function runRelease(options: ReleaseOptions): ReleaseOutcome {
  const { git, npm } = options;
  const dryRun = options.dryRun === true;
  const maxPushAttempts = options.maxPushAttempts ?? DEFAULT_MAX_PUSH_ATTEMPTS;
  const log = options.log ?? noop;
  const date = formatUtcDate(options.now?.() ?? new Date());

  git.fetch();
  const published = new Set(npm.publishedVersions());
  const tags = new Set(git.listTags());
  let repaired = false;

  const tipSha = git.baseSha();
  let tipVersion = git.versionAt(tipSha) ?? "0.0.0";

  if (dryRun) {
    const base = git.baseSha();
    const baseVersion = git.versionAt(base);
    if (baseVersion === undefined) {
      log("package.json has no version — nothing to rehearse");
      return { released: false, published: false, repaired: false };
    }
    const bump = detectBump(git.commitsSince(git.nearestTag(base), base));
    // Dry-run rehearsal: when nothing is release-worthy, rehearse a patch bump so the
    // rehearsal still exercises version stamping, package inspection and a dry-run publish.
    const rehearsed = bump === "none" ? "patch" : bump;
    const target = bumpVersion(baseVersion, rehearsed);
    git.resetHard(base);
    git.stageVersion(target, date);
    log(`dry run: would release ${target} (bump ${rehearsed})`);
    npm.publishDryRun();
    return { released: false, published: false, repaired: false, version: target };
  }

  // Phase 1 — npm holds a version that git has no tag for.
  const ahead = [...published]
    .filter((version) => !tags.has(`v${version}`) && compareVersions(version, tipVersion) > 0)
    .sort(compareVersions)
    .pop();
  if (ahead !== undefined) {
    log(`npm has ${ahead} but git has no tag for it — repairing the git history`);
    // WHY: the repair commit must also land through a PR (required status checks on
    // `main` block direct pushes).
    const mergeSha = landReleaseOnMain(git, options.pullRequests, ahead, date, maxPushAttempts, log);
    pushTagWithRetry(git, ahead, mergeSha, maxPushAttempts, log);
    tags.add(`v${ahead}`);
    tipVersion = ahead;
    repaired = true;
  }

  // Phase 2 — git holds a release commit that npm never received.
  const releaseCommit = git.commitForVersion(tipVersion);
  const isReleaseCommit =
    releaseCommit !== undefined &&
    git.subjectAt(releaseCommit) === `${RELEASE_COMMIT_PREFIX}${tipVersion}`;
  if (isReleaseCommit) {
    if (!tags.has(`v${tipVersion}`)) {
      log(`git has release commit ${tipVersion} without a tag — creating the missing tag`);
      pushTagWithRetry(git, tipVersion, releaseCommit, maxPushAttempts, log);
      tags.add(`v${tipVersion}`);
      repaired = true;
    }
    if (!published.has(tipVersion)) {
      log(`version ${tipVersion} is tagged but not published — publishing it`);
      git.checkoutDetached(releaseCommit);
      npm.publish();
      published.add(tipVersion);
    }
  }

  // Phase 3 — release the commits that landed since the last tag.
  git.fetch();
  const base = git.baseSha();
  const baseVersion = git.versionAt(base);
  const bump =
    baseVersion === undefined ? "none" : detectBump(git.commitsSince(git.nearestTag(base), base));
  if (baseVersion === undefined) {
    log("package.json has no version — nothing to release");
  } else if (bump === "none") {
    log("no release-worthy commits since the last tag");
  } else {
    const target = bumpVersion(baseVersion, bump);
    if (published.has(target)) {
      log(`${target} is already published — nothing to publish`);
    } else {
      // The release commit and its tag land on `main` before anything is published.
      // WHY: the version is computed once; a commit that lands on `main` mid-release
      // is picked up by the next run's scan instead of recomputing the bump here.
      const mergeSha = landReleaseOnMain(git, options.pullRequests, target, date, maxPushAttempts, log);
      pushTagWithRetry(git, target, mergeSha, maxPushAttempts, log);

      // Phase 3b — the commit and its tag are on `main`; publishing now keeps npm and
      // git in sync. A failure here is repaired by the next run (phase 2).
      log(`publishing ${target}`);
      npm.publish();
      published.add(target);

      return { released: true, published: true, repaired, version: target };
    }
  }

  return { released: false, published: published.has(tipVersion), repaired };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function runCli(): void {
  const log = (message: string): void => {
    console.error(`[pi-mcp release] ${message}`);
  };
  const outcome = runRelease({
    git: createGit(process.cwd()),
    pullRequests: createPullRequests(process.cwd()),
    npm: createNpm(process.cwd()),
    dryRun: process.env["DRY_RUN"] === "true",
    log,
  });
  log(
    outcome.released
      ? `released ${outcome.version ?? "unknown"}`
      : `nothing released${outcome.repaired ? " (repaired an npm/git divergence)" : ""}`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  runCli();
}
