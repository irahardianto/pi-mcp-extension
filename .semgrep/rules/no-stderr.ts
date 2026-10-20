import { reportDiagnostic } from "./debug-log.js";

declare const ctx: { ui: { notify(msg: unknown, level?: string): void } };

// ruleid: pi-mcp.no-stderr
console.error("[pi-mcp] error");

// ruleid: pi-mcp.no-stderr
process.stderr.write("raw stderr\n");

// ok: pi-mcp.no-stderr
reportDiagnostic({ level: "error", event: "config.error", message: "bad config" });

// ok: pi-mcp.no-stderr
ctx.ui.notify("connected", "info");
