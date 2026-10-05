import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorDetail, isRecord, serverMessage, type Api, type ApiResponse } from "../api.ts";
import type { Session } from "../auth/session.ts";
import { UserFacingError } from "../errors.ts";
import {
  defaultFolder,
  hasChanges,
  hashFiles,
  localChanges,
  readMarker,
  readTeamFiles,
  resolveFolder,
  writeTeamFolder,
  type TeamMarker,
} from "../folder.ts";
import type {
  Page,
  RevisionDetail,
  RevisionSummary,
  SetupApply,
  SetupBundle,
  SetupCheck,
  SetupCreated,
  SetupLearnings,
  SetupReference,
  SetupTeam,
  Starter,
} from "../setup-api.ts";
import {
  renderApplied,
  renderCheck,
  renderLearnings,
  renderReference,
  renderRefusedApply,
  renderRevision,
  renderRevisionLine,
} from "./render.ts";
import { run } from "./result.ts";

export interface TeamToolsContext {
  session: Session;
  api: Api;
  /** Where relative folders are resolved; the directory Claude Code runs in. */
  cwd?: string;
}

/** Enough for every team a firm has; a firm with more is asked for the id. */
const TEAM_LIST_LIMIT = 100;

const teamArg = z.string().min(1).max(200).describe("The team's name or id, as list_teams shows it.");
const folderArg = z
  .string()
  .min(1)
  .max(1000)
  .describe("The team's folder, absolute or relative to where Claude Code runs.");
const pathsArg = z
  .array(z.string().min(1).max(500))
  .max(200)
  .optional()
  .describe("Show the diffs of these files only. Every changed file is listed either way.");
const absorbArg = z
  .array(
    z.object({
      ruleId: z.string().min(1).max(64).describe("The rule's id as team_learnings shows it (r-…)."),
      reason: z.string().min(1).max(2000).describe("Where in the team's text the rule now lives."),
    }),
  )
  .max(100)
  .optional()
  .describe("Confirmed rules this change writes into the team's text, so they stop applying separately.");
const messageArg = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe("The person's own summary of the change and why. It is kept in the team's change log.");
const previewArg = z.string().min(1).max(100).describe("The preview id the check returned.");

type Absorb = Array<{ ruleId: string; reason: string }>;

export function registerTeamTools(server: McpServer, ctx: TeamToolsContext): void {
  const { session, api } = ctx;
  const env = session.env;
  const cwd = ctx.cwd ?? process.cwd();
  // What the person has been shown, by preview id. A preview id is a digest of
  // exactly what was checked, so a submit of anything else finds no entry.
  const previews = new Map<string, { baseHash: string | null }>();

  async function firm(): Promise<{ id: string; name: string }> {
    const saved = await session.current();
    if (!saved) throw new UserFacingError(`Not signed in to ${env.label}. Call sign_in.`);
    if (!saved.organizationId) throw new UserFacingError(`Signed in to ${env.label}, but no firm is selected. Call use_firm.`);
    return { id: saved.organizationId, name: saved.organizationName ?? saved.organizationId };
  }

  async function get<T>(path: string): Promise<T> {
    return ok<T>(await api.request<T>("GET", path));
  }

  async function resolveTeam(query: string): Promise<SetupTeam> {
    const page = await get<Page<SetupTeam>>(`/setup/teams?limit=${TEAM_LIST_LIMIT}`);
    const q = query.trim().toLowerCase();
    const byId = page.data.filter((t) => t.id.toLowerCase() === q);
    const matches = byId.length > 0 ? byId : page.data.filter((t) => t.name.trim().toLowerCase() === q || t.agentType === q);
    const [only] = matches;
    if (only && matches.length === 1) return only;
    if (matches.length > 1) {
      throw new UserFacingError(
        `Several teams match "${query}". Use the id:\n${matches.map((t) => `- ${t.name} (id ${t.id})`).join("\n")}`,
      );
    }
    throw new UserFacingError(
      `No team matches "${query}"${page.meta.hasNextPage ? " among the first teams; use its id" : ""}. Call list_teams.`,
    );
  }

  /** The folder's marker, after making sure it belongs to where this session is signed in. */
  async function pulledFolder(folderInput: string, current: { id: string; name: string }) {
    const folder = resolveFolder(folderInput, cwd);
    const marker = await readMarker(folder);
    if (!marker) {
      throw new UserFacingError(`${folder} is not a team folder from this plugin. Use pull_team or new_team first.`);
    }
    if (marker.environment !== env.name) {
      throw new UserFacingError(
        `${folder} was pulled from rightflow ${marker.environment}, but this plugin is set to ${env.name}. ` +
          `A team only goes back where it came from: switch the environment in /plugin, or pull the ${env.name} team into its own folder.`,
      );
    }
    if (marker.firmId !== current.id) {
      throw new UserFacingError(
        `${folder} belongs to ${marker.firmName}, but you are working on ${current.name}. Call use_firm to switch, or pull this firm's team into its own folder.`,
      );
    }
    return { folder, marker };
  }

  function teamPreviewId(marker: TeamMarker, files: Record<string, string>, absorb: Absorb): string {
    return digest({
      env: env.name,
      firm: marker.firmId,
      team: marker.teamId,
      base: marker.baseHash,
      files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
      absorb: [...absorb].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    });
  }

  /** Brings the folder up to date with the team after a submit, so its next check starts from what is live. */
  async function refresh(folder: string, marker: TeamMarker, submitted: Record<string, string>, teamId: string): Promise<string> {
    try {
      const now = await readTeamFiles(folder);
      if (hasChanges(localChanges(hashFiles(submitted), now))) {
        return `\nThe folder changed while submitting, so it was left as it is. Pull the team again before the next change.`;
      }
      const bundle = await get<SetupBundle>(`/setup/teams/${encodeURIComponent(teamId)}/bundle`);
      await writeTeamFolder(
        folder,
        bundle.files,
        { ...marker, teamId, teamName: bundle.team.name, baseHash: bundle.bundleHash },
        { replace: true },
      );
      return `\nThe folder ${folder} now holds the team as it is live.`;
    } catch (err) {
      const reason = err instanceof UserFacingError ? err.message : "an unexpected error (details are in the server log)";
      if (!(err instanceof UserFacingError)) console.error(err);
      return `\nThe change is live, but the folder could not be brought up to date: ${reason}\nPull the team again with replace: true before the next change.`;
    }
  }

  server.registerTool(
    "team_reference",
    {
      title: "What a team may use",
      description:
        "What rightflow allows in a firm's team right now: tool groups, artifact types, icons, case-field keywords, " +
        "which settings the firm may change and which rightflow sets, and size limits. Read it before writing or " +
        "changing a team's settings; never guess these lists.",
      inputSchema: { lang: z.string().min(2).max(10).optional().describe("Language for labels, e.g. en or de.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ lang }) =>
      run(env, async () => {
        const current = await firm();
        const ref = await get<SetupReference>(`/setup/reference${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`);
        return { firm: current, text: renderReference(ref) };
      }),
  );

  server.registerTool(
    "list_teams",
    {
      title: "List the firm's teams",
      description: "The firm's case teams, and which of them it may change here (its own) and which rightflow looks after.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(env, async () => {
        const current = await firm();
        const page = await get<Page<SetupTeam>>(`/setup/teams?limit=${TEAM_LIST_LIMIT}`);
        if (page.data.length === 0) {
          return { firm: current, text: "This firm has no case teams yet. new_team starts one." };
        }
        const lines = page.data.map(
          (t) =>
            `- ${t.name} (id ${t.id}) — ${t.editable ? "the firm's own; can be changed here" : "looked after by rightflow; ask rightflow to hand it over before changing it here"}`,
        );
        if (page.meta.hasNextPage) lines.push(`Only the first ${page.data.length} are listed; use a team's id for the others.`);
        return { firm: current, text: lines.join("\n") };
      }),
  );

  server.registerTool(
    "pull_team",
    {
      title: "Load a team into a folder",
      description:
        "Downloads one of the firm's own teams into a folder as plain files, to read and change with your normal tools. " +
        "Refuses a folder that holds unsubmitted changes or another team unless `replace` is true.",
      inputSchema: {
        team: teamArg,
        folder: folderArg.optional().describe("Where to put it. Default: rightflow/<environment>/<team name>."),
        replace: z.boolean().optional().describe("Overwrite the folder even if it holds unsubmitted changes or another team."),
      },
      annotations: { openWorldHint: true },
    },
    ({ team, folder, replace }) =>
      run(env, async () => {
        const current = await firm();
        const found = await resolveTeam(team);
        const bundle = await get<SetupBundle>(`/setup/teams/${encodeURIComponent(found.id)}/bundle`);
        const target = resolveFolder(folder ?? defaultFolder(env, bundle.team.name), cwd);
        await writeTeamFolder(
          target,
          bundle.files,
          {
            environment: env.name,
            firmId: current.id,
            firmName: current.name,
            teamId: bundle.team.id,
            teamName: bundle.team.name,
            baseHash: bundle.bundleHash,
          },
          { replace: replace === true },
        );
        const paths = Object.keys(bundle.files).sort();
        return {
          firm: current,
          team: bundle.team,
          text:
            `Loaded into ${target} (${paths.length} files):\n${paths.map((p) => `- ${p}`).join("\n")}\n\n` +
            "Change the files there, then call check_team with this folder.",
        };
      }),
  );

  server.registerTool(
    "new_team",
    {
      title: "Start a new team",
      description:
        "Puts rightflow's starter team into a folder, to shape into a new team of the firm's own. Nothing is created " +
        "in rightflow until submit_team.",
      inputSchema: {
        folder: folderArg.optional().describe("Where to put it. Default: rightflow/<environment>/new-team."),
        locale: z.string().min(2).max(10).optional().describe("Which starter, as team_reference lists them."),
      },
      annotations: { openWorldHint: true },
    },
    ({ folder, locale }) =>
      run(env, async () => {
        const current = await firm();
        let chosen = locale;
        if (!chosen) {
          const { starterLocales } = await get<SetupReference>("/setup/reference");
          if (starterLocales.length !== 1) {
            return {
              firm: current,
              text: `Choose a starter with \`locale\`: ${starterLocales.join(", ") || "rightflow offers none right now"}.`,
            };
          }
          chosen = starterLocales[0];
        }
        const starter = await get<Starter>(`/setup/teams/starter?locale=${encodeURIComponent(chosen ?? "")}`);
        const target = resolveFolder(folder ?? defaultFolder(env, "new-team"), cwd);
        await writeTeamFolder(
          target,
          starter.files,
          { environment: env.name, firmId: current.id, firmName: current.name, teamId: null, teamName: "new team", baseHash: null },
          { replace: false },
        );
        return {
          firm: current,
          text:
            `The starter (${starter.locale}) is in ${target} (${Object.keys(starter.files).length} files). ` +
            "Give the team its name and description in TEAM.md, shape it, then call check_team with this folder.",
        };
      }),
  );

  server.registerTool(
    "check_team",
    {
      title: "Check a change",
      description:
        "Sends the folder to rightflow without changing anything and shows what rightflow would do: whether it accepts " +
        "the change, every finding, and every changed file with its diff. Show this to the person before submitting. " +
        "Returns the preview id submit_team needs.",
      inputSchema: { folder: folderArg, absorbRules: absorbArg, paths: pathsArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ folder, absorbRules, paths }) =>
      run(env, async () => {
        const current = await firm();
        const { folder: dir, marker } = await pulledFolder(folder, current);
        const files = await readTeamFiles(dir);
        const absorb = absorbRules ?? [];
        const res =
          marker.teamId === null
            ? await api.request<SetupCheck>("POST", "/setup/teams/check", { files })
            : await api.request<SetupCheck>("POST", `/setup/teams/${encodeURIComponent(marker.teamId)}/bundle/check`, {
                files,
                baseHash: marker.baseHash,
                ...(absorb.length > 0 ? { absorbRules: absorb } : {}),
              });
        const check = ok<SetupCheck>(res);
        const local = localChanges(marker.files, files);
        const lines = [renderCheck(check, paths)];
        if (!hasChanges(local)) lines.unshift("This folder has no changes since it was pulled.");
        if (check.ok && !check.stale) {
          const id = teamPreviewId(marker, files, absorb);
          previews.set(id, { baseHash: marker.baseHash });
          lines.push(
            "",
            `Preview id: ${id}`,
            "Show the person this list of changes. Submit only once they agree, with their own summary as the message.",
          );
        }
        return { firm: current, team: marker.teamId ? { name: marker.teamName } : null, text: lines.join("\n") };
      }),
  );

  server.registerTool(
    "submit_team",
    {
      title: "Submit a change",
      description:
        "Makes the checked change live and records it in the team's change log with the person's message. Only after " +
        "the person has seen check_team's answer for exactly this folder and agreed. For a new team, creates it.",
      inputSchema: { folder: folderArg, message: messageArg, previewId: previewArg, absorbRules: absorbArg },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ folder, message, previewId, absorbRules }) =>
      run(env, async () => {
        const current = await firm();
        const { folder: dir, marker } = await pulledFolder(folder, current);
        const files = await readTeamFiles(dir);
        const absorb = absorbRules ?? [];
        if (teamPreviewId(marker, files, absorb) !== previewId || !previews.has(previewId)) {
          throw new UserFacingError(
            "This is not what the person was shown: the folder or the rules to take in changed since that check, or " +
              "the check was not run in this session. Call check_team again and show the person its answer.",
          );
        }
        const team = marker.teamId ? { name: marker.teamName } : null;

        if (marker.teamId === null) {
          const res = await api.request<SetupCreated>("POST", "/setup/teams", { files, message });
          if (res.status === 422 || res.status === 409) return { firm: current, team, text: refusedApply(res) };
          const created = ok<SetupCreated>(res);
          previews.delete(previewId);
          const note = await refresh(dir, marker, files, created.teamId);
          return { firm: current, team: null, text: `Created the team (id ${created.teamId}). Its change log starts here.${note}` };
        }

        const res = await api.request<SetupApply>("POST", `/setup/teams/${encodeURIComponent(marker.teamId)}/bundle`, {
          files,
          baseHash: marker.baseHash,
          message,
          ...(absorb.length > 0 ? { absorbRules: absorb } : {}),
        });
        if (res.status === 422 || res.status === 409) return { firm: current, team, text: refusedApply(res) };
        const applied = ok<SetupApply>(res);
        previews.delete(previewId);
        const note = await refresh(dir, marker, files, marker.teamId);
        return { firm: current, team, text: `${renderApplied(applied)}${note}` };
      }),
  );

  server.registerTool(
    "team_learnings",
    {
      title: "What a team learned",
      description:
        "Rules the firm confirmed while working (they apply on top of the team's text), proposals waiting for review " +
        "in the app, and files a learning changed. A confirmed rule can be written into the text with absorbRules.",
      inputSchema: { team: teamArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team }) =>
      run(env, async () => {
        const current = await firm();
        const found = await resolveTeam(team);
        const learnings = await get<SetupLearnings>(`/setup/teams/${encodeURIComponent(found.id)}/learnings`);
        return { firm: current, team: found, text: renderLearnings(learnings) };
      }),
  );

  server.registerTool(
    "team_history",
    {
      title: "A team's change log",
      description: "Who changed the team, when, how and why, newest first.",
      inputSchema: {
        team: teamArg,
        page: z.number().int().min(1).max(10_000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, page, limit }) =>
      run(env, async () => {
        const current = await firm();
        const found = await resolveTeam(team);
        const list = await get<Page<RevisionSummary>>(
          `/setup/teams/${encodeURIComponent(found.id)}/revisions?page=${page ?? 1}&limit=${limit ?? 20}`,
        );
        if (list.data.length === 0) {
          return {
            firm: current,
            team: found,
            text: page && page > 1 ? "No more entries." : "No changes are recorded yet. The log starts with the next submitted change.",
          };
        }
        const lines = list.data.map(renderRevisionLine);
        if (list.meta.hasNextPage) lines.push(`Older entries: call team_history with page ${(page ?? 1) + 1}.`);
        lines.push("show_revision shows what one change did.");
        return { firm: current, team: found, text: lines.join("\n") };
      }),
  );

  server.registerTool(
    "show_revision",
    {
      title: "What one change did",
      description: "One entry of the team's change log and what it changed compared with the entry before it.",
      inputSchema: { team: teamArg, number: z.number().int().min(1), paths: pathsArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, number, paths }) =>
      run(env, async () => {
        const current = await firm();
        const found = await resolveTeam(team);
        const detail = await get<RevisionDetail>(`/setup/teams/${encodeURIComponent(found.id)}/revisions/${number}`);
        return { firm: current, team: found, text: renderRevision(detail, paths) };
      }),
  );

  server.registerTool(
    "check_restore",
    {
      title: "Check bringing an earlier version back",
      description:
        "Shows what bringing the team back to an earlier entry of its change log would change today, checked like any " +
        "other change. Returns the preview id restore_revision needs.",
      inputSchema: { team: teamArg, number: z.number().int().min(1), paths: pathsArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ team, number, paths }) =>
      run(env, async () => {
        const current = await firm();
        const found = await resolveTeam(team);
        const teamPath = `/setup/teams/${encodeURIComponent(found.id)}`;
        const { bundleHash } = await get<SetupBundle>(`${teamPath}/bundle`);
        const check = ok<SetupCheck>(
          await api.request<SetupCheck>("POST", `${teamPath}/revisions/${number}/restore/check`, { baseHash: bundleHash }),
        );
        const lines = [`Bringing back #${number}:`, renderCheck(check, paths)];
        if (check.ok && !check.stale) {
          const id = digest({ env: env.name, firm: current.id, team: found.id, restore: number, base: bundleHash });
          previews.set(id, { baseHash: bundleHash });
          lines.push(
            "",
            `Preview id: ${id}`,
            "Show the person this list. Restore only once they agree, with their own reason as the message.",
          );
        }
        return { firm: current, team: found, text: lines.join("\n") };
      }),
  );

  server.registerTool(
    "restore_revision",
    {
      title: "Bring an earlier version back",
      description:
        "Brings the team back to an earlier entry of its change log, as a new entry; nothing in the log is rewritten. " +
        "Only after the person has seen check_restore's answer and agreed.",
      inputSchema: { team: teamArg, number: z.number().int().min(1), message: messageArg, previewId: previewArg },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ team, number, message, previewId }) =>
      run(env, async () => {
        const current = await firm();
        const found = await resolveTeam(team);
        const preview = previews.get(previewId);
        const expected = preview?.baseHash
          ? digest({ env: env.name, firm: current.id, team: found.id, restore: number, base: preview.baseHash })
          : null;
        if (!preview?.baseHash || expected !== previewId) {
          throw new UserFacingError(
            "This is not what the person was shown: that preview was for another team or entry, or was not made in this " +
              "session. Call check_restore again and show the person its answer.",
          );
        }
        const res = await api.request<SetupApply>(
          "POST",
          `/setup/teams/${encodeURIComponent(found.id)}/revisions/${number}/restore`,
          { baseHash: preview.baseHash, message },
        );
        if (res.status === 422 || res.status === 409) return { firm: current, team: found, text: refusedApply(res) };
        const applied = ok<SetupApply>(res);
        previews.delete(previewId);
        return {
          firm: current,
          team: found,
          text: `${renderApplied(applied)}\nA folder pulled before this is out of date: pull the team again with replace: true.`,
        };
      }),
  );
}

/** The body of a successful answer; a refusal becomes rightflow's own sentence. */
function ok<T>(res: ApiResponse<T>): T {
  if (res.status >= 200 && res.status < 300) return res.body;
  const said = serverMessage(res.body);
  if (res.status === 404) throw new UserFacingError(said ?? "rightflow does not know that.");
  throw new UserFacingError(said ?? `rightflow refused this (${res.status}).`);
}

function refusedApply(res: ApiResponse<unknown>): string {
  const detail = errorDetail(res.body);
  if (res.status === 409) {
    return `${serverMessage(res.body) ?? "The team changed in the meantime."}\nNothing was changed.`;
  }
  return isRecord(detail) ? renderRefusedApply(detail) : (serverMessage(res.body) ?? "rightflow did not apply the change.");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
