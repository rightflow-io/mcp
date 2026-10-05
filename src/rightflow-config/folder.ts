import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { Environment, EnvironmentName } from "./env.ts";
import { UserFacingError } from "./errors.ts";

/** Holds the marker. Hidden, so it is never mistaken for, or uploaded as, part of the team. */
export const MARKER_DIR = ".rightflow";
const MARKER_FILE = "team.json";

/** Far above any team; reached only when the folder chosen is not a team's own. */
const MAX_WALK_ENTRIES = 10_000;

/** Where a pulled team came from, and what it looked like then. */
export interface TeamMarker {
  version: 1;
  environment: EnvironmentName;
  firmId: string;
  firmName: string;
  /** Null until a new team has been created from this folder. */
  teamId: string | null;
  teamName: string;
  /** The team's version this folder is based on; null for a new team. */
  baseHash: string | null;
  /** sha256 of each file as pulled, so local changes are known without asking rightflow. */
  files: Record<string, string>;
}

export interface LocalChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** Relative to where Claude Code runs; the environment is part of it so a development copy never shares a folder with production. */
export function defaultFolder(env: Environment, name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return join("rightflow", env.name, slug || "team");
}

export function resolveFolder(folder: string, cwd: string = process.cwd()): string {
  return resolve(cwd, folder);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)]));
}

export async function readMarker(folder: string): Promise<TeamMarker | null> {
  let text: string;
  try {
    text = await readFile(join(folder, MARKER_DIR, MARKER_FILE), "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  const parsed = parseMarker(text);
  if (!parsed) {
    throw new UserFacingError(
      `${join(folder, MARKER_DIR, MARKER_FILE)} is not a rightflow team marker this plugin can read. ` +
        "Pull the team into a new folder.",
    );
  }
  return parsed;
}

export async function writeMarker(folder: string, marker: TeamMarker): Promise<void> {
  await mkdir(join(folder, MARKER_DIR), { recursive: true });
  await writeFile(join(folder, MARKER_DIR, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * The team as the folder holds it: every regular file, by its path relative to
 * the folder with `/` separators. Hidden files and folders are not part of a
 * team. A link is refused rather than followed, so the upload is exactly what
 * the folder shows.
 */
export async function readTeamFiles(folder: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let seen = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err) && dir === folder) throw new UserFacingError(`There is no folder ${folder}.`);
      throw err;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      if (++seen > MAX_WALK_ENTRIES) {
        throw new UserFacingError(`${folder} holds far more files than a team does. Choose the team's own folder.`);
      }
      const full = join(dir, entry.name);
      const rel = relative(folder, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new UserFacingError(`${rel} is a link. A team folder holds plain files only; replace it with the file itself.`);
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          files[rel] = decoder.decode(await readFile(full));
        } catch (err) {
          if (err instanceof TypeError) {
            throw new UserFacingError(`${rel} is not a text file in UTF-8. A team folder holds text files only.`);
          }
          throw err;
        }
      }
    }
  };
  await walk(folder);
  return files;
}

export function localChanges(base: Record<string, string>, current: Record<string, string>): LocalChanges {
  const now = hashFiles(current);
  const added = Object.keys(now).filter((p) => !(p in base));
  const modified = Object.keys(now).filter((p) => p in base && base[p] !== now[p]);
  const deleted = Object.keys(base).filter((p) => !(p in now));
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

export function hasChanges(c: LocalChanges): boolean {
  return c.added.length + c.modified.length + c.deleted.length > 0;
}

/**
 * Where a path from rightflow lands inside `folder`. The path comes from the
 * network, so it must name a place inside the folder the person chose and
 * nowhere else: not above it, not absolute, not hidden.
 */
export function targetInside(folder: string, path: string): string {
  const segments = path.split("/");
  const bad =
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    /^[a-zA-Z]:/.test(path) ||
    segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."));
  const target = resolve(folder, ...segments);
  if (bad || !target.startsWith(resolve(folder) + sep)) {
    throw new UserFacingError(`rightflow sent a file path this plugin will not write: ${JSON.stringify(path)}. Nothing was written.`);
  }
  return target;
}

export interface WriteOptions {
  /** Replace a folder that holds local changes or another team. */
  replace: boolean;
}

/**
 * Writes a team into `folder` and records where it came from. A folder that
 * holds changes nobody has submitted, files the plugin did not put there, or
 * another team is refused unless `replace` says to overwrite it; then every file
 * the team does not have is removed, so the folder is the team and nothing else.
 */
export async function writeTeamFolder(
  folder: string,
  files: Record<string, string>,
  marker: Omit<TeamMarker, "files" | "version">,
  opts: WriteOptions,
): Promise<void> {
  const targets = Object.keys(files).map((path) => [path, targetInside(folder, path)] as const);
  const existing = await readExisting(folder);
  if (existing && !opts.replace) {
    const reason = await occupied(folder, existing, marker);
    if (reason) throw new UserFacingError(`${reason} Choose another folder, or pass replace: true to overwrite it.`);
  }
  for (const path of Object.keys(existing ?? {})) {
    if (!(path in files)) await rm(targetInside(folder, path), { force: true });
  }
  if (existing) await pruneEmptyDirectories(folder);
  for (const [path, target] of targets) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, files[path] ?? "");
  }
  await writeMarker(folder, { version: 1, ...marker, files: hashFiles(files) });
}

/** The folder's team files, or null when there is no folder yet. */
async function readExisting(folder: string): Promise<Record<string, string> | null> {
  try {
    const st = await lstat(folder);
    if (!st.isDirectory()) throw new UserFacingError(`${folder} is a file, not a folder.`);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return readTeamFiles(folder);
}

async function occupied(
  folder: string,
  existing: Record<string, string>,
  incoming: Omit<TeamMarker, "files" | "version">,
): Promise<string | null> {
  const marker = await readMarker(folder);
  if (!marker) {
    return Object.keys(existing).length === 0 ? null : `${folder} already holds files that are not a pulled team.`;
  }
  if (marker.environment !== incoming.environment || marker.firmId !== incoming.firmId || marker.teamId !== incoming.teamId) {
    return `${folder} holds the team "${marker.teamName}" of ${marker.firmName} (${marker.environment}).`;
  }
  const changes = localChanges(marker.files, existing);
  return hasChanges(changes) ? `${folder} holds changes that were not submitted:\n${describeChanges(changes)}\n` : null;
}

export function describeChanges(c: LocalChanges, max = 30): string {
  const lines = [
    ...c.added.map((p) => `+ ${p}`),
    ...c.modified.map((p) => `~ ${p}`),
    ...c.deleted.map((p) => `- ${p}`),
  ];
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`… and ${lines.length - max} more`);
  return shown.join("\n");
}

/** Removes folders a replaced team left empty; hidden folders are not the plugin's. */
async function pruneEmptyDirectories(folder: string): Promise<void> {
  const prune = async (dir: string): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true });
    let empty = true;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        if (!(await prune(join(dir, entry.name)))) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && dir !== folder) await rmdir(dir);
    return empty;
  };
  await prune(folder);
}

function parseMarker(text: string): TeamMarker | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string";
  const files = m.files;
  if (
    m.version !== 1 ||
    (m.environment !== "production" && m.environment !== "development") ||
    !str(m.firmId) ||
    !str(m.firmName) ||
    !(m.teamId === null || str(m.teamId)) ||
    !str(m.teamName) ||
    !(m.baseHash === null || str(m.baseHash)) ||
    typeof files !== "object" ||
    files === null ||
    !Object.values(files).every(str)
  ) {
    return null;
  }
  return raw as TeamMarker;
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
