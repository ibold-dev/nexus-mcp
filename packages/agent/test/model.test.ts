import { describe, expect, it } from "vitest";
import { createModel, DEFAULT_MODEL_IDS, OLLAMA_DEFAULT_BASE_URL, parseProvider, ProviderConfigError } from "../src/index.js";

/**
 * The provider switch is the part of the agent that fails in production, so it
 * is tested for the failure it is supposed to produce: a named environment
 * variable, and no quiet substitution of one model for another.
 */
describe("model provider configuration", () => {
  it("defaults to Claude and names the key it is missing", () => {
    expect(() => createModel({})).toThrow(ProviderConfigError);
    expect(() => createModel({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("builds Claude with the default model id", () => {
    const choice = createModel({ ANTHROPIC_API_KEY: "key" });
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelId).toBe("claude-sonnet-4-5");
    expect(choice.model).toBeDefined();
  });

  it("lets NEXUS_MODEL override the default of any provider", () => {
    expect(createModel({ ANTHROPIC_API_KEY: "key", NEXUS_MODEL: "claude-opus-4-5" }).modelId).toBe(
      "claude-opus-4-5",
    );
    expect(createModel({ NEXUS_PROVIDER: "ollama", NEXUS_MODEL: "qwen3.5:0.8b" }).modelId).toBe("qwen3.5:0.8b");
  });

  it("requires the key that belongs to the chosen provider", () => {
    expect(() => createModel({ NEXUS_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() => createModel({ NEXUS_PROVIDER: "google" })).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
    expect(createModel({ NEXUS_PROVIDER: "google", GEMINI_API_KEY: "key" }).provider).toBe("google");
    expect(createModel({ NEXUS_PROVIDER: "openai", OPENAI_API_KEY: "key" }).modelId).toBe(DEFAULT_MODEL_IDS.openai);
  });

  it("points Ollama at the local server and needs no key", () => {
    const choice = createModel({ NEXUS_PROVIDER: "ollama" });
    expect(choice.provider).toBe("ollama");
    expect(choice.modelId).toBe("qwen3.5:9b");
    // A different base URL is honoured, which is how a remote Ollama is reached.
    expect(createModel({ NEXUS_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://box:11434/v1" }).provider).toBe("ollama");
    expect(OLLAMA_DEFAULT_BASE_URL).toBe("http://localhost:11434/v1");
  });

  it("makes an OpenAI-compatible endpoint say what it serves", () => {
    expect(() => createModel({ NEXUS_PROVIDER: "openai-compatible" })).toThrow(/NEXUS_BASE_URL/);
    expect(() => createModel({ NEXUS_PROVIDER: "openai-compatible", NEXUS_BASE_URL: "http://x/v1" })).toThrow(
      /NEXUS_MODEL/,
    );
    const choice = createModel({
      NEXUS_PROVIDER: "openai-compatible",
      NEXUS_BASE_URL: "http://x/v1",
      NEXUS_MODEL: "some-model",
      NEXUS_API_KEY: "key",
    });
    expect(choice.modelId).toBe("some-model");
  });

  it("reads a base URL with no provider named as an OpenAI-compatible endpoint", () => {
    // A bare URL says nothing about which vendor is behind it, so it is taken
    // at its word — and it still refuses to guess a model.
    expect(() => createModel({ NEXUS_BASE_URL: "http://gateway/v1" })).toThrow(/NEXUS_MODEL/);
    const choice = createModel({ NEXUS_BASE_URL: "http://gateway/v1", NEXUS_MODEL: "some-model" });
    expect(choice.provider).toBe("openai-compatible");
    expect(choice.modelId).toBe("some-model");
  });

  it("lets a named provider win over a base URL", () => {
    const choice = createModel({
      NEXUS_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "key",
      NEXUS_BASE_URL: "http://gateway/v1",
    });
    expect(choice.provider).toBe("anthropic");
    // NEXUS_BASE_URL belongs to openai-compatible, so here it does nothing —
    // and doing nothing is said out loud rather than assumed to be harmless.
    expect(choice.warnings).toHaveLength(1);
    expect(choice.warnings[0]).toMatch(/NEXUS_BASE_URL/);
  });

  it("warns about a base URL that belongs to a provider it did not select", () => {
    const warnings = createModel({ ANTHROPIC_API_KEY: "key", OPENAI_BASE_URL: "http://proxy/v1" }).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/OPENAI_BASE_URL/);
    expect(warnings[0]).toMatch(/anthropic/);
    // The matching one is not a warning: it is in use.
    expect(createModel({ ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "http://proxy/v1" }).warnings).toEqual([]);
  });

  it("accepts a base URL for each vendor that has one", () => {
    expect(
      createModel({ NEXUS_PROVIDER: "openai", OPENAI_API_KEY: "key", OPENAI_BASE_URL: "http://proxy/v1" }).warnings,
    ).toEqual([]);
    expect(
      createModel({
        NEXUS_PROVIDER: "google",
        GEMINI_API_KEY: "key",
        GEMINI_BASE_URL: "http://proxy/v1beta",
      }).warnings,
    ).toEqual([]);
    expect(
      createModel({ NEXUS_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://box:11434/v1" }).warnings,
    ).toEqual([]);
    // The stub reads no endpoint at all, so every URL is inert next to it.
    expect(createModel({ NEXUS_PROVIDER: "stub" }).warnings).toEqual([]);
  });

  it("refuses a provider it does not know, and lists the ones it does", () => {
    expect(() => parseProvider("gemini")).toThrow(/Supported providers: anthropic, openai, google, ollama/);
    expect(parseProvider(" Anthropic ")).toBe("anthropic");
    expect(parseProvider(undefined)).toBe("anthropic");
  });

  it("builds the stub without touching the network", () => {
    const choice = createModel({ NEXUS_PROVIDER: "stub" });
    expect(choice.provider).toBe("stub");
    expect(choice.modelId).toBe("stub-1");
    expect(choice.model).toBeDefined();
  });
});
