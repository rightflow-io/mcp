import { homedir } from "node:os";
import { join } from "node:path";

export type EnvironmentName = "production" | "development";

export interface Environment {
  name: EnvironmentName;
  label: string;
  /** Base URL of the rightflow API, including its `/api` prefix. */
  apiUrl: string;
  /** Base URL of the sign-in service (OpenID Connect issuer without `/oidc`). */
  authUrl: string;
  /**
   * Public client id of the sign-in app registered for this plugin, one that
   * signs in with a code (device flow). Public by design: a program on a
   * person's machine cannot keep a secret. `null` until the app is registered
   * for this environment.
   */
  clientId: string | null;
  /** True when a development override replaced one of the values above. */
  overridden: boolean;
}

const ENVIRONMENTS: Record<EnvironmentName, Omit<Environment, "overridden">> = {
  production: {
    name: "production",
    label: "Production",
    apiUrl: "https://api.rightflow.one/api",
    authUrl: "https://auth.rightflow.one",
    clientId: null,
  },
  development: {
    name: "development",
    label: "Development",
    apiUrl: "https://api.dev.rightflow.one/api",
    authUrl: "https://auth.dev.rightflow.one",
    // Public by design (see `clientId` above): a native app's id, not a secret.
    clientId: "ojjmyx4huwj74ih086xy1",
  },
};

/**
 * Picks the environment from the plugin's `environment` option. Empty means the
 * option's own default, production; an unknown value is refused rather than
 * mapped to either, since signing in to the wrong rightflow is the mistake a
 * guess would make.
 */
export function resolveEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const raw = (env.RF_CONFIG_ENV ?? "").trim();
  const name = raw === "" ? "production" : raw;
  if (name !== "production" && name !== "development") {
    throw new Error(`Unknown rightflow environment "${raw}". Choose production or development under /plugin.`);
  }
  const base = ENVIRONMENTS[name];
  // For people working on the plugin against a rightflow running on their own
  // machine. Never set by the plugin's own configuration.
  const apiUrl = env.RF_CONFIG_API_URL?.trim() || base.apiUrl;
  const authUrl = env.RF_CONFIG_AUTH_URL?.trim() || base.authUrl;
  const clientId = env.RF_CONFIG_CLIENT_ID?.trim() || base.clientId;
  return {
    ...base,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    authUrl: authUrl.replace(/\/+$/, ""),
    clientId,
    overridden: apiUrl !== base.apiUrl || authUrl !== base.authUrl || clientId !== base.clientId,
  };
}

/** The plugin's own data folder, which survives updates and is removed on uninstall. */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const fromPlugin = env.RF_CONFIG_DATA?.trim();
  return fromPlugin ? fromPlugin : join(homedir(), ".rightflow-config");
}
