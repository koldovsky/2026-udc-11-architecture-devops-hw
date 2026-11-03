#!/usr/bin/env node
// Deterministic checks for the deploy configuration (Task D).
//
//   npm run check:deploy                 checks this repo
//   node tools/check-deploy.mjs --root <dir>   checks another tree with the same layout
//
// Files: deploy/Dockerfile, deploy/compose.yaml, pipeline/deploy.yml; C5 also reads
// app/src/config.js and app/package.json (which compose services run the app's code).
// Output: one row per rule (PASS / FAIL / SKIP) and a hint under every FAIL.
// Exit code 1 when any rule fails.
//
// Adding a rule: append { id, title, hint, check(ctx) } to RULES. `check` returns
// pass(message) / fail(message) / skip(message). `ctx` holds the parsed files and
// `ctx.root`, so a rule can read any other file of the repo too.
// Cover the new rule in tools/test/check-deploy.test.mjs or in a new
// tools/test/<name>.test.mjs (npm run test:tools runs only tools/test/*.test.mjs).

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PATHS = {
  dockerfile: "deploy/Dockerfile",
  compose: "deploy/compose.yaml",
  workflow: "pipeline/deploy.yml",
  appConfig: "app/src/config.js", // C5: the code that reads the environment
};

// ---------------------------------------------------------------- parsing

export const YAML_TOOL = "npx yaml@2.8.1";

/**
 * YAML → plain JS via the `yaml` package's CLI (no npm install in this repo).
 * The first run downloads yaml@2.8.1 through npx; later runs use the npm cache.
 * Returns { data } | { error } (the text is not valid YAML) | { toolError } (npx/npm
 * itself could not run — says nothing about the file).
 */
export function parseYaml(text) {
  try {
    const out = execSync("npx --yes yaml@2.8.1 --json --single --strict --merge", {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 60_000,
    });
    return { data: JSON.parse(out.trim()) };
  } catch (err) {
    return classifyYamlFailure(err);
  }
}

/** Why did `npx yaml` fail: the YAML (→ { error }) or npx/npm itself (→ { toolError })? */
export function classifyYamlFailure(err) {
  const stderr = String(err?.stderr ?? "");
  const lines = stderr.split(/\r?\n/);
  // 1. the parser ran and rejected the text — whatever else stderr says
  const yamlLine = lines.find((l) => /YAML\w*Error/.test(l));
  if (yamlLine) return { error: yamlLine.trim() };
  // 2. npx/npm never got as far as parsing
  if (err?.code === "ETIMEDOUT") return { toolError: "npx не відповів за 60 с" };
  if (err?.code === "ENOENT" || /is not recognized as an internal|command not found|npx: not found/.test(stderr)) {
    return { toolError: "команду npx не знайдено (потрібен Node.js 22+ разом з npm)" };
  }
  if (/^npm (error|ERR!)/m.test(stderr)) {
    const code = /^npm (?:error|ERR!) code (\S+)/m.exec(stderr)?.[1];
    const first = lines.find((l) => /^npm (error|ERR!)\s*\S/.test(l))?.trim();
    return { toolError: code ? `npm error code ${code}` : first };
  }
  // 3. anything else: report it as the file's problem, as before
  const line = lines.find((l) => /^Error:/.test(l)) ?? lines.find((l) => l.trim()) ?? String(err?.message ?? err ?? "unknown error");
  return { error: line.trim() };
}

function tokenize(args) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const ch of args) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

const unquote = (s) => s.replace(/^(["'])(.*)\1$/s, "$2");

/** Dockerfile → [{ instruction, args, line }], line continuations joined, comments dropped. */
export function parseDockerfile(text) {
  const out = [];
  let buf = "";
  let start = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*#/.test(line) || (!buf && !line.trim())) return;
    if (!buf) start = i + 1;
    if (line.endsWith("\\")) {
      buf += `${line.slice(0, -1)} `;
      return;
    }
    buf += line;
    const m = /^\s*([A-Za-z]+)\s*([\s\S]*)$/.exec(buf);
    if (m) out.push({ instruction: m[1].toUpperCase(), args: m[2].trim(), line: start });
    buf = "";
  });
  if (buf.trim()) {
    const m = /^\s*([A-Za-z]+)\s*([\s\S]*)$/.exec(buf);
    if (m) out.push({ instruction: m[1].toUpperCase(), args: m[2].trim(), line: start });
  }
  return out;
}

/** `ENV A=1 B="2 3"`, legacy `ENV KEY some value`, `ARG NAME[=default]` → [[key, value|null]]. */
export function keyValues(instruction, args) {
  const tokens = tokenize(args);
  if (instruction === "ENV" && tokens.length && !tokens[0].includes("=")) {
    return [[tokens[0], args.slice(args.indexOf(tokens[0]) + tokens[0].length).trim()]];
  }
  return tokens.map((t) => {
    const i = t.indexOf("=");
    return i === -1 ? [t, null] : [t.slice(0, i), unquote(t.slice(i + 1))];
  });
}

export function parseImageRef(ref) {
  const [beforeDigest, digest = null] = String(ref).split("@");
  const slash = beforeDigest.lastIndexOf("/");
  const colon = beforeDigest.lastIndexOf(":");
  const tag = colon > slash ? beforeDigest.slice(colon + 1) : null;
  return { name: tag === null ? beforeDigest : beforeDigest.slice(0, colon), tag, digest };
}

/**
 * Is this the name of something that should only ever arrive as a secret?
 * A part (between _ or -) that ends in TOKEN / SECRET / PASSWORD / PASSWD / PASSPHRASE /
 * APIKEY (PGPASSWORD, DBPASSWORD) or is KEY as a whole (API_KEY, SSH_KEY, plain `key`).
 * The `key` of an actions/cache step is a cache key — W4 exempts it there.
 */
export function isSecretLike(name) {
  const upper = String(name).toUpperCase().replace(/-/g, "_");
  if (/_FILES?$/.test(upper)) return false; // a path to a mounted secret, not the secret itself
  if (upper.includes("CACHE")) return false; // cache keys
  return upper
    .split("_")
    .some((part) => /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY)S?$/.test(part) || /^(API|SSH|PRIVATE|ACCESS)?KEYS?$/.test(part));
}

// ---------------------------------------------------------------- context

export function dockerfileSource(text, path = PATHS.dockerfile) {
  if (text === null || text === undefined) return { path, exists: false, instructions: [] };
  return { path, exists: true, text, instructions: parseDockerfile(text) };
}

export function textFile(root, rel) {
  const full = join(root, rel);
  return existsSync(full) ? { path: rel, exists: true, text: readFileSync(full, "utf8") } : { path: rel, exists: false };
}

function readYamlFile(root, rel, parse) {
  const full = join(root, rel);
  if (!existsSync(full)) return { path: rel, exists: false };
  const parsed = parse(readFileSync(full, "utf8"));
  return { path: rel, exists: true, ...parsed };
}

export function loadContext(root, { parse = parseYaml } = {}) {
  const dockerPath = join(root, PATHS.dockerfile);
  // once npx has failed, do not wait for it again on the next file
  let toolError = null;
  const guarded = (text) => {
    if (toolError) return { toolError };
    const result = parse(text);
    if (result.toolError) toolError = result.toolError;
    return result;
  };
  return {
    root,
    dockerfile: dockerfileSource(existsSync(dockerPath) ? readFileSync(dockerPath, "utf8") : null),
    compose: readYamlFile(root, PATHS.compose, guarded),
    workflow: readYamlFile(root, PATHS.workflow, guarded),
    appConfig: textFile(root, PATHS.appConfig),
  };
}

// ---------------------------------------------------------------- helpers for rules

export const pass = (message) => ({ status: "PASS", message });
export const fail = (message) => ({ status: "FAIL", message });
export const skip = (message) => ({ status: "SKIP", message });

export const TOOL_HINT =
  "Це не помилка у ваших файлах: їх не вдалося навіть розібрати. Перший запуск check:deploy один раз завантажує yaml@2.8.1 через npx (потрібна мережа), далі перевірка працює офлайн з npm-кешу. Під'єднайтеся до мережі (або перевірте proxy / registry у npm config) і запустіть ще раз.";

/** A rule that could not run because npx could not: FAIL, but without the rule's hint. */
const toolFail = (source, prefix = "") => ({
  status: "FAIL",
  message: `${prefix}не вдалося запустити ${YAML_TOOL} — перший запуск потребує мережі (${source.toolError})`,
  toolError: true,
});

function stages(dockerfile) {
  const result = [];
  for (const ins of dockerfile.instructions) {
    if (ins.instruction === "FROM") result.push({ from: ins, body: [] });
    else if (result.length) result.at(-1).body.push(ins);
  }
  return result;
}

function globalArgs(dockerfile) {
  const args = {};
  for (const ins of dockerfile.instructions) {
    if (ins.instruction === "FROM") break;
    if (ins.instruction === "ARG") for (const [k, v] of keyValues("ARG", ins.args)) args[k] = v;
  }
  return args;
}

function substitute(value, vars) {
  return value.replace(/\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g, (whole, a, def, b) => {
    const name = a ?? b;
    if (vars[name] !== undefined && vars[name] !== null) return vars[name];
    return def !== undefined ? def : whole;
  });
}

function services(compose) {
  const s = compose.data?.services;
  return s && typeof s === "object" && !Array.isArray(s) ? Object.entries(s) : [];
}

/** null when compose is usable, otherwise the FAIL result for a rule that needs it. */
function composeProblem(compose, prefix = "") {
  if (!compose.exists) return fail(`${prefix}${PATHS.compose} не знайдено`);
  if (compose.toolError) return toolFail(compose, prefix);
  if (compose.error) return fail(`${prefix}${PATHS.compose} не розібрався як YAML: ${compose.error}`);
  if (!services(compose).length) return fail(`${prefix}${PATHS.compose}: немає жодного сервісу в services:`);
  return null;
}

function envEntries(environment) {
  if (!environment) return [];
  if (Array.isArray(environment)) {
    return environment.map((item) => {
      const s = String(item);
      const i = s.indexOf("=");
      return i === -1 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
    });
  }
  return Object.entries(environment);
}

/** `${VAR}`, `${VAR:?msg}`, `$VAR` — a value that comes from outside the file. */
function isComposeReference(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*(:?\?[^}]*)?\}$/.test(value) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function workflowJobs(workflow) {
  const jobs = workflow.data?.jobs;
  return jobs && typeof jobs === "object" && !Array.isArray(jobs) ? jobs : null;
}

function workflowUnavailable(workflow) {
  return !workflow.exists || workflow.error || workflow.toolError || !workflowJobs(workflow);
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// tests may also run inside a Dockerfile stage: docker build --target test
const TEST_COMMAND = /\b(?:npm|pnpm|yarn|bun)\b.*\btest\b|\bnode\s+--test\b|\bdocker\s+(?:buildx\s+)?build\b.*--target[ =]test\b/;

/** A job that actually runs the tests; a reusable workflow's steps are not visible, so its id or path decides. */
function isTestJob(id, job) {
  if (typeof job?.uses === "string") return /test/i.test(id) || /test/i.test(job.uses);
  return asList(job?.steps).some((step) => typeof step?.run === "string" && TEST_COMMAND.test(step.run));
}

// `permissions:` maps hold scopes (`id-token: write`), not values — never inspected.
// `parents` is the chain of objects/arrays above the key, nearest last.
function walk(node, path, visit, parents = []) {
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`, visit, [...parents, node]));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "permissions") continue;
      const p = path ? `${path}.${k}` : k;
      visit(k, v, p, [...parents, node]);
      walk(v, p, visit, [...parents, node]);
    }
  }
}

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const SECRET_OPERAND = /^(secrets\.[A-Za-z_][A-Za-z0-9_]*|github\.token)$/;
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
const PLACEHOLDER = "\u0000"; // stands in for an already-vetted ${{ … }}
// A value filled in from elsewhere: $VAR / ${VAR}, a vetted ${{ … }}, or a printf format slot
// (%s), as in printf "TOKEN=%s" "$TOKEN" when a deploy step writes .env on the server.
const fromOutside = (rhs) => /^["']?\$/.test(rhs) || /^["']?%[-+ 0#]*\d*[sdqb]/.test(rhs) || rhs.replace(/^["']/, "").startsWith(PLACEHOLDER);
// An obvious dummy value (a CI test job needs some value): not a leaked secret.
// (CHANGE_ME is NOT exempt: the seeded configs and the tests use it as the stand-in for a real secret.)
const DUMMY_VALUE = /placeholder|dummy|^(?:ci|test|fake|example)(?:[-_.][\w.-]*)?$/i;
const isDummy = (value) => DUMMY_VALUE.test(String(value).replace(/^["']|["']$/g, ""));

/** Names assigned a literal (NAME=literal) in a shell-ish text, among those `select` keeps. */
function literalAssignments(text, select = () => true) {
  return [...String(text).matchAll(ASSIGNMENT)].filter((m) => select(m[1]) && !fromOutside(m[2]) && !isDummy(m[2])).map((m) => m[1]);
}

/**
 * A value that can only come from secrets: it has at least one ${{ … }}, every one of
 * them uses only secrets.NAME / github.token (`||`, `&&` and parentheses allowed), and
 * no NAME= in it is followed by a literal (multi-line `secrets:` of build actions).
 */
export function isSecretReference(value) {
  const text = String(value);
  const expressions = [...text.matchAll(EXPRESSION)];
  if (!expressions.length) return false;
  for (const [, inner] of expressions) {
    const operands = inner.split(/\|\||&&|[()]/).map((o) => o.trim()).filter(Boolean);
    if (!operands.length || !operands.every((o) => SECRET_OPERAND.test(o))) return false;
  }
  return literalAssignments(text.replace(EXPRESSION, PLACEHOLDER)).length === 0;
}

// keys under `with:` that hold a shell script (appleboy/ssh-action and friends)
const SCRIPT_KEYS = new Set(["run", "script", "command", "commands", "args"]);
const isCacheStep = (step) => typeof step?.uses === "string" && /^actions\/cache(\/|@)/.test(step.uses);

function usesPinned(uses) {
  if (uses.startsWith("./")) return true;
  if (uses.startsWith("docker://")) {
    const ref = parseImageRef(uses.slice("docker://".length));
    return Boolean(ref.digest) || (ref.tag !== null && ref.tag !== "latest");
  }
  const at = uses.lastIndexOf("@");
  if (at === -1) return false;
  const ref = uses.slice(at + 1);
  return /^[0-9a-f]{40}$/i.test(ref) || /^v?\d+(\.\d+){0,2}$/.test(ref);
}

const REQUIRED = "__REQUIRED__"; // ${VAR:?…}: compose refuses to start without it
const UNSET = "__UNSET__"; // ${VAR} / $VAR: may well be empty

/** Why a compose image reference is not pinned, or null. Variables: a :- default is used, :? counts as set. */
export function imageProblem(image) {
  const resolved = image.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*)|(:?\?)[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, name, dash, def, required) => (dash ? def : required ? REQUIRED : UNSET),
  );
  const ref = parseImageRef(resolved);
  if (ref.digest) return null;
  const viaVar = resolved !== image;
  if (ref.tag === null) {
    if (ref.name.endsWith(REQUIRED)) return null; // the whole reference, tag included, comes from a required variable
    if (ref.name.endsWith(UNSET)) return "змінна без :? — якщо її не задано, образ буде без тегу";
    return viaVar ? "за замовчуванням без тегу" : "без тегу";
  }
  if (ref.tag.includes(REQUIRED)) return null;
  if (ref.tag.includes(UNSET)) return "тег зі змінної без :? і без значення за замовчуванням";
  if (ref.tag === "latest") return viaVar ? "за замовчуванням latest" : "тег latest";
  return null;
}

// A string literal's place in scanJs().code: \u0001<index into strings>\u0001.
const LITERAL = /\u0001(\d+)\u0001/;

/**
 * A `/` starts a regex literal (not a division) at the start, after an operator, an opening bracket,
 * a keyword or the `)` that closes the condition of an if, while or for.
 */
function regexCanStart(code) {
  const before = code.trimEnd();
  if (before.endsWith(")")) return closesCondition(before);
  return before === "" || /(?:[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await))$/.test(before.slice(-12));
}

/** `code` ends with `)`: does it close the condition of an if, while or for? In `(a + b) / 2` it does not. */
function closesCondition(code) {
  let depth = 0;
  for (let i = code.length - 1; i >= 0; i -= 1) {
    if (code[i] === ")") depth += 1;
    else if (code[i] === "(" && (depth -= 1) === 0) return /\b(?:if|while|for)\s*$/.test(code.slice(0, i));
  }
  return false;
}

/**
 * A small JS scanner for C5: comments and regex literals dropped, every string literal moved
 * out of the code into `strings` (its place marked by LITERAL), the expressions of template
 * literals kept as code. So `// env.OLD`, "http://…", /^https?:\/\// and log("env.X …") are
 * not mistaken for reads, and a quote inside a regex does not derail the strings after it.
 */
function scanJs(source) {
  const s = String(source);
  const strings = [];
  const templates = []; // brace depth at each open `${`
  let code = "";
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i += 1;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      code += " ";
    } else if (c === "/" && regexCanStart(code)) {
      let j = i + 1;
      let inClass = false; // a `/` inside [...] does not end the regex
      while (j < s.length && s[j] !== "\n" && (inClass || s[j] !== "/")) {
        if (s[j] === "\\") j += 1;
        else if (s[j] === "[") inClass = true;
        else if (s[j] === "]") inClass = false;
        j += 1;
      }
      j += 1;
      while (j < s.length && /[A-Za-z]/.test(s[j])) j += 1; // flags
      code += "/r/";
      i = j;
    } else if (c === '"' || c === "'" || c === "`" || (c === "}" && templates.at(-1) === depth)) {
      if (c === "}") templates.pop();
      const quote = c === "}" ? "`" : c;
      let j = i + 1;
      let text = "";
      while (j < s.length && s[j] !== quote && !(quote === "`" && s[j] === "$" && s[j + 1] === "{")) {
        text += s[j] === "\\" ? (s[(j += 1)] ?? "") : s[j];
        j += 1;
      }
      code += `\u0001${strings.push(text) - 1}\u0001`;
      if (quote === "`" && s[j] === "$") {
        templates.push(depth);
        i = j + 2;
      } else i = j + 1;
    } else {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      code += c;
      i += 1;
    }
  }
  return { code, strings };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names the code reads from the environment (`env` or `process.env`):
 *   env.NAME, env?.NAME, env["NAME"], const { NAME, OTHER: x = 1 } = env,
 *   "NAME" in env, Object.hasOwn(env, "NAME"), Reflect.has(env, "NAME"), env.hasOwnProperty("NAME");
 * and, when the code also indexes env with a variable or an expression (a helper like
 * need("NAME")), every string literal that is a whole UPPER_CASE name.
 */
export function envNamesRead(source) {
  const { code, strings } = scanJs(source);
  const literal = (token) => strings[Number(LITERAL.exec(token)?.[1])] ?? token;
  const names = new Set();
  const ENV = String.raw`(?:process\s*\.\s*)?env\b`;
  const STR = "(\u0001\\d+\u0001)";
  // env.NAME / process.env.NAME only: not settings.env.NAME or settings . env.NAME (someone else's object), not
  // this.#env.NAME (a private field), not env.method(); the last dot of a spread (...env.NAME) is no member access.
  // The same for env["NAME"] and env.hasOwnProperty("NAME") below.
  for (const m of code.matchAll(/(?<![\w$#])(?<!(?<!\.)\.\s*)(?:process\s*\.\s*)?env\s*(?:\?\.|\.)\s*([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_]|\s*\()/g)) names.add(m[1]);
  for (const re of [
    new RegExp(String.raw`(?<![\w$#])(?<!(?<!\.)\.\s*)(?:process\s*\.\s*)?env\s*(?:\?\.)?\[[\s(]*${STR}[\s)]*\]`, "g"),
    new RegExp(String.raw`${STR}\s+in\s+${ENV}`, "g"),
    new RegExp(String.raw`\b(?:Object\s*\.\s*hasOwn|Reflect\s*\.\s*has)\s*\(\s*${ENV}\s*,\s*${STR}`, "g"),
    new RegExp(String.raw`(?<![\w$#])(?<!(?<!\.)\.\s*)(?:process\s*\.\s*)?env\s*\.\s*hasOwnProperty\s*\(\s*${STR}`, "g"),
  ]) {
    for (const m of code.matchAll(re)) if (ENV_NAME.test(literal(m[1]))) names.add(literal(m[1]));
  }
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\s*\.\s*)?env\b/g)) {
    for (const part of m[1].split(",")) {
      const key = literal(part.split(/[:=]/)[0].trim());
      if (!key.startsWith("...") && ENV_NAME.test(key)) names.add(key);
    }
  }
  // env indexed by anything but one string literal: env[name], env[(name)], env["DB_" + name], env[`${p}_URL`];
  // env / process.env only, as above: not settings.env[name] or this.#env[name]
  if (/(?<![\w$#])(?<!(?<!\.)\.\s*)(?:process\s*\.\s*)?env\s*(?:\?\.)?\[(?![\s(]*\u0001\d+\u0001[\s)]*\])/.test(code)) {
    for (const text of strings) if (/^[A-Z][A-Z0-9_]*$/.test(text)) names.add(text);
  }
  names.delete("");
  return names;
}

// Read by the Node runtime / libuv itself, or by convention (NODE_ENV) — not by config.js.
export const RUNTIME_ENV = new Set(["TZ", "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "UV_THREADPOOL_SIZE"]);

// The whole image from a variable without a default — how the pipeline passes the release
// image (${IMAGE:?…}). With a :- default it is a pinned third-party image, not a release.
const RELEASE_IMAGE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::?\?[^}]*)?\})$/;
/**
 * The image without tag or digest, so that every tag of one image compares equal:
 * `repo:${TAG:?…}` and `${REGISTRY:?…}/repo:1.9` too (the tag is cut at the first colon after
 * the last /), and Docker Hub's implicit `docker.io/library/` is dropped.
 */
function imageName(image) {
  const s = String(image);
  if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\})$/.test(s)) return s; // the whole reference from one variable
  const ref = s.split("@")[0];
  const colon = ref.indexOf(":", ref.lastIndexOf("/") + 1);
  return (colon === -1 ? ref : ref.slice(0, colon)).replace(/^(?:(?:index\.)?docker\.io\/)?(?:library\/)?/, "");
}

function appScripts(root) {
  try {
    return JSON.parse(readFileSync(join(root, "app", "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/** Does this command start the app's code: a file of app/, or an npm script of app/package.json? */
function startsAppCode(svc, root, scripts) {
  const words = [...asList(svc?.entrypoint), ...asList(svc?.command)]
    .flatMap((w) => String(w).split(/\s+/))
    .map((w) => w.replace(/^["']+|["';]+$/g, ""))
    .filter(Boolean);
  const appFile = (w) => /\.[cm]?js$/.test(w) && existsSync(join(root, "app", w.replace(/^(?:\.\/|\/app\/)/, "")));
  if (words.some(appFile)) return true;
  const npm = words.indexOf("npm");
  if (npm === -1) return false;
  const [verb, script] = words.slice(npm + 1).filter((w) => !w.startsWith("-"));
  return Object.hasOwn(scripts, ["run", "run-script"].includes(verb) ? script : verb);
}

/**
 * Which compose services run the code from app/. Certainly ours: built from the repo (build:)
 * or given the release image from a variable. Only when there is no such service does a
 * command decide — a file or npm script of app/ — because `npm start` or `src/server.js` on
 * someone else's image proves nothing. Then also every service on the same image (same name,
 * any tag) — e.g. the API on the image's default CMD. The rest are third-party images: their
 * variables are read by someone else's code.
 */
function appServices(list, root) {
  const scripts = appScripts(root);
  const sure = list.filter(([, svc]) => svc?.build || RELEASE_IMAGE.test(String(svc?.image ?? "")));
  const certain = sure.length ? sure : list.filter(([, svc]) => startsAppCode(svc, root, scripts));
  const images = new Set(certain.filter(([, svc]) => svc?.image).map(([, svc]) => imageName(svc.image)));
  const ours = ([name, svc]) => certain.some(([n]) => n === name) || (Boolean(svc?.image) && images.has(imageName(svc.image)));
  return { apps: list.filter(ours), others: list.filter((entry) => !ours(entry)) };
}

const isNoneTest = (t) => (Array.isArray(t) ? String(t[0]).toUpperCase() === "NONE" : typeof t === "string" && t.trim().toUpperCase() === "NONE");
const healthcheckOff = (hc) => hc?.disable === true || isNoneTest(hc?.test);

// ---------------------------------------------------------------- rules

// A one-shot job (e.g. a nightly script run by `docker compose run`): no ports and an explicit
// "do not restart" policy. It needs neither a restart policy nor a healthcheck.
function oneShot(svc) {
  if (asList(svc?.ports).length) return false;
  return String(svc?.restart ?? "") === "no" || svc?.deploy?.restart_policy?.condition === "none";
}

export const RULES = [
  {
    id: "D1",
    title: "Базовий образ з явним тегом (не latest)",
    hint: "Вкажіть конкретну версію базового образу (наприклад, мажорна версія Node + варіант) або digest @sha256:…",
    check({ dockerfile }) {
      if (!dockerfile.exists) return fail(`${PATHS.dockerfile} не знайдено`);
      const all = stages(dockerfile);
      if (!all.length) return fail(`${PATHS.dockerfile}: немає FROM`);
      const vars = globalArgs(dockerfile);
      const aliases = new Set();
      const problems = [];
      for (const { from } of all) {
        const tokens = tokenize(from.args).filter((t) => !t.startsWith("--"));
        const image = substitute(tokens[0] ?? "", vars);
        const asIndex = tokens.findIndex((t) => t.toUpperCase() === "AS");
        const alias = asIndex !== -1 ? tokens[asIndex + 1]?.toLowerCase() : null;
        if (!aliases.has(image.toLowerCase()) && image !== "scratch") {
          const ref = parseImageRef(image);
          if (image.includes("$")) problems.push(`рядок ${from.line}: FROM ${tokens[0]} — тег з ARG без значення`);
          else if (!ref.digest && (ref.tag === null || ref.tag === "latest")) {
            problems.push(`рядок ${from.line}: FROM ${image} — ${ref.tag ? "тег latest" : "без тегу"}`);
          }
        }
        if (alias) aliases.add(alias);
      }
      return problems.length ? fail(problems.join("; ")) : pass("усі FROM мають конкретний тег або digest");
    },
  },
  {
    id: "D2",
    title: "USER у фінальному образі, не root",
    hint: "Додайте у фінальну стадію USER з непривілейованим користувачем (в образах node є користувач node) — після COPY і перед CMD.",
    check({ dockerfile }) {
      if (!dockerfile.exists) return fail(`${PATHS.dockerfile} не знайдено`);
      const last = stages(dockerfile).at(-1);
      const user = last?.body.filter((i) => i.instruction === "USER").at(-1);
      if (!user) return fail("у фінальній стадії немає USER — контейнер працює як root");
      const name = user.args.split(":")[0].trim().toLowerCase();
      if (name === "root" || name === "0") return fail(`рядок ${user.line}: USER ${user.args} — це root`);
      return pass(`USER ${user.args}`);
    },
  },
  {
    id: "D3",
    title: "Перевірка здоров'я: HEALTHCHECK або healthcheck у кожного сервісу",
    hint: "Або HEALTHCHECK у Dockerfile, або healthcheck: (test, interval, retries) у кожного сервісу compose; HEALTHCHECK NONE, test: [\"NONE\"] і disable: true — це не перевірка. Образ спільний для api і worker, а HTTP-сервер є лише в api: HTTP-перевірку з образу worker не пройде — для worker вимкніть її (healthcheck: disable: true) або дайте йому власну, а сервісу з ports: її вимикати не можна. У node:*-alpine і node:*-slim немає curl — перевіряйте через node -e.",
    check({ dockerfile, compose }) {
      const final = stages(dockerfile).at(-1);
      const hc = final?.body.filter((i) => i.instruction === "HEALTHCHECK").at(-1);
      if (hc && !/^NONE\b/i.test(hc.args)) {
        const where = `HEALTHCHECK у Dockerfile (рядок ${hc.line})`;
        if (composeProblem(compose)) return pass(where);
        const off = services(compose)
          .filter(([, svc]) => asList(svc?.ports).length && healthcheckOff(svc?.healthcheck))
          .map(([name]) => name);
        if (off.length) return fail(`${where}, але compose вимикає його для сервісів з ports: ${off.join(", ")}`);
        return pass(where);
      }
      const problem = composeProblem(compose, "у Dockerfile немає HEALTHCHECK, а ");
      if (problem) return problem;
      const missing = services(compose)
        .filter(([, svc]) => !oneShot(svc) && (!svc?.healthcheck?.test || healthcheckOff(svc.healthcheck)))
        .map(([name]) => name);
      if (missing.length) return fail(`у Dockerfile немає HEALTHCHECK; без healthcheck у compose: ${missing.join(", ")}`);
      return pass("healthcheck є в кожного сервісу compose");
    },
  },
  {
    id: "D4",
    title: "Жодних секретів у ENV/ARG Dockerfile",
    hint: "Секрет не має бути в образі: приберіть ENV/ARG зі значенням для TOKEN/SECRET/PASSWORD/KEY і передавайте його під час запуску — environment: з ${VAR:?…} з оточення. secrets: / *_FILE — лише якщо додасте читання файлу в app/src/config.js: застосунок бере секрети тільки зі змінних оточення.",
    check({ dockerfile }) {
      if (!dockerfile.exists) return fail(`${PATHS.dockerfile} не знайдено`);
      const problems = [];
      for (const ins of dockerfile.instructions) {
        if (ins.instruction !== "ENV" && ins.instruction !== "ARG") continue;
        for (const [key, value] of keyValues(ins.instruction, ins.args)) {
          if (isSecretLike(key) && value !== null && value !== "") {
            problems.push(`рядок ${ins.line}: ${ins.instruction} ${key} має значення в образі`);
          }
        }
      }
      return problems.length ? fail(problems.join("; ")) : pass("секретоподібних ENV/ARG зі значенням немає");
    },
  },
  {
    id: "C1",
    title: "Образи в compose з фіксованим тегом",
    hint: "Кожен сервіс — image: з версією (наприклад, тег релізу або ${IMAGE_TAG:?}), не latest і не без тегу. Змінна в тегу — лише з :? (обов'язкова) або з :-значенням за замовчуванням, яке саме є версією. Лише build: без image теж не годиться.",
    check({ compose }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const problems = [];
      for (const [name, svc] of services(compose)) {
        const image = svc?.image;
        if (!image) problems.push(`${name}: немає image`);
        else {
          const why = imageProblem(String(image));
          if (why) problems.push(`${name}: ${image} — ${why}`);
        }
      }
      return problems.length ? fail(problems.join("; ")) : pass("усі образи мають тег або digest");
    },
  },
  {
    id: "C2",
    title: "Політика перезапуску в кожного сервісу",
    hint: "Додайте restart: unless-stopped (або on-failure) кожному довгоживучому сервісу — інакше впалий процес так і лишиться лежати. Разова задача без ports: (запуск через docker compose run) може мати restart: \"no\" — це теж явне рішення.",
    check({ compose }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const missing = services(compose)
        .filter(([, svc]) => {
          const restart = String(svc?.restart ?? "");
          const ok = ["always", "unless-stopped", "on-failure"].includes(restart) || restart.startsWith("on-failure:");
          const condition = svc?.deploy?.restart_policy?.condition;
          return !ok && !["on-failure", "any"].includes(condition) && !oneShot(svc);
        })
        .map(([name]) => name);
      return missing.length ? fail(`без restart: ${missing.join(", ")}`) : pass("restart є в кожного сервісу");
    },
  },
  {
    id: "C3",
    title: "Ліміт пам'яті в кожного сервісу",
    hint: "Задайте mem_limit: або deploy.resources.limits.memory кожному сервісу — разом вони мають уміститися в пам'ять VM.",
    check({ compose }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const missing = services(compose)
        .filter(([, svc]) => !svc?.mem_limit && !svc?.deploy?.resources?.limits?.memory)
        .map(([name]) => name);
      return missing.length ? fail(`без ліміту пам'яті: ${missing.join(", ")}`) : pass("ліміт пам'яті є в кожного сервісу");
    },
  },
  {
    id: "C4",
    title: "Секрети в compose лише посиланням",
    hint: "Для TOKEN/SECRET/PASSWORD/KEY — значення ${VAR} або ${VAR:?…} з оточення чи .env поза git; ${VAR:-літерал} — теж літерал. secrets: / *_FILE — лише якщо додасте читання файлу в app/src/config.js: застосунок бере секрети тільки зі змінних оточення.",
    check({ compose }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const problems = [];
      for (const [name, svc] of services(compose)) {
        for (const [key, value] of envEntries(svc?.environment)) {
          if (!isSecretLike(key) || value === null || value === undefined) continue;
          if (!isComposeReference(String(value))) problems.push(`${name}: ${key} задано літералом`);
        }
      }
      return problems.length ? fail(problems.join("; ")) : pass("секретоподібні змінні задано посиланнями");
    },
  },
  {
    // Post-mortem 2026-10-14, action item #3: v1.8.0 renamed DB_POOL_MAX to DB_POOL_SIZE in compose
    // only; config.js never saw the new name and silently used its local-dev default (pool of 4).
    id: "C5",
    title: "Кожну змінну environment: сервісів застосунку читає app/src/config.js",
    hint: "Змінну, якої не читає код, застосунок просто не бачить і мовчки бере типове значення (2026-10-14: DB_POOL_SIZE замість DB_POOL_MAX → пул на 4 з'єднання замість 20). Назвіть змінну в compose так, як її читає app/src/config.js, або, якщо змінна нова, додайте її читання в config.js у тому самому PR. Правило розпізнає env.NAME, env?.NAME, env[\"NAME\"], деструктуризацію з env / process.env, \"NAME\" in env, Object.hasOwn(env, \"NAME\") і хелпер на кшталт need(\"NAME\") поруч з env[name]. Без звірки — лише змінні рантайму Node: TZ, NODE_ENV, NODE_OPTIONS, NODE_EXTRA_CA_CERTS, UV_THREADPOOL_SIZE. Сервіс вважається застосунком, якщо має build: або бере образ цілком зі змінної без значення за замовчуванням (${IMAGE:?…}); коли таких немає — якщо запускає файл чи npm-скрипт з app/; а також кожен сервіс на тому самому образі (будь-який тег). Решту (сторонні образи) правило називає, але не звіряє.",
    check({ compose, root, appConfig = textFile(root, PATHS.appConfig) }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      if (!appConfig.exists) return fail(`${PATHS.appConfig} не знайдено — немає з чим звірити змінні compose`);
      const read = envNamesRead(appConfig.text);
      const { apps, others } = appServices(services(compose), root);
      if (!apps.length) {
        return fail("жоден сервіс compose не розпізнано як застосунок з app/ (build:, image: ${IMAGE:?…}, command: з файлом чи npm-скриптом з app/) — немає що звіряти");
      }
      const unread = new Map(); // variable → services that set it
      const malformed = [];
      let total = 0;
      for (const [name, svc] of apps) {
        const environment = svc?.environment;
        const scalar = (item) => typeof item === "string" || typeof item === "number";
        if (environment !== undefined && environment !== null && (typeof environment !== "object" || (Array.isArray(environment) && !environment.every(scalar)))) {
          malformed.push(name);
          continue;
        }
        for (const [key] of envEntries(environment)) {
          total += 1;
          if (read.has(key) || RUNTIME_ENV.has(key)) continue;
          unread.set(key, [...(unread.get(key) ?? []), name]);
        }
      }
      const skipped = others.filter(([, svc]) => svc?.environment).map(([name]) => name);
      const note = skipped.length ? `; сторонні образи не звірялися: ${skipped.join(", ")}` : "";
      const problems = [...unread].map(([key, names]) => `${key} (${names.join(", ")})`);
      if (problems.length || malformed.length) {
        const parts = [];
        if (problems.length) parts.push(`${PATHS.appConfig} не читає: ${problems.join("; ")}`);
        if (malformed.length) parts.push(`environment: не словник і не список: ${malformed.join(", ")}`);
        return fail(parts.join("; ") + note);
      }
      return pass(`${total} змінних у ${apps.map(([name]) => name).join(", ")} — усі читає config.js або рантайм Node${note}`);
    },
  },
  {
    id: "W1",
    title: "pipeline/deploy.yml існує, валідний YAML, без pull_request_target",
    hint: "Створіть pipeline/deploy.yml (не в .github/workflows/) з on: і jobs:. Тригер pull_request_target дає коду з чужого PR доступ до секретів — не використовуйте його.",
    check({ workflow }) {
      if (!workflow.exists) return fail(`${PATHS.workflow} не знайдено`);
      if (workflow.toolError) return toolFail(workflow);
      if (workflow.error) return fail(`${PATHS.workflow} не розібрався як YAML: ${workflow.error}`);
      if (!workflowJobs(workflow)) return fail(`${PATHS.workflow}: немає jobs:`);
      const on = workflow.data.on;
      if (on === undefined) return fail(`${PATHS.workflow}: немає on:`);
      const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
      if (triggers.includes("pull_request_target")) return fail("тригер pull_request_target");
      return pass(`тригери: ${triggers.join(", ")}`);
    },
  },
  {
    id: "W2",
    title: "Мінімальні permissions на рівні workflow",
    hint: "Додайте на верхньому рівні permissions: (наприклад, contents: read) і розширюйте права лише в job, якій вони потрібні. write-all — ні.",
    check({ workflow }) {
      if (workflowUnavailable(workflow)) return skip(`немає валідного ${PATHS.workflow} (див. W1)`);
      if (!("permissions" in workflow.data)) return fail("немає permissions: на верхньому рівні — діють права за замовчуванням");
      if (workflow.data.permissions === "write-all") return fail("permissions: write-all");
      return pass("permissions задано");
    },
  },
  {
    id: "W3",
    title: "Деплой-job з environment: і needs: на тести",
    hint: "Job деплою — це job з environment: (там налаштовують approval). Вона має залежати через needs: (прямо або через build) від job, яка справді запускає тести: крок run: з npm test / node --test (для reusable workflow — test в id або в шляху).",
    check({ workflow }) {
      if (workflowUnavailable(workflow)) return skip(`немає валідного ${PATHS.workflow} (див. W1)`);
      const jobs = workflowJobs(workflow);
      const deployJobs = Object.entries(jobs).filter(([, job]) => job?.environment);
      if (!deployJobs.length) return fail("немає job з environment:");
      for (const [id] of deployJobs) {
        const seen = new Set();
        const queue = asList(jobs[id]?.needs).map(String);
        while (queue.length) {
          const next = queue.shift();
          if (seen.has(next) || !jobs[next]) continue;
          seen.add(next);
          queue.push(...asList(jobs[next].needs).map(String));
        }
        const tests = [...seen].filter((j) => j !== id && isTestJob(j, jobs[j]));
        if (tests.length) return pass(`${id} (environment) ← needs ← ${tests.join(", ")}`);
      }
      return fail(`${deployJobs.map(([id]) => id).join(", ")}: environment є, але needs: не веде до job тестів`);
    },
  },
  {
    id: "W4",
    title: "Секрети в workflow лише через ${{ secrets.NAME }}",
    hint: "Значення для TOKEN/SECRET/PASSWORD/KEY — тільки ${{ secrets.NAME }} (або ${{ github.token }}), ніяких літералів ні в env:/with:, ні в скриптах run: / with.script.",
    check({ workflow }) {
      if (workflowUnavailable(workflow)) return skip(`немає валідного ${PATHS.workflow} (див. W1)`);
      const problems = [];
      walk(workflow.data, "", (key, value, path, parents) => {
        if (key === "secrets" && value === "inherit") return; // reusable workflow: pass caller's secrets on
        const inWith = parents.length >= 2 && parents.at(-2)?.with === parents.at(-1);
        if (inWith && isCacheStep(parents.at(-2)) && ["key", "restore-keys"].includes(key)) return; // cache keys
        if (typeof value !== "string" && typeof value !== "number") return;
        if (isSecretLike(key)) {
          if (!isSecretReference(value) && !isDummy(value)) problems.push(`${path} не з secrets`);
          return;
        }
        const script = key === "run" || (inWith && (SCRIPT_KEYS.has(key) || String(value).includes("\n")));
        if (script) for (const name of literalAssignments(value, isSecretLike)) problems.push(`${path}: ${name}= літералом`);
      });
      return problems.length ? fail(problems.join("; ")) : pass("секретоподібні значення лише з secrets");
    },
  },
  {
    id: "W5",
    title: "Кожен uses: закріплено тегом або SHA",
    hint: "Пишіть owner/action@v4 (тег версії) або @<40-символьний SHA>, не @main/@master і не без @. Локальні ./… не перевіряються.",
    check({ workflow }) {
      if (workflowUnavailable(workflow)) return skip(`немає валідного ${PATHS.workflow} (див. W1)`);
      const problems = [];
      let count = 0;
      for (const [id, job] of Object.entries(workflowJobs(workflow))) {
        const refs = [job?.uses, ...asList(job?.steps).map((s) => s?.uses)].filter((u) => typeof u === "string");
        for (const uses of refs) {
          count += 1;
          if (!usesPinned(uses)) problems.push(`${id}: ${uses}`);
        }
      }
      return problems.length ? fail(`не закріплено: ${problems.join("; ")}`) : pass(`закріплено: ${count}`);
    },
  },
];

// ---------------------------------------------------------------- running

export function runChecks(ctx, rules = RULES) {
  return rules.map((rule) => {
    let result;
    try {
      result = rule.check(ctx);
    } catch (err) {
      result = fail(`правило впало: ${err.message}`);
    }
    return { id: rule.id, title: rule.title, hint: rule.hint, ...result };
  });
}

export function formatReport(results) {
  const lines = ["ID  STATUS  MESSAGE"];
  for (const r of results) {
    lines.push(`${r.id.padEnd(3)} ${r.status.padEnd(7)} ${r.title}: ${r.message}`);
    if (r.status === "FAIL" && !r.toolError) lines.push(`            підказка: ${r.hint}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  lines.push("", `PASS ${count("PASS")}  FAIL ${count("FAIL")}  SKIP ${count("SKIP")}`);
  if (results.some((r) => r.toolError)) lines.push("", `УВАГА: ${YAML_TOOL} не запустився, YAML-правила не перевірено. ${TOOL_HINT}`);
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--root");
  const root = resolve(i !== -1 ? argv[i + 1] : fileURLToPath(new URL("..", import.meta.url)));
  const results = runChecks(loadContext(root));
  process.stdout.write(formatReport(results));
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
