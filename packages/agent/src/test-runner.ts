import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * A test runner an agent is allowed to touch, and nothing more.
 *
 * An agent that can run arbitrary commands is an agent that can do arbitrary
 * damage, so this one runs a fixed command with validated arguments: test files,
 * inside the repository root, no shell, no flags of the model's choosing. It is
 * off unless the operator turns it on.
 */

/**
 * The one command the runner will use. The reporter matters: `basic` was
 * removed in Vitest 5, where an unknown reporter name is treated as a module
 * path and the run dies before a single test executes. `dot` is stable and
 * terse, which is what an agent wants to read anyway.
 */
export const DEFAULT_TEST_RUNNER = ["pnpm", "exec", "vitest", "run", "--reporter=dot"] as const;

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
const MAX_OUTPUT_CHARS = 12_000;

export class TestRunNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestRunNotAllowedError";
  }
}

export interface TestRunnerOptions {
  /** The repository root. Nothing outside it can be run. */
  root: string;
  /** Off by default: the operator has to allow the runner to run anything. */
  enabled?: boolean;
  /** The only command that will be run. */
  runner?: readonly string[];
  timeoutMs?: number;
}

export interface TestRunRequest {
  /** Repository-relative paths of test files. */
  paths: string[];
}

export interface TestRunResult {
  command: string;
  paths: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Validates the requested paths and returns them relative to the root.
 *
 * A path must be relative, must stay inside the root, must not contain a
 * traversal, and must name a test file. Anything else is refused with the reason.
 */
export async function resolveTestPaths(root: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) {
    throw new TestRunNotAllowedError("Name at least one test file to run.");
  }
  if (paths.length > 10) {
    throw new TestRunNotAllowedError("At most 10 test files can be run at once.");
  }

  const absoluteRoot = path.resolve(root);
  const resolved: string[] = [];

  for (const candidate of paths) {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new TestRunNotAllowedError("Every test path must be a non-empty string.");
    }
    const trimmed = candidate.trim();
    if (path.isAbsolute(trimmed)) {
      throw new TestRunNotAllowedError(`"${trimmed}" is absolute. Give a path relative to the repository root.`);
    }
    if (trimmed.includes("\0")) {
      throw new TestRunNotAllowedError(`"${trimmed}" contains a null byte.`);
    }
    const normalised = path.normalize(trimmed);
    if (normalised.startsWith("..") || normalised.split(path.sep).includes("..")) {
      throw new TestRunNotAllowedError(`"${trimmed}" leaves the repository root.`);
    }
    if (!TEST_FILE_PATTERN.test(normalised)) {
      throw new TestRunNotAllowedError(`"${trimmed}" is not a test file (.test.ts, .spec.ts, and their variants).`);
    }
    const absolute = path.resolve(absoluteRoot, normalised);
    if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
      throw new TestRunNotAllowedError(`"${trimmed}" is outside the repository root.`);
    }
    try {
      await access(absolute);
    } catch {
      throw new TestRunNotAllowedError(`"${trimmed}" does not exist.`);
    }
    resolved.push(normalised);
  }

  return [...new Set(resolved)];
}

/** Runs the allowlisted test command over the requested test files. */
export async function runTests(options: TestRunnerOptions, request: TestRunRequest): Promise<TestRunResult> {
  if (options.enabled !== true) {
    throw new TestRunNotAllowedError(
      "The test runner is off. Set NEXUS_ALLOW_TESTS=1 to let the agent run tests.",
    );
  }

  const runner = options.runner ?? DEFAULT_TEST_RUNNER;
  const command = runner[0];
  if (command === undefined) {
    throw new TestRunNotAllowedError("The test runner command is empty.");
  }

  const paths = await resolveTestPaths(options.root, request.paths);
  const args = [...runner.slice(1), ...paths];
  const startedAt = Date.now();
  let timedOut = false;

  return await new Promise<TestRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new TestRunNotAllowedError(`Could not run "${command}": ${error.message}`));
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        paths,
        exitCode,
        signal,
        stdout: tail(stdout),
        stderr: tail(stderr),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/** Keeps the end of a long log, which is where the summary is. */
function tail(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `… ${text.length - MAX_OUTPUT_CHARS} characters trimmed …\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}
