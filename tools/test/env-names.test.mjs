// Tests for rule P1 (tools/check-deploy.mjs): every app variable in compose is read by
// app/src/config.js. Comes from the 2026-10-14 incident (docs/postmortem.md, action item #1).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, PATHS, RULES } from "../check-deploy.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
// the real config.js: the rule must work against what the app actually reads
const CONFIG = readFileSync(join(REPO, "app", "src", "config.js"), "utf8");
const P1 = RULES.find((r) => r.id === "P1");

/** A repo-like root with app/src/config.js; compose is handed over already parsed. */
function check(services, config = CONFIG) {
  const root = mkdtempSync(join(tmpdir(), "p1-"));
  try {
    if (config !== null) {
      mkdirSync(join(root, "app", "src"), { recursive: true });
      writeFileSync(join(root, "app", "src", "config.js"), config);
    }
    return P1.check({ root, compose: { exists: true, data: { services } } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// deploy/compose.yaml of v1.8.0 (incident/changes/v1.8.0.diff:84-115): sorted, DB_POOL_MAX → DB_POOL_SIZE
const v180env = {
  COURIER_BASE_URL: "https://courier.example.com/api/v1",
  DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
  DB_POOL_SIZE: "20",
  DB_POOL_WAIT_MS: "2000",
  LOG_LEVEL: "info",
  SMS_BASE_URL: "https://sms.example.net/api/v2",
  SMS_RATE_PER_SEC: "20",
  SMS_TOKEN: "${SMS_TOKEN:?}",
  TZ: "Europe/Kyiv",
};

test("P1: the v1.8.0 compose from the incident fails — DB_POOL_SIZE is read nowhere", () => {
  const result = check({
    api: { image: "poshtomat:1.8.0", environment: { ...v180env, PORT: "8080" } },
    worker: { image: "poshtomat:1.8.0", command: ["node", "src/worker.js"], environment: v180env },
  });
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /api: DB_POOL_SIZE не читається \(схожа: DB_POOL_MAX\)/);
  assert.match(result.message, /worker: DB_POOL_SIZE/);
  assert.doesNotMatch(result.message, /TZ/); // the rename is the problem, not the runtime variable
});

test("P1: a correct compose passes, though a naive rule would trip on TZ, list form and a database service", () => {
  const result = check({
    api: {
      image: "poshtomat:1.7.3",
      // list form, as compose allows; TZ and NODE_ENV are read by Node, not by config.js
      environment: ["TZ=Europe/Kyiv", "NODE_ENV=production", "DB_POOL_MAX=20", "DATABASE_URL=${DATABASE_URL:?}", "PORT=8080"],
    },
    worker: { image: "poshtomat:1.7.3", environment: { TZ: "Europe/Kyiv", DB_POOL_MAX: "20", SMS_TOKEN: "${SMS_TOKEN:?}" } },
    // not our app: its variables are not config.js's business
    postgres: { image: "postgres:17.6", environment: { POSTGRES_PASSWORD: "${PG_PASSWORD:?}", POSTGRES_DB: "poshtomat" } },
  });
  assert.equal(result.status, "PASS");
  assert.match(result.message, /api, worker/);
});

test("P1: catches the class, not just this rename — a typo and a variable the app stopped reading", () => {
  const typo = check({ worker: { image: "w:1", environment: { DATABASE_URL: "x", SMS_RATE_PER_SECOND: "8" } } });
  assert.equal(typo.status, "FAIL");
  assert.match(typo.message, /SMS_RATE_PER_SECOND не читається \(схожа: SMS_RATE_PER_SEC\)/);

  const config = CONFIG.replace(/\s*courierBaseUrl:.*\n/, "\n");
  const dropped = check({ api: { image: "a:1", environment: { PORT: "8080", COURIER_BASE_URL: "https://c" } } }, config);
  assert.equal(dropped.status, "FAIL");
  assert.match(dropped.message, /api: COURIER_BASE_URL не читається$/);
});

test("P1: env[\"NAME\"] counts as reading; without config.js or app services the rule skips", () => {
  assert.equal(check({ api: { image: "a:1", environment: { PORT: "1", EXTRA: "2" } } }, 'const p = env.PORT; const e = env["EXTRA"];\n').status, "PASS");
  assert.equal(check({ api: { image: "a:1", environment: { PORT: "1" } } }, null).status, "SKIP");
  assert.equal(check({ db: { image: "postgres:17.6", environment: { POSTGRES_DB: "x" } } }).status, "SKIP");
});

test("P1: a service whose every app variable is misnamed still fails, not skips", () => {
  const result = check({ worker: { image: "w:1", environment: { TZ: "Europe/Kyiv", DB_POOL_SIZE: "20" } } });
  assert.equal(result.status, "FAIL");
  // DB_POOL_WAIT_MS is a candidate too: the service does not set it here
  assert.match(result.message, /worker: DB_POOL_SIZE не читається \(схожа: DB_POOL_MAX, DB_POOL_WAIT_MS\)/);
});

test("P1: env.NAME in a comment or a string is not a read", () => {
  const config = CONFIG.replace(
    "// sensible default for local dev",
    '// v1.8.0 used env.DB_POOL_SIZE /* env.SMS_RATE */\n    hint: "set env.SMS_RATE or \'env.DB_POOL_SIZE\'",',
  );
  const result = check({ worker: { image: "w:1", environment: { ...v180env, SMS_RATE: "8" } } }, config);
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /worker: DB_POOL_SIZE не читається/);
  assert.match(result.message, /worker: SMS_RATE не читається/);
  // the real reads around them still count, URLs with // inside strings included
  assert.doesNotMatch(result.message, /DATABASE_URL|SMS_BASE_URL|COURIER_BASE_URL/);
});

test("P1: destructuring from env counts as reading", () => {
  const config = "export function loadConfig(env = process.env) {\n  const { PORT, DB_POOL_MAX: max = 4, ...rest } = env;\n  return { PORT, max, rest };\n}\n";
  const ok = check({ api: { image: "a:1", environment: { PORT: "8080", DB_POOL_MAX: "20" } } }, config);
  assert.equal(ok.status, "PASS", ok.message);
  const renamed = check({ api: { image: "a:1", environment: { PORT: "8080", DB_POOL_SIZE: "20" } } }, config);
  assert.equal(renamed.status, "FAIL");
  assert.match(renamed.message, /api: DB_POOL_SIZE не читається \(схожа: DB_POOL_MAX\)/);
});

// Only compose is parsed (P1 needs nothing else), through the real YAML parser — npx needs
// the network or a warm npm cache, so without them the test skips instead of failing on npx.
test("P1: the repo's own deploy/compose.yaml passes", (t) => {
  const parsed = parseYaml(readFileSync(join(REPO, PATHS.compose), "utf8"));
  if (parsed.toolError) return t.skip(`npx yaml недоступний: ${parsed.toolError}`);
  const result = P1.check({ root: REPO, compose: { path: PATHS.compose, exists: true, ...parsed } });
  assert.equal(result.status, "PASS", result.message);
});
