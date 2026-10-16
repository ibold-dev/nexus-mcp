import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/env-file.js";

/**
 * `.env` is what a local run does not read by itself, and the failure it produces
 * is invisible: the variables that came from the file simply never arrive, and
 * the run proceeds against defaults as though nobody had asked for anything.
 */
const KEY = "NEXUS_TEST_FROM_FILE";

describe("loading .env", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "nexus-env-"));
    delete process.env[KEY];
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    delete process.env[KEY];
  });

  it("says nothing and loads nothing when there is no file", () => {
    expect(loadDotEnv(directory)).toBeUndefined();
    expect(process.env[KEY]).toBeUndefined();
  });

  it("supplies a variable that only the file defines", () => {
    writeFileSync(join(directory, ".env"), `${KEY}=from_file\n`);
    expect(loadDotEnv(directory)).toBe(join(directory, ".env"));
    expect(process.env[KEY]).toBe("from_file");
  });

  it("never overwrites a variable that is already exported", () => {
    // The property the callers depend on: `FOO=bar node …` and the Compose
    // environment still win over the file.
    process.env[KEY] = "from_env";
    writeFileSync(join(directory, ".env"), `${KEY}=from_file\n`);
    loadDotEnv(directory);
    expect(process.env[KEY]).toBe("from_env");
  });
});
