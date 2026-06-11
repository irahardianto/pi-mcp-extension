/**
 * Unit tests for convertMcpContent — annotation preservation.
 *
 * Tests that MCP content annotations (audience, priority, lastModified)
 * are preserved through the conversion, enabling downstream consumers
 * (e.g., pi-mcp-audience) to inspect and filter by audience.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertMcpContent } from "../src/tool-bridge.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Backward compatibility — items without annotations
// ═══════════════════════════════════════════════════════════════════════════════

describe("convertMcpContent — backward compatibility", () => {
  it("converts a plain text item", () => {
    const result = convertMcpContent([{ type: "text", text: "hello" }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.type, "text");
    assert.equal(result[0]?.text, "hello");
  });

  it("converts text with empty string", () => {
    const result = convertMcpContent([{ type: "text", text: "" }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.text, "");
  });

  it("converts text with null/undefined text", () => {
    const result = convertMcpContent([{ type: "text" }, { type: "text", text: undefined }]);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.text, "");
    assert.equal(result[1]?.text, "");
  });

  it("converts an image item to a text placeholder", () => {
    const result = convertMcpContent([{ type: "image", mimeType: "image/png", data: "base64..." }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.text, "[Image: image/png, base64 encoded]");
  });

  it("converts an image without mimeType", () => {
    const result = convertMcpContent([{ type: "image", data: "base64..." }]);
    assert.equal(result.length, 1);
    assert.ok(result[0]?.text?.includes("unknown"));
  });

  it("converts an audio item to a text placeholder", () => {
    const result = convertMcpContent([{ type: "audio", mimeType: "audio/wav", data: "base64..." }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.text, "[Audio: audio/wav, base64 encoded]");
  });

  it("converts a resource with text content", () => {
    const result = convertMcpContent([{
      type: "resource",
      resource: { uri: "test://foo", text: "resource content" },
    }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.type, "text");
    assert.equal(result[0]?.text, "resource content");
  });

  it("converts a resource with blob content", () => {
    const result = convertMcpContent([{
      type: "resource",
      resource: { uri: "test://blob", blob: "base64..." },
    }]);
    assert.equal(result.length, 1);
    assert.ok(result[0]?.text?.includes("[Resource blob: test://blob]"));
  });

  it("converts a resource without text or blob", () => {
    const result = convertMcpContent([{
      type: "resource",
      resource: { uri: "test://empty" },
    }]);
    assert.equal(result.length, 1);
    assert.ok(result[0]?.text?.includes("[Resource: test://empty]"));
  });

  it("handles null/undefined items", () => {
    const result = convertMcpContent([null, undefined]);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.text, "null");
    assert.equal(result[1]?.text, "undefined");
  });

  it("handles non-object items", () => {
    const result = convertMcpContent(["string", 42]);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.text, "string");
    assert.equal(result[1]?.text, "42");
  });

  it("handles unknown item types by serializing to JSON", () => {
    const result = convertMcpContent([{ type: "custom", data: { key: "val" } }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.type, "text");
    assert.ok(typeof result[0]?.text === "string");
  });

  it("handles empty array", () => {
    const result = convertMcpContent([]);
    assert.equal(result.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Annotation preservation — the new feature
// ═══════════════════════════════════════════════════════════════════════════════

describe("convertMcpContent — annotation preservation", () => {
  it("preserves audience annotation on text content", () => {
    const result = convertMcpContent([{
      type: "text",
      text: "secret",
      annotations: { audience: ["assistant"] },
    }]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.annotations?.audience, ["assistant"]);
  });

  it("preserves all annotation fields on text content", () => {
    const result = convertMcpContent([{
      type: "text",
      text: "annotated",
      annotations: {
        audience: ["user", "assistant"],
        priority: 5,
        lastModified: "2026-01-15T10:30:00Z",
      },
    }]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.annotations?.audience, ["user", "assistant"]);
    assert.equal(result[0]?.annotations?.priority, 5);
    assert.equal(result[0]?.annotations?.lastModified, "2026-01-15T10:30:00Z");
  });

  it("preserves audience annotation on image content", () => {
    const result = convertMcpContent([{
      type: "image",
      mimeType: "image/png",
      data: "base64...",
      annotations: { audience: ["assistant"] },
    }]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.annotations?.audience, ["assistant"]);
    assert.ok(result[0]?.text?.includes("[Image:"));
  });

  it("preserves audience annotation on audio content", () => {
    const result = convertMcpContent([{
      type: "audio",
      mimeType: "audio/wav",
      data: "base64...",
      annotations: { audience: ["assistant"] },
    }]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.annotations?.audience, ["assistant"]);
    assert.ok(result[0]?.text?.includes("[Audio:"));
  });

  it("preserves resource-level annotations (nested inside resource)", () => {
    const result = convertMcpContent([{
      type: "resource",
      resource: {
        uri: "test://foo",
        text: "resource data",
        annotations: { audience: ["assistant"] },
      },
    }]);
    assert.equal(result.length, 1);
    // resource-level annotations should be available on the result
    assert.deepEqual(result[0]?.resource?.annotations?.audience, ["assistant"]);
  });

  it("preserves both block-level and resource-level annotations on resource", () => {
    const result = convertMcpContent([{
      type: "resource",
      resource: {
        uri: "test://foo",
        text: "data",
        annotations: { audience: ["assistant"] },
      },
      annotations: { audience: ["user"] },
    }]);
    assert.equal(result.length, 1);
    // Both levels should be preserved independently
    assert.deepEqual(result[0]?.annotations?.audience, ["user"]);
    assert.deepEqual(result[0]?.resource?.annotations?.audience, ["assistant"]);
  });

  it("preserves audience on unknown/default content type", () => {
    const result = convertMcpContent([{
      type: "custom_type",
      foo: "bar",
      annotations: { audience: ["assistant"] },
    }]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.annotations?.audience, ["assistant"]);
  });

  it("does not add annotations field when there are no annotations", () => {
    const result = convertMcpContent([{ type: "text", text: "plain" }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.annotations, undefined);
  });

  it("handles multiple items with mixed annotations", () => {
    const result = convertMcpContent([
      { type: "text", text: "public", annotations: { audience: ["user"] } },
      { type: "text", text: "private", annotations: { audience: ["assistant"] } },
      { type: "text", text: "both", annotations: { audience: ["user", "assistant"] } },
      { type: "text", text: "no annotation" },
    ]);
    assert.equal(result.length, 4);
    assert.deepEqual(result[0]?.annotations?.audience, ["user"]);
    assert.deepEqual(result[1]?.annotations?.audience, ["assistant"]);
    assert.deepEqual(result[2]?.annotations?.audience, ["user", "assistant"]);
    assert.equal(result[3]?.annotations, undefined);
  });

  it("preserves audience with priority and lastModified on image", () => {
    const result = convertMcpContent([{
      type: "image",
      mimeType: "image/jpeg",
      data: "base64...",
      annotations: {
        audience: ["assistant"],
        priority: 1,
        lastModified: "2026-06-10T00:00:00Z",
      },
    }]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.annotations?.audience, ["assistant"]);
    assert.equal(result[0]?.annotations?.priority, 1);
    assert.equal(result[0]?.annotations?.lastModified, "2026-06-10T00:00:00Z");
  });

  it("preserves audience on resource blob", () => {
    const result = convertMcpContent([{
      type: "resource",
      resource: {
        uri: "test://secret",
        blob: "base64encoded",
        annotations: { audience: ["assistant"] },
      },
    }]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.resource?.annotations?.audience, ["assistant"]);
    assert.ok(result[0]?.text?.includes("[Resource blob: test://secret]"));
  });
});
