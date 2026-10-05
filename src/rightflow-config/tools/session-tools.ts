import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.ts";
import type { PendingSignIn, Session } from "../auth/session.ts";
import type { StoredSession } from "../auth/store.ts";
import { UserFacingError } from "../errors.ts";
import { fetchMe, matchFirms, selectableFirms, SETUP_MODULE, SETUP_PERMISSION, type Me, type Membership } from "../me.ts";
import { run, selectedFirmOf, type ToolOutcome } from "./result.ts";

export interface SessionToolsContext {
  session: Session;
  api: Api;
  version: string;
  /** How long a sign_in call waits for a code shown earlier to be confirmed. */
  signInWaitMs?: number;
}

const MIN_NODE = [22, 18] as const;

export function registerSessionTools(server: McpServer, ctx: SessionToolsContext): void {
  const { session, api } = ctx;
  const env = session.env;
  const go = (body: () => Promise<ToolOutcome>) => run(env, body, selectedFirmOf(session));
  // One sign-in at a time. It stays here until a sign_in call has seen how it
  // ended, so the call after the one that showed the code picks up the login
  // instead of starting over with a new code.
  let pending: PendingSignIn | null = null;

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
      go(async () => {
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
        "Signs in to rightflow with your normal rightflow login, then selects your firm. The first call returns a link " +
        "and a code at once: show both to the person, word for word. They open the link in any browser, check that " +
        "the code matches, and sign in. Then call sign_in again; it waits for the confirmation. If the login belongs " +
        "to several firms, pass `firm` (its name or id) or call use_firm afterwards.",
      inputSchema: {
        firm: z.string().min(1).max(200).optional().describe("Name or id of the firm to work on."),
      },
      annotations: { openWorldHint: true },
    },
    ({ firm }) =>
      go(async () => {
        if (!pending) {
          pending = await session.startSignIn();
          return { firm: null, text: showCode(env.label, pending) };
        }
        const current = pending;
        const outcome = await Promise.race([
          current.done,
          delay(ctx.signInWaitMs ?? 90_000).then(() => ({ ok: "waiting" as const })),
        ]);
        if (outcome.ok === "waiting") {
          return { firm: null, text: `Not confirmed yet.\n\n${showCode(env.label, current)}` };
        }
        if (pending === current) pending = null;
        if (!outcome.ok) throw outcome.error;
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
      go(async () => {
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
      go(async () => {
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

function showCode(label: string, p: PendingSignIn): string {
  const manual = p.url === p.verificationUri ? "" : ` (or open ${p.verificationUri} and type the code)`;
  return (
    `To sign in to ${label}, open this link in any browser${manual}:\n${p.url}\n\n` +
    `Code: ${p.userCode}\n\n` +
    "Check that the page shows this code, then sign in with your rightflow login. Afterwards, call sign_in again."
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
  if (!saved.organizationIds.includes(chosen.id)) {
    // The login only knows the firms it had when it was made.
    throw new UserFacingError(`${chosen.name} was added to this login after it signed in. Call sign_in to pick it up.`);
  }
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
    `May change agent teams: ${canChange ? "yes" : "no — your role in this firm does not include changing its settings"}.`,
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

