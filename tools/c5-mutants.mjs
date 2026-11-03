#!/usr/bin/env node
// Mutation check for rule C5 (tools/check-deploy.mjs): do its tests notice when the rule breaks?
//
//   node tools/c5-mutants.mjs          (~2–3 min; needs the npx yaml@2.8.1 cache like the tests)
//
// Each mutant replaces one whole line of check-deploy.mjs — found by a snippet that must occur
// on exactly one line — in a temp copy of the repo, then runs the C5 tests there. A mutant is
// "killed" only when a test assertion fails; a run that goes red otherwise (spawn error, signal,
// a test that broke on something else — say, npx unavailable) is an ERROR, not a kill.
// Not part of `npm run test:tools`: it lives outside tools/test/.
// Exit code 1 if any mutant survives or errors, or a snippet no longer matches (update the list then).

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const R = String.raw;

// name → [snippet that identifies the line, the line that replaces it]
const MUTANTS = {
  // which services are ours
  "no build: seed": ["const sure = list.filter(", R`  const sure = list.filter(([, svc]) => RELEASE_IMAGE.test(String(svc?.image ?? "")));`],
  "any image variable is a release": ["const RELEASE_IMAGE =", R`const RELEASE_IMAGE = /^\$/;`],
  "no command detection": ["function startsAppCode(svc, root, scripts) {", "function startsAppCode(svc, root, scripts) { return false;"],
  "command detection even next to build/release services": ["const certain = sure.length ?", "  const certain = [...sure, ...list.filter(([, svc]) => startsAppCode(svc, root, scripts))];"],
  "any .js counts (no exists check)": ["const appFile = (w) =>", R`  const appFile = (w) => /\.[cm]?js$/.test(w);`],
  "no ./ or /app/ prefix strip": ["const appFile = (w) =>", R`  const appFile = (w) => /\.[cm]?js$/.test(w) && existsSync(join(root, "app", w));`],
  "no quote strip": [".map((w) => w.replace(", "    .map((w) => w)"],
  "no npm script detection": ['const npm = words.indexOf("npm");', "  const npm = -1;"],
  "npm flags taken as the verb": ["const [verb, script] = words.slice(npm + 1)", "  const [verb, script] = words.slice(npm + 1);"],
  "no shared-image propagation": ["const ours = ([name, svc]) =>", "  const ours = ([name]) => certain.some(([n]) => n === name);"],
  "image name keeps the digest": ['const ref = s.split("@")[0];', "  const ref = s;"],
  "any $-image kept whole (registry variable)": ["return s; // the whole reference from one variable", '  if (s.startsWith("$")) return s;'],
  "no docker.io/library normalisation": [R`docker\.io`, "  return colon === -1 ? ref : ref.slice(0, colon);"],
  // comparing names
  "substring match of names": ["if (read.has(key) || RUNTIME_ENV.has(key)) continue;", "          if ([...read].some((n) => n.includes(key)) || RUNTIME_ENV.has(key)) continue;"],
  "runtime exemption by prefix": ["if (read.has(key) || RUNTIME_ENV.has(key)) continue;", "          if (read.has(key) || [...RUNTIME_ENV].some((r) => key.startsWith(r))) continue;"],
  "malformed environment ignored": ["!environment.every(scalar)", "        if (false) {"],
  "missing config.js passes": ["if (!appConfig.exists) return fail(", "      if (!appConfig.exists) return pass('');"],
  "skipped services hidden": ["const note = skipped.length ?", '      const note = "";'],
  "env-less third-party services named": ["const skipped = others.filter(", "      const skipped = others.map(([name]) => name);"],
  // reading config.js
  "no word boundary before env": [R`(?:\?\.|\.)\s*([A-Za-z_]`, R`  for (const m of code.matchAll(/env\s*(?:\?\.|\.)\s*([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);`],
  "no destructuring": [R`matchAll(/\{([^{}]*)`, "  for (const m of []) {"],
  "no `in env`": [R`\s+in\s+`, ""],
  "no Object.hasOwn / Reflect.has": ["Object\\s*\\.\\s*hasOwn", ""],
  "no helper literals": [".test(code)) {", "  if (false) {"],
  "comments kept as code": ['if (c === "/" && s[i + 1] === "/") {', "    if (false) {"],
  "strings kept as code": ["strings.push(text) - 1", "      code += quote + text + quote; strings.push(text);"],
  "escaped quote ends a string": ['text += s[j] === "\\\\"', "        text += s[j];"],
  "regex literals not skipped": ['} else if (c === "/" && regexCanStart(code)) {', "    } else if (false) {"],
  "a / inside [...] ends the regex": ['else if (s[j] === "[") inClass = true;', "        else if (false) inClass = true;"],
};

function runC5Tests(dir) {
  const files = readdirSync(join(dir, "tools", "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => join("tools", "test", f));
  return spawnSync(process.execPath, ["--test", "--test-name-pattern", "C5", ...files], { cwd: dir, encoding: "utf8" });
}

function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "c5-mutant-"));
  for (const part of ["tools", "app", "deploy", "package.json"]) cpSync(join(REPO, part), join(dir, part), { recursive: true });
  return dir;
}

const source = readFileSync(join(REPO, "tools", "check-deploy.mjs"), "utf8");
const lines = source.split("\n");

const baseline = copyRepo();
try {
  const r = runC5Tests(baseline);
  if (r.status !== 0) {
    console.error("The C5 tests fail without any mutation — fix them first.\n" + r.stdout);
    process.exit(1);
  }
} finally {
  rmSync(baseline, { recursive: true, force: true });
}

let killed = 0;
let bad = 0;
for (const [name, [snippet, replacement]] of Object.entries(MUTANTS)) {
  const hits = lines.flatMap((line, i) => (line.includes(snippet) ? [i] : []));
  if (hits.length !== 1) {
    console.log(`STALE    ${name}: the snippet matches ${hits.length} lines`);
    bad += 1;
    continue;
  }
  const dir = copyRepo();
  try {
    writeFileSync(join(dir, "tools", "check-deploy.mjs"), lines.map((line, i) => (i === hits[0] ? replacement : line)).join("\n"));
    const r = runC5Tests(dir);
    const verdict = r.error || r.signal ? "ERROR" : r.status === 0 ? "SURVIVED" : r.stdout.includes("ERR_ASSERTION") ? "killed" : "ERROR";
    if (verdict === "killed") killed += 1;
    else bad += 1;
    console.log(`${verdict.padEnd(8)} ${name}${verdict === "ERROR" ? `: ${r.error?.message ?? r.signal ?? "the tests failed without a failed assertion"}` : ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const total = Object.keys(MUTANTS).length;
console.log(`\n${killed}/${total} mutants killed`);
process.exitCode = bad ? 1 : 0;
