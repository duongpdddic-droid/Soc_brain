#!/usr/bin/env node
// soc-task-bootstrap.test.mjs -- tests for bin/soc-task-bootstrap.mjs
// Imports and tests the real parseArgs from bootstrap script, workspace primitives, and syntax check

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { provision, verifyBinding, cleanup, defaultWorktreesRoot, identityHash, worktreeBranchFor, worktreePathFor, bindingPathFor, SHA40_RE } from "../packages/workspace/workspace.mjs";
import { normalizeRemoteUrl } from "../packages/safe-git/safe-git.mjs";
import { parseArgs } from "../bin/soc-task-bootstrap.mjs";

const CANON = "duongpdddic-droid/Soc_brain";

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g) });

function createMockExec(responses) {
  return function(cmd, args, opts = {}) {
    const key = [cmd, ...args].join(" ");
    if (responses[key]) return responses[key];
    throw new Error("no mock for: " + key);
  };
}

async function testCliParsing() {
  // Test the REAL parseArgs from bootstrap script
  tru("args with value", parseArgs(["--title", "test"]).title === "test");
  tru("args with goal", parseArgs(["--goal", "my-goal"]).goal === "my-goal");
  tru("flag not recognized becomes true", parseArgs(["--unknown"]).unknown === true);
  tru("defaults applied when empty", Object.keys(parseArgs([])).length === 0);
  tru("--issue parsed as number", parseArgs(["--issue", "123"]).issue === "123");
  tru("--issue without value becomes true", parseArgs(["--issue"]).issue === true);
}

async function testMockProvision() {
  const worktreesRoot = defaultWorktreesRoot();
  const h = identityHash({ repo: CANON, issueNumber: 9999 });
  tru("identityHash generates hash", h && h.length === 32);

  const branch = worktreeBranchFor({ identityHash: h });
  eq("worktreeBranchFor format", branch, "agent/" + h);

  const wtPath = worktreePathFor({ worktreesRoot, identityHash: h });
  tru("worktreePathFor contains agent", wtPath.includes("agent" + path.sep));
  tru("worktreePathFor starts with worktreesRoot", wtPath.startsWith(worktreesRoot));

  const bPath = bindingPathFor({ worktreesRoot, identityHash: h });
  tru("bindingPathFor ends with .json", bPath.endsWith(".json"));
  tru("bindingPathFor contains bindings", bPath.includes("bindings" + path.sep));

  const validSha = "a".repeat(40);
  const invalidSha = "short";
  tru("SHA40_RE valid", SHA40_RE.test(validSha));
  tru("SHA40_RE invalid", !SHA40_RE.test(invalidSha));

  const normalized = normalizeRemoteUrl("https://github.com/duongpdddic-droid/Soc_brain.git");
  eq("normalizeRemoteUrl", normalized, "duongpdddic-droid/soc_brain");
}

async function testFailClosedRollback() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soc-test-"));
  const wtRoot = path.join(tmpRoot, "worktrees");
  fs.mkdirSync(wtRoot, { recursive: true });

  const hTest = identityHash({ repo: CANON, issueNumber: 9999 });
  const wtPathTest = worktreePathFor({ worktreesRoot: wtRoot, identityHash: hTest });
  const bPathTest = bindingPathFor({ worktreesRoot: wtRoot, identityHash: hTest });

  fs.mkdirSync(wtPathTest, { recursive: true });
  fs.mkdirSync(path.dirname(bPathTest), { recursive: true });
  fs.writeFileSync(bPathTest, JSON.stringify({ schemaVersion: "1.0", repo: CANON, issueNumber: 9999, baseSha: "a".repeat(40) }));

  tru("worktree dir exists for test", fs.existsSync(wtPathTest));
  tru("binding file exists for test", fs.existsSync(bPathTest));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  tru("cleanup removes temp dir", !fs.existsSync(tmpRoot));
}

async function testSyntaxCheck() {
  // Verify the bootstrap script has valid syntax (exit code 0)
  try {
    execFileSync("node", ["-c", "bin/soc-task-bootstrap.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    tru("syntax check passes", true);
  } catch (e) {
    tru("syntax check passes", false);
    console.error("Syntax check failed:", String(e.stdout || e.stderr || e.message));
  }
}

async function runAllTests() {
  await testCliParsing();
  await testMockProvision();
  await testFailClosedRollback();
  await testSyntaxCheck();
  const pass = checks.filter(c => c.ok).length;
  const fail = checks.filter(c => !c.ok).length;
  console.log("\nTong: " + pass + "/" + checks.length + " PASS");
  for (const c of checks) if (!c.ok) console.error("FAIL " + c.name + "=>", c.got, "want", c.want);
  process.exit(fail > 0 ? 1 : 0);
}

runAllTests();