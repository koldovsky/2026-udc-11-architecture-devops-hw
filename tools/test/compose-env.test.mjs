// Tests for rule C5 of tools/check-deploy.mjs: every environment variable that compose sets
// for a service must be one the app reads (env.NAME in app/src or app/bin) or a runtime var.
// Fixtures are whole small trees on disk, parsed by the real YAML parser, so YAML merge keys
// (<<: *env) and the list form (- KEY=value) reach the rule exactly as in deploy/compose.yaml.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadContext, RULES } from "../check-deploy.mjs";

const C5 = RULES.find((r) => r.id === "C5");

// app/src/config.js as it is in the repo: reads DB_POOL_MAX, not DB_POOL_SIZE
const CONFIG_JS = [
  "export function loadConfig(env = process.env) {",
  "  return {",
  "    port: Number(env.PORT) || 8080,",
  "    dbPoolMax: Number(env.DB_POOL_MAX) || 4,",
  "    logLevel: env.LOG_LEVEL || \"info\",",
  "  };",
  "}",
  "",
].join("\n");

/** Writes { "rel/path": text } into a fresh temp dir and runs C5 on it. */
function checkTree(files) {
  const dir = mkdtempSync(join(tmpdir(), "check-c5-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return C5.check(loadContext(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// withDb: api is built from app/ and a third-party postgres service sits next to it
// (worker runs the same image as api, so it still counts as an app service).
const composeWithPool = (poolVar, { withDb = false } = {}) =>
  [
    "x-env: &env",
    "  TZ: \"Europe/Kyiv\"",
    "  LOG_LEVEL: \"info\"",
    `  ${poolVar}: "20"`,
    "services:",
    "  api:",
    "    image: poshtomat:1.8.0",
    ...(withDb ? ["    build:", "      context: ../app"] : []),
    "    environment:",
    "      <<: *env",
    "      PORT: \"8080\"",
    "  worker:",
    "    image: poshtomat:1.8.0",
    "    environment:",
    "      <<: *env",
    ...(withDb
      ? [
          "  db:",
          "    image: postgres:16.4",
          "    environment:",
          "      POSTGRES_DB: poshtomat",
          "      POSTGRES_USER: poshtomat",
          "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}",
        ]
      : []),
    "",
  ].join("\n");

test("C5 FAILs on the v1.8.0 incident: compose sets DB_POOL_SIZE, the app reads DB_POOL_MAX", () => {
  const result = checkTree({ "deploy/compose.yaml": composeWithPool("DB_POOL_SIZE"), "app/src/config.js": CONFIG_JS });
  assert.equal(result.status, "FAIL");
  // names every service and the variable, so the reader knows what to rename where
  assert.match(result.message, /api: DB_POOL_SIZE/);
  assert.match(result.message, /worker: DB_POOL_SIZE/);
  assert.doesNotMatch(result.message, /LOG_LEVEL|PORT|TZ/);
});

test("C5 PASSes the same compose once the name matches the code (v1.7.3)", () => {
  const result = checkTree({ "deploy/compose.yaml": composeWithPool("DB_POOL_MAX"), "app/src/config.js": CONFIG_JS });
  assert.equal(result.status, "PASS", result.message);
});

// A correct config that naive versions of the rule would flag:
//  - "read the keys of environment: as a map" sees list-form keys "0", "1" (and "<<" without merge);
//  - "split list items on '=' only" chokes on a pass-through item with no value (- LOG_LEVEL);
//  - "only app/src/config.js counts" misses a var the nightly job in app/bin reads itself;
//  - "only env.NAME" misses process.env["NAME"].
test("C5 PASSes list form, merged anchors, pass-through vars and vars read only in app/bin", () => {
  const compose = [
    "x-env: &env",
    "  TZ: \"Europe/Kyiv\"",
    "  DB_POOL_MAX: \"20\"",
    "services:",
    "  api:",
    "    image: poshtomat:1.7.3",
    "    environment:",
    "      <<: *env",
    "      PORT: \"8080\"",
    "  expire:",
    "    image: poshtomat:1.7.3",
    "    restart: \"no\"",
    "    environment:",
    "      - LOG_LEVEL",
    "      - EXPIRE_AFTER_HOURS=72",
    "      - SMS_SENDER=Poshtomat",
    "      - NODE_OPTIONS=--max-old-space-size=192",
    "",
  ].join("\n");
  const bin = "const hours = Number(process.env.EXPIRE_AFTER_HOURS) || 72;\nconst sender = process.env[\"SMS_SENDER\"];\n";
  const result = checkTree({ "deploy/compose.yaml": compose, "app/src/config.js": CONFIG_JS, "app/bin/expire.js": bin });
  assert.equal(result.status, "PASS", result.message);
});

test("C5 FAILs on a list-form typo and does not count a var that only the tests read", () => {
  const compose = [
    "services:",
    "  api:",
    "    image: poshtomat:1.7.3",
    "    environment:",
    "      - DB_POOL_MAXX=20",
    "      - FEATURE_X=1",
    "",
  ].join("\n");
  const testFile = "process.env.FEATURE_X = \"1\";\n";
  const result = checkTree({ "deploy/compose.yaml": compose, "app/src/config.js": CONFIG_JS, "app/test/x.test.js": testFile });
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /api: DB_POOL_MAXX/);
  assert.match(result.message, /api: FEATURE_X/);
});

test("C5 SKIPs when there is no app source to compare against", () => {
  const result = checkTree({ "deploy/compose.yaml": composeWithPool("DB_POOL_MAX") });
  assert.equal(result.status, "SKIP");
});

// The strongest "naive rule would flag it" case: a third-party container's own variables
// (POSTGRES_*) are read by that image, not by our app. Only services built from app/ (or
// running the same image as one) are checked; a typo in the app service is still caught.
test("C5 ignores a third-party service but still checks the app services next to it", () => {
  const ok = checkTree({ "deploy/compose.yaml": composeWithPool("DB_POOL_MAX", { withDb: true }), "app/src/config.js": CONFIG_JS });
  assert.equal(ok.status, "PASS", ok.message);
  // api 4 entries (TZ, LOG_LEVEL, DB_POOL_MAX, PORT) + worker 3; db is not counted
  assert.match(ok.message, /записів environment: 7 у сервісах api, worker \(унікальних назв: 4\); сторонні образи не перевірялись: db/);
  const bad = checkTree({ "deploy/compose.yaml": composeWithPool("DB_POOL_SIZE", { withDb: true }), "app/src/config.js": CONFIG_JS });
  assert.equal(bad.status, "FAIL");
  assert.match(bad.message, /api: DB_POOL_SIZE; worker: DB_POOL_SIZE$/); // worker shares the image of api
  assert.doesNotMatch(bad.message, /POSTGRES/);
});
