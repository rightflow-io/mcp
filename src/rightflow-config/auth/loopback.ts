import { createServer, type Server } from "node:http";
import { UserFacingError } from "../errors.ts";

/**
 * Ports the native sign-in app accepts as redirect targets. The sign-in service
 * matches redirect URIs exactly, so this list and the app's registration have to
 * agree; a free port outside it would be refused.
 */
export const CALLBACK_PORTS = [53682, 53683, 53684, 53685, 53686, 53687, 53688, 53689, 53690, 53691] as const;

export interface PendingCallback {
  redirectUri: string;
  /** Resolves with the authorization code, or rejects on refusal, state mismatch or timeout. */
  code: Promise<string>;
  close: () => void;
}

/**
 * Listens on 127.0.0.1 only, so nothing else on the network can deliver a code,
 * and accepts exactly one callback whose state matches.
 */
export async function awaitCallback(
  expectedState: string,
  opts: { timeoutMs?: number; ports?: readonly number[] } = {},
): Promise<PendingCallback> {
  const ports = opts.ports ?? CALLBACK_PORTS;
  for (const port of ports) {
    try {
      return await listen(port, expectedState, opts.timeoutMs ?? 5 * 60_000);
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new UserFacingError(
    `Could not start the sign-in callback: ports ${ports[0]}–${ports[ports.length - 1]} are all in use on this machine.`,
  );
}

function listen(port: number, expectedState: string, timeoutMs: number): Promise<PendingCallback> {
  return new Promise((resolveReady, rejectReady) => {
    let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
    const code = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // A caller that gives up early must not leave an unhandled rejection behind.
    code.catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const received = url.searchParams.get("code");
      let outcome: { ok: true; code: string } | { ok: false; message: string };
      if (error) outcome = { ok: false, message: `The sign-in was not completed (${error}).` };
      else if (state !== expectedState) outcome = { ok: false, message: "The sign-in answer did not belong to this request." };
      else if (!received) outcome = { ok: false, message: "The sign-in answer carried no code." };
      else outcome = { ok: true, code: received };

      res.writeHead(outcome.ok ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
      });
      res.end(page(outcome.ok ? "Signed in. You can close this window and return to Claude." : outcome.message));
      if (timer) clearTimeout(timer);
      server.close();
      if (outcome.ok) settle.resolve(outcome.code);
      else settle.reject(new UserFacingError(outcome.message));
    });

    server.once("error", rejectReady);
    server.listen(port, "127.0.0.1", () => {
      timer = setTimeout(() => {
        server.close();
        settle.reject(new UserFacingError("No sign-in arrived within five minutes. Call sign_in to try again."));
      }, timeoutMs);
      timer.unref();
      resolveReady({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        code,
        close: () => {
          if (timer) clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>rightflow</title><p>${escapeHtml(message)}</p>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
