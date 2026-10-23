# Security Policy

## Supported Versions

Only the latest minor version receives bug fixes and security updates. A new minor line (`1.11.0`) replaces the previous one as the supported line as soon as it is published; the previous line then receives no further fixes. Within the supported line, fixes ship to npm as patch releases (`1.10.0` → `1.10.1`), so staying on `latest` always keeps you supported.

The table names the supported line as `major.minor.x`, so it stays accurate across patch releases:

| Version | Supported          |
| ------- | ------------------ |
| 1.10.x  | :white_check_mark: |
| < 1.10  | :x:                |

This table is maintained by hand: the release workflow bumps `package.json` and `CHANGELOG.md` automatically, so a `feat:` (minor) or breaking (major) change must update it in the same pull request (see [AGENTS.md](AGENTS.md#commits--release)).

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or public discussions.**

Please submit security reports privately through GitHub Private Vulnerability Reporting:

👉 **[Submit a Vulnerability Report](https://github.com/irahardianto/pi-mcp-extension/security/advisories/new)**

If the private reporting form is unavailable, please open a public GitHub issue titled **`Security contact request`** with **no vulnerability details**, and the maintainer will arrange a private channel.

## Scope

### In Scope

Security issues in `pi-mcp-extension`'s core logic, configuration handling, authentication, process lifecycle, and release pipelines are in scope. Examples include:

- **OAuth token & credential leaks:** Access tokens, refresh tokens, client secrets, authorization codes, or PKCE verifiers exposed in logs, error messages, terminal output, or UI notifications.
- **Cross-origin token reuse:** Failure to enforce origin binding on stored OAuth state files (`state.serverUrl !== config.url`), or stored refresh tokens / client credentials being sent to an authorization server other than the one they are bound to (`issuer`).
- **Project trust boundary bypass:** Loading or executing untrusted project-level configuration (`<cwd>/.pi/mcp.json`) when `ctx.isProjectTrusted()` is `false`.
- **OAuth callback attacks:** CSRF vulnerabilities, bypass of callback `state` parameter validation on success or error redirects, or listening on non-loopback interfaces.
- **Command / shell injection:** Unsanitized parameters or authorization URLs passed to OS openers or shell processes.
- **Terminal escape sequence injection:** Failure to sanitize raw ANSI/VT control sequences from MCP server `stderr` or output before display.
- **Insecure file permissions:** Writing sensitive credential caches or lockfiles (`<hash>.json`, `<hash>.json.lock`) with permissions looser than `0o600` inside `0o700` directories.
- **Supply-chain security:** Vulnerabilities in this package's release workflows, dependency chain, or published npm packages.

### Out of Scope

The following are outside the threat model of this extension:

- **Third-party MCP servers:** Vulnerabilities or malicious behavior within external MCP servers themselves (report to the server maintainers).
- **Upstream Pi coding agent:** Vulnerabilities in Pi's core runtime or extensions host (report upstream to Pi).
- **Compromised local environment:** Attacks requiring an adversary who already has the ability to run code under your OS user account or modify your global configuration (`~/.pi/agent/mcp.json`).
- **Deliberately trusted malicious projects:** Attacks where the user explicitly trusts an untrusted workspace containing malicious project files.
- **Local denial of service:** Killing local processes or filling local disk when the attacker already has local access.

## What to Include in a Report

To help triage and resolve the issue quickly, please include:

1. **Extension version:** The version of `pi-mcp-extension` in use (see [Checking Your Version](#checking-your-version)).
2. **Pi version:** The version of the Pi coding agent (`pi --version`).
3. **Environment details:** Node.js version (`node --version`), operating system, and architecture.
4. **Transport:** The transport type involved (`stdio`, `streamable-http`, or `sse`).
5. **Configuration snippet:** Relevant excerpts from `mcp.json` with all secrets, tokens, keys, and authorization headers redacted.
6. **Reproduction steps:** A clear, deterministic set of steps or minimal reproduction script.
7. **Impact:** A description of the attack scenario, security impact, and prerequisites.

## Response Expectations & Disclosure

This is an open-source project maintained by an individual maintainer. Vulnerability reports are handled on a best-effort basis:

- **Acknowledgment:** Within 7 business days of receipt.
- **Status update:** An assessment and intended fix within 30 days.
- **Coordinated disclosure:** We follow coordinated vulnerability disclosure. Fixes will be prepared in private GitHub Security Advisories and released simultaneously with a public advisory and patch release.
- **Credit:** Reporters will be acknowledged and credited in the GitHub Security Advisory and CHANGELOG (unless they prefer to remain anonymous).

## Keeping the Extension Updated

Security fixes ship as automated patch releases via npm. Users should keep the extension up to date.

Pi installs packages into `~/.pi/agent/npm/` by default (or `.pi/npm/` for project-local installs; if overridden, `$PI_CODING_AGENT_DIR/npm/`).

### Checking Your Version

To check the currently installed version:

- **Using npm against Pi's package directory:**
  ```bash
  npm --prefix ~/.pi/agent/npm ls pi-mcp-extension
  ```
  *(replace prefix with `.pi/npm` for project-local installs)*
- **Reading the package manifest directly:**
  ```bash
  node -p "require(require('node:os').homedir() + '/.pi/agent/npm/node_modules/pi-mcp-extension/package.json').version"
  ```
  *(or inspect `~/.pi/agent/npm/node_modules/pi-mcp-extension/package.json`)*

### Updating

To update to the latest release:

```bash
pi update npm:pi-mcp-extension
```

Alternatively, reinstall the latest release:

```bash
pi install npm:pi-mcp-extension@latest
```
