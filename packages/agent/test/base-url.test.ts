import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModel } from "../src/index.js";

/**
 * A base URL that is accepted and then never used is the failure this file
 * exists to catch. The AI SDK wrappers compile the vendor host into the bundle,
 * so a constructor that dropped the option would still type-check, still start,
 * and quietly send the request to the public API — the one outcome that must
 * not happen silently when someone has pointed the agent at a gateway.
 *
 * Each provider is aimed at a plain HTTP server on localhost that records what
 * it was asked for and answers 401. The request has to arrive there, and it has
 * to arrive under the version prefix the provider expects: `/v1` for Anthropic
 * and OpenAI, `/v1beta` for Google. No key is real and nothing leaves the
 * machine.
 */
describe("provider base URLs are used, not merely accepted", () => {
  const paths: string[] = [];
  let server: Server;
  let origin = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "recorded by the test server" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  /** Runs one request against the override and returns the paths it reached. */
  async function requestPaths(env: NodeJS.ProcessEnv): Promise<string[]> {
    const before = paths.length;
    const { model } = createModel(env);
    await generateText({ model, prompt: "hello", maxRetries: 0 }).catch(() => undefined);
    return paths.slice(before);
  }

  function expectReached(seen: string[], prefix: string): void {
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((path) => path.startsWith(`${prefix}/`))).toBe(true);
  }

  it("sends Anthropic to ANTHROPIC_BASE_URL", async () => {
    const seen = await requestPaths({
      NEXUS_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: `${origin}/v1`,
    });
    expectReached(seen, "/v1");
  });

  it("sends OpenAI to OPENAI_BASE_URL", async () => {
    const seen = await requestPaths({
      NEXUS_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: `${origin}/v1`,
    });
    expectReached(seen, "/v1");
  });

  it("sends Google to GEMINI_BASE_URL", async () => {
    const seen = await requestPaths({
      NEXUS_PROVIDER: "google",
      GEMINI_API_KEY: "test-key",
      GEMINI_BASE_URL: `${origin}/v1beta`,
    });
    expectReached(seen, "/v1beta");
  });

  it("sends an inferred OpenAI-compatible provider to NEXUS_BASE_URL", async () => {
    const seen = await requestPaths({ NEXUS_BASE_URL: `${origin}/v1`, NEXUS_MODEL: "local-model" });
    expectReached(seen, "/v1");
  });
});
