// Tests for rule E1: every environment variable an app service gets is one the app reads.
// Each case builds a tiny tree (app/src + app/package.json) in a temp dir, because the
// rule compares compose against the app's code.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvNames, RULES } from "../check-deploy.mjs";

const CONFIG = `export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) || 2000,
    smsToken: env["SMS_TOKEN"] || "",
  };
}
`;

function withApp(fn, { config = CONFIG } = {}) {
  const root = mkdtempSync(join(tmpdir(), "check-deploy-e1-"));
  try {
    if (config !== null) {
      mkdirSync(join(root, "app", "src"), { recursive: true });
      writeFileSync(join(root, "app", "src", "config.js"), config);
      writeFileSync(join(root, "app", "package.json"), JSON.stringify({ name: "poshtomat", version: "1.8.0" }));
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function e1(root, services) {
  const rule = RULES.find((r) => r.id === "E1");
  return rule.check({ root, compose: { exists: true, data: { services } } });
}

test("E1: the 2026-10-14 incident — DB_POOL_SIZE instead of DB_POOL_MAX — fails and names the right variable", () => {
  withApp((root) => {
    const env = { DB_POOL_SIZE: "20", DB_POOL_WAIT_MS: "2000", PORT: "8080", TZ: "Europe/Kyiv" };
    const result = e1(root, {
      api: { image: "poshtomat:1.8.0", build: { context: "../app" }, environment: env },
      worker: { image: "poshtomat:1.8.0", environment: env },
    });
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /api: DB_POOL_SIZE .*можливо, DB_POOL_MAX/);
    assert.match(result.message, /worker: DB_POOL_SIZE/);
  });
});

test("E1: a correct config that a naive rule would trip over passes", () => {
  withApp((root) => {
    const result = e1(root, {
      // runtime variables nobody reads in app/ (TZ, NODE_ENV), a secret by reference,
      // the list form of environment:, an image from a registry with a variable tag
      api: {
        image: "ghcr.io/example/poshtomat:${IMAGE_TAG:?set IMAGE_TAG}",
        environment: ["TZ=Europe/Kyiv", "NODE_ENV=production", "DB_POOL_MAX=20", "SMS_TOKEN=${SMS_TOKEN:?}"],
      },
      // fewer variables than the app reads is fine: the rule is about wrong names, not missing ones
      worker: { image: "ghcr.io/example/poshtomat:${IMAGE_TAG:?set IMAGE_TAG}", environment: { PORT: "8080" } },
      // not the app: its variables are read by someone else
      db: { image: "postgres:16.4", environment: { POSTGRES_PASSWORD: "${PG_PASSWORD:?}" } },
    });
    assert.equal(result.status, "PASS", result.message);
  });
});

test("E1: a service is the app's when its command runs a file of app/, even if the image is one opaque variable", () => {
  withApp((root) => {
    writeFileSync(join(root, "app", "src", "worker.js"), "// worker\n");
    const result = e1(root, {
      worker: { image: "${POSHTOMAT_IMAGE:?}", command: ["node", "src/worker.js"], environment: { DB_POOL_SIZE: "20" } },
      // a command that names no file of app/ does not make a service the app's
      proxy: { image: "${PROXY_IMAGE:?}", command: ["node", "proxy.js"], environment: { UPSTREAM: "api:8080" } },
    });
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /^worker: DB_POOL_SIZE/);
    assert.doesNotMatch(result.message, /proxy/);
  });
});

test("E1: a typo in a list-form environment fails too", () => {
  withApp((root) => {
    const result = e1(root, { api: { build: "../app", environment: ["DB_POOL_MAXX=20"] } });
    assert.equal(result.status, "FAIL");
  });
});

test("E1: skips without app code or without app services", () => {
  withApp((root) => assert.equal(e1(root, { api: { image: "x:1", environment: { A: "1" } } }).status, "SKIP"), { config: null });
  withApp((root) => assert.equal(e1(root, { cache: { image: "redis:7.4", environment: { A: "1" } } }).status, "SKIP"));
});

test("appEnvNames: reads env.NAME and env[\"NAME\"]", () => {
  withApp((root) => {
    assert.deepEqual([...appEnvNames(root)].sort(), ["DB_POOL_MAX", "DB_POOL_WAIT_MS", "PORT", "SMS_TOKEN"]);
  });
});
