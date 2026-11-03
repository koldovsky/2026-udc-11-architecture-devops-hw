// Tests for rule E1 (tools/check-deploy.mjs): every variable a compose service sets must be
// read by the app. Comes from the incident of 2026-10-14: v1.8.0 renamed DB_POOL_MAX to
// DB_POOL_SIZE in compose.yaml, the code kept reading the old name, and the pool silently
// fell from 20 to the local-dev default of 4.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerfileSource, envNamesReadByApp, loadContext, RULES, runChecks } from "../check-deploy.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const rule = RULES.find((r) => r.id === "E1");

const check = (services, root = REPO) => rule.check({ root, dockerfile: dockerfileSource(null), compose: { exists: true, data: { services } } });

/** A throwaway tree with the given app files; returns its path. */
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-env-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function withTree(files, fn) {
  const dir = tree(files);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("E1 FAIL: the incident of 2026-10-14, the real code with the v1.8.0 environment", () => {
  // the variables as incident/changes/v1.8.0.diff leaves them, for both services
  const env = { DB_POOL_SIZE: "20", DB_POOL_WAIT_MS: "2000", LOG_LEVEL: "info", TZ: "Europe/Kyiv" };
  const result = check({ api: { environment: env }, worker: { environment: env } });
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /api: DB_POOL_SIZE/);
  assert.match(result.message, /worker: DB_POOL_SIZE/);
  assert.doesNotMatch(result.message, /TZ|DB_POOL_WAIT_MS|LOG_LEVEL/); // names only what is wrong
});

test("E1 FAIL: the class of the problem, not just that one name", () => {
  const code = { "app/src/config.js": "export const load = (env) => ({ rate: env.SMS_RATE_PER_SEC, url: env.DATABASE_URL });\n" };
  withTree(code, (root) => {
    const fails = (environment) => check({ web: { environment } }, root).status === "FAIL";
    assert.ok(fails({ SMS_RATE_PER_SECOND: "5" }), "a typo");
    assert.ok(fails(["DATABASE_URL=x", "OLD_LIMIT=3"]), "a stale variable, list syntax");
    assert.ok(fails(["SMS_RATE_PER_SECOND"]), "a pass-through without a value");
    assert.ok(fails({ sms_rate_per_sec: "5" }), "names are case-sensitive");
  });
  // a mention in a comment is not reading the variable
  withTree({ "app/src/config.js": "// was: env.POOL_SIZE\n/* env.OLD_POOL */\nexport const load = (env) => env.POOL;\n" }, (root) => {
    assert.equal(check({ web: { environment: { POOL_SIZE: "1" } } }, root).status, "FAIL");
    assert.equal(check({ web: { environment: { OLD_POOL: "1" } } }, root).status, "FAIL");
  });
});

test("E1 PASS: correct configs a naive «compose and config.js must match» rule would reject", () => {
  // worker has no PORT and api has no SMS_*: a service sets only what it needs; TZ and NODE_ENV
  // are read by the runtime, not by our code; secrets come by reference
  const result = check({
    api: { environment: { TZ: "Europe/Kyiv", NODE_ENV: "production", PORT: "8080", DATABASE_URL: "${DATABASE_URL:?required}", DB_POOL_MAX: "20" } },
    worker: { environment: ["TZ=Europe/Kyiv", "SMS_TOKEN", "SMS_RATE_PER_SEC=5", "DB_POOL_MAX=20"] },
  });
  assert.equal(result.status, "PASS", result.message);
  // a variable read outside config.js counts as read, through process.env too
  withTree({ "app/src/config.js": "export const a = (env) => env.A;\n", "app/src/deep/feature.js": "export const b = process.env.FEATURE_B;\n", "app/bin/job.mjs": "console.log(process.env.JOB_C);\n" }, (root) => {
    assert.equal(check({ web: { environment: { A: "1", FEATURE_B: "2", JOB_C: "3" } } }, root).status, "PASS");
  });
  // no environment at all: nothing to get wrong
  assert.equal(check({ web: { image: "a:1" } }).status, "PASS");
});

test("E1 looks only at what reaches the container: compose's own ${VAR} does not count", () => {
  // POSHTOMAT_IMAGE is read by compose to pick the image, the app never sees it
  const yaml = [
    "x-env: &env",
    "  LOG_LEVEL: info",
    "services:",
    "  web:",
    "    image: ${POSHTOMAT_IMAGE:?required}",
    "    environment:",
    "      <<: *env",
    '      DB_POOL_MAX: "20"',
    "",
  ].join("\n");
  withTree({ "app/src/config.js": "export const c = (env) => [env.LOG_LEVEL, env.DB_POOL_MAX];\n", "deploy/compose.yaml": yaml }, (root) => {
    assert.equal(runChecks(loadContext(root)).find((r) => r.id === "E1").status, "PASS");
    writeFileSync(join(root, "deploy", "compose.yaml"), yaml.replace("DB_POOL_MAX", "DB_POOL_SIZE"));
    const result = runChecks(loadContext(root)).find((r) => r.id === "E1");
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /web: DB_POOL_SIZE/);
  });
});

test("E1 skips rather than guesses when there is no code to compare with", () => {
  withTree({ "README.md": "no code here\n" }, (root) => {
    assert.equal(check({ web: { environment: { ANYTHING: "1" } } }, root).status, "SKIP");
  });
  // a compose file it cannot use is the same FAIL as in the other compose rules
  assert.equal(rule.check({ root: REPO, compose: { exists: false } }).status, "FAIL");
});

test("envNamesReadByApp finds every variable of the real config", () => {
  const names = envNamesReadByApp(REPO);
  for (const name of ["PORT", "DATABASE_URL", "DB_POOL_MAX", "DB_POOL_WAIT_MS", "SMS_BASE_URL", "SMS_TOKEN", "SMS_RATE_PER_SEC", "COURIER_BASE_URL", "LOG_LEVEL"]) {
    assert.ok(names.has(name), name);
  }
  assert.ok(!names.has("DB_POOL_SIZE"));
});
