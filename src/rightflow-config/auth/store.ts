import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentName } from "../env.ts";

/** What the plugin keeps between calls. One file per environment, readable only by its owner. */
export interface StoredSession {
  version: 1;
  refreshToken: string;
  /** Short-lived token for the selected firm. Absent until a firm is selected. */
  accessToken?: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt?: number;
  organizationId?: string;
  organizationName?: string;
  /** Firms the login belongs to, as the sign-in service reported them. */
  organizationIds: string[];
  signedInAt: string;
}

export class SessionStore {
  private readonly directory: string;
  private readonly env: EnvironmentName;

  constructor(directory: string, env: EnvironmentName) {
    this.directory = directory;
    this.env = env;
  }

  get path(): string {
    return join(this.directory, `session-${this.env}.json`);
  }

  async read(): Promise<StoredSession | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSession(parsed)) {
      throw new Error(`The saved sign-in at ${this.path} is not in a format this plugin understands. Sign out and in again.`);
    }
    return parsed;
  }

  /** Writes atomically with mode 0600, so a crash never leaves half a file and nobody else can read it. */
  async write(session: StoredSession): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  /**
   * Runs `fn` while holding a lock file next to the session. The sign-in service
   * rotates refresh tokens, so two Claude sessions refreshing at once would spend
   * the same token and sign each other out; the second one waits and then reads
   * what the first one wrote.
   */
  async withLock<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.close();
        break;
      } catch (err) {
        if (!isExists(err)) throw err;
        if (await isStale(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Another Claude session is holding the sign-in lock (${lockPath}). Try again in a moment.`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

/** A lock older than this belongs to a process that died while holding it. */
const STALE_LOCK_MS = 30_000;

async function isStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS;
  } catch (err) {
    return isNotFound(err);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function isExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.refreshToken === "string" &&
    Array.isArray(v.organizationIds) &&
    v.organizationIds.every((id) => typeof id === "string") &&
    typeof v.signedInAt === "string"
  );
}
