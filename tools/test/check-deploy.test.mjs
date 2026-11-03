// Tests for tools/check-deploy.mjs. Each rule gets small, generic snippets — one
// that passes and the ways it can fail. Most tests hand the rules already-parsed
// objects; the last ones go through loadContext, the real CLI and the YAML parser.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyYamlFailure,
  dockerfileSource,
  envNamesRead,
  formatReport,
  isSecretLike,
  isSecretReference,
  loadContext,
  parseYaml,
  RULES,
  runChecks,
} from "../check-deploy.mjs";

const CHECKER = fileURLToPath(new URL("../check-deploy.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

function ctx({ dockerfile = null, compose, workflow } = {}) {
  return {
    root: ".",
    dockerfile: dockerfileSource(dockerfile),
    compose: compose === undefined ? { exists: false } : { exists: true, data: compose },
    workflow: workflow === undefined ? { exists: false } : { exists: true, data: workflow },
  };
}

function status(id, context) {
  const rule = RULES.find((r) => r.id === id);
  return rule.check(context).status;
}

const svc = (extra = {}) => ({ image: "example/web:1.4.2", ...extra });
const compose = (...list) => ({ services: Object.fromEntries(list.map((s, i) => [`s${i + 1}`, s])) });
const wf = (extra = {}) => ({ on: { push: { branches: ["main"] } }, permissions: { contents: "read" }, jobs: {}, ...extra });

test("D1: the base image needs an explicit tag that is not latest", () => {
  assert.equal(status("D1", ctx({ dockerfile: "FROM node:22-alpine\n" })), "PASS");
  assert.equal(status("D1", ctx({ dockerfile: "FROM node\n" })), "FAIL");
  assert.equal(status("D1", ctx({ dockerfile: "FROM node:latest\n" })), "FAIL");
  assert.equal(status("D1", ctx({ dockerfile: "FROM node:22 AS build\nRUN true\nFROM build\n" })), "PASS");
  assert.equal(status("D1", ctx({ dockerfile: `FROM --platform=linux/amd64 node@sha256:${"a".repeat(64)}\n` })), "PASS");
  assert.equal(status("D1", ctx({ dockerfile: "ARG NODE_VERSION=22\nFROM node:${NODE_VERSION}-slim\n" })), "PASS");
  assert.equal(status("D1", ctx({ dockerfile: "ARG NODE_VERSION\nFROM node:${NODE_VERSION}\n" })), "FAIL");
  assert.equal(status("D1", ctx({ dockerfile: "FROM example.org:5000/base\n" })), "FAIL"); // a port is not a tag
  assert.equal(status("D1", ctx({})), "FAIL");
});

test("D2: the final stage runs as a non-root USER", () => {
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\nUSER node\nCMD [\"node\"]\n" })), "PASS");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\nUSER 1000:1000\n" })), "PASS");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\n" })), "FAIL");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\nUSER root\n" })), "FAIL");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\nUSER 0:0\n" })), "FAIL");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22 AS b\nUSER node\nFROM node:22\n" })), "FAIL");
});

test("D3: a HEALTHCHECK in the Dockerfile or a healthcheck on every compose service", () => {
  const hc = { test: ["CMD", "true"], interval: "30s" };
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\nHEALTHCHECK --interval=30s CMD true\n" })), "PASS");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc({ healthcheck: hc })) })), "PASS");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc()) })), "FAIL");
  // a one-shot job (no ports, restart: "no") needs no healthcheck; a long-running service still does
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc({ restart: "no" })) })), "PASS");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc({ restart: "no", ports: ["80:80"] })) })), "FAIL");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: { ...hc, disable: true } })) })), "FAIL");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\nHEALTHCHECK NONE\n", compose: compose(svc()) })), "FAIL");
  // test NONE switches the check off just like disable: true
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc({ healthcheck: { test: ["NONE"] } })) })), "FAIL");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: { test: "NONE" } })) })), "FAIL");
  // with a HEALTHCHECK in the image: a service without ports may switch it off, one with ports may not
  const image = "FROM a:1\nHEALTHCHECK CMD node -e \"process.exit(0)\"\n";
  const api = (healthcheck) => svc({ ports: ["8080:8080"], ...(healthcheck ? { healthcheck } : {}) });
  assert.equal(status("D3", ctx({ dockerfile: image, compose: compose(api(), svc({ healthcheck: { disable: true } })) })), "PASS");
  assert.equal(status("D3", ctx({ dockerfile: image, compose: compose(api({ disable: true }), svc()) })), "FAIL");
  assert.equal(status("D3", ctx({ dockerfile: image, compose: compose(api({ test: ["NONE"] })) })), "FAIL");
});

test("D4: no secret-like ENV or ARG with a value baked into the image", () => {
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV NODE_ENV=production PORT=8080\nARG NPM_TOKEN\n" })), "PASS");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV DB_PASSWORD_FILE=/run/secrets/db\n" })), "PASS");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV API_TOKEN=CHANGE_ME\n" })), "FAIL");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV NODE_ENV=production \\\n    SIGNING_KEY=CHANGE_ME\n" })), "FAIL");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV API_KEY CHANGE_ME\n" })), "FAIL"); // legacy form
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nARG DB_PASSWORD=CHANGE_ME\n" })), "FAIL");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV PGPASSWORD=CHANGE_ME\n" })), "FAIL"); // no underscore before PASSWORD
});

test("C1: compose images are pinned", () => {
  assert.equal(status("C1", ctx({ compose: compose(svc(), svc({ image: "registry.example.org/web:${IMAGE_TAG:?set it}" })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: `web@sha256:${"b".repeat(64)}` })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web:latest" })) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web" })) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose({ build: "." }) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web:${TAG:-latest}" })) })), "FAIL");
  assert.equal(status("C1", ctx({})), "FAIL");
  // variables: the :- default is what runs when the variable is not set; :? makes it required
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web:${TAG:-1.4.2}" })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "${IMAGE:-web:1.4.2}" })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "${IMAGE:?set IMAGE}" })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "${IMAGE:-poshtomat}" })) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web:${TAG}" })) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "$IMAGE" })) })), "FAIL");
});

test("C2: every service has a restart policy", () => {
  assert.equal(status("C2", ctx({ compose: compose(svc({ restart: "unless-stopped" }), svc({ restart: "on-failure:3" })) })), "PASS");
  assert.equal(status("C2", ctx({ compose: compose(svc({ deploy: { restart_policy: { condition: "on-failure" } } })) })), "PASS");
  assert.equal(status("C2", ctx({ compose: compose(svc({ restart: "always" }), svc()) })), "FAIL");
  // a one-shot job without ports may say restart: "no"; a service with ports may not
  assert.equal(status("C2", ctx({ compose: compose(svc({ restart: "no" })) })), "PASS");
  assert.equal(status("C2", ctx({ compose: compose(svc({ restart: "no", ports: ["8080:8080"] })) })), "FAIL");
  assert.equal(status("C2", ctx({ compose: compose(svc({ deploy: { restart_policy: { condition: "none" } } })) })), "PASS");
});

test("C3: every service has a memory limit", () => {
  assert.equal(status("C3", ctx({ compose: compose(svc({ mem_limit: "256m" }), svc({ deploy: { resources: { limits: { memory: "128M" } } } })) })), "PASS");
  assert.equal(status("C3", ctx({ compose: compose(svc({ mem_limit: "256m" }), svc()) })), "FAIL");
  assert.equal(status("C3", ctx({ compose: compose(svc({ deploy: { resources: { limits: { cpus: "0.5" } } } })) })), "FAIL");
});

test("C4: secret-like compose variables come only by reference", () => {
  const ok = svc({ environment: { API_TOKEN: "${API_TOKEN}", DB_PASSWORD: "${DB_PASSWORD:?missing}", LOG_LEVEL: "info" } });
  assert.equal(status("C4", ctx({ compose: compose(ok) })), "PASS");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: ["API_TOKEN", "LOG_LEVEL=info"] })) })), "PASS");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: { API_TOKEN: "CHANGE_ME" } })) })), "FAIL");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: ["API_TOKEN=CHANGE_ME"] })) })), "FAIL");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: { API_TOKEN: "${API_TOKEN:-CHANGE_ME}" } })) })), "FAIL");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: { PGPASSWORD: "CHANGE_ME" } })) })), "FAIL");
});

// C5 — post-mortem 2026-10-14, action item #3. Shaped like app/src/config.js.
const CONFIG_JS = [
  "export function loadConfig(env = process.env) {",
  "  return {",
  "    port: Number(env.PORT) || 8080,",
  '    dbUrl: env.DATABASE_URL || "postgres://poshtomat@localhost:5432/poshtomat",',
  "    dbPoolMax: Number(env.DB_POOL_MAX) || 4,",
  '    smsBaseUrl: env["SMS_BASE_URL"] || "http://localhost:9001",',
  '    smsToken: env.SMS_TOKEN || "",',
  "  };",
  "}",
  "",
].join("\n");

function c5(composeData, { text = CONFIG_JS, root = REPO } = {}) {
  const rule = RULES.find((r) => r.id === "C5");
  const appConfig = text === null ? { exists: false } : { exists: true, text };
  return rule.check({ ...ctx({ compose: composeData }), root, appConfig });
}

// how the pipeline passes our image: whole, by digest, from a required variable
const appSvc = (environment, extra = {}) => ({ image: "${IMAGE:?set IMAGE}", restart: "unless-stopped", environment, ...extra });
const DB = { DATABASE_URL: "${DATABASE_URL:?missing}" };

test("C5: the v1.8.0 rename (DB_POOL_MAX → DB_POOL_SIZE in compose only) fails, naming the variable and the services", () => {
  const incident = {
    services: {
      api: appSvc({ ...DB, DB_POOL_SIZE: "20", PORT: "8080" }, { command: ["node", "src/server.js"], ports: ["8080:8080"] }),
      worker: appSvc({ ...DB, DB_POOL_SIZE: "20", SMS_TOKEN: "${SMS_TOKEN:?missing}" }, { command: ["node", "src/worker.js"] }),
    },
  };
  const result = c5(incident);
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /DB_POOL_SIZE \(api, worker\)/);
  assert.doesNotMatch(result.message, /DATABASE_URL|PORT|SMS_TOKEN/); // only the unread name is reported
});

test("C5: a correct config that a naive rule would trip over passes", () => {
  const good = {
    services: {
      // TZ and NODE_EXTRA_CA_CERTS are read by Node itself, not by config.js
      api: appSvc(
        { TZ: "Europe/Kyiv", NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca.pem", ...DB, DB_POOL_MAX: "20", PORT: "8080" },
        { command: ["node", "src/server.js"], ports: ["8080:8080"] },
      ),
      // list form; SMS_TOKEN is a ${…:?} reference (C4 demands it): only the name is checked, never the value;
      // a bare name passes the value through from the shell; env["SMS_BASE_URL"] counts as reading it
      worker: appSvc(["TZ=Europe/Kyiv", "DB_POOL_MAX=20", "SMS_TOKEN=${SMS_TOKEN:?missing}", "SMS_BASE_URL"], { command: "node src/worker.js" }),
      // third-party images in the same compose — one pinned through a variable with a default:
      // their variables are read by the proxy / the database, not by config.js
      proxy: { image: "caddy:2.8.4-alpine", restart: "unless-stopped", ports: ["443:443"], environment: { CADDY_ADMIN: "off", ACME_EMAIL: "ops@example.org" } },
      db: { image: "${PG_IMAGE:-postgres:17.6-bookworm}", restart: "unless-stopped", environment: { POSTGRES_PASSWORD: "${PG_PASSWORD:?missing}" } },
      // a third-party service without environment: has nothing to compare, so it is not named either
      cache: { image: "redis:7.4.1-alpine", restart: "unless-stopped" },
    },
  };
  const result = c5(good);
  assert.equal(result.status, "PASS", result.message);
  assert.match(result.message, /у api, worker —/); // only our services were compared…
  assert.match(result.message, /сторонні образи не звірялися: proxy, db$/); // …and the skipped ones are named, not hidden
});

test("C5: the compose shape at the time of the incident: v1.7.3 passes, v1.8.0 fails", () => {
  // deploy/compose.yaml as on main before Task D: api built from the repo, worker on the same
  // literal image — compared with the real app/src/config.js
  const config = readFileSync(join(REPO, "app", "src", "config.js"), "utf8");
  const env = (pool) => ({
    TZ: "Europe/Kyiv",
    LOG_LEVEL: "info",
    DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
    ...pool,
    DB_POOL_WAIT_MS: "2000",
    SMS_BASE_URL: "https://sms.example.net/api/v2",
    SMS_TOKEN: "CHANGE_ME",
    SMS_RATE_PER_SEC: "20",
    COURIER_BASE_URL: "https://courier.example.com/api/v1",
  });
  const release = (pool) => ({
    services: {
      api: { image: "poshtomat:latest", build: { context: "../app", dockerfile: "../deploy/Dockerfile" }, ports: ["8080:8080"], environment: { ...env(pool), PORT: "8080" } },
      worker: { image: "poshtomat:latest", command: ["node", "src/worker.js"], environment: env(pool) },
    },
  });
  const v173 = c5(release({ DB_POOL_MAX: "20" }), { text: config });
  assert.equal(v173.status, "PASS", v173.message);
  const v180 = c5(release({ DB_POOL_SIZE: "20" }), { text: config });
  assert.equal(v180.status, "FAIL");
  assert.equal(v180.message, "app/src/config.js не читає: DB_POOL_SIZE (api, worker)");
});

test("C5: every service that runs our code is compared, however compose starts it", () => {
  const renamed = { DB_POOL_SIZE: "20" };
  const unread = (...names) => new RegExp(`не читає: DB_POOL_SIZE \\(${names.join(", ")}\\)`);
  const only = (svc) => c5({ services: { svc } });
  // build: alone
  assert.match(only({ build: { context: "../app" }, environment: renamed }).message, unread("svc"));
  // a literal image started with a file of app/ — also behind ./, /app/, sh -c and quotes
  for (const command of [["node", "src/worker.js"], ["node", "./src/worker.js"], ["node", "/app/src/worker.js"], ["sh", "-c", 'exec node "./src/server.js"']]) {
    assert.match(only({ image: "ghcr.io/example/poshtomat:1.9.0", command, environment: renamed }).message, unread("svc"), command.join(" "));
  }
  // an npm script of app/package.json; a script that does not exist there is not ours
  assert.match(only({ image: "ghcr.io/example/poshtomat:1.9.0", command: ["npm", "run", "expire"], environment: renamed }).message, unread("svc"));
  assert.match(only({ image: "ghcr.io/example/poshtomat:1.9.0", command: "npm start", environment: renamed }).message, unread("svc"));
  assert.match(only({ image: "ghcr.io/example/poshtomat:1.9.0", command: ["npm", "--silent", "run", "expire"], environment: renamed }).message, unread("svc"));
  assert.match(only({ image: "example/tool:1.0", command: ["npm", "run", "no-such-script"], environment: renamed }).message, /жоден сервіс/);
  // a .js file that is not in app/ is someone else's program
  assert.match(only({ image: "example/other:2.0", command: ["node", "index.js"], environment: renamed }).message, /жоден сервіс/);
  // the API on the image's default CMD (no command:), pinned by a tag or a tag variable: ours,
  // because it runs the same image as the worker — the rename only in api is still caught
  for (const tag of ["1.9.0", "${TAG:?set TAG}"]) {
    const shared = {
      services: {
        api: { image: `ghcr.io/example/poshtomat:${tag}`, ports: ["8080:8080"], environment: renamed },
        worker: { image: "ghcr.io/example/poshtomat:1.9.0", command: ["node", "src/worker.js"], environment: { DB_POOL_MAX: "20" } },
      },
    };
    assert.match(c5(shared).message, unread("api"), tag);
  }
  // the same image under another spelling: tag + digest vs digest, a registry from a variable,
  // Docker Hub's implicit docker.io/library/
  for (const [api, worker] of [
    ["ghcr.io/example/poshtomat:1.9.0@sha256:aa", "ghcr.io/example/poshtomat@sha256:aa"],
    ["${REGISTRY:?set REGISTRY}/poshtomat:1.9.0", "${REGISTRY:?set REGISTRY}/poshtomat:1.9.1"],
    ["poshtomat:1.9.0", "docker.io/library/poshtomat:1.9.0"],
  ]) {
    const pair = {
      services: {
        api: { image: api, environment: renamed },
        worker: { image: worker, command: ["node", "src/worker.js"], environment: { DB_POOL_MAX: "20" } },
      },
    };
    assert.match(c5(pair).message, unread("api"), api);
  }
  // next to services that are certainly ours (${IMAGE}), a command that merely looks like ours —
  // npm start, src/server.js — on someone else's image does not make that image ours
  const lookalikes = {
    services: {
      api: appSvc({ DB_POOL_MAX: "20" }, { command: ["node", "src/server.js"] }),
      relay: { image: "ghcr.io/other/webhook-relay:2.1.0", command: "npm start", environment: { RELAY_SECRET: "${RELAY_SECRET:?missing}" } },
      mock: { image: "ghcr.io/other/mock-sms:1.0.0", command: ["node", "src/server.js"], environment: { MOCK_DELAY_MS: "50" } },
    },
  };
  const result = c5(lookalikes);
  assert.equal(result.status, "PASS", result.message);
  assert.match(result.message, /у api —.*сторонні образи не звірялися: relay, mock$/);
});

test("C5: what only looks like reading the variable does not count", () => {
  const one = (environment, extra) => ({ services: { api: appSvc(environment, extra) } });
  // the name must match whole: DB_POOL is a substring of env.DB_POOL_MAX, yet nobody reads it
  assert.equal(c5(one({ DB_POOL: "20" })).status, "FAIL");
  assert.equal(c5(one({ DB_POOL_MAXX: "20" })).status, "FAIL"); // a typo
  // a renamed variable left in a comment of config.js is still not read
  const commented = CONFIG_JS.replace("    dbPoolMax:", "    // v1.8.0 tried env.DB_POOL_SIZE here\n    /* env.DB_POOL_SIZE */ dbPoolMax:");
  assert.equal(c5(one({ DB_POOL_SIZE: "20" }), { text: commented }).status, "FAIL");
  assert.equal(c5(one({ DB_POOL_MAX: "20" }), { text: commented }).status, "PASS");
  // …and so is one only mentioned in a string or after `;//`
  const mentioned = CONFIG_JS.replace("  return {", '  log.warn("env.DB_POOL_SIZE was renamed");x();// env.DB_POOL_SIZE\n  return {');
  assert.equal(c5(one({ DB_POOL_SIZE: "20" }), { text: mentioned }).status, "FAIL");
  // a runtime-variable exemption is by whole name too
  assert.equal(c5(one({ TZ_NAME: "Kyiv" })).status, "FAIL");
  // environment: given as a plain string is reported as such, not split into characters
  assert.match(c5(one("DB_POOL_MAX=20")).message, /environment: не словник і не список: api/);
  assert.match(c5(one([{ DB_POOL_MAX: 20 }])).message, /environment: не словник і не список: api/);
  // without config.js, or without any service recognisable as ours, the rule cannot vouch for anything
  assert.equal(c5(one({ DB_POOL_MAX: "20" }), { text: null }).status, "FAIL");
  assert.equal(c5({ services: { proxy: { image: "caddy:2.8.4-alpine", environment: { CADDY_ADMIN: "off" } } } }).status, "FAIL");
});

test("C5: names read from the environment", () => {
  const read = (code) => [...envNamesRead(code)].sort();
  assert.deepEqual(read('const a = env.A; const b = process.env.B;\nconst c = env["C"], d = env[\'D\'];\n// env.E\n/* env.F */ const u = "http://x" || env.G;\n'), ["A", "B", "C", "D", "G"]);
  assert.deepEqual(read("const p = env?.PORT ?? process.env?.['DB_URL'];"), ["DB_URL", "PORT"]);
  assert.deepEqual(read("const { PORT, DB_POOL_MAX: max = 4, ...rest } = process.env;\nfunction f({ LOG_LEVEL } = env) {}"), ["DB_POOL_MAX", "LOG_LEVEL", "PORT"]);
  assert.deepEqual(read("const t = `pool ${env.DB_POOL_MAX} at ${`${env.DATABASE_URL}`}`;"), ["DATABASE_URL", "DB_POOL_MAX"]);
  // strings and comments never count — unless env is indexed by a variable, where the names
  // live in string literals (a helper of action item #1): then whole UPPER_CASE literals count
  assert.deepEqual(read('log("env.A is gone"); const s = "B"; /* env.C */'), []);
  assert.deepEqual(read(String.raw`log("say \"env.A\" twice"); const b = env.B;`), ["B"]); // an escaped quote does not end the string
  const helper = 'const need = (name) => { const v = env[name]; if (!v) throw new Error(`${name} is required`); return v; };\nneed("DB_POOL_MAX"); need(\'SMS_TOKEN\'); log("not a Name");';
  assert.deepEqual(read(helper), ["DB_POOL_MAX", "SMS_TOKEN"]);
  assert.deepEqual(read('const v = process.env[name]; need("DB_POOL_MAX");'), ["DB_POOL_MAX"]);
  // a key in parentheses is the same access
  assert.deepEqual(read('const v = env[(name)] ?? process.env?.[ ( key ) ]; need("DB_POOL_MAX");'), ["DB_POOL_MAX"]);
  assert.deepEqual(read('const v = env[("DB_POOL_MAX")] ?? process.env[ ( "PORT" ) ];'), ["DB_POOL_MAX", "PORT"]);
  // …and so is a key built from parts ("DB_" is a whole UPPER_CASE literal too), while one literal key is not
  assert.deepEqual(read('const v = env["DB_" + name]; need("POOL_MAX");'), ["DB_", "POOL_MAX"]);
  assert.deepEqual(read('const v = env[`${p}_URL`]; need("DB_POOL_MAX");'), ["DB_POOL_MAX"]);
  assert.deepEqual(read('const v = env["PORT"] ?? env[ ( `HOST` ) ]; log("NOT_READ");'), ["HOST", "PORT"]);
  // …but not when someone else's object or a private field is indexed
  assert.deepEqual(read('const v = this.#env[name] ?? settings.env[key]; need("DB_POOL_SIZE");'), []);
  // `env` as a whole word only: myenv.X is someone else's object
  assert.deepEqual(read("const x = myenv.X + envy.Y;"), []);
  // …and so is settings.env.X, while a method called on env reads nothing
  assert.deepEqual(read("const s = settings.env.DB_POOL_SIZE + this.env?.Z; const t = process.env.T.trim();"), ["T"]);
  assert.deepEqual(read("const s = settings . env.DB_POOL_SIZE + cfg\n  .env.Y; const u = process . env.U; function f() { return env.V; }"), ["U", "V"]);
  assert.deepEqual(read('const s = settings.env["DB_POOL_SIZE"] + cfg . env?.["Y"] + settings.process.env["Z"];'), []);
  // …and so is a private field #env
  assert.deepEqual(read('const s = this.#env.DB_POOL_SIZE + this.#env["DB_POOL_MAX"];'), []);
  assert.deepEqual(read('const s = settings.env.hasOwnProperty("A") + this.#env.hasOwnProperty("B");'), []);
  assert.deepEqual(read('const s = process.env.hasOwnProperty("D");'), ["D"]);
  // …but the dots of a spread are no member access
  assert.deepEqual(read("const h = [...env.HOSTS, ... process.env.PEERS, ...settings.env.DB_POOL_SIZE];"), ["HOSTS", "PEERS"]);
  assert.deepEqual(read('const h = [...env["HOSTS"], ...process.env?.["PEERS"], ...settings.env["DB_POOL_SIZE"]];'), ["HOSTS", "PEERS"]);
  // presence checks
  assert.deepEqual(read('if ("A" in env || Object.hasOwn(process.env, "B") || Reflect.has(env, \'C\') || env.hasOwnProperty("D")) {}'), ["A", "B", "C", "D"]);
  // regex literals are skipped: their // is no comment, their quote opens no string…
  assert.deepEqual(read(String.raw`const url = /^https?:\/\//.test(env.SMS_BASE_URL) ? env.SMS_BASE_URL : bad();`), ["SMS_BASE_URL"]);
  assert.deepEqual(read('const q = /["]/; const a = env.A; const m = "env.DB_POOL_SIZE was renamed";'), ["A"]);
  assert.deepEqual(read('const q = /[/"]/g; const b = env.B; const m = "x";'), ["B"]); // a / inside [...] does not end the regex
  assert.deepEqual(read(String.raw`if (x) /https?:\/\//.test(u); const p = env.DB_POOL_MAX;`), ["DB_POOL_MAX"]); // after the ) of a condition
  // …while a / after a value is a division, not a regex
  assert.deepEqual(read("const half = env.X / 2 / (env.Y) / 3;"), ["X", "Y"]);
});

test("C5 on the repo's own files: the current compose passes, the v1.8.0 rename fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-c5-"));
  try {
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "app", "src"), { recursive: true });
    for (const file of ["src/config.js", "package.json"]) writeFileSync(join(dir, "app", file), readFileSync(join(REPO, "app", file), "utf8"));
    const current = readFileSync(join(REPO, "deploy", "compose.yaml"), "utf8");
    const only = RULES.filter((r) => r.id === "C5");

    writeFileSync(join(dir, "deploy", "compose.yaml"), current);
    const context = loadContext(dir);
    const ok = runChecks(context, only)[0];
    assert.equal(ok.status, "PASS", ok.message);

    // the services that set DB_POOL_MAX, from the parsed compose — not a hard-coded list
    const setsPool = ([, svc]) => {
      const env = svc?.environment ?? {};
      return Array.isArray(env) ? env.some((e) => String(e).split("=")[0] === "DB_POOL_MAX") : Object.hasOwn(env, "DB_POOL_MAX");
    };
    const expected = Object.entries(context.compose.data.services).filter(setsPool).map(([name]) => name);
    assert.ok(expected.length, "the current compose must set DB_POOL_MAX somewhere");

    const renamed = current.replace(/\bDB_POOL_MAX(?=\s*[:=])/g, "DB_POOL_SIZE"); // what v1.8.0 did, in map or list form
    writeFileSync(join(dir, "deploy", "compose.yaml"), renamed);
    const broken = runChecks(loadContext(dir), only)[0];
    assert.equal(broken.status, "FAIL");
    assert.match(broken.message, new RegExp(`DB_POOL_SIZE \\(${expected.join(", ")}\\)`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1: the workflow exists, parses, and does not use pull_request_target", () => {
  assert.equal(status("W1", ctx({ workflow: wf() })), "PASS");
  assert.equal(status("W1", ctx({})), "FAIL");
  assert.equal(status("W1", { ...ctx(), workflow: { exists: true, error: "YAMLParseError: bad indent" } }), "FAIL");
  assert.equal(status("W1", ctx({ workflow: { on: "push" } })), "FAIL"); // no jobs
  assert.equal(status("W1", ctx({ workflow: wf({ on: "pull_request_target" }) })), "FAIL");
  assert.equal(status("W1", ctx({ workflow: wf({ on: ["push", "pull_request_target"] }) })), "FAIL");
  assert.equal(status("W1", ctx({ workflow: wf({ on: { pull_request_target: { types: ["opened"] } } }) })), "FAIL");
});

test("W2–W5 are skipped, not failed, while there is no workflow", () => {
  const results = runChecks(ctx({}));
  assert.deepEqual(
    results.filter((r) => r.id.startsWith("W")).map((r) => [r.id, r.status]),
    [["W1", "FAIL"], ["W2", "SKIP"], ["W3", "SKIP"], ["W4", "SKIP"], ["W5", "SKIP"]],
  );
});

test("W2: top-level permissions are set and not write-all", () => {
  assert.equal(status("W2", ctx({ workflow: wf() })), "PASS");
  assert.equal(status("W2", ctx({ workflow: wf({ permissions: "read-all" }) })), "PASS");
  const { permissions, ...noPermissions } = wf();
  assert.equal(status("W2", ctx({ workflow: noPermissions })), "FAIL");
  assert.equal(status("W2", ctx({ workflow: wf({ permissions: "write-all" }) })), "FAIL");
});

test("W3: the deploy job has an environment and needs the tests, directly or through other jobs", () => {
  const unit = { "runs-on": "ubuntu-latest", steps: [{ run: "npm test" }] };
  const ship = (needs) => ({ "runs-on": "ubuntu-latest", environment: "production", needs, steps: [{ run: "./ship.sh" }] });
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: unit, deploy: ship("test") } }) })), "PASS");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { checks: unit, build: { needs: ["checks"] }, release: ship(["build"]) } }) })), "PASS");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: unit, deploy: ship(undefined) } }) })), "FAIL");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { lint: { steps: [{ run: "echo ok" }] }, deploy: ship("lint") } }) })), "FAIL");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: unit, deploy: { needs: "test" } } }) })), "FAIL");
  // a job called test that runs no tests is not a test job; a reusable workflow is judged by its id or path
  const fake = { "runs-on": "ubuntu-latest", steps: [{ run: "echo skipped" }, { run: "echo ok" }] };
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: fake, deploy: ship("test") } }) })), "FAIL");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: { uses: "./.github/workflows/ci.yml" }, deploy: ship("test") } }) })), "PASS");
  // tests run inside a Dockerfile test stage count as tests
  const staged = { "runs-on": "ubuntu-latest", steps: [{ run: "docker build --target test --file deploy/Dockerfile app" }] };
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: staged, deploy: ship("test") } }) })), "PASS");
});

test("W4: secret-like values in the workflow come only from secrets", () => {
  const job = (extra) => ({ jobs: { deploy: { "runs-on": "ubuntu-latest", ...extra } } });
  const good = job({
    permissions: { "id-token": "write", contents: "read" },
    env: { API_TOKEN: "${{ secrets.API_TOKEN }}", GH_TOKEN: "${{ github.token }}" },
    steps: [
      { uses: "actions/cache@v4", with: { key: "npm-${{ hashFiles('**/package.json') }}", "restore-keys": "npm-" } },
      { uses: "docker/login-action@v3", with: { password: "${{ secrets.REGISTRY_PASSWORD || github.token }}" } },
      { uses: "docker/build-push-action@v6", with: { secrets: "npm_token=${{ secrets.NPM_TOKEN }}\n" } },
      { run: 'API_TOKEN="$API_TOKEN" ./ship.sh' },
      {
        uses: "appleboy/ssh-action@v1.2.0",
        with: { key: "${{ secrets.DEPLOY_SSH_KEY }}", script: 'cd /opt/app\nAPI_TOKEN="$API_TOKEN" docker compose up -d\n' },
      },
    ],
  });
  assert.equal(status("W4", ctx({ workflow: wf(good) })), "PASS");
  const reusable = { jobs: { ship: { uses: "example/workflows/.github/workflows/ship.yml@v2", secrets: "inherit" } } };
  assert.equal(status("W4", ctx({ workflow: wf(reusable) })), "PASS");
  assert.equal(status("W4", ctx({ workflow: wf({ env: { API_TOKEN: "CHANGE_ME" } }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ uses: "x/y@v1", with: { password: "CHANGE_ME" } }] })) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ run: "API_TOKEN=CHANGE_ME ./ship.sh" }] })) })), "FAIL");
  const step = (s) => wf(job({ steps: [s] }));
  // ssh deploy actions: the private key and the remote script
  const ssh = (w) => step({ uses: "appleboy/ssh-action@v1.2.0", with: { host: "203.0.113.5", ...w } });
  assert.equal(status("W4", ctx({ workflow: ssh({ key: "CHANGE_ME" }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: ssh({ key: "CHANGE_ME-literal-ssh-key" }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: ssh({ script: "SMS_TOKEN=CHANGE_ME docker compose pull\n" }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: ssh({ script: 'echo "SMS_TOKEN=CHANGE_ME" > .env\ndocker compose up -d\n' }) })), "FAIL");
  // writing .env on the server from a secret via a printf slot is not a literal
  const dotenv = { env: { SMS_TOKEN: "${{ secrets.SMS_TOKEN }}" }, run: "printf \"SMS_TOKEN='%s'\\n\" \"$SMS_TOKEN\" > .env" };
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [dotenv] })) })), "PASS");
  // an obvious dummy value for a CI test step is not a leaked secret; a real-looking literal still fails
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ env: { SMS_TOKEN: "ci-placeholder" }, run: "npm test" }] })) })), "PASS");
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ run: "SMS_TOKEN=dummy npm test" }] })) })), "PASS");
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ env: { SMS_TOKEN: "k3y-9f2a7c" }, run: "npm test" }] })) })), "FAIL");
  // `key` is a cache key only on actions/cache
  assert.equal(status("W4", ctx({ workflow: step({ uses: "actions/cache/restore@v4", with: { key: "npm-1", "restore-keys": "npm-" } }) })), "PASS");
  assert.equal(status("W4", ctx({ workflow: step({ uses: "x/y@v1", with: { key: "npm-1" } }) })), "FAIL");
  // expressions: only secrets / github.token, and no literal next to them
  assert.equal(status("W4", ctx({ workflow: step({ uses: "x/y@v1", with: { password: "${{ secrets.P || 'CHANGE_ME' }}" } }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: step({ uses: "x/y@v1", with: { password: "${{ env.P }}" } }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: step({ uses: "x/y@v1", with: { secrets: "npm_token=CHANGE_ME\nother=${{ secrets.O }}\n" } }) })), "FAIL");
});

test("secret references: secrets.* and github.token only, nothing literal beside them", () => {
  for (const v of ["${{ secrets.A }}", "${{secrets.A}}", "${{ github.token }}", "${{ secrets.A || github.token }}", "a=${{ secrets.A }}\nb=${{ secrets.B }}\n"]) {
    assert.ok(isSecretReference(v), v);
  }
  for (const v of ["CHANGE_ME", "${{ vars.A }}", "${{ secrets.A || 'x' }}", "a=${{ secrets.A }}\nb=CHANGE_ME\n", ""]) assert.ok(!isSecretReference(v), v);
});

test("W5: every uses: is pinned to a version tag or a full SHA", () => {
  const steps = (...uses) => ({ jobs: { build: { steps: uses.map((u) => ({ uses: u })) } } });
  assert.equal(status("W5", ctx({ workflow: wf(steps("actions/checkout@v4", `actions/setup-node@${"c".repeat(40)}`, "./.github/actions/local", "docker://alpine:3.20")) })), "PASS");
  assert.equal(status("W5", ctx({ workflow: wf(steps("actions/checkout@main")) })), "FAIL");
  assert.equal(status("W5", ctx({ workflow: wf(steps("actions/checkout")) })), "FAIL");
  assert.equal(status("W5", ctx({ workflow: wf({ jobs: { reuse: { uses: "example/workflows/.github/workflows/ship.yml@master" } } }) })), "FAIL");
});

test("secret-like names", () => {
  const positives = ["SMS_TOKEN", "DB_PASSWORD", "API_KEY", "client-secret", "APIKEY", "GITHUB_TOKEN", "PGPASSWORD", "DBPASSWORD", "key", "ssh-key", "passphrase"];
  for (const name of positives) assert.ok(isSecretLike(name), name);
  for (const name of ["DB_PASSWORD_FILE", "KEYCLOAK_URL", "CACHE_KEY", "LOG_LEVEL", "IMAGE_TAG", "MONKEY"]) assert.ok(!isSecretLike(name), name);
});

test("npx failures are told apart from YAML errors", () => {
  const npm = (code, extra = "") => ({ status: 1, stderr: `npm error code ${code}\n${extra}npm error A complete log of this run can be found in: x.log\n` });
  assert.deepEqual(classifyYamlFailure(npm("ENOTCACHED", "npm error request to https://registry.npmjs.org/yaml failed: cache mode is 'only-if-cached'\n")), { toolError: "npm error code ENOTCACHED" });
  assert.deepEqual(classifyYamlFailure(npm("ECONNREFUSED", "npm error FetchError: request to https://registry.npmjs.org/yaml failed, reason: connect ECONNREFUSED 127.0.0.1:9\n")), { toolError: "npm error code ECONNREFUSED" });
  assert.ok(classifyYamlFailure({ code: "ETIMEDOUT", signal: "SIGTERM", stderr: "" }).toolError);
  assert.ok(classifyYamlFailure({ status: 1, stderr: "'npx' is not recognized as an internal or external command,\n" }).toolError);
  // the parser ran: a YAML error, even if the student's text quoted in the code frame says "npm error"
  const parsed = classifyYamlFailure({ status: 1, stderr: "file:///x/bin.mjs:10\n\nYAMLParseError: Map keys must be unique at line 3, column 1:\n\nnpm error code X\n^\n" });
  assert.match(parsed.error, /^YAMLParseError/);
  assert.equal(parsed.toolError, undefined);
  assert.deepEqual(classifyYamlFailure({ status: 3, stderr: "Error: Input stream contains multiple documents\n" }), { error: "Error: Input stream contains multiple documents" });
});

test("when npx cannot run, the YAML rules say so instead of blaming the files", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-tool-"));
  try {
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "pipeline"));
    writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM example/base:2.1\nUSER app\nCMD [\"run\"]\n");
    writeFileSync(join(dir, "deploy", "compose.yaml"), "services:\n  web:\n    image: example/web:1.0.0\n");
    writeFileSync(join(dir, "pipeline", "deploy.yml"), "on: push\njobs: {}\n");
    let calls = 0;
    const offline = () => {
      calls += 1;
      return { toolError: "npm error code ENOTCACHED" };
    };
    const results = runChecks(loadContext(dir, { parse: offline }));
    assert.equal(calls, 1, "after the first failure npx is not tried again");
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    for (const id of ["D3", "C1", "C2", "C3", "C4", "C5", "W1"]) {
      assert.equal(by[id].status, "FAIL", id);
      assert.equal(by[id].toolError, true, id);
      assert.match(by[id].message, /не вдалося запустити npx yaml@2\.8\.1 — перший запуск потребує мережі \(npm error code ENOTCACHED\)/, id);
    }
    for (const id of ["W2", "W3", "W4", "W5"]) assert.equal(by[id].status, "SKIP", id);
    assert.equal(by.D1.status, "PASS");
    const report = formatReport(results);
    assert.ok(!/підказка:/.test(report), "no rule hints when the rules could not run");
    assert.match(report, /УВАГА: npx yaml@2\.8\.1 не запустився/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the YAML parser: workflow keys stay strings, broken YAML is an error, merge keys work", () => {
  assert.deepEqual(parseYaml("on:\n  push: {}\njobs: {}\n").data, { on: { push: {} }, jobs: {} });
  assert.match(parseYaml("a: [1, 2\nb: c\n").error, /YAML/);
  assert.match(parseYaml("a: 1\na: 2\n").error, /unique|YAML/);
  assert.deepEqual(parseYaml("x: &d {restart: always}\ns:\n  <<: *d\n  image: w:1\n").data.s, { restart: "always", image: "w:1" });
});

test("the CLI prints a row per rule, survives broken YAML and exits 1 on failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-"));
  try {
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "pipeline"));
    writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM example/base:2.1\nUSER app\nCMD [\"run\"]\n");
    writeFileSync(
      join(dir, "deploy", "compose.yaml"),
      [
        "x-defaults: &defaults",
        "  restart: unless-stopped",
        "  mem_limit: 128m",
        "services:",
        "  web:",
        "    <<: *defaults",
        "    image: example/web:1.0.0",
        "    environment:",
        "      API_TOKEN: ${API_TOKEN:?missing}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "pipeline", "deploy.yml"), "on: [push\njobs:\n  a: {}\n");

    let code = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [CHECKER, "--root", dir], { encoding: "utf8" });
    } catch (err) {
      code = err.status;
      out = err.stdout;
    }
    assert.equal(code, 1);
    const rows = Object.fromEntries(out.split("\n").filter((l) => /^[DCW]\d /.test(l)).map((l) => [l.slice(0, 2), l.slice(4, 8)]));
    assert.deepEqual(rows, {
      D1: "PASS", D2: "PASS", D3: "FAIL", D4: "PASS",
      C1: "PASS", C2: "PASS", C3: "PASS", C4: "PASS",
      C5: "FAIL", // the temp tree has no app/src/config.js to compare compose with
      W1: "FAIL", W2: "SKIP", W3: "SKIP", W4: "SKIP", W5: "SKIP",
    });
    assert.match(out, /W1 +FAIL .*не розібрався як YAML/);
    assert.match(out, /підказка:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
