import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/env-file.js";

/**
 * The server is often started by hand, from a directory where the reader can see
 * a `.env` file — and a hand-started server would not read it. The variable that
 * matters most here is NEXUS_ROOT: without it the server exits, complaining
 * about a variable the reader can see in the file they are looking at.
 */
const KEY = "NEXUS_TEST_SERVER_FROM_FILE";

describe("loading .env when the server starts", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "nexus-mcp-env-"));
    delete process.env[KEY];
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    delete process.env[KEY];
  });

  it("supplies what the file defines and reports where it read it", () => {
    writeFileSync(join(directory, ".env"), `${KEY}=from_file\n`);
    expect(loadDotEnv(directory)).toBe(join(directory, ".env"));
    expect(process.env[KEY]).toBe("from_file");
  });

  it("reports nothing when there is no file", () => {
    expect(loadDotEnv(directory)).toBeUndefined();
  });
});
