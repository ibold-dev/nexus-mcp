import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createStubModel, defaultStubScript, type StubScript } from "./stub-model.js";

/**
 * Every provider a Nexus agent can be pointed at.
 *
 * Claude is the default, and nothing about the agent changes when the provider
 * does: the same tool loop, the same MCP tools, the same graph. `stub` is a
 * scripted model with no network access at all, used by the tests and by the
 * offline benchmark run.
 */
export const PROVIDERS = ["anthropic", "openai", "google", "ollama", "openai-compatible", "stub"] as const;

export type Provider = (typeof PROVIDERS)[number];

export const DEFAULT_PROVIDER: Provider = "anthropic";

/** The model used when NEXUS_MODEL is not set. */
export const DEFAULT_MODEL_IDS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.6",
  google: "gemini-3.8-flash",
  ollama: "qwen3.5:9b",
  // An OpenAI-compatible endpoint is someone else's server: it must be told
  // which model to use rather than being guessed at.
  "openai-compatible": "",
  stub: "stub-1",
};

/** Which environment variable each provider reads its credential from. */
export const PROVIDER_KEY_ENV: Record<Provider, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  ollama: null,
  "openai-compatible": "NEXUS_API_KEY",
  stub: null,
};

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

/**
 * The endpoint each provider talks to, and the variable that can point it
 * somewhere else.
 *
 * The AI SDK wrappers compile the vendor host into the bundle and do not read
 * the vendor environment variables themselves, so a URL takes effect only
 * because it is passed to the constructor here. Every one of these is optional
 * except `NEXUS_BASE_URL`, which is the whole identity of `openai-compatible`:
 * there is no vendor default to fall back on.
 */
export const PROVIDER_BASE_URL_ENV: Record<Provider, string | null> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  google: "GEMINI_BASE_URL",
  ollama: "OLLAMA_BASE_URL",
  "openai-compatible": "NEXUS_BASE_URL",
  stub: null,
};

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export interface ModelChoice {
  provider: Provider;
  modelId: string;
  model: LanguageModel;
  /**
   * Configuration that was set and has no effect on the provider chosen — a
   * base URL belonging to a provider that was not selected. Returned rather
   * than written to stderr, so the library stays quiet and the caller decides
   * what to do with it.
   */
  warnings: string[];
}

export interface CreateModelOptions {
  /** The script the `stub` provider replays. Defaults to the change-impact script. */
  stubScript?: StubScript;
}

/**
 * Builds the model for the configured provider, failing fast and by name when
 * the configuration is incomplete. There is no silent fallback: an agent that
 * quietly answered with a different model than the one asked for would be worse
 * than one that refused to start.
 */
export function createModel(env: NodeJS.ProcessEnv = process.env, options: CreateModelOptions = {}): ModelChoice {
  const provider = parseProvider(env.NEXUS_PROVIDER, env);
  const modelId = env.NEXUS_MODEL?.trim() || DEFAULT_MODEL_IDS[provider];
  const baseURL = providerBaseUrl(env, provider);
  const warnings = unusedBaseUrlWarnings(env, provider);

  switch (provider) {
    case "anthropic": {
      const apiKey = requireEnv(env, "ANTHROPIC_API_KEY", provider);
      return {
        provider,
        modelId,
        warnings,
        model: createAnthropic({ apiKey, ...baseUrlOption(baseURL) }).languageModel(modelId),
      };
    }
    case "openai": {
      const apiKey = requireEnv(env, "OPENAI_API_KEY", provider);
      return {
        provider,
        modelId,
        warnings,
        model: createOpenAI({ apiKey, ...baseUrlOption(baseURL) }).languageModel(modelId),
      };
    }
    case "google": {
      const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        throw new ProviderConfigError(
          `NEXUS_PROVIDER=google needs GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY). Set it, or pick another provider: ${PROVIDERS.join(", ")}.`,
        );
      }
      return {
        provider,
        modelId,
        warnings,
        model: createGoogleGenerativeAI({ apiKey, ...baseUrlOption(baseURL) }).languageModel(modelId),
      };
    }
    case "ollama": {
      // Ollama speaks the OpenAI-compatible protocol and needs no credential,
      // so the whole agent runs locally with nothing but the graph.
      return {
        provider,
        modelId,
        warnings,
        model: createOpenAICompatible({
          name: "ollama",
          baseURL: baseURL ?? OLLAMA_DEFAULT_BASE_URL,
          apiKey: "ollama",
        }).languageModel(modelId),
      };
    }
    case "openai-compatible": {
      // Required, not optional: this provider is defined by its URL.
      const compatibleBaseURL = requireEnv(env, "NEXUS_BASE_URL", provider);
      if (modelId === "") {
        throw new ProviderConfigError(
          "NEXUS_PROVIDER=openai-compatible needs NEXUS_MODEL, the model id served at NEXUS_BASE_URL.",
        );
      }
      const name = env.NEXUS_PROVIDER_NAME?.trim() || "openai-compatible";
      const apiKey = env.NEXUS_API_KEY?.trim();
      return {
        provider,
        modelId,
        warnings,
        model: createOpenAICompatible({
          name,
          baseURL: compatibleBaseURL,
          ...(apiKey === undefined ? {} : { apiKey }),
        }).languageModel(modelId),
      };
    }
    case "stub": {
      const script =
        options.stubScript ?? defaultStubScript(env.NEXUS_STUB_SYMBOL?.trim() || "run");
      return { provider, modelId, warnings, model: createStubModel(script, { modelId }) };
    }
  }
}

/**
 * The provider to use, and the one place a configuration choice is inferred
 * rather than named.
 *
 * An explicit `NEXUS_PROVIDER` always wins. With no provider named, a base URL
 * is on its own the OpenAI-compatible case, because a bare URL can only be an
 * OpenAI-shaped server — it says nothing about which vendor's API is behind it.
 * The inference fills in a provider; it never fills in a model, so a run that
 * needs `NEXUS_MODEL` still fails fast and says so.
 */
export function parseProvider(value: string | undefined, env: NodeJS.ProcessEnv = {}): Provider {
  const name = (value ?? "").trim().toLowerCase();
  if (name === "") {
    return env.NEXUS_BASE_URL?.trim() ? "openai-compatible" : DEFAULT_PROVIDER;
  }
  if ((PROVIDERS as readonly string[]).includes(name)) {
    return name as Provider;
  }
  throw new ProviderConfigError(
    `Unknown NEXUS_PROVIDER "${value}". Supported providers: ${PROVIDERS.join(", ")}.`,
  );
}

function baseUrlOption(baseURL: string | undefined): { baseURL?: string } {
  return baseURL === undefined ? {} : { baseURL };
}

function providerBaseUrl(env: NodeJS.ProcessEnv, provider: Provider): string | undefined {
  const name = PROVIDER_BASE_URL_ENV[provider];
  return name === null ? undefined : env[name]?.trim() || undefined;
}

/**
 * A base URL that belongs to a provider other than the selected one does
 * nothing, and silently doing nothing is how an afternoon gets lost: the URL
 * was exported in a shell profile, or copied from the example file, and the
 * requests went to the vendor anyway. Each one is named.
 */
function unusedBaseUrlWarnings(env: NodeJS.ProcessEnv, selected: Provider): string[] {
  const warnings: string[] = [];
  for (const provider of PROVIDERS) {
    if (provider === selected) {
      continue;
    }
    const name = PROVIDER_BASE_URL_ENV[provider];
    if (name === null || !env[name]?.trim()) {
      continue;
    }
    warnings.push(
      `${name} is set, but the provider is ${selected}: it applies to ${provider} and is being ignored.`,
    );
  }
  return warnings;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string, provider: Provider): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ProviderConfigError(
      `NEXUS_PROVIDER=${provider} needs ${name}. Set it, or pick another provider: ${PROVIDERS.join(", ")}.`,
    );
  }
  return value;
}
