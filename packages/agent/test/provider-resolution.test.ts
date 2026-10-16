import { describe, expect, it } from "vitest";
import {
  createModel,
  discoverModel,
  labelFromHost,
  modelIds,
  pickModel,
  ProviderConfigError,
  resolveProvider,
} from "../src/index.js";

/**
 * One key and one URL should be enough, and these tests are what "enough"
 * means: which provider is meant, which protocol it speaks, which variable the
 * key came from, and what happens when the configuration says two things at
 * once. All of it is decided without a network call, so all of it is checked
 * here — the one thing that cannot be is the model list, which has its own
 * section with a stub server.
 */
describe("resolving the provider from the environment", () => {
  it("takes a single vendor key as the answer to which provider is meant", () => {
    const resolved = resolveProvider({ OPENAI_API_KEY: "k" });
    expect(resolved.provider).toBe("openai");
    expect(resolved.providerSource).toBe("credential");
    expect(resolved.apiKeyEnv).toBe("OPENAI_API_KEY");
    // OpenAI's own API, so its own protocol, and its own default model.
    expect(resolved.api).toBe("responses");
    expect(resolved.modelId).toBe("gpt-5.6");
    expect(resolved.problems).toEqual([]);
  });

  it("takes a pointed endpoint as the answer, and calls it by its host", () => {
    // The DeepSeek case, which is the one that produced all of this: a key and
    // a URL, no NEXUS_PROVIDER in sight.
    const resolved = resolveProvider({
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
    });
    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.providerSource).toBe("openai-url");
    expect(resolved.providerName).toBe("deepseek");
    expect(resolved.baseURL).toBe("https://api.deepseek.com/v1");
    // Not OpenAI's host, so not the Responses API.
    expect(resolved.api).toBe("chat");
    // An OpenAI-shaped server names its own models, so there is nothing to
    // guess and the endpoint has to be asked.
    expect(resolved.modelId).toBeUndefined();
    expect(resolved.problems).toEqual([]);
  });

  it("still recognises OpenAI when the URL points at OpenAI", () => {
    const resolved = resolveProvider({
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
    });
    expect(resolved.provider).toBe("openai");
    expect(resolved.providerName).toBe("openai");
    expect(resolved.api).toBe("responses");
  });

  it("prefers the vendor's own key over the neutral one, and says which it used", () => {
    const anthropic = resolveProvider({ ANTHROPIC_API_KEY: "vendor", NEXUS_API_KEY: "neutral" });
    expect(anthropic.provider).toBe("anthropic");
    expect(anthropic.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(anthropic.apiKey).toBe("vendor");

    // An OpenAI-shaped server is not a vendor, so the neutral name comes first.
    const compatible = resolveProvider({
      NEXUS_API_KEY: "neutral",
      OPENAI_API_KEY: "vendor",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
    });
    expect(compatible.apiKeyEnv).toBe("NEXUS_API_KEY");
    expect(compatible.apiKey).toBe("neutral");
  });

  it("lets the neutral key stand alone without pretending to know the vendor", () => {
    // NEXUS_API_KEY is accepted by every provider, so it cannot say which one is
    // meant: the default still decides, and the key is still used.
    const resolved = resolveProvider({ NEXUS_API_KEY: "k" });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.providerSource).toBe("default");
    expect(resolved.apiKey).toBe("k");
    expect(resolved.problems).toEqual([]);

    // Next to a URL it is exactly the configuration an OpenAI-shaped endpoint
    // needs, and nothing more has to be said.
    const endpoint = resolveProvider({ NEXUS_API_KEY: "k", NEXUS_BASE_URL: "http://gateway/v1" });
    expect(endpoint.provider).toBe("openai-compatible");
    expect(endpoint.providerName).toBe("gateway");
    expect(endpoint.problems).toEqual([]);
  });

  it("refuses to guess when two vendors' keys are set, and names them", () => {
    const resolved = resolveProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toMatch(/ANTHROPIC_API_KEY and OPENAI_API_KEY are set/);
    expect(resolved.problems[0]).toMatch(/NEXUS_PROVIDER/);
    // And the run stops, rather than picking one of them quietly.
    expect(() => createModel({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toThrow(ProviderConfigError);
    // Naming one settles it.
    expect(createModel({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", NEXUS_PROVIDER: "anthropic" }).provider).toBe(
      "anthropic",
    );
  });

  it("names every token of the configuration in its reasons", () => {
    const resolved = resolveProvider({
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      NEXUS_MODEL: "deepseek-flash",
    });
    const reasons = resolved.reasons.join("\n");
    expect(reasons).toMatch(/openai-compatible \(OPENAI_BASE_URL/);
    expect(reasons).toMatch(/chat completions/);
    expect(reasons).toMatch(/key OPENAI_API_KEY/);
    expect(reasons).toMatch(/model deepseek-flash \(NEXUS_MODEL\)/);
  });

  it("lets NEXUS_OPENAI_API pick the wire protocol, and only where it applies", () => {
    const chat = resolveProvider({ OPENAI_API_KEY: "k", NEXUS_OPENAI_API: "chat" });
    expect(chat.provider).toBe("openai");
    expect(chat.api).toBe("chat");

    const responses = resolveProvider({ OPENAI_API_KEY: "k", NEXUS_OPENAI_API: "responses" });
    expect(responses.api).toBe("responses");

    // A proxy that speaks OpenAI but is not OpenAI defaults to chat, and can be
    // told otherwise.
    const proxy = { NEXUS_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_BASE_URL: "http://proxy/v1" };
    expect(resolveProvider(proxy).api).toBe("chat");
    expect(resolveProvider({ ...proxy, NEXUS_OPENAI_API: "responses" }).api).toBe("responses");

    // An OpenAI-shaped server always speaks chat, so asking for responses there
    // is a contradiction rather than a preference.
    const contradictory = resolveProvider({
      NEXUS_BASE_URL: "http://gateway/v1",
      NEXUS_MODEL: "m",
      NEXUS_OPENAI_API: "responses",
    });
    expect(contradictory.problems.join(" ")).toMatch(/only applies to the openai provider/);

    const nonsense = resolveProvider({ OPENAI_API_KEY: "k", NEXUS_OPENAI_API: "graphql" });
    expect(nonsense.problems.join(" ")).toMatch(/must be "chat" or "responses"/);
  });

  it("collects problems instead of throwing, so a report can list them all", () => {
    const resolved = resolveProvider({ NEXUS_PROVIDER: "openai-compatible" });
    expect(resolved.problems).toEqual([
      expect.stringMatching(/needs an endpoint/),
    ]);
    // The model is not a problem: the endpoint is going to be asked.
    expect(resolved.modelId).toBeUndefined();
  });

  it("says where the model came from, and asks when nobody has said", () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: "k" }).reasons.join("\n")).toMatch(
      /model claude-sonnet-4-5 \(the default for anthropic\)/,
    );
    expect(resolveProvider({ NEXUS_BASE_URL: "http://x/v1", NEXUS_MODEL: "m" }).reasons.join("\n")).toMatch(
      /model m \(NEXUS_MODEL\)/,
    );
    expect(resolveProvider({ NEXUS_BASE_URL: "http://x/v1" }).reasons.join("\n")).toMatch(/endpoint is asked/);
  });

  it("calls an endpoint by the word a person would use for it", () => {
    expect(labelFromHost("api.deepseek.com")).toBe("deepseek");
    expect(labelFromHost("api.groq.com")).toBe("groq");
    expect(labelFromHost("openrouter.ai")).toBe("openrouter");
    expect(labelFromHost("localhost")).toBe("localhost");
    expect(labelFromHost("127.0.0.1")).toBe("127.0.0.1");
    // NEXUS_PROVIDER_NAME still wins, for anything with its own idea of itself.
    expect(
      resolveProvider({ NEXUS_BASE_URL: "http://gateway/v1", NEXUS_PROVIDER_NAME: "company-llm" }).providerName,
    ).toBe("company-llm");
  });
});

describe("finding the model an endpoint serves", () => {
  const endpoint = (env: NodeJS.ProcessEnv) => resolveProvider(env);

  it("asks /models once, with the key, and reads the ids out of any shape", () => {
    const shapes: unknown[] = [
      { data: [{ id: "a" }, { id: "b" }] },
      { models: [{ id: "a" }, { id: "b" }] },
      { models: ["a", "b"] },
      ["a", "b"],
    ];
    for (const shape of shapes) {
      expect(modelIds(shape)).toEqual(["a", "b"]);
    }
    // Duplicates and blanks are not models.
    expect(modelIds({ data: [{ id: "a" }, { id: "a" }, { id: " " }, { nope: true }] })).toEqual(["a"]);
    expect(modelIds({})).toEqual([]);
    expect(modelIds("nope")).toEqual([]);
  });

  it("picks a small model by name, and refuses to pick at random", () => {
    expect(pickModel(["only-one"])).toBe("only-one");
    expect(pickModel(["deepseek-v4-pro", "deepseek-flash"])).toBe("deepseek-flash");
    // Cheap-looking beats big: the tier order is the preference order.
    expect(pickModel(["gpt-5.6", "gpt-5.6-mini", "gemini-3.8-flash"])).toBe("gemini-3.8-flash");
    // Deterministic when a tier has several: sorted, not in whatever order the
    // endpoint happened to answer.
    expect(pickModel(["b-mini", "a-mini"])).toBe("a-mini");
    // Nothing recognisable is a question for the user, not a guess.
    expect(pickModel(["neural-9000", "neural-9000-large"])).toBeUndefined();
  });

  it("asks the endpoint and prints what it chose", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resolved = endpoint({
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1/",
    });
    const model = await discoverModel(resolved, { fetch: fakeFetch });
    expect(model).toBe("deepseek-flash");
    // One request, to /models, with the key — and not a double slash where the
    // base URL ended with one.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/models");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("turns every discovery failure into the same instruction", async () => {
    const resolved = endpoint({ NEXUS_BASE_URL: "https://api.deepseek.com/v1", NEXUS_MODEL: undefined });

    const unreachable = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.deepseek.com");
    }) as unknown as typeof fetch;
    await expect(discoverModel(resolved, { fetch: unreachable })).rejects.toThrow(/Could not reach .*\/models/);
    await expect(discoverModel(resolved, { fetch: unreachable })).rejects.toThrow(/ENOTFOUND/);
    await expect(discoverModel(resolved, { fetch: unreachable })).rejects.toThrow(/Set NEXUS_MODEL/);

    const denied = (async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    await expect(discoverModel(resolved, { fetch: denied })).rejects.toThrow(/401 Unauthorized/);
    // A rejected key is worth naming, because it is not the model list's fault.
    const withKey = endpoint({ NEXUS_BASE_URL: "https://api.deepseek.com/v1", NEXUS_API_KEY: "k" });
    await expect(discoverModel(withKey, { fetch: denied })).rejects.toThrow(/The key in NEXUS_API_KEY was rejected/);

    const notJson = (async () => new Response("<html>hello</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(discoverModel(resolved, { fetch: notJson })).rejects.toThrow(/did not answer with JSON/);

    const empty = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(discoverModel(resolved, { fetch: empty })).rejects.toThrow(/listed no models/);

    const unhelpful = (async () =>
      new Response(JSON.stringify({ data: [{ id: "neural-9000" }, { id: "neural-9000-large" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(discoverModel(resolved, { fetch: unhelpful })).rejects.toThrow(/none of them is obviously a default/);
    await expect(discoverModel(resolved, { fetch: unhelpful })).rejects.toThrow(/neural-9000/);

    // An endpoint with no endpoint to ask is a configuration problem, not a
    // network one.
    await expect(discoverModel(resolveProvider({ NEXUS_PROVIDER: "stub" }), { fetch: denied })).rejects.toThrow(
      /no endpoint to ask/,
    );
  });
});
