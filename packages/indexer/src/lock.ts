import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export const LOCK_DIRECTORY = ".nexus";
const LOCK_FILE = "sync.lock";

export class RepositoryLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryLockedError";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquire(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid), "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
      if (Number.isInteger(owner) && owner > 0 && isProcessAlive(owner)) {
        throw new RepositoryLockedError(`repository is being synced by process ${owner}`);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new RepositoryLockedError("could not acquire the repository lock");
}

export async function withRepositoryLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const directory = path.join(root, LOCK_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, LOCK_FILE);
  await acquire(lockPath);
  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true });
  }
}
