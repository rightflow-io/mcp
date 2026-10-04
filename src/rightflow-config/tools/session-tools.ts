import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.ts";
import type { Session } from "../auth/session.ts";
import type { StoredSession } from "../auth/store.ts";
import { UserFacingError } from "../errors.ts";
import { fetchMe, matchFirms, selectableFirms, SETUP_MODULE, SETUP_PERMISSION, type Me, type Membership } from "../me.ts";
import { run } from "./result.ts";

export interface SessionToolsContext {
  session: Session;
  api: Api;
  version: string;
  /** How long one sign_in call waits for the browser before handing back the link. */
  signInWaitMs?: number;
}

const MIN_NODE = [22, 18] as const;

export function registerSessionTools(server: McpServer, ctx: SessionToolsContext): void {
  const { session, api } = ctx;
  const env = session.env;
  // One browser sign-in at a time; a second sign_in call picks up the first.
  let pending: { done: Promise<StoredSession>; url: string } | null = null;

  server.registerTool(
    "status",
    {
      title: "rightflow status",
      description:
        "Which rightflow environment and firm this plugin is signed in to, your role there, and whether you can set up " +
        "your firm's own agent teams. Call it first when anything looks wrong.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(env, async () => {
        const lines = [`Plugin version ${ctx.version}. ${nodeCheck()}`];
        const saved = await session.current();
        if (!saved) {
          return { firm: null, text: [...lines, `Not signed in to ${env.label}. Call sign_in.`].join("\n") };
        }
        if (!saved.organizationId) {
          return {
            firm: null,
            text: [...lines, `Signed in to ${env.label}, but no firm is selected. Call use_firm.`].join("\n"),
          };
        }
        const me = await fetchMe(api);
        const firm = me.activeOrganization ?? { name: saved.organizationName ?? saved.organizationId };
        return { firm, text: [...lines, ...describeAccess(me)].join("\n") };
      }),
  );

  server.registerTool(
    "sign_in",
    {
      title: "Sign in to rightflow",
      description:
        "Signs in to rightflow in the browser with your normal rightflow login, then selects your firm. If the login " +
        "belongs to several firms, pass `firm` (its name or id) or call use_firm afterwards. If the browser sign-in is " +
        "not finished within a minute and a half, this returns the link; call sign_in again once you are done.",
      inputSchema: {
        firm: z.string().min(1).max(200).optional().describe("Name or id of the firm to work on."),
      },
      annotations: { openWorldHint: true },
    },
    ({ firm }) =>
      run(env, async () => {
        let current = pending;
        if (!current) {
          let url = "";
          let urlReady!: () => void;
          const ready = new Promise<void>((r) => {
            urlReady = r;
          });
          const done = session.signIn((u) => {
            url = u;
            urlReady();
          });
          // signIn hands over the URL before it starts waiting for the browser;
          // if it fails before that, the failure is reported below.
          await Promise.race([ready, done.catch(() => undefined)]);
          current = { done, url };
          pending = current;
          const started = current;
          done
            .finally(() => {
              if (pending === started) pending = null;
            })
            .catch(() => undefined);
        }
        const outcome = await Promise.race([
          current.done.then((s) => ({ kind: "done" as const, session: s })),
          delay(ctx.signInWaitMs ?? 90_000).then(() => ({ kind: "waiting" as const })),
        ]);
        if (outcome.kind === "waiting") {
          return {
            firm: null,
            text:
              `A ${env.label} sign-in page should have opened in your browser. If it did not, open this link:\n` +
              `${current.url}\n\nOnce you have signed in, call sign_in again.`,
          };
        }
        return chooseFirm(session, api, outcome.session, firm);
      }),
  );

  server.registerTool(
    "use_firm",
    {
      title: "Choose the firm",
      description: "Switches to another firm your login belongs to, by its name or id. No new browser sign-in is needed.",
      inputSchema: { firm: z.string().min(1).max(200).describe("Name or id of the firm.") },
      annotations: { openWorldHint: true },
    },
    ({ firm }) =>
      run(env, async () => {
        const saved = await session.current();
        if (!saved) throw new UserFacingError(`Not signed in to ${env.label}. Call sign_in.`);
        return chooseFirm(session, api, saved, firm);
      }),
  );

  server.registerTool(
    "sign_out",
    {
      title: "Sign out of rightflow",
      description: `Deletes the sign-in this plugin saved on this computer and revokes it.`,
      inputSchema: {},
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    () =>
      run(env, async () => {
        const revoked = await session.signOut();
        return {
          firm: null,
          text: revoked
            ? `Signed out of ${env.label}. The saved sign-in is deleted and revoked.`
            : `Signed out of ${env.label}. The saved sign-in is deleted; rightflow could not confirm the revocation, so it ends when it expires.`,
        };
      }),
  );
}

async function chooseFirm(
  session: Session,
  api: Api,
  saved: StoredSession,
  query: string | undefined,
): Promise<{ firm: Membership | null; text: string }> {
  const probeOrg = saved.organizationId ?? saved.organizationIds[0];
  if (!probeOrg) throw new UserFacingError("This login does not belong to any firm.");
  const me = await fetchMe(api, await session.probeToken(probeOrg));
  const firms = selectableFirms(me);
  if (firms.length === 0) throw new UserFacingError("This login does not belong to any firm.");

  const candidates = query ? matchFirms(firms, query) : firms;
  if (candidates.length !== 1) {
    const list = firms.map((f) => `- ${f.name} (id ${f.id}${f.role ? `, ${f.role}` : ""})`).join("\n");
    const lead = query
      ? candidates.length === 0
        ? `No firm in this login matches "${query}".`
        : `Several firms match "${query}"; use the id.`
      : "This login belongs to several firms.";
    return { firm: null, text: `${lead} Call use_firm with one of these:\n${list}` };
  }
  const chosen = candidates[0];
  if (!chosen) throw new Error("unreachable");
  await session.selectFirm(chosen.id, chosen.name);
  const selected = await fetchMe(api);
  return { firm: chosen, text: [`Now working on ${chosen.name}.`, ...describeAccess(selected)].join("\n") };
}

function describeAccess(me: Me): string[] {
  const who = me.email ?? me.name ?? "this login";
  const role = me.activeOrganization?.role ?? "no role";
  const canChange = me.permissions.includes(SETUP_PERMISSION);
  const enabled = me.features[SETUP_MODULE]?.enabled === true;
  const lines = [
    `Signed in as ${who}, role: ${role}.`,
    `May change agent teams: ${canChange ? "yes" : "no — this needs the owner or admin role in the firm"}.`,
    `Own agent teams switched on for this firm: ${enabled ? "yes" : "no — rightflow switches this on per firm"}.`,
  ];
  return lines;
}

function nodeCheck(): string {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return ok
    ? `Node.js ${process.versions.node}.`
    : `Node.js ${process.versions.node} is older than ${MIN_NODE.join(".")}; update Node.js before relying on this plugin.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

