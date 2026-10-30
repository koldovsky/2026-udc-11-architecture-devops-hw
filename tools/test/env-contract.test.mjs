// Tests for rule E1: compose environment vs the names app/src/config.js reads.
// Incident 14.10.2026: v1.8.0 renamed DB_POOL_MAX to DB_POOL_SIZE in compose only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "../check-deploy.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const E1 = RULES.find((r) => r.id === "E1");

const ctx = (root, services) => ({ root, compose: { exists: true, data: { services } } });

/** Runs `fn(root)` against a temporary tree whose app/src/config.js is `config` (none when null). */
function withConfig(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), "env-contract-"));
  try {
    if (config !== null) {
      mkdirSync(join(dir, "app", "src"), { recursive: true });
      writeFileSync(join(dir, "app", "src", "config.js"), config);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// incident/changes/v1.8.0.diff, the "+" side
const V180 = {
  api: {
    image: "poshtomat:latest",
    environment: {
      COURIER_BASE_URL: "https://courier.example.com/api/v1",
      DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
      DB_POOL_SIZE: "20",
      DB_POOL_WAIT_MS: "2000",
      LOG_LEVEL: "info",
      PORT: "8080",
      SMS_BASE_URL: "https://sms.example.net/api/v2",
      SMS_RATE_PER_SEC: "20",
      SMS_TOKEN: "CHANGE_ME",
      TZ: "Europe/Kyiv",
    },
  },
  worker: {
    image: "poshtomat:latest",
    command: ["node", "src/worker.js"],
    environment: {
      COURIER_BASE_URL: "https://courier.example.com/api/v1",
      DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
      DB_POOL_SIZE: "20",
      DB_POOL_WAIT_MS: "2000",
      LOG_LEVEL: "info",
      SMS_BASE_URL: "https://sms.example.net/api/v2",
      SMS_RATE_PER_SEC: "20",
      SMS_TOKEN: "CHANGE_ME",
      TZ: "Europe/Kyiv",
    },
  },
};

// the same diff, the "-" side: v1.7.3, before the release
const V173 = {
  api: {
    image: "poshtomat:latest",
    environment: {
      TZ: "Europe/Kyiv",
      PORT: "8080",
      LOG_LEVEL: "info",
      DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
      DB_POOL_MAX: "20",
      DB_POOL_WAIT_MS: "2000",
      SMS_BASE_URL: "https://sms.example.net/api/v2",
      SMS_TOKEN: "CHANGE_ME",
      SMS_RATE_PER_SEC: "20",
      COURIER_BASE_URL: "https://courier.example.com/api/v1",
    },
  },
  worker: {
    image: "poshtomat:latest",
    command: ["node", "src/worker.js"],
    environment: {
      TZ: "Europe/Kyiv",
      LOG_LEVEL: "info",
      DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
      DB_POOL_MAX: "20",
      DB_POOL_WAIT_MS: "2000",
      SMS_BASE_URL: "https://sms.example.net/api/v2",
      SMS_TOKEN: "CHANGE_ME",
      SMS_RATE_PER_SEC: "20",
      COURIER_BASE_URL: "https://courier.example.com/api/v1",
    },
  },
};

test("E1: the v1.8.0 rename (DB_POOL_MAX → DB_POOL_SIZE) fails against the real config.js", () => {
  const result = E1.check(ctx(REPO, V180));
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /api: DB_POOL_SIZE — app\/src\/config\.js його не читає/);
  assert.match(result.message, /worker: немає DB_POOL_MAX/);
});

test("E1: v1.7.3 passes — TZ is set in compose but read by the runtime, not config.js", () => {
  assert.equal(E1.check(ctx(REPO, V173)).status, "PASS");
});

test("E1: DB_POOL_MAX simply removed, no unknown names → FAIL", () => {
  const { DB_POOL_MAX, ...rest } = V173.api.environment;
  const result = E1.check(ctx(REPO, { api: { environment: rest } }));
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /api: немає DB_POOL_MAX — застосунок тихо візьме дефолт/);
  assert.doesNotMatch(result.message, /не читає/);
});

test("E1: a substring of a read name does not count", () => {
  withConfig("export const c = (env) => Number(env.DB_POOL_MAX) || 4;\n", (root) => {
    const result = E1.check(ctx(root, { api: { environment: { DB_POOL: "20", DB_POOL_MAX: "20" } } }));
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /api: DB_POOL — /);
  });
});

test("E1: a read that survives only in a comment does not count (rename in code, not in compose)", () => {
  const renamed = [
    "// was env.DB_POOL_MAX before the rename\nexport const c = (env) => Number(env.DB_POOL_SIZE) || 4;\n",
    "/* env.DB_POOL_MAX */ export const c = (env) => Number(env.DB_POOL_SIZE) || 4;\n",
  ];
  for (const config of renamed) {
    withConfig(config, (root) => {
      const result = E1.check(ctx(root, { api: { environment: { DB_POOL_MAX: "20" } } }));
      assert.equal(result.status, "FAIL", config);
      assert.match(result.message, /api: DB_POOL_MAX — /);
    });
  }
  // `//` inside a string is not a comment: the read after it on the same line still counts
  withConfig('export const c = (env) => ["http://localhost", env.DB_POOL_MAX];\n', (root) => {
    assert.equal(E1.check(ctx(root, { api: { environment: { DB_POOL_MAX: "20" } } })).status, "PASS");
  });
});

test("E1: a name inside a string literal is not a read; ${…} in a template literal is", () => {
  const set = { api: { environment: { DB_POOL_MAX: "20", DB_POOL_SIZE: "20" } } };
  const quoted = [
    'export const c = (env) => [env.DB_POOL_MAX, "env.DB_POOL_SIZE"];\n',
    "export const c = (env) => [env.DB_POOL_MAX, 'set env.DB_POOL_SIZE \\' first'];\n",
    "export const c = (env) => [env.DB_POOL_MAX, `env.DB_POOL_SIZE ${1}`];\n",
  ];
  for (const config of quoted) {
    withConfig(config, (root) => {
      const result = E1.check(ctx(root, set));
      assert.equal(result.status, "FAIL", config);
      assert.match(result.message, /api: DB_POOL_SIZE — /);
    });
  }
  withConfig("export const c = (env) => `${env.DB_POOL_MAX}/${ { n: env.DB_POOL_SIZE }.n }`;\n", (root) => {
    assert.equal(E1.check(ctx(root, set)).status, "PASS");
  });
});

test("E1: list-form environment and ${VAR:?…} references pass; an unknown bare NAME fails", () => {
  withConfig("export const c = (env) => [env.DB_POOL_MAX, env.SMS_TOKEN, env.LOG_LEVEL];\n", (root) => {
    const services = {
      api: { environment: ["DB_POOL_MAX=20", "SMS_TOKEN=${SMS_TOKEN:?set SMS_TOKEN}", "LOG_LEVEL", "TZ=Europe/Kyiv"] },
    };
    assert.equal(E1.check(ctx(root, services)).status, "PASS");
    // a bare NAME in list form still counts as set by compose
    const unknown = { api: { environment: ["DB_POOL_MAX=20", "DB_POOL_SIZE"] } };
    assert.equal(E1.check(ctx(root, unknown)).status, "FAIL");
  });
});

test("E1: DB_POOL_MAX must be a positive integer or a required ${…:?} reference", () => {
  const pool = (value) => E1.check(ctx(REPO, { api: { environment: { ...V173.api.environment, DB_POOL_MAX: value } } }));
  for (const value of ["", "${DB_POOL_MAX}", "20 conns"]) {
    const result = pool(value);
    assert.equal(result.status, "FAIL", JSON.stringify(value));
    assert.ok(result.message.includes(`DB_POOL_MAX="${value}"`), result.message);
    assert.doesNotMatch(result.message, /немає DB_POOL_MAX/);
  }
  for (const value of [20, "20", "${DB_POOL_MAX:?set it}"]) assert.equal(pool(value).status, "PASS", JSON.stringify(value));
  // a bare name in list form takes whatever the shell has, possibly nothing
  const bare = E1.check(ctx(REPO, { api: { environment: ["DB_POOL_MAX", "LOG_LEVEL=info"] } }));
  assert.equal(bare.status, "FAIL");
  assert.match(bare.message, /api: DB_POOL_MAX без значення/);
});

test("E1: no app/src/config.js → FAIL", () => {
  withConfig(null, (root) => {
    const result = E1.check(ctx(root, V173));
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /app\/src\/config\.js не знайдено/);
  });
});
