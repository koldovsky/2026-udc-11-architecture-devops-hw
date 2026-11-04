// Tests for rule P1 (docs/postmortem.md, action item #1): every environment variable that
// compose or the Dockerfile sets must be one the app actually reads. Each test builds a
// small app/ tree on disk, because the rule reads the app code from ctx.root.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvNames, dockerfileSource, RULES } from "../check-deploy.mjs";

// the same shape as app/src/config.js
const CONFIG = `export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbUrl: env.DATABASE_URL || "postgres://poshtomat@localhost:5432/poshtomat",
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) || 2000,
    smsToken: env.SMS_TOKEN || "",
  };
}
`;

function withApp(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "check-deploy-p1-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function p1(root, { compose, dockerfile = null }) {
  const rule = RULES.find((r) => r.id === "P1");
  return rule.check({ root, dockerfile: dockerfileSource(dockerfile), compose: { exists: true, data: compose } });
}

const svc = (environment) => ({ image: "example/web:1.0.0", environment });

test("P1: the 2026-10-14 incident — DB_POOL_SIZE in compose, the app reads DB_POOL_MAX → FAIL", () => {
  withApp({ "app/src/config.js": CONFIG }, (root) => {
    const result = p1(root, {
      compose: {
        services: {
          api: svc({ DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat", DB_POOL_SIZE: "20", DB_POOL_WAIT_MS: "2000" }),
          worker: svc({ DB_POOL_SIZE: "20" }),
        },
      },
    });
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /api: DB_POOL_SIZE — код її не читає \(є DB_POOL_MAX, DB_POOL_WAIT_MS\)/);
    assert.match(result.message, /worker: DB_POOL_SIZE/);
  });
});

test("P1: a correct config a naive rule would reject → PASS", () => {
  withApp({ "app/src/config.js": CONFIG }, (root) => {
    // TZ and NODE_ENV are not in config.js but are read by Node itself; list-form environment,
    // ${VAR:?} references and a variable read only outside config.js are all fine
    const result = p1(root, {
      dockerfile: "FROM node:22-slim\nENV NODE_ENV=production TZ=Europe/Kyiv\nUSER node\n",
      compose: {
        services: {
          api: svc({ TZ: "Europe/Kyiv", PORT: "8080", DB_POOL_MAX: "20", SMS_TOKEN: "${SMS_TOKEN:?required}" }),
          worker: svc(["DB_POOL_MAX=4", "DB_POOL_WAIT_MS=2000", "DATABASE_URL"]),
        },
      },
    });
    assert.equal(result.status, "PASS", result.message);
  });
});

test("P1: a name read anywhere in app/src or app/bin counts, tests do not", () => {
  withApp(
    {
      "app/src/config.js": CONFIG,
      "app/bin/job.js": 'const batch = Number(process.env["EXPIRE_BATCH"]) || 100;\n',
      "app/test/config.test.js": "loadConfig({ ONLY_IN_TESTS: '1' }); process.env.ONLY_IN_TESTS;\n",
    },
    (root) => {
      const names = appEnvNames(root);
      assert.ok(names.has("EXPIRE_BATCH"));
      assert.ok(!names.has("ONLY_IN_TESTS"));
      assert.equal(p1(root, { compose: { services: { job: svc({ EXPIRE_BATCH: "50" }) } } }).status, "PASS");
      assert.equal(p1(root, { compose: { services: { job: svc({ ONLY_IN_TESTS: "1" }) } } }).status, "FAIL");
    },
  );
});

test("P1: an unknown ENV baked into the Dockerfile fails too, with its line", () => {
  withApp({ "app/src/config.js": CONFIG }, (root) => {
    const result = p1(root, { dockerfile: "FROM node:22-slim\nENV DB_POOL_SIZE=20\n", compose: { services: { api: svc({ DB_POOL_MAX: "20" }) } } });
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /deploy\/Dockerfile:2: DB_POOL_SIZE/);
  });
});

test("P1: without app code there is nothing to compare → SKIP; a broken compose still fails", () => {
  withApp({ "README.md": "no app here\n" }, (root) => {
    assert.equal(p1(root, { compose: { services: { api: svc({ X: "1" }) } } }).status, "SKIP");
  });
  withApp({ "app/src/config.js": CONFIG }, (root) => {
    assert.equal(p1(root, { compose: { services: {} } }).status, "FAIL");
  });
});
