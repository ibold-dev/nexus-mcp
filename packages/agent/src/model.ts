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
  const provider = parseProvider(env.NEXUS_PROVIDER);
  const modelId = env.NEXUS_MODEL?.trim() || DEFAULT_MODEL_IDS[provider];

  switch (provider) {
    case "anthropic": {
      const apiKey = requireEnv(env, "ANTHROPIC_API_KEY", provider);
      return { provider, modelId, model: createAnthropic({ apiKey }).languageModel(modelId) };
    }
    case "openai": {
      const apiKey = requireEnv(env, "OPENAI_API_KEY", provider);
      return { provider, modelId, model: createOpenAI({ apiKey }).languageModel(modelId) };
    }
    case "google": {
      const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        throw new ProviderConfigError(
          `NEXUS_PROVIDER=google needs GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY). Set it, or pick another provider: ${PROVIDERS.join(", ")}.`,
        );
      }
      return { provider, modelId, model: createGoogleGenerativeAI({ apiKey }).languageModel(modelId) };
    }
    case "ollama": {
      // Ollama speaks the OpenAI-compatible protocol and needs no credential,
      // so the whole agent runs locally with nothing but the graph.
      const baseURL = env.OLLAMA_BASE_URL?.trim() || OLLAMA_DEFAULT_BASE_URL;
      return {
        provider,
        modelId,
        model: createOpenAICompatible({ name: "ollama", baseURL, apiKey: "ollama" }).languageModel(modelId),
      };
    }
    case "openai-compatible": {
      const baseURL = requireEnv(env, "NEXUS_BASE_URL", provider);
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
        model: createOpenAICompatible({
          name,
          baseURL,
          ...(apiKey === undefined ? {} : { apiKey }),
        }).languageModel(modelId),
      };
    }
    case "stub": {
      const script =
        options.stubScript ?? defaultStubScript(env.NEXUS_STUB_SYMBOL?.trim() || "run");
      return { provider, modelId, model: createStubModel(script, { modelId }) };
    }
  }
}

export function parseProvider(value: string | undefined): Provider {
  const name = (value ?? DEFAULT_PROVIDER).trim().toLowerCase();
  if ((PROVIDERS as readonly string[]).includes(name)) {
    return name as Provider;
  }
  throw new ProviderConfigError(
    `Unknown NEXUS_PROVIDER "${value}". Supported providers: ${PROVIDERS.join(", ")}.`,
  );
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
