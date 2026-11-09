import { describe, expect, test } from "bun:test";
import { localNamingModels, namingMethod, withNamingCancellation } from "../src/naming-models.js";
import type { NamingMode } from "../src/conversation-title.js";

describe("title model discovery", () => {
  test("uses the compact public method names", () => {
    expect((["off", "message", "subscription", "local"] as NamingMode[]).map(namingMethod))
      .toEqual(["off", "auto", "cloud", "local"]);
  });

  test("lists installed models without inference and deduplicates the inventory", async () => {
    const calls: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ models: [{ name: "qwen:small" }, { model: "qwen:large" },
        { name: "qwen:small" }, { name: "bad\nname" }, { name: 42 }, null] });
    } });
    try {
      expect(await localNamingModels(`http://127.0.0.1:${server.port}/`)).toEqual(["qwen:large", "qwen:small"]);
      expect(calls).toEqual(["GET /api/tags"]);
    } finally { server.stop(true); }
  });

  test.each(["bad JSON", '{"models":null}', '{"wrong":[]}'])("rejects malformed inventory %s", async (body) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
    try { await expect(localNamingModels(`http://127.0.0.1:${server.port}`)).rejects.toThrow("invalid model inventory"); }
    finally { server.stop(true); }
  });

  test("accepts an empty installed inventory", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ models: [] }) });
    try { expect(await localNamingModels(`http://127.0.0.1:${server.port}`)).toEqual([]); }
    finally { server.stop(true); }
  });

  test("rejects redirects", async () => {
    let redirected = false;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/other") { redirected = true; return Response.json({ models: [] }); }
      return new Response("private server details", { status: 302, headers: { location: "/other" } });
    } });
    try {
      await expect(localNamingModels(`http://127.0.0.1:${server.port}`)).rejects.toThrow("Could not reach Ollama");
      expect(redirected).toBe(false);
    } finally { server.stop(true); }
  });

  test("reports HTTP failure without exposing the response body", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response("private backend details", { status: 503 }) });
    try {
      await expect(localNamingModels(`http://127.0.0.1:${server.port}`)).rejects.toThrow("HTTP 503");
    } finally { server.stop(true); }
  });

  test("bounds the inventory response", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(" ".repeat(256_001)) });
    try {
      await expect(localNamingModels(`http://127.0.0.1:${server.port}`)).rejects.toThrow("too large");
    } finally { server.stop(true); }
  });

  test("rejects URL credentials before requesting the inventory", async () => {
    await expect(localNamingModels("http://user:secret@localhost:11434")).rejects.toThrow("without URL credentials");
  });

  test("cancels waiting even when a metadata provider does not cooperate", async () => {
    const controller = new AbortController();
    const pending = withNamingCancellation(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
