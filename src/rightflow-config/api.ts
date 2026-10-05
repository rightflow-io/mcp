import type { Fetch } from "./auth/oidc.ts";
import type { Session } from "./auth/session.ts";
import { UserFacingError } from "./errors.ts";

/** Long enough for a whole bundle to be checked and stored, short enough that a hung call ends. */
const API_TIMEOUT_MS = 60_000;

export interface ApiResponse<T> {
  status: number;
  body: T;
}

/**
 * The only way the plugin talks to rightflow. Every decision — what may change,
 * what is valid — is the API's; this client carries requests and turns refusals
 * into sentences.
 */
export class Api {
  private readonly session: Session;
  private readonly fetchImpl: Fetch;

  constructor(session: Session, fetchImpl: Fetch = fetch) {
    this.session = session;
    this.fetchImpl = fetchImpl;
  }

  /** A request as the selected firm. */
  async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const { token } = await this.session.accessToken();
    return this.send<T>(method, path, token, body);
  }

  /** A request with an explicit token, for the moment between sign-in and choosing a firm. */
  async requestWithToken<T>(method: string, path: string, token: string): Promise<ApiResponse<T>> {
    return this.send<T>(method, path, token);
  }

  private async send<T>(method: string, path: string, token: string, body?: unknown): Promise<ApiResponse<T>> {
    const env = this.session.env;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${env.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      text = await res.text();
    } catch {
      throw new UserFacingError(`Could not reach rightflow ${env.label} (${env.apiUrl}). Check the connection and try again.`);
    }
    const parsed = parseJson(text);
    if (res.status === 401) {
      throw new UserFacingError(`rightflow ${env.label} no longer accepts this sign-in. Call sign_in.`);
    }
    if (res.status === 403) {
      throw new UserFacingError(serverMessage(parsed) ?? "rightflow refused this for your account.");
    }
    if (res.status === 413) {
      throw new UserFacingError(
        "rightflow refused the request as too large. team_reference lists the limits for files and request size.",
      );
    }
    if (res.status >= 500) {
      throw new UserFacingError(`rightflow ${env.label} had a problem answering (${res.status}). Try again shortly.`);
    }
    return { status: res.status, body: parsed as T };
  }
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The details of a refusal. rightflow wraps them as `{ statusCode, …, error }`,
 * where `error` is the refusal itself: a sentence, or an object with `message`
 * and, depending on the refusal, a `code` and the findings behind it.
 */
export function errorDetail(body: unknown): Record<string, unknown> | string | null {
  const detail = isRecord(body) && "error" in body ? body.error : body;
  if (typeof detail === "string" || isRecord(detail)) return detail;
  return null;
}

/** The API's own human-readable refusal, when it sent one. */
export function serverMessage(body: unknown): string | null {
  const detail = errorDetail(body);
  if (typeof detail === "string") return detail;
  if (!detail) return null;
  const m = detail.message;
  const message = typeof m === "string" ? m : Array.isArray(m) && m.every((x) => typeof x === "string") ? m.join(" ") : null;
  const issues = Array.isArray(detail.issues)
    ? detail.issues.filter(isRecord).map((i) => `- ${typeof i.path === "string" && i.path ? `${i.path}: ` : ""}${String(i.message ?? "")}`)
    : [];
  if (message === null) return issues.length > 0 ? issues.join("\n") : null;
  return issues.length > 0 ? `${message}\n${issues.join("\n")}` : message;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
