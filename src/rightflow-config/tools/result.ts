import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Session } from "../auth/session.ts";
import type { Environment } from "../env.ts";
import { UserFacingError } from "../errors.ts";
import { header } from "../header.ts";

export type ToolResult = CallToolResult;

export interface ToolOutcome {
  firm: { name: string } | null;
  team?: { name: string } | null;
  text: string;
}

/** The firm selected when a call failed, for the header of its error; null when none is, or it cannot be read. */
export type SelectedFirm = () => Promise<{ name: string } | null>;

export function selectedFirmOf(session: Pick<Session, "current">): SelectedFirm {
  return async () => {
    const saved = await session.current();
    return saved?.organizationId ? { name: saved.organizationName ?? saved.organizationId } : null;
  };
}

/**
 * Runs a tool body and shapes its answer: the header first, always. A refusal
 * the person can act on is shown as written. Anything unexpected goes to stderr
 * only: its message can quote what was being read when it failed, a token included.
 *
 * An error names the selected firm too: a refusal shown under "no firm selected"
 * reads as a refusal about selecting one.
 */
export async function run(env: Environment, body: () => Promise<ToolOutcome>, selectedFirm?: SelectedFirm): Promise<ToolResult> {
  try {
    const out = await body();
    return { content: [{ type: "text", text: `${header(env, out.firm, out.team ?? null)}\n${out.text}` }] };
  } catch (err) {
    const firm = await selectedFirm?.().catch(() => null);
    if (err instanceof UserFacingError) {
      return { isError: true, content: [{ type: "text", text: `${header(env, firm ?? null)}\n${err.message}` }] };
    }
    console.error(err);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${header(env, firm ?? null)}\nSomething went wrong inside the plugin. The details are in the rightflow-config MCP server log (/mcp in Claude Code).`,
        },
      ],
    };
  }
}
