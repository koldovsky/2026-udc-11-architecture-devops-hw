// Tests for rule C5: every `environment:` variable in deploy/compose.yaml must be one
// the application actually reads (env.<NAME> in app/src/config.js) or a runtime
// variable (TZ, NODE_ENV, …). The rule exists because release v1.8.0 renamed
// DB_POOL_MAX → DB_POOL_SIZE in compose, the app silently fell back to a pool of 4,
// and the API answered 503 for 45 minutes (incident 2026-10-14, see docs/rca.md).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULES } from "../check-deploy.mjs";

const rule = RULES.find((r) => r.id === "C5");

/** A throwaway tree with the given app/src/config.js source; cb gets its root. */
function withConfig(source, cb) {
  const dir = mkdtempSync(join(tmpdir(), "check-config-vars-"));
  try {
    mkdirSync(join(dir, "app", "src"), { recursive: true });
    if (source !== null) writeFileSync(join(dir, "app", "src", "config.js"), source);
    return cb(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// the shape of the real config.js: explicit env.<NAME> reads with defaults
const CONFIG = `export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) || 2000,
    smsToken: env.SMS_TOKEN || "",
    logLevel: env.LOG_LEVEL || "info",
  };
}
`;

const ctx = (root, composeData) => ({ root, compose: { exists: true, data: composeData } });
const compose = (environment) => ({ services: { api: { image: "poshtomat:1.8.0", environment } } });

test("C5 FAIL: the incident — compose renames DB_POOL_MAX to DB_POOL_SIZE, which the app never reads", () => {
  withConfig(CONFIG, (root) => {
    const result = rule.check(ctx(root, compose({ DB_POOL_SIZE: "20", DB_POOL_WAIT_MS: "2000", LOG_LEVEL: "${LOG_LEVEL:?}" })));
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /api: DB_POOL_SIZE/);
    // the correctly named variables are not flagged, whatever their value syntax
    assert.ok(!/DB_POOL_WAIT_MS|LOG_LEVEL/.test(result.message));
  });
});

test("C5 PASS: a correct config that a naive rule would reject — TZ is read by the runtime, not by config.js", () => {
  withConfig(CONFIG, (root) => {
    const result = rule.check(
      ctx(root, compose({ TZ: "Europe/Kyiv", NODE_ENV: "production", PORT: "8080", DB_POOL_MAX: "20", LOG_LEVEL: "info" })),
    );
    assert.equal(result.status, "PASS", result.message);
  });
});

test("C5 checks every service and both environment syntaxes (map and list)", () => {
  withConfig(CONFIG, (root) => {
    const data = {
      services: {
        api: { image: "poshtomat:1.8.0", environment: { DB_POOL_MAX: "20" } },
        worker: { image: "poshtomat:1.8.0", environment: ["LOG_LEVEL", "DB_POOL_SIZZE=20"] },
      },
    };
    const result = rule.check(ctx(root, data));
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /worker: DB_POOL_SIZZE/);
    assert.ok(!/api:/.test(result.message), "the healthy service is not flagged");
  });
});

test("C5 SKIP when there is no app/src/config.js to compare against", () => {
  withConfig(null, (root) => {
    assert.equal(rule.check(ctx(root, compose({ ANYTHING: "1" }))).status, "SKIP");
  });
});

test("C5 FAIL when compose itself is missing or empty, like the other compose rules", () => {
  withConfig(CONFIG, (root) => {
    assert.equal(rule.check({ root, compose: { exists: false } }).status, "FAIL");
    assert.equal(rule.check(ctx(root, {})).status, "FAIL");
  });
});

test("C5 PASS: a service without environment: has nothing to check", () => {
  withConfig(CONFIG, (root) => {
    assert.equal(rule.check(ctx(root, { services: { api: { image: "poshtomat:1.8.0" } } })).status, "PASS");
  });
});
