/**
 * Tests for scripts/release.ts — the release flow behind .github/workflows/publish.yml.
 *
 * The tests drive the real git adapter against a real (local) repository so the
 * race that issue #82 describes — `main` moving while a release runs — is exercised
 * for real, and pair it with a fake npm registry so the npm side is deterministic.
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
  type CommitInfo,
  type GitPort,
  type NpmPort,
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

  return { root, remote, workspace, other, otherSha: git(other, ["rev-parse", "HEAD"]).trim() };
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

/** Push a concurrent commit to `main` right before the first push of the release. */
function raceOnPush(gitPort: GitPort, other: string): GitPort {
  let raced = false;
  return new Proxy(gitPort, {
    get(target, property, receiver) {
      if (property === "pushBranch") {
        return (sha: string): void => {
          if (!raced) {
            raced = true;
            git(other, ["push", "origin", "main"]);
          }
          target.pushBranch(sha);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Reject every push, as a protected branch would. */
function rejectPushes(gitPort: GitPort): GitPort {
  return new Proxy(gitPort, {
    get(target, property, receiver) {
      if (property === "pushBranch") {
        return (): void => {
          throw new Error("rejected (non-fast-forward)");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

describe("runRelease", () => {
  it("pushes the release commit and its tag before publishing", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        npm,
        now: () => new Date("2026-10-21T00:00:00Z"),
      });

      assert.equal(outcome.released, true);
      assert.equal(outcome.published, true);
      assert.equal(outcome.version, "1.1.0");
      assert.equal(npm.publishCount, 1);
      assert.deepEqual([...npm.published], ["1.1.0"]);

      assert.equal(remoteVersion(fixture.remote), "1.1.0");
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0", "v1.1.0"]);
      assert.equal(
        git(fixture.remote, ["rev-parse", "v1.1.0"]).trim(),
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
      const outcome = runRelease({
        git: raceOnPush(createGit(fixture.workspace), fixture.other),
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
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("publishes nothing when the release commit cannot be pushed", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      assert.throws(
        () =>
          runRelease({
            git: rejectPushes(createGit(fixture.workspace)),
            npm,
            maxPushAttempts: 2,
          }),
        /rejected/,
      );

      // Nothing reached npm: the version only exists once the tag is on main.
      assert.equal(npm.publishCount, 0);
      assert.equal(npm.published.size, 0);
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0"]);
      assert.equal(remoteVersion(fixture.remote), "1.0.0");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("publishes nothing when the release tag cannot be pushed", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      assert.throws(
        () =>
          runRelease({
            git: rejectTagPushes(createGit(fixture.workspace)),
            npm,
            maxPushAttempts: 2,
          }),
        /rejected/,
      );

      // The version only reaches npm once its tag is on main.
      assert.equal(npm.publishCount, 0);
      assert.equal(npm.published.size, 0);
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0"]);
      // The release commit is on main, so the next run can repair the missing tag.
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

      const outcome = runRelease({
        git: createGit(fixture.workspace),
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
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("publishes a tagged version that never reached npm", () => {
    const fixture = createFixture();
    try {
      // Simulate a release that pushed the commit and the tag but never published.
      writePackageFiles(fixture.workspace, "1.1.0");
      git(fixture.workspace, ["add", "-A"]);
      git(fixture.workspace, ["commit", "-m", "chore: release v1.1.0"]);
      git(fixture.workspace, ["tag", "v1.1.0"]);
      git(fixture.workspace, ["push", "origin", "main"]);
      git(fixture.workspace, ["push", "origin", "v1.1.0"]);

      const npm = new FakeNpm(fixture.workspace);
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        npm,
        now: () => new Date("2026-10-21T00:00:00Z"),
      });

      assert.equal(outcome.published, true);
      assert.equal(npm.publishCount, 1);
      assert.deepEqual([...npm.published], ["1.1.0"]);
      // No second release was created for the same commits.
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
      const outcome = runRelease({
        git: createGit(fixture.workspace),
        npm,
      });

      assert.equal(outcome.released, false);
      assert.equal(npm.publishCount, 0);
      assert.deepEqual(remoteTags(fixture.remote), ["v1.0.0"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("rehearses a release without committing, tagging or publishing", () => {
    const fixture = createFixture();
    try {
      const npm = new FakeNpm(fixture.workspace);
      const outcome = runRelease({
        git: createGit(fixture.workspace),
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
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
