// Tests for rule K1 (tools/check-deploy.mjs): every environment variable that compose
// hands to a service is read by app/src/config.js. Born from the incident of 2026-10-14:
// DB_POOL_MAX was renamed to DB_POOL_SIZE in compose, config.js kept reading the old name
// and silently fell back to a pool of 4.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configEnvNames, dockerfileSource, loadContext, parseYaml, RULES } from "../check-deploy.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const K1 = RULES.find((r) => r.id === "K1");

// config.js as it was at the time of the incident (the lines that matter)
const CONFIG = `
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) || 2000,
    smsBaseUrl: env.SMS_BASE_URL || "http://localhost:9001",
    smsToken: env.SMS_TOKEN || "",
  };
}
`;

function check(composeEnv, { config = CONFIG, serviceCount = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "check-k1-"));
  try {
    if (config !== null) {
      mkdirSync(join(root, "app", "src"), { recursive: true });
      writeFileSync(join(root, "app", "src", "config.js"), config);
    }
    const services = {};
    for (let i = 1; i <= serviceCount; i += 1) services[`s${i}`] = { image: "example/web:1.0.0", environment: composeEnv };
    return K1.check({
      root,
      dockerfile: dockerfileSource(null),
      compose: { exists: true, data: { services } },
      workflow: { exists: false },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("K1 FAIL: the incident — compose renamed DB_POOL_MAX to DB_POOL_SIZE, config.js still reads the old name", () => {
  const result = check({ PORT: "8080", DB_POOL_SIZE: "20", DB_POOL_WAIT_MS: "2000" });
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /s1: DB_POOL_SIZE — config\.js її не читає/);
  assert.doesNotMatch(result.message, /DB_POOL_WAIT_MS/, "only the variable nobody reads is named");
});

test("K1 PASS: TZ is consumed by the runtime, not config.js — a naive 'every key must be in config.js' would fail here", () => {
  const result = check({ TZ: "Europe/Kyiv", NODE_OPTIONS: "--max-old-space-size=200", PORT: "8080", DB_POOL_MAX: "20", SMS_TOKEN: "${SMS_TOKEN:?required}" });
  assert.equal(result.status, "PASS");
});

test("K1 PASS: the list form of environment (NAME=value) is understood", () => {
  const list = ["TZ=Europe/Kyiv", "DB_POOL_MAX=20", "SMS_BASE_URL=https://sms.example.net/api/v2"];
  assert.equal(check(list).status, "PASS");
  const wrong = check(["DB_POOL_SIZE=20"]);
  assert.equal(wrong.status, "FAIL");
  assert.match(wrong.message, /DB_POOL_SIZE/);
});

test("K1 FAIL: a name that only appears in a comment of config.js is not 'read'", () => {
  const config = `${CONFIG}\n// DB_POOL_SIZE was the old name\n/* env.COURIER_BASE_URL is planned */\n`;
  assert.equal(check({ DB_POOL_SIZE: "20" }, { config }).status, "FAIL");
  assert.equal(check({ COURIER_BASE_URL: "https://courier.example.com/api/v1" }, { config }).status, "FAIL");
});

test("K1 PASS: a // inside a URL default does not hide the variables that come after it", () => {
  // naive comment stripping would cut the line at "http://" and lose SMS_TOKEN
  assert.equal(check({ SMS_BASE_URL: "x", SMS_TOKEN: "${SMS_TOKEN:?x}" }).status, "PASS");
});

test("K1: process.env.NAME and env['NAME'] count as reads", () => {
  const config = `const a = process.env.A_ONE;\nconst b = env["B_TWO"];\nconst c = env . C_THREE;\n`;
  assert.deepEqual([...configEnvNames(config)].sort(), ["A_ONE", "B_TWO", "C_THREE"]);
  assert.equal(check({ A_ONE: "1", B_TWO: "2", C_THREE: "3" }, { config }).status, "PASS");
});

test("K1 reports every service that has an unread variable", () => {
  const result = check({ DB_POOL_SIZE: "20" }, { serviceCount: 2 });
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /s1: DB_POOL_SIZE.*s2: DB_POOL_SIZE/);
});

test("K1: a service with no environment, or config.js missing, are handled", () => {
  assert.equal(check(undefined).status, "PASS");
  const missing = check({ PORT: "8080" }, { config: null });
  assert.equal(missing.status, "FAIL");
  assert.match(missing.message, /app\/src\/config\.js не знайдено/);
});

test("K1 on this repo: the real compose.yaml and the real config.js agree", () => {
  const results = RULES.filter((r) => r.id === "K1").map((r) => r.check(loadContext(REPO, { parse: parseYaml })));
  assert.equal(results[0].status, "PASS", results[0].message);
});
