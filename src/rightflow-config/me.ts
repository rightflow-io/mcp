import type { Api } from "./api.ts";

/** The part of `GET /auth/me` this plugin reads. The API's contract is the source; this is a narrow view of it. */
export interface Membership {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer" | null;
  isAdminOrg: boolean;
}

export interface Me {
  email?: string | null;
  name?: string | null;
  activeOrganization: Membership | null;
  organizations: Membership[];
  permissions: string[];
  features: Record<string, { enabled: boolean }>;
}

/** What setting up a firm's own team needs; reported by `status`, enforced by the API. */
export const SETUP_PERMISSION = "tenant:settings:write";
export const SETUP_MODULE = "custom_teams";

export async function fetchMe(api: Api, token?: string): Promise<Me> {
  const res = token ? await api.requestWithToken<Me>("GET", "/auth/me", token) : await api.request<Me>("GET", "/auth/me");
  if (res.status !== 200 || typeof res.body !== "object" || res.body === null) {
    throw new Error(`Unexpected answer from /auth/me (${res.status}).`);
  }
  return res.body;
}

/** Firms a person can choose: every membership except rightflow's own staff organization. */
export function selectableFirms(me: Me): Membership[] {
  return me.organizations.filter((o) => !o.isAdminOrg);
}

/** Matches a firm by id or by name, ignoring case. Ambiguity is the caller's to resolve. */
export function matchFirms(firms: Membership[], query: string): Membership[] {
  const q = query.trim().toLowerCase();
  const byId = firms.filter((f) => f.id.toLowerCase() === q);
  if (byId.length > 0) return byId;
  return firms.filter((f) => f.name.trim().toLowerCase() === q);
}
