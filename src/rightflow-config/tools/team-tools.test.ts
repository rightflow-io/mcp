import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api, ApiResponse } from "../api.ts";
import type { Session } from "../auth/session.ts";
import type { StoredSession } from "../auth/store.ts";
import { resolveEnvironment } from "../env.ts";
import { readMarker } from "../folder.ts";
import type { FileChange, RevisionSource, RevisionSummary, SetupCheck } from "../setup-api.ts";
import { renderChanges } from "./render.ts";
import type { ToolResult } from "./result.ts";
import { registerTeamTools } from "./team-tools.ts";

type Files = Record<string, string>;
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const hashOf = (files: Files) =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");

function diff(before: Files, after: Files): FileChange[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.flatMap((path): FileChange[] => {
    const a = before[path];
    const b = after[path];
    if (a === b) return [];
    const status = a === undefined ? "added" : b === undefined ? "deleted" : "modified";
    return [{ path, status, unified: `--- ${path}\n+++ ${path}\n-${a ?? ""}\n+${b ?? ""}\n`, truncated: false }];
  });
}

const refusal = (status: number, error: Record<string, unknown>) => ({
  status,
  body: { statusCode: status, path: "/x", method: "POST", error },
});

/** rightflow's `/setup` routes for one firm, kept in memory. */
class FakeRightflow {
  teams = new Map<string, { name: string; files: Files }>([["team-1", { name: "Team A", files: { "TEAM.md": "v1" } }]]);
  log = new Map<string, Array<RevisionSummary & { files: Files }>>([["team-1", []]]);
  refuseNextApply = false;

  record(teamId: string, files: Files, source: RevisionSource, message: string | null, restoredFrom: number | null = null) {
    const log = this.log.get(teamId) ?? [];
    const before = log.at(-1)?.files ?? {};
    const changes = diff(before, files);
    log.push({
      number: log.length + 1,
      createdAt: "2026-01-01T10:00:00.000Z",
      source,
      message,
      author: source === "outside_import" ? null : "Person A",
      bundleHash: hashOf(files),
      restoredFrom,
      counts: {
        added: changes.filter((c) => c.status === "added").length,
        modified: changes.filter((c) => c.status === "modified").length,
        deleted: changes.filter((c) => c.status === "deleted").length,
      },
      absorbedRules: [],
      files,
    });
    this.log.set(teamId, log);
    return log.length;
  }

  check(teamId: string, files: Files, baseHash: string | null): SetupCheck {
    const live = this.teams.get(teamId)?.files ?? {};
    const refusals = Object.entries(files)
      .filter(([, c]) => c.includes("LOCKED"))
      .map(([path]) => ({ rule: "locked-setting", path, message: "This setting is set by rightflow." }));
    const stale = baseHash !== null && baseHash !== hashOf(live);
    return {
      ok: refusals.length === 0 && !stale,
      stale,
      bundleHash: hashOf(live),
      refusals,
      lint: { errors: [], advisories: [] },
      changes: diff(live, files),
      agents: { created: [], updated: [], deleted: [] },
      missingLetterheads: [],
      absorbRules: [],
      warnings: { orphanedRules: [] },
    };
  }

  apply(teamId: string, files: Files, baseHash: string, message: string, source: RevisionSource, restoredFrom: number | null = null) {
    const team = this.teams.get(teamId);
    if (!team) return refusal(404, { message: "not found" });
    const check = this.check(teamId, files, baseHash);
    if (check.stale) {
      return refusal(409, { code: "BUNDLE_CHANGED_SINCE_BASE", message: "The team changed after the version this change is based on was downloaded." });
    }
    if (!check.ok || this.refuseNextApply) {
      this.refuseNextApply = false;
      return refusal(422, {
        code: "BUNDLE_REFUSED",
        message: "The change was not applied. Every finding is listed.",
        refusals: check.refusals.length ? check.refusals : [{ rule: "r", path: "TEAM.md", message: "Refused for the test." }],
        lint: [],
      });
    }
    team.files = files;
    const revision = check.changes.length ? this.record(teamId, files, source, message, restoredFrom) : null;
    return { status: 200, body: { bundleHash: hashOf(files), revision, changedFiles: check.changes.length, agents: check.agents, absorbedRules: [] } };
  }

  handle(method: string, path: string, body: unknown): ApiResponse<unknown> {
    const b = (body ?? {}) as { files?: Files; baseHash?: string; message?: string };
    let m: RegExpExecArray | null;
    if (method === "GET" && path.startsWith("/setup/teams?")) {
      const data = [...this.teams].map(([id, t]) => ({ id, name: t.name, agentType: `firm-${id}`, origin: "firm", editable: true }));
      return { status: 200, body: { data, meta: { hasNextPage: false } } };
    }
    if (method === "GET" && path.startsWith("/setup/teams/starter")) {
      return { status: 200, body: { locale: "xx", files: { "TEAM.md": "starter" } } };
    }
    if (method === "GET" && path.startsWith("/setup/reference")) {
      return { status: 200, body: { starterLocales: ["xx"] } };
    }
    if (method === "POST" && path === "/setup/teams/check") {
      return { status: 200, body: this.check("none", b.files ?? {}, null) };
    }
    if (method === "POST" && path === "/setup/teams") {
      const id = `team-${this.teams.size + 1}`;
      this.teams.set(id, { name: "New team", files: b.files ?? {} });
      this.record(id, b.files ?? {}, "firm", b.message ?? null);
      return { status: 201, body: { teamId: id, agentType: `firm-${id}`, bundleHash: hashOf(b.files ?? {}) } };
    }
    if ((m = /^\/setup\/teams\/([^/]+)\/bundle$/.exec(path))) {
      const id = m[1] ?? "";
      const team = this.teams.get(id);
      if (!team) return refusal(404, { message: "not found" });
      if (method === "GET") return { status: 200, body: { team: { id, name: team.name, agentType: `firm-${id}` }, files: team.files, bundleHash: hashOf(team.files) } };
      return this.apply(id, b.files ?? {}, b.baseHash ?? "", b.message ?? "", "firm");
    }
    if ((m = /^\/setup\/teams\/([^/]+)\/bundle\/check$/.exec(path))) {
      return { status: 200, body: this.check(m[1] ?? "", b.files ?? {}, b.baseHash ?? null) };
    }
    if ((m = /^\/setup\/teams\/([^/]+)\/revisions\?/.exec(path))) {
      const data = [...(this.log.get(m[1] ?? "") ?? [])].reverse();
      return { status: 200, body: { data, meta: { hasNextPage: false } } };
    }
    if ((m = /^\/setup\/teams\/([^/]+)\/revisions\/(\d+)(\/restore(\/check)?)?$/.exec(path))) {
      const id = m[1] ?? "";
      const n = Number(m[2]);
      const entry = this.log.get(id)?.[n - 1];
      if (!entry) return refusal(404, { message: `This team has no change number ${n}.` });
      if (m[4]) return { status: 200, body: this.check(id, entry.files, b.baseHash ?? null) };
      if (m[3]) return this.apply(id, entry.files, b.baseHash ?? "", b.message ?? "", "restore", n);
      const previous = this.log.get(id)?.[n - 2]?.files ?? {};
      return { status: 200, body: { ...entry, changes: diff(previous, entry.files), files: null } };
    }
    return refusal(404, { message: `no route ${method} ${path}` });
  }
}

function harness(opts: { rf?: FakeRightflow; cwd: string; environment?: string; firmId?: string }) {
  const rf = opts.rf ?? new FakeRightflow();
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  const firmId = opts.firmId ?? "firm-1";
  const saved: StoredSession = {
    version: 1,
    refreshToken: "r",
    organizationIds: [firmId],
    organizationId: firmId,
    organizationName: firmId === "firm-1" ? "Firm A" : "Firm B",
    signedInAt: "t",
  };
  const session = {
    env: resolveEnvironment(opts.environment ? { RF_CONFIG_ENV: opts.environment } : {}),
    current: async () => saved,
  } as unknown as Session;
  const api = {
    request: async (method: string, path: string, body?: unknown) => rf.handle(method, path, body),
  } as unknown as Api;
  registerTeamTools(server, { session, api, cwd: opts.cwd });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`no tool ${name}`);
    const result = await handler(args);
    const first = result.content[0];
    return { text: first?.type === "text" ? first.text : "", isError: result.isError === true };
  };
  return { call, rf };
}

const previewIdOf = (text: string) => /Preview id: (\w+)/.exec(text)?.[1] ?? "";

async function pulled(environment?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "rf-tools-"));
  const h = harness({ cwd, ...(environment ? { environment } : {}) });
  const pull = await h.call("pull_team", { team: "Team A", folder: "team" });
  assert.equal(pull.isError, false, pull.text);
  return { ...h, cwd, dir: join(cwd, "team") };
}

test("pull, edit, check, submit: the change is live, logged with its message, and the folder follows", async () => {
  const h = await pulled();
  await writeFile(join(h.dir, "TEAM.md"), "v2");
  const check = await h.call("check_team", { folder: "team" });
  assert.match(check.text, /^\[rightflow Production · firm "Firm A" · team "Team A"\]/);
  assert.match(check.text, /~ TEAM\.md/);
  assert.match(check.text, /\+v2/);

  const submit = await h.call("submit_team", { folder: "team", message: "Shorter intake", previewId: previewIdOf(check.text) });
  assert.equal(submit.isError, false, submit.text);
  assert.match(submit.text, /change #1/);
  assert.equal(h.rf.teams.get("team-1")?.files["TEAM.md"], "v2");
  assert.equal((await readMarker(h.dir))?.baseHash, hashOf({ "TEAM.md": "v2" }));

  const history = await h.call("team_history", { team: "Team A" });
  assert.match(history.text, /#1 · 2026-01-01 10:00 UTC · submitted by the firm · Person A/);
  assert.match(history.text, /"Shorter intake"/);
});

test("a submit needs the preview of exactly this folder", async () => {
  const h = await pulled();
  await writeFile(join(h.dir, "TEAM.md"), "v2");
  const none = await h.call("submit_team", { folder: "team", message: "m", previewId: "0".repeat(16) });
  assert.equal(none.isError, true);
  assert.match(none.text, /not what the person was shown/);

  const check = await h.call("check_team", { folder: "team" });
  await writeFile(join(h.dir, "TEAM.md"), "v3, edited after the check");
  const edited = await h.call("submit_team", { folder: "team", message: "m", previewId: previewIdOf(check.text) });
  assert.equal(edited.isError, true);
  assert.equal(h.rf.teams.get("team-1")?.files["TEAM.md"], "v1");
});

test("a check with findings gives no preview id", async () => {
  const h = await pulled();
  await writeFile(join(h.dir, "TEAM.md"), "LOCKED value");
  const check = await h.call("check_team", { folder: "team" });
  assert.match(check.text, /would not accept/);
  assert.match(check.text, /TEAM\.md: This setting is set by rightflow\./);
  assert.equal(previewIdOf(check.text), "");
});

test("a folder only goes back to the environment and firm it came from", async () => {
  const h = await pulled();
  const onDev = harness({ cwd: h.cwd, environment: "development", rf: h.rf });
  const dev = await onDev.call("check_team", { folder: "team" });
  assert.equal(dev.isError, true);
  assert.match(dev.text, /^\[rightflow Development/);
  assert.match(dev.text, /pulled from rightflow production, but this plugin is set to development/);

  const otherFirm = harness({ cwd: h.cwd, firmId: "firm-2", rf: h.rf });
  const firm = await otherFirm.call("check_team", { folder: "team" });
  assert.equal(firm.isError, true);
  assert.match(firm.text, /belongs to Firm A, but you are working on Firm B/);
});

test("development is a separate default folder from production", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rf-tools-"));
  const rf = new FakeRightflow();
  await harness({ cwd, rf }).call("pull_team", { team: "Team A" });
  await harness({ cwd, rf, environment: "development" }).call("pull_team", { team: "Team A" });
  assert.equal((await readMarker(join(cwd, "rightflow", "production", "team-a")))?.environment, "production");
  assert.equal((await readMarker(join(cwd, "rightflow", "development", "team-a")))?.environment, "development");
});

test("a team changed since the check is refused with rightflow's sentence, and nothing changes", async () => {
  const h = await pulled();
  await writeFile(join(h.dir, "TEAM.md"), "v2");
  const check = await h.call("check_team", { folder: "team" });
  h.rf.teams.set("team-1", { name: "Team A", files: { "TEAM.md": "changed in the app" } });
  const submit = await h.call("submit_team", { folder: "team", message: "m", previewId: previewIdOf(check.text) });
  assert.match(submit.text, /changed after the version this change is based on/);
  assert.match(submit.text, /Nothing was changed/);
  assert.equal(await readFile(join(h.dir, "TEAM.md"), "utf8"), "v2");
});

test("an apply rightflow refuses lists every finding", async () => {
  const h = await pulled();
  await writeFile(join(h.dir, "TEAM.md"), "v2");
  const check = await h.call("check_team", { folder: "team" });
  h.rf.refuseNextApply = true;
  const submit = await h.call("submit_team", { folder: "team", message: "m", previewId: previewIdOf(check.text) });
  assert.match(submit.text, /The change was not applied/);
  assert.match(submit.text, /- TEAM\.md: Refused for the test\./);
});

test("an earlier version comes back as a new entry, only with the preview of that restore", async () => {
  const h = await pulled();
  for (const v of ["v2", "v3"]) {
    await writeFile(join(h.dir, "TEAM.md"), v);
    const check = await h.call("check_team", { folder: "team" });
    await h.call("submit_team", { folder: "team", message: `to ${v}`, previewId: previewIdOf(check.text) });
  }
  const check = await h.call("check_restore", { team: "Team A", number: 1 });
  assert.match(check.text, /Bringing back #1/);
  assert.match(check.text, /\+v2/);
  const wrong = await h.call("restore_revision", { team: "Team A", number: 2, message: "back", previewId: previewIdOf(check.text) });
  assert.equal(wrong.isError, true);

  const done = await h.call("restore_revision", { team: "Team A", number: 1, message: "back", previewId: previewIdOf(check.text) });
  assert.match(done.text, /change #3/);
  assert.match(done.text, /pull the team again with replace: true/);
  const history = await h.call("team_history", { team: "Team A" });
  assert.match(history.text, /#3 · .* · restored from #1/);
});

test("a new team starts from the starter and is created by its first submit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rf-tools-"));
  const h = harness({ cwd });
  const started = await h.call("new_team", { folder: "fresh" });
  assert.match(started.text, /The starter \(xx\)/);
  await writeFile(join(cwd, "fresh", "TEAM.md"), "our own team");
  const check = await h.call("check_team", { folder: "fresh" });
  const created = await h.call("submit_team", { folder: "fresh", message: "First version", previewId: previewIdOf(check.text) });
  assert.match(created.text, /Created the team \(id team-2\)/);
  const marker = await readMarker(join(cwd, "fresh"));
  assert.equal(marker?.teamId, "team-2");
  assert.equal(marker?.baseHash, hashOf({ "TEAM.md": "our own team" }));
});

test("every changed file is listed even when the diffs exceed the budget", () => {
  const changes: FileChange[] = ["a.md", "b.md", "c.md"].map((path) => ({
    path,
    status: "modified",
    unified: `--- ${path}\n${"x".repeat(60)}\n`,
    truncated: false,
  }));
  const text = renderChanges(changes, undefined, 100);
  for (const p of ["a.md", "b.md", "c.md"]) assert.match(text, new RegExp(`~ ${p.replace(".", "\\.")}`));
  assert.match(text, /Diffs not shown here, to keep this answer readable: b\.md, c\.md/);
  assert.match(renderChanges(changes, ["c.md"], 100), /--- c\.md/);
});
