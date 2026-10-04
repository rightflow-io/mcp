import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEnvironment } from "./env.ts";
import { UserFacingError } from "./errors.ts";
import { header } from "./header.ts";
import { matchFirms, selectableFirms, type Me } from "./me.ts";
import { run } from "./tools/result.ts";

test("production is the default and an unknown environment is refused", () => {
  assert.equal(resolveEnvironment({}).name, "production");
  assert.equal(resolveEnvironment({ RF_CONFIG_ENV: "development" }).label, "Development");
  assert.throws(() => resolveEnvironment({ RF_CONFIG_ENV: "staging" }));
});

test("development overrides are visible in the header", () => {
  const env = resolveEnvironment({ RF_CONFIG_ENV: "development", RF_CONFIG_API_URL: "http://127.0.0.1:3003/api" });
  assert.equal(env.overridden, true);
  assert.equal(header(env, { name: "Firm A" }), '[rightflow Development (custom endpoints) · firm "Firm A"]');
  assert.equal(header(resolveEnvironment({})), "[rightflow Production · no firm selected]");
});

const me = (orgs: Me["organizations"]): Me => ({
  activeOrganization: orgs[0] ?? null,
  organizations: orgs,
  permissions: [],
  features: {},
});

test("the staff organization is never offered as a firm", () => {
  const firms = selectableFirms(
    me([
      { id: "a", name: "Firm A", role: "admin", isAdminOrg: false },
      { id: "s", name: "Staff", role: "admin", isAdminOrg: true },
    ]),
  );
  assert.deepEqual(firms.map((f) => f.id), ["a"]);
});

test("a firm is matched by id first, then by name ignoring case", () => {
  const firms = [
    { id: "a", name: "Firm A", role: null, isAdminOrg: false },
    { id: "b", name: "firm a", role: null, isAdminOrg: false },
  ];
  assert.deepEqual(matchFirms(firms, "b").map((f) => f.id), ["b"]);
  assert.equal(matchFirms(firms, "FIRM A").length, 2);
  assert.equal(matchFirms(firms, "Firm C").length, 0);
});

test("every answer starts with the header, errors included", async () => {
  const env = resolveEnvironment({});
  const ok = await run(env, async () => ({ firm: { name: "Firm A" }, text: "done" }));
  assert.equal(ok.content[0]?.type === "text" && ok.content[0].text, '[rightflow Production · firm "Firm A"]\ndone');
  const refused = await run(env, async () => {
    throw new UserFacingError("not allowed");
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0]?.type === "text" && refused.content[0].text, "[rightflow Production · no firm selected]\nnot allowed");
});
