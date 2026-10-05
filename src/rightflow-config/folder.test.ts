import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEnvironment } from "./env.ts";
import { UserFacingError } from "./errors.ts";
import { defaultFolder, localChanges, readMarker, readTeamFiles, targetInside, writeTeamFolder } from "./folder.ts";

const ORIGIN = {
  environment: "production" as const,
  firmId: "firm-1",
  firmName: "Firm A",
  teamId: "team-1",
  teamName: "Team A",
  baseHash: "a".repeat(64),
};

const TEAM = { "TEAM.md": "team", "skills/one/SKILL.md": "skill" };

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rf-folder-"));
}

test("a pulled team reads back exactly, and its marker knows where it came from", async () => {
  const dir = join(await tmp(), "team");
  await writeTeamFolder(dir, TEAM, ORIGIN, { replace: false });
  assert.deepEqual(await readTeamFiles(dir), TEAM);
  const marker = await readMarker(dir);
  assert.equal(marker?.teamId, "team-1");
  assert.equal(marker?.environment, "production");
  assert.deepEqual(localChanges(marker?.files ?? {}, TEAM), { added: [], modified: [], deleted: [] });
});

test("local changes are added, modified and deleted paths against the pull", async () => {
  const dir = join(await tmp(), "team");
  await writeTeamFolder(dir, TEAM, ORIGIN, { replace: false });
  const marker = await readMarker(dir);
  const changed = localChanges(marker?.files ?? {}, { "TEAM.md": "edited", "skills/two/SKILL.md": "new" });
  assert.deepEqual(changed, { added: ["skills/two/SKILL.md"], modified: ["TEAM.md"], deleted: ["skills/one/SKILL.md"] });
});

test("hidden files are never part of the team", async () => {
  const dir = join(await tmp(), "team");
  await writeTeamFolder(dir, TEAM, ORIGIN, { replace: false });
  await writeFile(join(dir, ".notes"), "local");
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "x"), "local");
  assert.deepEqual(Object.keys(await readTeamFiles(dir)).sort(), ["TEAM.md", "skills/one/SKILL.md"]);
});

test("a path that would land outside the folder, or hidden, is refused before anything is written", async () => {
  const dir = join(await tmp(), "team");
  for (const bad of ["../x", "/etc/x", "a/../../x", "C:/x", "a\\b", ".rightflow/team.json", "a//b", ""]) {
    assert.throws(() => targetInside(dir, bad), UserFacingError, bad);
  }
  await assert.rejects(writeTeamFolder(dir, { "TEAM.md": "t", "../escape.md": "x" }, ORIGIN, { replace: false }), UserFacingError);
  await assert.rejects(readFile(join(dir, "TEAM.md")));
});

test("a link inside the folder is refused, not followed", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "TEAM.md"), "t");
  await symlink(join(dir, "TEAM.md"), join(dir, "LINK.md"));
  await assert.rejects(readTeamFiles(dir), /is a link/);
});

test("a file that is not UTF-8 text is refused", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "image.bin"), Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(readTeamFiles(dir), /not a text file/);
});

test("pulling over unsubmitted changes, foreign files or another team is refused without replace", async () => {
  const dir = join(await tmp(), "team");
  await writeTeamFolder(dir, TEAM, ORIGIN, { replace: false });
  // Same team, no local change: pulling again just updates it.
  await writeTeamFolder(dir, { ...TEAM, "TEAM.md": "newer" }, ORIGIN, { replace: false });

  await writeFile(join(dir, "TEAM.md"), "edited here");
  await assert.rejects(writeTeamFolder(dir, TEAM, ORIGIN, { replace: false }), /changes that were not submitted/);
  await assert.rejects(writeTeamFolder(dir, TEAM, { ...ORIGIN, teamId: "team-2" }, { replace: false }), /holds the team/);
  await assert.rejects(
    writeTeamFolder(dir, TEAM, { ...ORIGIN, environment: "development" }, { replace: false }),
    /holds the team/,
  );

  const plain = await tmp();
  await writeFile(join(plain, "notes.md"), "mine");
  await assert.rejects(writeTeamFolder(plain, TEAM, ORIGIN, { replace: false }), /not a pulled team/);
});

test("replace makes the folder the team: files it lacks go, hidden files stay", async () => {
  const dir = join(await tmp(), "team");
  await writeTeamFolder(dir, TEAM, ORIGIN, { replace: false });
  await writeFile(join(dir, "extra.md"), "local");
  await writeFile(join(dir, ".notes"), "kept");
  await writeTeamFolder(dir, { "TEAM.md": "only" }, ORIGIN, { replace: true });
  assert.deepEqual(await readTeamFiles(dir), { "TEAM.md": "only" });
  assert.equal(await readFile(join(dir, ".notes"), "utf8"), "kept");
  await assert.rejects(readFile(join(dir, "skills", "one", "SKILL.md")));
});

test("the default folder keeps development and production apart", () => {
  const prod = defaultFolder(resolveEnvironment({}), "Team Ä / 1");
  const dev = defaultFolder(resolveEnvironment({ RF_CONFIG_ENV: "development" }), "Team Ä / 1");
  assert.equal(prod, join("rightflow", "production", "team-a-1"));
  assert.equal(dev, join("rightflow", "development", "team-a-1"));
});
