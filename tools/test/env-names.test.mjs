// Tests for rule E1 (tools/check-deploy.mjs): every environment variable of the app's
// compose services must be one that app/src/config.js reads.
// Origin: incident 2026-10-14 — v1.8.0 renamed DB_POOL_MAX → DB_POOL_SIZE in compose,
// config.js kept reading DB_POOL_MAX and silently used a pool of 4 (docs/rca.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configEnvNames, dockerfileSource, parseYaml, RULES } from "../check-deploy.mjs";

// the real config of the service, so the test follows the code if it changes
const REAL_CONFIG = readFileSync(new URL("../../app/src/config.js", import.meta.url), "utf8");
const E1 = RULES.find((r) => r.id === "E1");

const ctx = (compose, appConfig = REAL_CONFIG) => ({
  root: ".",
  appConfig,
  dockerfile: dockerfileSource(null),
  compose: { exists: true, data: compose },
  workflow: { exists: false },
});
const run = (compose, appConfig) => E1.check(ctx(compose, appConfig));

// the app's two services, built from one image, as in deploy/compose.yaml
const app = (env, workerEnv = env) => ({
  services: {
    api: { image: "poshtomat:1.8.0", build: { context: "../app" }, environment: env },
    worker: { image: "poshtomat:1.8.0", command: ["node", "src/worker.js"], environment: workerEnv },
  },
});

test("E1 reads the variable names from app/src/config.js", () => {
  const names = configEnvNames(REAL_CONFIG);
  assert.ok(names.has("DB_POOL_MAX"));
  assert.ok(names.has("SMS_TOKEN"));
  assert.ok(!names.has("DB_POOL_SIZE"));
  assert.deepEqual([...configEnvNames('const a = env["X_Y"]; env.Z;')].sort(), ["X_Y", "Z"]);
});

test("E1 FAIL: the 2026-10-14 compose — DB_POOL_SIZE, which the code does not read", () => {
  // environment of v1.8.0, taken from incident/changes/v1.8.0.diff
  const v180 = {
    COURIER_BASE_URL: "https://courier.example.com/api/v1",
    DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
    DB_POOL_SIZE: "20",
    DB_POOL_WAIT_MS: "2000",
    LOG_LEVEL: "info",
    PORT: "8080",
    SMS_BASE_URL: "https://sms.example.net/api/v2",
    SMS_RATE_PER_SEC: "20",
    SMS_TOKEN: "${SMS_TOKEN:?missing}",
    TZ: "Europe/Kyiv",
  };
  const result = run(app(v180));
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /api: DB_POOL_SIZE/);
  assert.match(result.message, /worker: DB_POOL_SIZE/);
});

test("E1 FAIL: a typo in the list form of environment: is caught too", () => {
  assert.equal(run(app(["DB_POOL_MAX=20", "SMS_RATE_PERSEC=8"])).status, "FAIL");
});

test("E1 FAIL: the same rename hidden behind a YAML anchor and merge key", () => {
  const yaml = [
    "x-env: &env",
    "  DB_POOL_SIZE: '20'",
    "  TZ: Europe/Kyiv",
    "services:",
    "  api:",
    "    image: poshtomat:1.8.0",
    "    build: ../app",
    "    environment:",
    "      <<: *env",
    "      PORT: '8080'",
    "",
  ].join("\n");
  const parsed = parseYaml(yaml);
  assert.ok(parsed.data, parsed.error ?? parsed.toolError);
  assert.equal(run(parsed.data).status, "FAIL");
});

test("E1 PASS: a correct config a naive rule would reject", () => {
  // - TZ and NODE_ENV are read by Node/the OS, not by config.js;
  // - list form with KEY=value and a bare KEY (value from the host's environment);
  // - a third-party postgres sidecar has its own variables (POSTGRES_PASSWORD), not ours;
  // - the merge-key form of deploy/compose.yaml.
  const compose = app(
    { TZ: "Europe/Kyiv", NODE_ENV: "production", PORT: "8080", DB_POOL_MAX: "20", SMS_TOKEN: "${SMS_TOKEN:?missing}" },
    ["TZ=Europe/Kyiv", "DB_POOL_MAX=20", "SMS_TOKEN", "SMS_RATE_PER_SEC=8"],
  );
  compose.services.db = { image: "postgres:16-alpine", environment: { POSTGRES_PASSWORD: "${PG_PASSWORD:?missing}" } };
  assert.equal(run(compose).status, "PASS");
});

test("E1 PASS on the repo's deploy/compose.yaml", () => {
  const parsed = parseYaml(readFileSync(new URL("../../deploy/compose.yaml", import.meta.url), "utf8"));
  assert.ok(parsed.data, parsed.error ?? parsed.toolError);
  assert.equal(run(parsed.data).status, "PASS");
});

test("E1 SKIP when there is no app/src/config.js to compare with", () => {
  assert.equal(run(app({ DB_POOL_MAX: "20" }), null).status, "SKIP");
});

