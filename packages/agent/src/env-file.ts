import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads `.env` from the working directory, the way Compose already does.
 *
 * A local `node dist/main.js` run reads nothing on its own, so a variable set in
 * `.env` is silently ignored: the run behaves exactly as though the file were not
 * there, and the only symptom is that half the configuration had no effect. That
 * is how a working provider setup turns into an hour of looking at the wrong
 * thing, so the file is read.
 *
 * Node's own loader is used, which costs no dependency and has the property this
 * needs: a variable that is already exported always wins over the file, so
 * `FOO=bar node …` and the Compose `environment:` block both keep overriding it.
 *
 * Returns the path that was loaded, or undefined when there is no file — the
 * caller decides whether to mention it.
 */
export function loadDotEnv(directory: string = process.cwd()): string | undefined {
  const path = resolve(directory, ".env");
  if (!existsSync(path)) {
    return undefined;
  }
  process.loadEnvFile(path);
  return path;
}
