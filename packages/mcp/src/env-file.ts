import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads `.env` from the working directory, the way Compose already does.
 *
 * The server is started by an editor, by Compose, or by hand, and only one of
 * those three reads a `.env` file. When it is started by hand the variables in
 * that file are silently absent — the server comes up against defaults, or fails
 * on a variable that is plainly set in the file the reader is looking at.
 *
 * Node's own loader is used: no dependency, and an already-exported variable
 * always wins over the file, so an editor's `env` block and the Compose
 * `environment:` block both keep overriding it.
 *
 * Returns the path that was loaded, or undefined when there is no file.
 */
export function loadDotEnv(directory: string = process.cwd()): string | undefined {
  const path = resolve(directory, ".env");
  if (!existsSync(path)) {
    return undefined;
  }
  process.loadEnvFile(path);
  return path;
}
