// Tests for rule C5: the variables compose passes to the app vs. the ones app/src/config.js reads.
// Action item #1 of docs/postmortem.md (incident 2026-10-14: DB_POOL_MAX → DB_POOL_SIZE).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configVars, loadContext, RULES } from "../check-deploy.mjs";

const C5 = RULES.find((r) => r.id === "C5");
const REPO = fileURLToPath(new URL("../..", import.meta.url));

// A trimmed copy of app/src/config.js as it was in v1.7.3 and v1.8.0 (it did not change).
const CONFIG_JS = `export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbUrl: env.DATABASE_URL || "postgres://poshtomat@localhost:5432/poshtomat",
    // sensible default for local dev
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    smsToken: env.SMS_TOKEN || "",
    logLevel: env["LOG_LEVEL"] || "info",
  };
}
`;

const IMAGE = "${POSHTOMAT_IMAGE:?not set}";
const api = (env) => ({ image: IMAGE, restart: "unless-stopped", ports: ["8080:8080"], environment: env });
const worker = (env) => ({ image: IMAGE, restart: "unless-stopped", command: ["node", "src/worker.js"], environment: env });

let root;
test.before(() => {
  root = mkdtempSync(join(tmpdir(), "check-c5-"));
  mkdirSync(join(root, "app", "src"), { recursive: true });
  writeFileSync(join(root, "app", "src", "config.js"), CONFIG_JS);
});
test.after(() => rmSync(root, { recursive: true, force: true }));

const run = (services) => C5.check({ root, compose: { exists: true, data: { services } } });

test("C5 reads env.NAME and env[\"NAME\"] from config.js", () => {
  assert.deepEqual([...configVars(CONFIG_JS)].sort(), ["DATABASE_URL", "DB_POOL_MAX", "LOG_LEVEL", "PORT", "SMS_TOKEN"]);
});

test("C5 FAIL: the 14.10 incident — v1.8.0 renamed DB_POOL_MAX to DB_POOL_SIZE in both services", () => {
  const base = { DATABASE_URL: "${DATABASE_URL:?}", DB_POOL_SIZE: "20", LOG_LEVEL: "info" };
  const r = run({ api: api({ ...base, PORT: "8080" }), worker: worker({ ...base, SMS_TOKEN: "${SMS_TOKEN:?}" }) });
  assert.equal(r.status, "FAIL");
  assert.match(r.message, /api: DB_POOL_SIZE застосунок не читає/);
  assert.match(r.message, /worker: DB_POOL_SIZE/);
  assert.match(r.message, /не задано в жодному сервісі.*DB_POOL_MAX/);
});

test("C5 FAIL: a rename in one service only is caught too, though the variable is still set elsewhere", () => {
  const r = run({
    api: api({ PORT: "8080", DATABASE_URL: "x", DB_POOL_SIZE: "20", LOG_LEVEL: "info" }),
    worker: worker({ DATABASE_URL: "x", DB_POOL_MAX: "20", SMS_TOKEN: "${SMS_TOKEN:?}" }),
  });
  assert.equal(r.status, "FAIL");
  assert.match(r.message, /api: DB_POOL_SIZE/);
});

test("C5 FAIL: a typo and a variable the code reads but nobody sets", () => {
  const r = run({ api: api({ PORT: "8080", DATABASE_URL: "x", DB_POOL_MAX: "20", LOG_LEVL: "info", SMS_TOKEN: "${SMS_TOKEN:?}" }) });
  assert.equal(r.status, "FAIL");
  assert.match(r.message, /LOG_LEVL застосунок не читає/);
  assert.match(r.message, /не задано в жодному сервісі.*LOG_LEVEL/);
});

test("C5 PASS: a correct config the naive versions of the rule would reject", () => {
  // - TZ is not read by config.js but by the runtime (app/src/log.js relies on it):
  //   a naive "only variables config.js knows" rule would fail here;
  // - the api does not send SMS and gets no SMS_TOKEN, list-form environment on the worker:
  //   a naive "every service gets every variable" rule would fail here;
  // - postgres is a third-party service with its own variables: not checked.
  const r = run({
    api: api({ TZ: "Europe/Kyiv", PORT: "8080", DATABASE_URL: "${DATABASE_URL:?}", DB_POOL_MAX: "20", LOG_LEVEL: "info" }),
    worker: worker(["TZ=Europe/Kyiv", "DATABASE_URL", "DB_POOL_MAX=20", "SMS_TOKEN=${SMS_TOKEN:?}"]),
    postgres: { image: "postgres:17.2", restart: "unless-stopped", environment: { POSTGRES_PASSWORD: "${PG_PASSWORD:?}" } },
  });
  assert.equal(r.status, "PASS", r.message);
});

test("C5 SKIP when there is nothing to compare with", () => {
  assert.equal(C5.check({ root: join(root, "nowhere"), compose: { exists: true, data: { services: { api: api({}) } } } }).status, "SKIP");
  assert.equal(run({ db: { image: "postgres:17.2", environment: { POSTGRES_DB: "x" } } }).status, "SKIP");
});

test("C5 FAIL, not a silent SKIP: the app image variable renamed to a neutral name", () => {
  for (const neutral of ["${APP_IMAGE:?not set}", "$APP_IMAGE"]) {
    const r = run({
      api: { ...api({ PORT: "8080", DATABASE_URL: "x", DB_POOL_SIZE: "20", LOG_LEVEL: "info" }), image: neutral },
      db: { image: "postgres:17.2", environment: { POSTGRES_DB: "x" } },
    });
    assert.equal(r.status, "FAIL", `${neutral}: ${r.message}`);
    assert.match(r.message, /APP_IMAGE/);
    assert.doesNotMatch(r.message, /\bdb\b/);
  }
  // `$$` is an escaped literal `$`, not a variable: nothing to recognise, so SKIP as before.
  assert.equal(run({ tool: { image: "registry.example.org/tool:$$x" } }).status, "SKIP");
});

test("C5 FAIL, not a silent SKIP: config.js reads variables in a way the rule does not understand", () => {
  const other = mkdtempSync(join(tmpdir(), "check-c5-destructure-"));
  try {
    mkdirSync(join(other, "app", "src"), { recursive: true });
    writeFileSync(join(other, "app", "src", "config.js"),
      "export function loadConfig() { const { PORT, DB_POOL_MAX } = process.env; return { PORT, DB_POOL_MAX }; }\n");
    const r = C5.check({ root: other, compose: { exists: true, data: { services: { api: api({ PORT: "8080" }) } } } });
    assert.equal(r.status, "FAIL", r.message);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("C5 on this repo: deploy/compose.yaml matches app/src/config.js", () => {
  const r = C5.check(loadContext(REPO));
  assert.equal(r.status, "PASS", r.message);
});
