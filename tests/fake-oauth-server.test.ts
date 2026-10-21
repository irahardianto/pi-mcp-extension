/**
 * Regression tests for the fake OAuth server fixture (tests/helpers/fake-oauth-server.ts).
 *
 * The fixture answers failed requests with a generic error. It must never
 * reflect exception text (or its stack) back to the client: the text can embed
 * untrusted request input, so echoing it would both leak implementation details
 * and let a crafted payload be interpreted as markup by an HTTP client.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeOAuthServer, type FakeOAuthServer } from "./helpers/fake-oauth-server.js";

describe("fake OAuth server", () => {
  let server: FakeOAuthServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("answers a malformed request with a generic error and keeps the detail server-side", async () => {
    server = await startFakeOAuthServer();

    const res = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    assert.equal(res.status, 500);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const body = await res.text();
    assert.equal(body, JSON.stringify({ error: "internal_server_error" }));

    // The failure detail is available to the test, but only through the
    // server-side handle - never through the HTTP response.
    assert.ok(server.lastError instanceof Error, "expected the fixture to record the failure");
    assert.match(server.lastError.message, /JSON/i);
  });

  it("does not echo attacker-controlled request input into the error response", async () => {
    server = await startFakeOAuthServer();

    const payload = '<img src=x onerror="alert(1)">';
    const res = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    assert.equal(res.status, 500);

    const body = await res.text();
    assert.ok(!body.includes("onerror"), `response must not reflect request input: ${body}`);
    assert.ok(!body.includes("<img"), `response must not reflect request input: ${body}`);
    assert.ok(!body.includes(payload), `response must not reflect request input: ${body}`);
  });

  it("does not expose a stack trace in the error response", async () => {
    server = await startFakeOAuthServer();

    const res = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    assert.equal(res.status, 500);

    const body = await res.text();
    assert.ok(!body.includes("fake-oauth-server.ts"), `response must not contain a stack trace: ${body}`);
    assert.ok(!/\n\s+at\s/.test(body), `response must not contain a stack trace: ${body}`);
  });

  it("answers unknown routes with a plain-text 404", async () => {
    server = await startFakeOAuthServer();

    const res = await fetch(`${server.baseUrl}/nope`);

    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  });
});
