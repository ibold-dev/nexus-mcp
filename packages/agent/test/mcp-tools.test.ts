import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  SYNC_TOOL_TIMEOUT_MS,
  callNexusTool,
  toolTimeoutMs,
} from "../src/mcp-tools.js";

/**
 * The client timeout is not decoration. A cold index of a real repository runs
 * for longer than the SDK's 60-second default; when the client gives up, the
 * server keeps indexing and the read that follows is answered by a graph that
 * is still being written. These tests pin the behaviour rather than the number.
 */

async function slowServer(milliseconds: number): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer({ name: "slow", version: "0.0.0" });
  const wait = async (): Promise<{ content: { type: "text"; text: string }[] }> => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  };
  server.registerTool("nexus_sync", { title: "Slow sync", inputSchema: {} }, wait);
  server.registerTool("nexus_locate", { title: "Slow locate", inputSchema: {} }, wait);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "timeout-test", version: "0.1.0" });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("tool timeouts", () => {
  it("gives the sync far longer than it gives a read", () => {
    expect(toolTimeoutMs("nexus_sync")).toBe(SYNC_TOOL_TIMEOUT_MS);
    expect(toolTimeoutMs("nexus_locate")).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    // Both are far above the SDK default of 60s, which is the number that broke.
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(SYNC_TOOL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it("lets a sync outlive the SDK default", async () => {
    // 200 ms is well under the default, so this proves the call is not being
    // cut off at a short timeout the caller set by accident.
    const slow = await slowServer(200);
    try {
      const outcome = await callNexusTool(slow.client, "nexus_sync");
      expect(outcome.ok).toBe(true);
      expect(outcome.body).toEqual({ ok: true });
    } finally {
      await slow.close();
    }
  });

  it("still honours an explicit timeout when one is given", async () => {
    const slow = await slowServer(300);
    try {
      await expect(callNexusTool(slow.client, "nexus_sync", {}, { timeoutMs: 20 })).rejects.toThrow();
    } finally {
      await slow.close();
    }
  });

  it("reports a tool's own failure as a failure rather than throwing", async () => {
    const server = new McpServer({ name: "failing", version: "0.0.0" });
    server.registerTool(
      "nexus_locate",
      { title: "Fails", inputSchema: {} },
      async () => ({ isError: true, content: [{ type: "text", text: "no symbol matched" }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "failure-test", version: "0.1.0" });
    await client.connect(clientTransport);

    try {
      const outcome = await callNexusTool(client, "nexus_locate");
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toBe("no symbol matched");
      expect(outcome.body).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
