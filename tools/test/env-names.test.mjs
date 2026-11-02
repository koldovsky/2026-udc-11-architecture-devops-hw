// Tests for rule E1 (tools/check-deploy.mjs): every variable in compose environment:
// must be one the application actually reads. Action item from docs/postmortem.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvNames, RULES } from "../check-deploy.mjs";

// the same shape as app/src/config.js
const CONFIG = `export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) || 2000,
    smsToken: env["SMS_TOKEN"] || "",
  };
}
`;

const E1 = RULES.find((r) => r.id === "E1");

function withRepo(config, fn) {
  const root = mkdtempSync(join(tmpdir(), "check-e1-"));
  try {
    if (config !== null) {
      mkdirSync(join(root, "app", "src"), { recursive: true });
      writeFileSync(join(root, "app", "src", "config.js"), config);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const check = (root, environment) =>
  E1.check({ root, compose: { exists: true, data: { services: { api: { image: "poshtomat:1.8.0", environment } } } } });

test("E1: appEnvNames finds env.NAME and env[\"NAME\"]", () => {
  assert.deepEqual([...appEnvNames(CONFIG)].sort(), ["DB_POOL_MAX", "DB_POOL_WAIT_MS", "PORT", "SMS_TOKEN"]);
});

test("E1: the v1.8.0 incident — DB_POOL_SIZE in compose, DB_POOL_MAX in config — FAILS", () => {
  withRepo(CONFIG, (root) => {
    const r = check(root, { PORT: "8080", DB_POOL_SIZE: "20", DB_POOL_WAIT_MS: "2000" });
    assert.equal(r.status, "FAIL");
    assert.match(r.message, /api: DB_POOL_SIZE/);
    assert.doesNotMatch(r.message, /DB_POOL_WAIT_MS|PORT/);
  });
});

test("E1: the list form of environment: is checked too", () => {
  withRepo(CONFIG, (root) => {
    assert.equal(check(root, ["DB_POOL_SIZE=20"]).status, "FAIL");
    assert.equal(check(root, ["DB_POOL_MAX=20"]).status, "PASS");
  });
});

test("E1: a correct compose PASSES — including what a naive rule would flag", () => {
  withRepo(CONFIG, (root) => {
    const r = check(root, {
      DB_POOL_MAX: "20",
      SMS_TOKEN: "${SMS_TOKEN:?set SMS_TOKEN}", // read through env["…"], value is a reference
      TZ: "Europe/Kyiv", // read by Node/ICU, not by config.js
      NODE_ENV: "production",
    });
    assert.equal(r.status, "PASS", r.message);
  });
});

test("E1: SKIP when there is no app config to compare with", () => {
  withRepo(null, (root) => {
    assert.equal(check(root, { ANYTHING: "1" }).status, "SKIP");
  });
});
