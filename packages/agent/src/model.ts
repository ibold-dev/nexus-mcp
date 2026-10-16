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
  // An OpenAI-compatible endpoint names its own models, so there is nothing to
  // guess: the endpoint is asked (see `discoverModel`) or NEXUS_MODEL says so.
  "openai-compatible": "",
  stub: "stub-1",
};

/**
 * The variables each provider will accept a credential from, best first.
 *
 * The vendor's own name is preferred, and the vendor-neutral NEXUS_API_KEY is
 * accepted by everything so that one key and one URL are enough to configure a
 * run. The order is the whole rule: the first one that is set is used.
 */
export const PROVIDER_KEY_FALLBACKS: Record<Provider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "NEXUS_API_KEY"],
  openai: ["OPENAI_API_KEY", "NEXUS_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "NEXUS_API_KEY"],
  ollama: [],
  // An OpenAI-shaped server is not a vendor, so the neutral name comes first.
  "openai-compatible": ["NEXUS_API_KEY", "OPENAI_API_KEY"],
  stub: [],
};

/** Which environment variable each provider reads its credential from. */
export const PROVIDER_KEY_ENV: Record<Provider, string | null> = Object.fromEntries(
  PROVIDERS.map((provider) => [provider, PROVIDER_KEY_FALLBACKS[provider][0] ?? null]),
) as Record<Provider, string | null>;

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

/** The vendor host whose API is not the OpenAI-shaped chat API. */
export const OPENAI_HOST = "api.openai.com";

/** How long a model-list request is given before the run gives up on it. */
const DISCOVERY_TIMEOUT_MS = 10_000;

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/**
 * Which wire protocol the chosen endpoint speaks.
 *
 * It matters because it is not derivable from the base URL alone: two servers
 * can both answer at `/v1` and still disagree about which API is behind it, and
 * getting it wrong fails at the *second* call, in the middle of a tool loop,
 * with an error about a tool call id that means nothing to the reader. DeepSeek
 * is the worked example: its bundled OpenAI model spoke the Responses API at
 * `/responses` and rejected the tool result, while the chat API at
 * `/chat/completions` ran the same loop to completion.
 */
export type ProviderApi = "messages" | "generateContent" | "chat" | "responses" | "stub";

/**
 * How the provider was decided. Kept because "why is it using that one?" is the
 * question every surprising run starts with, and the answer is not in the
 * resolved value on its own.
 */
export type ProviderSource = "explicit" | "generic-url" | "openai-url" | "credential" | "default";

export interface ResolvedProvider {
  provider: Provider;
  /** What to call it in messages: the vendor, or the host that is being talked to. */
  providerName: string;
  /** The wire protocol to speak to `baseURL`. */
  api: ProviderApi;
  /** Where requests go. Undefined means the vendor's own default host. */
  baseURL?: string;
  apiKey?: string;
  /** The variable the key came from, so a report can say which one was used. */
  apiKeyEnv?: string;
  /** The model to ask for. Undefined means the endpoint has yet to name one. */
  modelId?: string;
  providerSource: ProviderSource;
  /** One line per decision, in the order they were made. */
  reasons: string[];
  /** Configuration that is set and has no effect. */
  warnings: string[];
  /**
   * What makes a run impossible, phrased for the person who has to fix it. Empty
   * means runnable. Nothing here is thrown: a report wants to list all of them,
   * and a run wants the first one to stop it.
   */
  problems: string[];
}

export interface ModelChoice {
  provider: Provider;
  /** The name to show for it: the host for an OpenAI-shaped endpoint. */
  providerName: string;
  /** The wire protocol in use, for the startup line and for `--json`. */
  api: ProviderApi;
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
 * Reads the configuration and decides everything that can be decided without a
 * network call: provider, protocol, endpoint, key and model.
 *
 * The goal is that one key and one URL are enough. A person who has
 * `OPENAI_BASE_URL` pointing at a gateway, or a single vendor key exported, has
 * already said what they mean, and being made to repeat it in NEXUS_ variables
 * is how a fast setup becomes a slow one. The inference fills in a *provider*;
 * the model is only ever taken from NEXUS_MODEL, a vendor default, or the
 * endpoint itself (see `discoverModel`), never from a guess.
 *
 * Nothing here throws except an unknown provider name — a typo is a typo — and
 * nothing here touches the network, so the whole truth table is testable and the
 * caller can print it. What would stop a run is collected in `problems`.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const problems: string[] = [];

  const explicit = env.NEXUS_PROVIDER?.trim();
  const genericUrl = env.NEXUS_BASE_URL?.trim();
  const openaiUrl = env.OPENAI_BASE_URL?.trim();
  const credentials = credentialCandidates(env);
  const [onlyCredential, ...otherCredentials] = credentials;

  // Which provider, in the order a person would mean it. An explicit name always
  // wins; then any endpoint that was pointed somewhere, because pointing a URL
  // somewhere is a deliberate act; then the only key on the machine, because it
  // is unambiguous; then the default.
  let provider: Provider;
  let providerSource: ProviderSource;
  const openaiHost = openaiUrl === undefined || openaiUrl === "" ? undefined : hostnameOf(openaiUrl);
  if (explicit !== undefined && explicit !== "") {
    provider = parseProvider(explicit);
    providerSource = "explicit";
    reasons.push(`provider ${provider} (NEXUS_PROVIDER)`);
  } else if (genericUrl !== undefined && genericUrl !== "") {
    provider = "openai-compatible";
    providerSource = "generic-url";
    reasons.push(
      "provider openai-compatible (NEXUS_BASE_URL: a bare URL can only be an OpenAI-shaped server)",
    );
  } else if (openaiHost !== undefined && openaiHost !== OPENAI_HOST) {
    provider = "openai-compatible";
    providerSource = "openai-url";
    reasons.push(`provider openai-compatible (OPENAI_BASE_URL points at ${openaiHost}, not ${OPENAI_HOST})`);
  } else if (openaiHost !== undefined) {
    provider = "openai";
    providerSource = "openai-url";
    reasons.push(`provider openai (OPENAI_BASE_URL points at ${OPENAI_HOST})`);
  } else if (onlyCredential !== undefined && otherCredentials.length === 0) {
    provider = onlyCredential.provider;
    providerSource = "credential";
    reasons.push(`provider ${provider} (${onlyCredential.name} is the only credential set)`);
  } else if (onlyCredential !== undefined) {
    provider = DEFAULT_PROVIDER;
    providerSource = "default";
    problems.push(
      `${joinNames(credentials.map((candidate) => candidate.name))} are set, so the provider is ambiguous: ` +
        "choose one with NEXUS_PROVIDER.",
    );
  } else {
    provider = DEFAULT_PROVIDER;
    providerSource = "default";
    reasons.push(`provider ${provider} (the default; nothing said otherwise)`);
  }

  // Where requests go.
  let baseURL: string | undefined;
  let baseUrlEnv: string | undefined;
  switch (provider) {
    case "openai-compatible":
      // Either variable can point at it: NEXUS_BASE_URL is the one this project
      // documents, OPENAI_BASE_URL is the one people already have.
      baseURL = genericUrl || openaiUrl;
      baseUrlEnv = genericUrl ? "NEXUS_BASE_URL" : openaiUrl ? "OPENAI_BASE_URL" : undefined;
      if (baseURL === undefined) {
        problems.push(
          "openai-compatible needs an endpoint: set NEXUS_BASE_URL (or OPENAI_BASE_URL) to the server to talk to.",
        );
      }
      break;
    case "openai":
      baseURL = openaiUrl || undefined;
      baseUrlEnv = baseURL === undefined ? undefined : "OPENAI_BASE_URL";
      break;
    case "anthropic":
      baseURL = env.ANTHROPIC_BASE_URL?.trim() || undefined;
      baseUrlEnv = baseURL === undefined ? undefined : "ANTHROPIC_BASE_URL";
      break;
    case "google":
      baseURL = env.GEMINI_BASE_URL?.trim() || undefined;
      baseUrlEnv = baseURL === undefined ? undefined : "GEMINI_BASE_URL";
      break;
    case "ollama":
      baseURL = env.OLLAMA_BASE_URL?.trim() || OLLAMA_DEFAULT_BASE_URL;
      baseUrlEnv = env.OLLAMA_BASE_URL?.trim() ? "OLLAMA_BASE_URL" : undefined;
      break;
    case "stub":
      break;
  }

  const host = baseURL === undefined ? undefined : hostnameOf(baseURL);
  if (baseURL !== undefined && host === undefined) {
    problems.push(`${baseUrlEnv ?? "The base URL"} is not a URL: "${baseURL}".`);
  }

  // Which protocol that endpoint speaks.
  const requestedApi = env.NEXUS_OPENAI_API?.trim().toLowerCase();
  let api: ProviderApi;
  if (provider === "openai") {
    const endpointHost = host ?? OPENAI_HOST;
    const inferred: ProviderApi = endpointHost === OPENAI_HOST ? "responses" : "chat";
    if (requestedApi === "chat" || requestedApi === "responses") {
      api = requestedApi;
      reasons.push(`api ${api} (NEXUS_OPENAI_API)`);
    } else {
      api = inferred;
      reasons.push(
        api === "responses"
          ? `api ${API_DESCRIPTIONS.responses}`
          : `api chat completions (${endpointHost} is OpenAI-shaped, not ${OPENAI_HOST})`,
      );
      if (requestedApi !== undefined && requestedApi !== "") {
        problems.push(`NEXUS_OPENAI_API must be "chat" or "responses", not "${requestedApi}".`);
      }
    }
  } else {
    api = DEFAULT_APIS[provider];
    const description = API_DESCRIPTIONS[api];
    if (description !== "") {
      reasons.push(`api ${description}`);
    }
    if (requestedApi !== undefined && requestedApi !== "") {
      problems.push(
        `NEXUS_OPENAI_API is set, but the provider is ${provider}: it only applies to the openai ` +
          "provider, and an OpenAI-shaped server always speaks chat completions.",
      );
    }
  }

  // Which credential, from the first variable that has one.
  const keyVars = PROVIDER_KEY_FALLBACKS[provider];
  const apiKeyEnv = keyVars.find((name) => (env[name]?.trim() ?? "") !== "");
  const apiKey = apiKeyEnv === undefined ? undefined : env[apiKeyEnv]?.trim();
  if (apiKey === undefined && !KEYLESS_PROVIDERS.includes(provider)) {
    problems.push(
      `The ${provider} provider needs ${either(keyVars)}. Set it, or pick another provider: ${PROVIDERS.join(", ")}.`,
    );
  } else if (apiKeyEnv !== undefined) {
    reasons.push(keyVars.length > 1 ? `key ${apiKeyEnv} (of ${either(keyVars)})` : `key ${apiKeyEnv}`);
  }

  // Which model. Never guessed from the provider name: an endpoint that names
  // its own models is asked, and until it has answered there is no model.
  const namedModel = env.NEXUS_MODEL?.trim();
  const modelId = namedModel || DEFAULT_MODEL_IDS[provider] || undefined;
  if (namedModel) {
    reasons.push(`model ${namedModel} (NEXUS_MODEL)`);
  } else if (modelId !== undefined) {
    reasons.push(`model ${modelId} (the default for ${provider})`);
  } else {
    reasons.push(
      `${provider} endpoints name their own models, so the endpoint is asked for the list ` +
        "(nexus-agent --check), unless NEXUS_MODEL says which one.",
    );
  }

  const providerName =
    env.NEXUS_PROVIDER_NAME?.trim() ||
    (provider === "openai-compatible" && host !== undefined ? labelFromHost(host) : provider);

  return {
    provider,
    providerName,
    api,
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(modelId === undefined ? {} : { modelId }),
    providerSource,
    reasons,
    warnings: [...warnings, ...unusedBaseUrlWarnings(env, provider, baseUrlEnv)],
    problems,
  };
}

const DEFAULT_APIS: Record<Provider, ProviderApi> = {
  anthropic: "messages",
  openai: "responses",
  google: "generateContent",
  ollama: "chat",
  "openai-compatible": "chat",
  stub: "stub",
};

/** How to describe a wire protocol in one line of the resolution report. */
const API_DESCRIPTIONS: Record<ProviderApi, string> = {
  messages: "messages (anthropic's own API)",
  generateContent: "generateContent (google's own API)",
  chat: "chat completions (the OpenAI-shaped chat API)",
  responses: "responses (OpenAI's own API)",
  stub: "",
};

/**
 * The providers that run without a credential.
 *
 * An OpenAI-shaped endpoint is on the list on purpose: the reason to point at
 * one is often that it is a process on the same machine — a local server, a
 * gateway in front of the vendor — and those answer without a key. Asking for
 * one anyway would be inventing a requirement the protocol does not have.
 */
const KEYLESS_PROVIDERS: readonly Provider[] = ["ollama", "openai-compatible", "stub"];

export interface DiscoveryOptions {
  /** Injected by the tests; the real one is the global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Asks an endpoint which models it serves, for the provider that cannot know.
 *
 * An OpenAI-shaped server is somebody else's deployment, and the model id is the
 * one thing that cannot be inferred from the URL: it is the vendor's name for a
 * model, not a protocol detail. Rather than make the user look it up, the
 * endpoint is asked — `/models` is part of the API being spoken — and the answer
 * is printed, so the choice is always visible and can be overridden with
 * NEXUS_MODEL.
 *
 * Every failure here is a configuration failure with the same remedy, so they
 * all end in the same sentence: set NEXUS_MODEL.
 */
export async function discoverModel(
  resolved: ResolvedProvider,
  options: DiscoveryOptions = {},
): Promise<string> {
  const endpoint = resolved.baseURL;
  if (endpoint === undefined) {
    throw new ProviderConfigError(`${resolved.providerName} has no endpoint to ask for a model list.`);
  }
  const url = `${endpoint.replace(/\/+$/, "")}/models`;
  const fetchImpl = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: resolved.apiKey === undefined ? {} : { authorization: `Bearer ${resolved.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderConfigError(
      `Could not reach ${url} to list models (${(error as Error).message}). Set NEXUS_MODEL to the model id it serves.`,
    );
  }
  if (!response.ok) {
    // A rejected key is the one failure here with a different remedy, so it is
    // the one that gets a different sentence.
    const rejected =
      response.status === 401 || response.status === 403
        ? ` The key${resolved.apiKeyEnv === undefined ? "" : ` in ${resolved.apiKeyEnv}`} was rejected.`
        : "";
    throw new ProviderConfigError(
      `${url} answered ${response.status} ${response.statusText} when asked for the model list.${rejected} ` +
        "Set NEXUS_MODEL to the model id it serves.",
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProviderConfigError(`${url} did not answer with JSON. Set NEXUS_MODEL to the model id it serves.`);
  }

  const ids = modelIds(body);
  if (ids.length === 0) {
    throw new ProviderConfigError(`${url} listed no models. Set NEXUS_MODEL to the model id it serves.`);
  }
  const picked = pickModel(ids);
  if (picked === undefined) {
    throw new ProviderConfigError(
      `${url} lists ${ids.length} models (${summarise(ids)}), and none of them is obviously a default. ` +
        "Set NEXUS_MODEL to the one to use.",
    );
  }
  return picked;
}

/**
 * The model ids in a `/models` answer. The OpenAI shape is `{data:[{id}]}`,
 * which is what the API being spoken promises; `{models:[…]}` and a bare array
 * are accepted too, because servers that answer `/models` do not all wrap it
 * the same way and this is not the place to be strict.
 */
export function modelIds(body: unknown): string[] {
  const lists: unknown[] = [];
  if (Array.isArray(body)) {
    lists.push(body);
  } else if (isRecord(body)) {
    for (const key of ["data", "models"]) {
      if (Array.isArray(body[key])) {
        lists.push(body[key]);
      }
    }
  }
  const ids: string[] = [];
  for (const list of lists) {
    for (const entry of list as unknown[]) {
      if (typeof entry === "string" && entry.trim() !== "") {
        ids.push(entry.trim());
      } else if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim() !== "") {
        ids.push(entry.id.trim());
      }
    }
  }
  return [...new Set(ids)];
}

/**
 * A model id that is safe to pick without being asked: the cheapest-looking one
 * on offer.
 *
 * Preference is by name, because that is all the list gives: a `flash` or `mini`
 * or `small` model is the one a vendor prices for volume, and some vendors leave
 * the model the endpoint is really for out of `/models` entirely — DeepSeek
 * lists `deepseek-flash` and not the `deepseek-reasoner` it documents. When
 * nothing matches, no model is returned and the caller asks for NEXUS_MODEL
 * instead of picking a large expensive one at random.
 */
const MODEL_PREFERENCE = [/flash/i, /mini/i, /small/i, /lite/i, /chat/i, /turbo/i, /instruct/i];

export function pickModel(ids: string[]): string | undefined {
  const sorted = [...ids].sort();
  if (sorted.length === 1) {
    return sorted[0];
  }
  for (const pattern of MODEL_PREFERENCE) {
    const hit = sorted.find((id) => pattern.test(id));
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

function summarise(ids: string[]): string {
  const listed = ids.slice(0, 12).join(", ");
  return ids.length <= 12 ? listed : `${listed}, …`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The provider to use, from an explicitly named one. A name that is not one of
 * ours is a typo and stops the run; everything that can be *inferred* is decided
 * by `resolveProvider`, so there is one place that owns the inference.
 */
export function parseProvider(value: string): Provider {
  const name = value.trim().toLowerCase();
  if ((PROVIDERS as readonly string[]).includes(name)) {
    return name as Provider;
  }
  throw new ProviderConfigError(
    `Unknown NEXUS_PROVIDER "${value}". Supported providers: ${PROVIDERS.join(", ")}.`,
  );
}

/**
 * Builds the model for the configured provider, failing fast and by name when
 * the configuration is incomplete. There is no silent fallback: an agent that
 * quietly answered with a different model than the one asked for would be worse
 * than one that refused to start.
 */
export function createModel(env: NodeJS.ProcessEnv = process.env, options: CreateModelOptions = {}): ModelChoice {
  const resolved = resolveProvider(env);
  if (resolved.problems.length > 0) {
    throw new ProviderConfigError(resolved.problems.join(" "));
  }
  const { provider, providerName, api, baseURL, warnings } = resolved;
  const modelId = resolved.modelId;
  if (modelId === undefined) {
    throw new ProviderConfigError(
      `${providerName} has no model id: run \`nexus-agent --check\` to read one from the endpoint, ` +
        "or set NEXUS_MODEL.",
    );
  }

  switch (provider) {
    case "anthropic": {
      const apiKey = requiredKey(resolved);
      return {
        provider,
        providerName,
        api,
        modelId,
        warnings,
        model: createAnthropic({ apiKey, ...baseUrlOption(baseURL) }).languageModel(modelId),
      };
    }
    case "openai": {
      const apiKey = requiredKey(resolved);
      const openai = createOpenAI({ apiKey, ...baseUrlOption(baseURL) });
      // The one provider where the wire protocol is a choice rather than a
      // property of the vendor: `openai` is the Responses API, `chat` is the
      // older chat API that every OpenAI-shaped server also speaks.
      return {
        provider,
        providerName,
        api,
        modelId,
        warnings,
        model: api === "chat" ? openai.chat(modelId) : openai.languageModel(modelId),
      };
    }
    case "google": {
      const apiKey = requiredKey(resolved);
      return {
        provider,
        providerName,
        api,
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
        providerName,
        api,
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
      const endpoint = requiredBaseURL(resolved);
      const apiKey = resolved.apiKey;
      return {
        provider,
        providerName,
        api,
        modelId,
        warnings,
        model: createOpenAICompatible({
          name: providerName,
          baseURL: endpoint,
          ...(apiKey === undefined ? {} : { apiKey }),
        }).languageModel(modelId),
      };
    }
    case "stub": {
      const script = options.stubScript ?? defaultStubScript(env.NEXUS_STUB_SYMBOL?.trim() || "run");
      return { provider, providerName, api, modelId, warnings, model: createStubModel(script, { modelId }) };
    }
  }
}

function baseUrlOption(baseURL: string | undefined): { baseURL?: string } {
  return baseURL === undefined ? {} : { baseURL };
}

function requiredKey(resolved: ResolvedProvider): string {
  if (resolved.apiKey === undefined) {
    // Unreachable: `resolveProvider` reports a missing key as a problem, and
    // `createModel` throws on problems before it gets here. Stated anyway so the
    // type is honest and the day it changes is not a crash.
    throw new ProviderConfigError(
      `The ${resolved.provider} provider needs ${either(PROVIDER_KEY_FALLBACKS[resolved.provider])}.`,
    );
  }
  return resolved.apiKey;
}

function requiredBaseURL(resolved: ResolvedProvider): string {
  if (resolved.baseURL === undefined) {
    throw new ProviderConfigError("openai-compatible needs NEXUS_BASE_URL.");
  }
  return resolved.baseURL;
}

/**
 * A base URL that belongs to a provider other than the selected one does
 * nothing, and silently doing nothing is how an afternoon gets lost: the URL
 * was exported in a shell profile, or copied from the example file, and the
 * requests went to the vendor anyway. Each one is named.
 */
function unusedBaseUrlWarnings(env: NodeJS.ProcessEnv, selected: Provider, used: string | undefined): string[] {
  const warnings: string[] = [];
  for (const other of PROVIDERS) {
    if (other === selected) {
      continue;
    }
    const name = PROVIDER_BASE_URL_ENV[other];
    if (name === null || name === used || !env[name]?.trim()) {
      continue;
    }
    warnings.push(
      `${name} is set, but the provider is ${selected}: it applies to ${other} and is being ignored.`,
    );
  }
  return warnings;
}

/**
 * The vendor keys that are present, at most one per vendor.
 *
 * NEXUS_API_KEY is deliberately not counted: it is accepted by every provider,
 * so its presence says nothing about which one is meant, and treating it as a
 * credential would turn "which provider?" into a coin flip. With nothing else
 * set, the run still says which variable it needs.
 */
function credentialCandidates(env: NodeJS.ProcessEnv): Array<{ provider: Provider; name: string }> {
  const vendors: Array<{ provider: Provider; names: string[] }> = [
    { provider: "anthropic", names: ["ANTHROPIC_API_KEY"] },
    { provider: "openai", names: ["OPENAI_API_KEY"] },
    { provider: "google", names: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"] },
  ];
  const found: Array<{ provider: Provider; name: string }> = [];
  for (const vendor of vendors) {
    const name = vendor.names.find((candidate) => (env[candidate]?.trim() ?? "") !== "");
    if (name !== undefined) {
      found.push({ provider: vendor.provider, name });
    }
  }
  return found;
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to call an endpoint in messages. `https://api.deepseek.com/v1` is
 * "deepseek", because that is the word the user would use, and "openai-compatible"
 * names a protocol rather than the thing being talked to.
 */
export function labelFromHost(hostname: string): string {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    return hostname;
  }
  const parts = hostname.split(".");
  const [first, second] = parts;
  if (first === undefined) {
    return hostname;
  }
  return parts.length > 2 && (first === "api" || first === "www") && second !== undefined ? second : first;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

function either(names: string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;
}
