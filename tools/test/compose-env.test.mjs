// Tests for rule E1 in tools/check-deploy.mjs: deploy/compose.yaml and app/src/config.js
// name the same environment variables (post-mortem action item 2, docs/postmortem.md).
// The fixtures are the files of the 2026-10-14 incident: config.js and the Dockerfile did
// not change in v1.8.0, only the compose did (incident/changes/v1.8.0.diff).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerfileSource, envReads, mayBeEmpty, NOT_APP, RULES } from "../check-deploy.mjs";

// app/src/config.js of v1.7.3 and v1.8.0
const CONFIG = `export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbUrl: env.DATABASE_URL || "postgres://poshtomat@localhost:5432/poshtomat",
    // sensible default for local dev
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) || 2000,
    smsBaseUrl: env.SMS_BASE_URL || "http://localhost:9001",
    smsToken: env.SMS_TOKEN || "",
    smsRatePerSec: Number(env.SMS_RATE_PER_SEC) || 5,
    courierBaseUrl: env.COURIER_BASE_URL || "http://localhost:9002",
    logLevel: env.LOG_LEVEL || "info",
  };
}
`;

// deploy/Dockerfile of v1.7.3 and v1.8.0
const DOCKERFILE = `FROM node:latest

WORKDIR /app
ENV NODE_ENV=production
ENV SMS_TOKEN=CHANGE_ME

COPY . .

EXPOSE 8080
CMD ["node", "src/server.js"]
`;

const SHARED = {
  LOG_LEVEL: "info",
  DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
  DB_POOL_MAX: "20",
  DB_POOL_WAIT_MS: "2000",
  SMS_BASE_URL: "https://sms.example.net/api/v2",
  SMS_TOKEN: "CHANGE_ME",
  SMS_RATE_PER_SEC: "20",
  COURIER_BASE_URL: "https://courier.example.com/api/v1",
};

// deploy/compose.yaml of v1.7.3 (git show main:deploy/compose.yaml), environment edited by each test
function composeV173({ api = (env) => env, worker = (env) => env } = {}) {
  return {
    services: {
      api: {
        image: "poshtomat:latest",
        build: { context: "../app", dockerfile: "../deploy/Dockerfile" },
        ports: ["8080:8080"],
        environment: api({ TZ: "Europe/Kyiv", PORT: "8080", ...SHARED }),
      },
      worker: {
        image: "poshtomat:latest",
        command: ["node", "src/worker.js"],
        environment: worker({ TZ: "Europe/Kyiv", ...SHARED }),
      },
    },
  };
}

const without = (...names) => (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !names.includes(k)));
const renamed = (from, to) => (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k === from ? to : k, v]));

const roots = [];
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Runs E1 on a repo tree whose app/src/config.js is `config` (null: no such file). */
function e1({ compose, config = CONFIG, dockerfile = DOCKERFILE }) {
  const root = mkdtempSync(join(tmpdir(), "check-e1-"));
  roots.push(root);
  if (config !== null) {
    mkdirSync(join(root, "app", "src"), { recursive: true });
    writeFileSync(join(root, "app", "src", "config.js"), config);
  }
  const rule = RULES.find((r) => r.id === "E1");
  return rule.check({ root, dockerfile: dockerfileSource(dockerfile), compose: { exists: true, data: compose }, workflow: { exists: false } });
}

test("E1: the v1.8.0 compose fails — DB_POOL_SIZE is unknown and DB_POOL_MAX is missing, in both services", () => {
  const rename = renamed("DB_POOL_MAX", "DB_POOL_SIZE");
  const result = e1({ compose: composeV173({ api: rename, worker: rename }) });
  assert.equal(result.status, "FAIL");
  for (const service of ["api", "worker"]) {
    assert.match(result.message, new RegExp(`${service}: not read by app/src/config\\.js: DB_POOL_SIZE`));
    assert.match(result.message, new RegExp(`${service}: missing: DB_POOL_MAX`));
  }
});

test("E1: a removed variable fails too — the v1.7.3 compose without SMS_RATE_PER_SEC in worker", () => {
  const result = e1({ compose: composeV173({ worker: without("SMS_RATE_PER_SEC") }) });
  assert.equal(result.status, "FAIL");
  assert.equal(result.message, "worker: missing: SMS_RATE_PER_SEC");
});

test("E1: the v1.7.3 compose passes — TZ is read by the runtime, worker does not listen on PORT", () => {
  // what a naive rule would trip on: TZ is not in config.js, PORT is not in worker
  assert.ok(!envReads(CONFIG).includes("TZ"));
  assert.ok(envReads(CONFIG).includes("PORT"));
  assert.equal(e1({ compose: composeV173() }).status, "PASS");
});

test("E1: the PORT exemption is for worker only", () => {
  const result = e1({ compose: composeV173({ api: without("PORT") }) });
  assert.equal(result.status, "FAIL");
  assert.equal(result.message, "api: missing: PORT");
});

test("E1: an unknown variable alone fails — a typo added next to the right name", () => {
  const typo = (env) => ({ ...env, SMS_RATE_PER_SECOND: "20" });
  const result = e1({ compose: composeV173({ api: typo }) });
  assert.equal(result.status, "FAIL");
  assert.equal(result.message, "api: not read by app/src/config.js: SMS_RATE_PER_SECOND");
});

test("E1: a variable the image sets with ENV need not be in compose — only ENV that reaches the final stage counts", () => {
  // config.js once action item 1 makes it read NODE_ENV
  const config = CONFIG.replace("    logLevel:", '    production: env.NODE_ENV === "production",\n    logLevel:');
  assert.ok(envReads(config).includes("NODE_ENV"));
  const compose = composeV173();
  assert.equal(e1({ compose, config }).status, "PASS");
  assert.equal(e1({ compose, config, dockerfile: "FROM node:22-alpine\n" }).status, "FAIL");
  // a build stage's ENV stays in that stage; a base stage's ENV is inherited by the stage built FROM it
  assert.equal(e1({ compose, config, dockerfile: "FROM node:22 AS build\nENV NODE_ENV=production\nFROM node:22-alpine\n" }).status, "FAIL");
  assert.equal(e1({ compose, config, dockerfile: "FROM node:22-alpine AS base\nENV NODE_ENV=production\nFROM base\n" }).status, "PASS");
  // the image sets every other variable too: compose may leave them out
  const all = `FROM node:22-alpine\nENV ${Object.keys(SHARED).map((k) => `${k}=x`).join(" ")} PORT=8080 NODE_ENV=production\n`;
  assert.equal(e1({ compose: { services: { worker: { image: "poshtomat:1.8.1" } } }, config, dockerfile: all }).status, "PASS");
});

test("E1: list-form environment and ${VAR:?} references count as set; a bare name does not", () => {
  const list = (env) => Object.entries(env).map(([k, v]) => (k === "SMS_TOKEN" ? "SMS_TOKEN=${SMS_TOKEN:?set SMS_TOKEN}" : `${k}=${v}`));
  assert.equal(e1({ compose: composeV173({ api: list, worker: list }) }).status, "PASS");
  // `- SMS_TOKEN` passes on the shell's value, or nothing when the shell has none
  const passThrough = (env) => [...Object.keys(env).filter((k) => k !== "SMS_TOKEN").map((k) => `${k}=${env[k]}`), "SMS_TOKEN"];
  const result = e1({ compose: composeV173({ worker: passThrough }) });
  assert.equal(result.status, "FAIL");
  assert.equal(result.message, "worker: may be empty: SMS_TOKEN");
});

test("E1: a value that can come out empty fails like a missing one — config.js falls back to its default", () => {
  // DB_POOL_MAX moved to deploy/.env as ${DB_POOL_MAX} and not set on the VM: compose passes a
  // blank string, Number("") || 4 gives the pool of the incident
  assert.equal(Number("") || 4, 4);
  for (const value of ["${DB_POOL_MAX}", "$DB_POOL_MAX", "", "${DB_POOL_MAX:-}", "${DB_POOL_MAX-20}", "${DB_POOL_MAX:-${POOL}}"]) {
    const result = e1({ compose: composeV173({ api: (env) => ({ ...env, DB_POOL_MAX: value }) }) });
    assert.equal(result.status, "FAIL", value);
    assert.equal(result.message, "api: may be empty: DB_POOL_MAX", value);
  }
  // values that cannot come out empty
  for (const value of ["${DB_POOL_MAX:?set DB_POOL_MAX in deploy/.env}", "${DB_POOL_MAX:-20}", 20]) {
    assert.equal(e1({ compose: composeV173({ api: (env) => ({ ...env, DB_POOL_MAX: value }) }) }).status, "PASS", String(value));
  }
  // a runtime variable is held to the same standard: an empty TZ gives UTC timestamps
  assert.equal(e1({ compose: composeV173({ worker: (env) => ({ ...env, TZ: "" }) }) }).message, "worker: may be empty: TZ");
});

test("may be empty: compose interpolation", () => {
  const empty = [null, undefined, "", "  ", "${A}", "$A", "${A-x}", "${A?msg}", "${A:+x}", "${A+x}", "${A:-}", "${A}${B}"];
  const set = ["20", 20, false, "${A:?msg}", "${A:-x}", "x${A}", "$$", "postgres://${HOST}/db"];
  // nested references resolve from the inside out: a default that is only a reference may be empty
  empty.push("${A:-${B}}", "${A:-$B}", "${A:-${B:-}}");
  set.push("${A:-x${B}}", "${A:-${B:-20}}", "${A:-$$}", "${A:?${B}}");
  for (const v of empty) assert.equal(mayBeEmpty(v), true, String(v));
  for (const v of set) assert.equal(mayBeEmpty(v), false, String(v));
});

test("E1: a service that does not run the app is skipped only when NOT_APP names it", () => {
  const withProxy = composeV173();
  withProxy.services.proxy = { image: "nginx:1.27", environment: { NGINX_PORT: "80" } };
  const before = e1({ compose: withProxy });
  assert.equal(before.status, "FAIL");
  assert.match(before.message, /proxy: not read by app\/src\/config\.js: NGINX_PORT; proxy: missing: PORT, /);
  NOT_APP.push("proxy");
  try {
    assert.deepEqual(e1({ compose: withProxy }), {
      status: "PASS",
      message: "api, worker: no unknown, missing or possibly empty variables (app/src/config.js reads 9)",
    });
    // nothing left to compare is not a pass
    assert.equal(e1({ compose: { services: { proxy: withProxy.services.proxy } } }).status, "FAIL");
  } finally {
    NOT_APP.splice(NOT_APP.indexOf("proxy"), 1);
  }
});

test("E1: fails when config.js is missing or reads no variable — nothing to compare is not a pass", () => {
  const compose = composeV173();
  assert.match(e1({ compose, config: null }).message, /app\/src\/config\.js not found/);
  assert.equal(e1({ compose, config: null }).status, "FAIL");
  assert.equal(e1({ compose, config: "export const loadConfig = () => ({});\n" }).status, "FAIL");
  assert.equal(e1({ compose: { services: {} } }).status, "FAIL");
});

test("env reads: env.NAME, env['NAME'] and process.env.NAME, not the env object itself", () => {
  const text = 'f(env = process.env); a = env.A_1; b = env["B"]; c = process.env.C; d = env[name]; e = environment.E;';
  assert.deepEqual(envReads(text).sort(), ["A_1", "B", "C"]);
  assert.deepEqual(envReads(CONFIG).sort(), [
    "COURIER_BASE_URL", "DATABASE_URL", "DB_POOL_MAX", "DB_POOL_WAIT_MS", "LOG_LEVEL",
    "PORT", "SMS_BASE_URL", "SMS_RATE_PER_SEC", "SMS_TOKEN",
  ]);
});
