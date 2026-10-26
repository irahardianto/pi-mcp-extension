declare const err: Error & { status?: number; code?: number };
declare const msg: string;

// ruleid: pi-mcp.no-401-substring
if (err.message.includes("401")) {}

// ruleid: pi-mcp.no-401-substring
if (msg.indexOf("401") !== -1) {}

// ruleid: pi-mcp.no-401-substring
if (msg.match("401")) {}

// ruleid: pi-mcp.no-401-substring
if (msg.search("401") !== -1) {}

// ruleid: pi-mcp.no-401-substring
if (/401/.test(msg)) {}

// ruleid: pi-mcp.no-401-substring
if (/\b401\b/.test(msg)) {}

// ruleid: pi-mcp.no-401-substring
if (/401/.exec(msg)) {}

// ruleid: pi-mcp.no-401-substring
if (new RegExp("401").test(msg)) {}

// ruleid: pi-mcp.no-401-substring
const r = new RegExp("\\b401\\b", "i");

// Extracting the literals into a table must not hide them from the rule (#182).
// ruleid: pi-mcp.no-401-substring
const extractedPatterns = [/\b401\b/i];

// ruleid: pi-mcp.no-401-substring
const anchored401Pattern = /^\s*401\s*$/;

// ruleid: pi-mcp.no-401-substring
const someMatcher = (text: string): boolean => [/(401)/, /\breturned\s+401\b/i].some((re) => re.test(text));

// ok: pi-mcp.no-401-substring
if (err.status === 401) {}

// ok: pi-mcp.no-401-substring
if (err.name === "UnauthorizedError") {}

// ok: pi-mcp.no-401-substring
if (msg.includes("unauthorized")) {}

// ok: pi-mcp.no-401-substring
const okReg = new RegExp("unauthorized", "i");

// ok: pi-mcp.no-401-substring
const okPatterns = [/unauthorized/i, /\b403\b/];

// ok: pi-mcp.no-401-substring
const docsPath = "docs/http/401/handling.md";
