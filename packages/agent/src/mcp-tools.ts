import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { jsonSchema, tool, type Tool } from "ai";

/**
 * The bridge from the Nexus MCP server to a model's tool-calling API.
 *
 * The agent does not get a bespoke client for the graph. It gets the same MCP
 * tools every other client gets, described by the server itself, so a run in
 * this harness and a run inside OpenCode or Claude Code exercise the same code.
 */

/** Tool input, as the server advertises it. */
export interface McpToolDescription {
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
}

export interface McpToolOutcome {
  /** False when the server reported the call itself as a failure. */
  ok: boolean;
  /** The response text, always present. */
  text: string;
  /** The response parsed as JSON when it was JSON. */
  body: unknown;
}

export const DEFAULT_SERVER_ENTRY = fileURLToPath(new URL("../../mcp/dist/main.js", import.meta.url));

export interface NexusToolsOptions {
  /** The repository the server indexes. */
  root: string;
  graphUrl?: string;
  graphName?: string;
  salt?: string;
  userId?: string;
  agentId?: string;
  /** The MCP server entry point. Defaults to the build in this workspace. */
  serverEntry?: string;
  /** Connect using this transport instead of spawning a server process. */
  transport?: Transport;
  /** Environment for the spawned server, on top of the agent's own. */
  env?: Record<string, string>;
}

export interface NexusConnection {
  client: Client;
  /** The MCP tools, ready to hand to `generateText`. */
  tools: Record<string, Tool>;
  toolNames: string[];
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolOutcome>;
  close(): Promise<void>;
}

/** Calls one MCP tool and normalises the result, whichever shape it came in. */
export async function callNexusTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
  const ok = result.isError !== true;
  return { ok, text, body: ok ? tryParseJson(text) : undefined };
}

/**
 * Turns MCP tool descriptions into tools a model can call. The JSON Schema the
 * server published is used as-is, so the tool arguments the model sees are the
 * ones the server validates against.
 */
export function nexusToolsAsAiSdk(client: Client, descriptions: McpToolDescription[]): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const description of descriptions) {
    tools[description.name] = tool({
      ...(description.description === undefined ? {} : { description: description.description }),
      inputSchema: jsonSchema<Record<string, unknown>>(description.inputSchema as JSONSchema7),
      execute: async (input) => {
        const outcome = await callNexusTool(client, description.name, input);
        return outcome.ok ? (outcome.body ?? outcome.text) : { ok: false, error: outcome.text };
      },
    });
  }
  return tools;
}

/** Spawns the Nexus MCP server over stdio and turns its tools into model tools. */
export async function connectNexusTools(options: NexusToolsOptions): Promise<NexusConnection> {
  const client = new Client({ name: "nexus-agent", version: "0.1.0" });

  if (options.transport !== undefined) {
    await client.connect(options.transport);
  } else {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    env.NEXUS_ROOT = options.root;
    Object.assign(env, options.env ?? {});
    if (options.graphUrl !== undefined) {
      env.FALKORDB_URL = options.graphUrl;
    }
    if (options.graphName !== undefined) {
      env.NEXUS_GRAPH = options.graphName;
    }
    if (options.salt !== undefined) {
      env.NEXUS_SALT = options.salt;
    }
    if (options.userId !== undefined) {
      env.NEXUS_USER = options.userId;
    }
    if (options.agentId !== undefined) {
      env.NEXUS_AGENT = options.agentId;
    }

    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [options.serverEntry ?? DEFAULT_SERVER_ENTRY],
        cwd: options.root,
        env,
        stderr: "inherit",
      }),
    );
  }

  const listed = await client.listTools();
  const tools = nexusToolsAsAiSdk(client, listed.tools);
  return {
    client,
    tools,
    toolNames: listed.tools.map((entry) => entry.name),
    callTool: (name, args) => callNexusTool(client, name, args ?? {}),
    close: async () => {
      await client.close();
    },
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
