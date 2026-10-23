/**
 * Tests for scripts/release.ts — the release flow behind .github/workflows/publish.yml.
 *
 * The tests drive the real git adapter against a real (local) repository so the
 * race that issue #82 describes — `main` moving while a release runs — is exercised
 * for real, and pair it with a fake pull-request port and a fake npm registry so the
 * GitHub and npm sides are deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bumpVersion,
  compareVersions,
  createGit,
  detectBump,
  runRelease,
  REQUIRED_WORKFLOWS,
  selectDispatchedRun,
  type CommitInfo,
  type GitPort,
  type NpmPort,
  type PullRequestPort,
  type WorkflowRun,
} from "../scripts/release.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface Fixture {
  readonly root: string;
  readonly remote: string;
  readonly workspace: string;
  readonly other: string;
  readonly server: string;
  readonly otherSha: string;
}

function writePackageFiles(dir: string, version: string): void {
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "pi-mcp-extension", version }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "pi-mcp-extension",
        version,
        lockfileVersion: 3,
        packages: { "": { name: "pi-mcp-extension", version } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n### Added\n- the first feature\n",
  );
}

/**
 * A bare "remote" with a working clone and a second clone that can push a concurrent
 * commit to `main` while the release runs.
 */
function createFixture(options: { withFeature?: boolean } = {}): Fixture {
  const withFeature = options.withFeature ?? true;
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-release-"));
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  const other = path.join(root, "other");

  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, workspace], { stdio: "ignore" });
  git(workspace, ["config", "user.name", "Release Test"]);
  git(workspace, ["config", "user.email", "release@example.com"]);
  git(workspace, ["config", "commit.gpgsign", "false"]);
  // WHY: keep the fixture byte-identical on every platform.
  git(workspace, ["config", "core.autocrlf", "false"]);

  writePackageFiles(workspace, "1.0.0");
  git(workspace, ["add", "-A"]);
  git(workspace, ["commit", "-m", "chore: init"]);
  git(workspace, ["tag", "v1.0.0"]);
  git(workspace, ["push", "origin", "main"]);
  git(workspace, ["push", "origin", "v1.0.0"]);

  if (withFeature) {
    writeFileSync(path.join(workspace, "feature.txt"), "the feature\n");
    git(workspace, ["add", "-A"]);
    git(workspace, ["commit", "-m", "feat: add the feature"]);
    git(workspace, ["push", "origin", "main"]);
  }

  execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
  git(other, ["config", "user.name", "Other Test"]);
  git(other, ["config", "user.email", "other@example.com"]);
  git(other, ["config", "commit.gpgsign", "false"]);
  git(other, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(other, "unrelated.txt"), "unrelated\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-m", "fix: an unrelated change"]);

  // WHY: a third clone plays GitHub's server. The simulated squash merge is created
  // there, so the release workspace has never seen the merge commit until it fetches —
  // exactly like the runner after `gh pr merge`.
  const server = path.join(root, "server");
  execFileSync("git", ["clone", remote, server], { stdio: "ignore" });
  git(server, ["config", "user.name", "GitHub"]);
  git(server, ["config", "user.email", "github@example.com"]);
  git(server, ["config", "commit.gpgsign", "false"]);
  git(server, ["config", "core.autocrlf", "false"]);

  return { root, remote, workspace, other, server, otherSha: git(other, ["rev-parse", "HEAD"]).trim() };
}

class FakeNpm implements NpmPort {
  readonly published = new Set<string>();
  publishCount = 0;
  dryRunCount = 0;
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  publishedVersions(): string[] {
    return [...this.published];
  }

  publish(): void {
    const raw = readFileSync(path.join(this.cwd, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    assert.ok(typeof parsed === "object" && parsed !== null);
    const version = (parsed as { version?: unknown })["version"];
    assert.equal(typeof version, "string");
    this.published.add(version as string);
    this.publishCount += 1;
  }

  publishDryRun(): void {
    this.dryRunCount += 1;
  }
}

/** A git command that is allowed to fail; the status and stderr are returned. */
function gitAllowFailure(cwd: string, args: string[]): { status: number; stderr: string } {
  try {
    git(cwd, args);
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return {
      status: typeof failure.status === "number" ? failure.status : 1,
      stderr: failure.stderr ?? "",
    };
  }
}

/**
 * A `PullRequestPort` that simulates GitHub against the local bare remote.
 *
 * The simulated squash merge behaves like GitHub's: it creates a brand-new commit on
 * the "server" clone whose tree is the PR head's tree and whose parent is the `main`
 * tip the PR was opened against, then pushes it to `main`. The release workspace
 * therefore does not have the merge commit until it fetches. A push that is no longer
 * fast-forward is rejected exactly like a real merge under the ruleset's
 * required-up-to-date policy, which is how the tests exercise the mid-release race.
 */
class FakePullRequests implements PullRequestPort {
  readonly pushedBranches: string[] = [];
  readonly openedTitles: string[] = [];
  readonly dispatched: string[] = [];
  readonly waited: string[] = [];
  readonly merges: string[] = [];
  mergeAttempts = 0;
  /** Reject every simulated merge, as a branch required-checks rule would. */
  rejectMerges = false;
  /** Reject every simulated check wait, as a failing required check would. */
  rejectChecks = false;
  /** Runs once right before the first simulated merge (the race hook). */
  beforeFirstMerge: (() => void) | undefined;

  private readonly cwd: string;
  private readonly server: string;
  private nextNumber = 1;
  private readonly branchHeads = new Map<string, string>();
  private readonly branchBases = new Map<string, string>();

  constructor(cwd: string, server: string) {
    this.cwd = cwd;
    this.server = server;
  }

  pushReleaseBranch(version: string, sha: string): void {
    this.pushedBranches.push(`release/v${version}`);
    this.branchHeads.set(version, sha);
    // The PR is opened against the `main` tip the release was based on.
    this.branchBases.set(version, git(this.cwd, ["rev-parse", "origin/main"]).trim());
    git(this.cwd, ["push", "--force", "origin", `${sha}:refs/heads/release/v${version}`]);
  }

  openReleasePullRequest(version: string): number {
    this.openedTitles.push(`chore: release v${version}`);
    return this.nextNumber++;
  }

  dispatchRequiredWorkflows(branch: string): void {
    for (const workflow of REQUIRED_WORKFLOWS) {
      this.dispatched.push(`${workflow}@${branch}`);
    }
  }

  waitForRequiredChecks(branch: string): void {
    this.waited.push(branch);
    if (this.rejectChecks) {
      throw new Error(`required checks failed on ${branch}`);
    }
  }

  mergeReleasePullRequest(prNumber: number, version: string): string {
    this.mergeAttempts += 1;
    if (this.beforeFirstMerge !== undefined) {
      const hook = this.beforeFirstMerge;
      this.beforeFirstMerge = undefined;
      hook();
    }
    if (this.rejectMerges) {
      throw new Error(`merge of PR #${prNumber} was rejected`);
    }
    const head = this.branchHeads.get(version);
    const base = this.branchBases.get(version);
    assert.ok(head !== undefined, "the release branch was pushed before merging");
    assert.ok(base !== undefined, "the release branch recorded its base before merging");
    git(this.server, ["fetch", "--force", "origin"]);
    const tree = git(this.server, ["rev-parse", `${head}^{tree}`]).trim();
    const mergeSha = git(this.server, [
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      `chore: release v${version} (#${prNumber})`,
    ]).trim();
    const result = gitAllowFailure(this.server, ["push", "origin", `${mergeSha}:main`]);
    if (result.status !== 0) {
      throw new Error(`merge of PR #${prNumber} was rejected: ${result.stderr.trim()}`);
    }
    this.merges.push(`#${prNumber} v${version}`);
    git(this.server, ["push", "origin", "--delete", `release/v${version}`]);
    return mergeSha;
  }
}

/** Reject every tag push, as a broken tag refspec would. */
function rejectTagPushes(gitPort: GitPort): GitPort {
  return new Proxy(gitPort, {
    get(target, property, receiver) {
      if (property === "pushTag") {
        return (): void => {
          throw new Error("rejected (tag refspec)");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function remoteVersion(remote: string): string {
  const raw = git(remote, ["show", "main:package.json"]);
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === "object" && parsed !== null);
  const version = (parsed as { version?: unknown })["version"];
  assert.equal(typeof version, "string");
  return version as string;
}

function remoteTags(remote: string): string[] {
  return git(remote, ["tag", "--list"])
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

function remoteBranches(remote: string): string[] {
  return git(remote, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch !== "");
}

describe("detectBump", () => {
  const commit = (subject: string, body = ""): CommitInfo => ({ subject, body });

  it("maps conventional commits to bump levels", () => {
    assert.equal(detectBump([commit("feat: add a thing")]), "minor");
    assert.equal(detectBump([commit("fix(scope): repair a thing")]), "patch");
    assert.equal(detectBump([commit("perf: speed a thing up")]), "patch");
    assert.equal(detectBump([commit("docs: describe a thing")]), "none");
    assert.equal(detectBump([commit("chore: release v1.2.3")]), "none");
  });

  it("treats a breaking subject or body as a major bump", () => {
    assert.equal(detectBump([commit("feat!: drop a thing")]), "major");
    assert.equal(detectBump([commit("feat(scope)!: drop a thing")]), "major");
    assert.equal(detectBump([commit("fix: a thing", "BREAKING CHANGE: it is")]), "major");
    assert.equal(detectBump([commit("BREAKING CHANGE: it is")]), "major");
  });

  it("prefers the highest bump level in the range", () => {
    assert.equal(detectBump([commit("fix: a"), commit("feat: b")]), "minor");
    assert.equal(detectBump([commit("feat: a"), commit("feat!: b")]), "major");
  });
});

describe("bumpVersion", () => {
  it("increments the matching component", () => {
    assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
    assert.equal(bumpVersion("1.2.3", "none"), "1.2.3");
  });
});

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });
});

describe("selectDispatchedRun", () => {
  const run = (databaseId: number, headSha?: string): WorkflowRun =>
    headSha === undefined ? { databaseId } : { databaseId, headSha };

  it("returns the run created by the dispatch", () => {
    assert.deepEqual(selectDispatchedRun([run(11), run(12)], 11), run(12));
  });

  it("returns nothing until a run newer than the dispatch baseline exists", () => {
    assert.equal(selectDispatchedRun([], 11), undefined);
    assert.equal(selectDispatchedRun([run(10), run(11)], 11), undefined);
  });

  it("never accepts a completed run left by an earlier attempt", () => {
    // WHY: a retried release re-dispatches on the same branch. The runs of the failed
    // attempt are exactly the ones a retry must not mistake for its own checks.
    const stale = [run(7), run(8), run(9)];
    assert.equal(selectDispatchedRun(stale, 9), undefined);
  });

  it("prefers the newest run when several appeared", () => {
    assert.deepEqual(selectDispatchedRun([run(13), run(12), run(14)], 11), run(14));
  });

  it("ignores a run above the baseline whose head is not the dispatched head", () => {
    // WHY: the baseline is a snapshot of `gh run list`; a stale run that registers
    // after the snapshot has an id above the baseline but still carries the old
    // branch head, because a retry force-pushes the branch before re-dispatching.
    const stale = run(12, "old-head");
    assert.equal(selectDispatchedRun([stale], 11, "new-head"), undefined);
    assert.deepEqual(selectDispatchedRun([stale, run(13, "new-head")], 11, "new-head"), run(13, "new-head"));
  });

  it("prefers the newest run on the dispatched head when several match", () => {
    const runs = [run(12, "new-head"), run(13, "old-head"), run(14, "new-head")];
    assert.deepEqual(selectDispatchedRun(runs, 11, "new-head"), run(14, "new-head"));
  });

  it("matches by id alone when the dispatched head is unknown", () => {
    assert.deepEqual(selectDispatchedRun([run(12)], 11), run(12));
    assert.deepEqual(selectDispatchedRun([run(12, "any-head")], 11), run(12, "any-head"));
  });
});

describe("runRelease", () => {
  it("lands the release commit and its tag through a pull request before publishing", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        pullRequests,
        npm,
        now: () => new Date("2026-10-21T00:00:00Z"),
      });

      assert.equal(outcome.released, true);
      assert.equal(outcome.published, true);
      assert.equal(outcome.version, "1.1.0");
      assert.equal(npm.publishCount, 1);
      assert.deepEqual([...npm.published], ["1.1.0"]);

      // The release landed through a PR: pushed branch, dispatched checks, one merge.
      assert.deepEqual(pullRequests.pushedBranches, ["release/v1.1.0"]);
      assert.deepEqual(pullRequests.openedTitles, ["chore: release v1.1.0"]);
      assert.deepEqual(
        pullRequests.dispatched,
        REQUIRED_WORKFLOWS.map((workflow) => `${workflow}@release/v1.1.0`),
      );
      assert.deepEqual(pullRequests.waited, ["release/v1.1.0"]);
      assert.deepEqual(pullRequests.merges, ["#1 v1.1.0"]);
      // The merged release branch is deleted, like --delete-branch.
      assert.deepEqual(remoteBranches(fixture.remote), ["main"]);

      assert.equal(remoteVersion(fixture.remote), "1.1.0");
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0", "v1.1.0"]);
      assert.equal(
        git(fixture.remote, ["rev-parse", "v1.1.0"]).trim(),
        git(fixture.remote, ["rev-parse", "main"]).trim(),
      );
      // WHY: the squash merge created a commit the workspace had never seen; the flow
      // must fetch it before tagging, so `origin/main` points at the tagged commit.
      assert.equal(
        git(fixture.workspace, ["rev-parse", "origin/main"]).trim(),
        git(fixture.remote, ["rev-parse", "main"]).trim(),
      );

      const changelog = git(fixture.remote, ["show", "main:CHANGELOG.md"]);
      assert.match(changelog, /## \[1\.1\.0\] - 2026-10-21/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("keeps npm and git in sync when main moves during the release", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      // Push the concurrent commit right before the first simulated merge, so the
      // merge is rejected as non-fast-forward and the release must be retried.
      pullRequests.beforeFirstMerge = (): void => {
        git(fixture.other, ["push", "origin", "main"]);
      };
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        pullRequests,
        npm,
        now: () => new Date("2026-10-21T00:00:00Z"),
      });

      assert.equal(outcome.released, true);
      assert.equal(outcome.published, true);
      assert.equal(outcome.version, "1.1.0");
      assert.equal(npm.publishCount, 1);

      // The release was recreated on top of the commit that landed during the run.
      assert.equal(
        git(fixture.remote, ["rev-parse", "main^"]).trim(),
        fixture.otherSha,
      );
      assert.equal(remoteVersion(fixture.remote), "1.1.0");
      assert.equal(
        git(fixture.remote, ["rev-parse", "v1.1.0"]).trim(),
        git(fixture.remote, ["rev-parse", "main"]).trim(),
      );
      assert.deepEqual([...npm.published], ["1.1.0"]);
      // The retry recreated the release commit on the new tip and re-ran the checks.
      assert.deepEqual(pullRequests.pushedBranches, ["release/v1.1.0", "release/v1.1.0"]);
      assert.equal(pullRequests.mergeAttempts, 2);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("publishes nothing when the release PR cannot be merged", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      pullRequests.rejectMerges = true;
      assert.throws(
        () =>
          runRelease({
            git: createGit(fixture.workspace),
            pullRequests,
            npm,
            maxPushAttempts: 2,
          }),
        /merge of PR #[0-9]+ was rejected/,
      );

      // Nothing reached npm: the version only exists once the PR is merged and tagged.
      assert.equal(npm.publishCount, 0);
      assert.equal(npm.published.size, 0);
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0"]);
      assert.equal(remoteVersion(fixture.remote), "1.0.0");
      // The failed attempts left the release branch behind for the next run to reuse.
      assert.equal(pullRequests.mergeAttempts, 2);
      assert.deepEqual(remoteBranches(fixture.remote).sort(), ["main", "release/v1.1.0"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("publishes nothing when the required checks on the release PR fail", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      pullRequests.rejectChecks = true;
      assert.throws(
        () =>
          runRelease({
            git: createGit(fixture.workspace),
            pullRequests,
            npm,
          }),
        /required checks failed/,
      );

      // Nothing reached npm and nothing landed on main; the release branch stays
      // behind and the next run retries on a fresh release commit.
      assert.equal(npm.publishCount, 0);
      assert.equal(remoteVersion(fixture.remote), "1.0.0");
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0"]);
      assert.deepEqual(remoteBranches(fixture.remote).sort(), ["main", "release/v1.1.0"]);
      assert.equal(pullRequests.mergeAttempts, 0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("publishes nothing when the release tag cannot be pushed", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      assert.throws(
        () =>
          runRelease({
            git: rejectTagPushes(createGit(fixture.workspace)),
            pullRequests,
            npm,
            maxPushAttempts: 2,
          }),
        /rejected/,
      );

      // The version only reaches npm once its tag is on main.
      assert.equal(npm.publishCount, 0);
      assert.equal(npm.published.size, 0);
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0"]);
      // The release commit is on main (through the PR), so the next run can repair
      // the missing tag.
      assert.equal(remoteVersion(fixture.remote), "1.1.0");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("repairs git when npm already holds a version without a tag", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      npm.published.add("1.1.0");

      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        pullRequests,
        npm,
        now: () => new Date("2026-10-21T00:00:00Z"),
      });

      assert.equal(outcome.repaired, true);
      assert.equal(npm.publishCount, 0);
      assert.equal(remoteVersion(fixture.remote), "1.1.0");
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0", "v1.1.0"]);
      assert.equal(
        git(fixture.remote, ["rev-parse", "v1.1.0"]).trim(),
        git(fixture.remote, ["rev-parse", "main"]).trim(),
      );
      // The repair commit landed through a PR as well.
      assert.deepEqual(pullRequests.merges, ["#1 v1.1.0"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("publishes a tagged version that never reached npm", () => {
    const fixture = createFixture();
    try {
      // Simulate a release that landed the commit and the tag but never published.
      writePackageFiles(fixture.workspace, "1.1.0");
      git(fixture.workspace, ["add", "-A"]);
      git(fixture.workspace, ["commit", "-m", "chore: release v1.1.0"]);
      git(fixture.workspace, ["tag", "v1.1.0"]);
      git(fixture.workspace, ["push", "origin", "main"]);
      git(fixture.workspace, ["push", "origin", "v1.1.0"]);

      const npm = new FakeNpm(fixture.workspace);
      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        pullRequests,
        npm,
        now: () => new Date("2026-10-21T00:00:00Z"),
      });

      assert.equal(outcome.published, true);
      assert.equal(npm.publishCount, 1);
      assert.deepEqual([...npm.published], ["1.1.0"]);
      // No second release was created for the same commits, and no PR was needed:
      // the release commit is already on main.
      assert.deepEqual(pullRequests.merges, []);
      assert.deepEqual(pullRequests.dispatched, []);
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0", "v1.1.0"]);
      assert.equal(
        git(fixture.remote, ["rev-list", "--count", "main"]).trim(),
        "3",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("does nothing when no commit is release-worthy", () => {
    const fixture = createFixture({ withFeature: false });
    try {
      writeFileSync(path.join(fixture.workspace, "docs.txt"), "docs\n");
      git(fixture.workspace, ["add", "-A"]);
      git(fixture.workspace, ["commit", "-m", "docs: describe the project"]);
      git(fixture.workspace, ["push", "origin", "main"]);

      const npm = new FakeNpm(fixture.workspace);
      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        pullRequests,
        npm,
      });

      assert.equal(outcome.released, false);
      assert.equal(npm.publishCount, 0);
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0"]);
      // No release PR was opened for a non-release.
      assert.deepEqual(pullRequests.dispatched, []);
      assert.deepEqual(pullRequests.merges, []);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("rehearses a release without committing, tagging or publishing", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      const pullRequests = new FakePullRequests(fixture.workspace, fixture.server);
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        pullRequests,
        npm,
        dryRun: true,
        now: () => new Date("2026-10-21T00:00:00Z"),
      });

      assert.equal(outcome.released, false);
      assert.equal(outcome.version, "1.1.0");
      assert.equal(npm.dryRunCount, 1);
      assert.equal(npm.publishCount, 0);
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0"]);
      assert.equal(remoteVersion(fixture.remote), "1.0.0");
      // The rehearsal opens no pull request.
      assert.deepEqual(pullRequests.dispatched, []);
      assert.deepEqual(pullRequests.merges, []);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
