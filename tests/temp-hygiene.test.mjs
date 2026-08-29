// Regression tests for packages/temp-hygiene.
// Parity naming preserved with upstream AI_PR_REVIEWER@9c104c8 (pid-reuse, etc.).
// Covers review 5058720741 changes-requested:
//   AC1c mutated manifest identity, AC4b mixed-case Windows containment,
//   AC7b unverified owner refuses cleanup, AC11 canonical soc-brain slug.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  isSafeProjectId,
  isSafeTaskId,
  isSafeSessionId,
  isInside,
  isSymlink,
  hasOwnershipMarker,
  assertOutsideWorktree,
  createSessionManager,
  cleanupSession,
  recoverSession,
  snapshotWorkspace,
  redactHome,
  isAlive,
} from "../packages/temp-hygiene/temp-hygiene.mjs";

const RESULTS = { pass: 0, fail: 0, skip: 0, log: [] };
const t0 = Date.now();
async function test(name, fn) {
  try {
    await fn();
    RESULTS.pass++;
    RESULTS.log.push("PASS " + name);
  } catch (e) {
    RESULTS.fail++;
    RESULTS.log.push("FAIL " + name + " :: " + (e && e.message ? e.message : String(e)));
  }
}
function skip(name, why) { RESULTS.skip++; RESULTS.log.push("SKIP " + name + " :: " + why); }

const isWin = process.platform === "win32";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "soc-th-"));
function fresh(prefix) {
  return fs.mkdtempSync(path.join(TMP, (prefix || "x") + "-"));
}

// ---- Slug rules (AC11) -----------------------------------------------------
await test("isSafeProjectId accepts soc-brain", () => {
  assert.equal(isSafeProjectId("soc-brain"), true);
});
await test("isSafeProjectId accepts task_1", () => {
  assert.equal(isSafeProjectId("task_1"), true);
});
await test("isSafeProjectId accepts proj-2026", () => {
  assert.equal(isSafeProjectId("proj-2026"), true);
});
await test("isSafeProjectId accepts hex 32 (parity)", () => {
  assert.equal(isSafeProjectId("0123456789abcdef0123456789abcdef"), true);
});
await test("isSafeProjectId rejects ..", () => {
  assert.equal(isSafeProjectId(".."), false);
});
await test("isSafeProjectId rejects a/b", () => {
  assert.equal(isSafeProjectId("a/b"), false);
});
await test("isSafeProjectId rejects a\\b", () => {
  assert.equal(isSafeProjectId("a\\b"), false);
});
await test("isSafeProjectId rejects empty", () => {
  assert.equal(isSafeProjectId(""), false);
});
await test("isSafeProjectId rejects 0.0", () => {
  assert.equal(isSafeProjectId("0.0"), false);
});
await test("isSafeProjectId rejects with space", () => {
  assert.equal(isSafeProjectId("with space"), false);
});
await test("isSafeProjectId rejects uppercase", () => {
  assert.equal(isSafeProjectId("Soc-brain"), false);
});
await test("isSafeProjectId rejects leading hyphen", () => {
  assert.equal(isSafeProjectId("-foo"), false);
});
await test("isSafeProjectId rejects too long", () => {
  assert.equal(isSafeProjectId("a".repeat(65)), false);
});
await test("isSafeTaskId mirrors project rules", () => {
  assert.equal(isSafeTaskId("soc-brain"), true);
  assert.equal(isSafeTaskId("task_1"), true);
  assert.equal(isSafeTaskId(".."), false);
  assert.equal(isSafeTaskId("a/b"), false);
  assert.equal(isSafeTaskId(""), false);
});

// ---- sessionId rules (parity) ---------------------------------------------
await test("isSafeSessionId hex ok", () => {
  assert.equal(isSafeSessionId("0123456789abcdef0123456789abcdef"), true);
});
await test("isSafeSessionId upper rejected", () => {
  assert.equal(isSafeSessionId("0123456789ABCDEF0123456789ABCDEF"), false);
});
await test("isSafeSessionId weird chars rejected", () => {
  assert.equal(isSafeSessionId("not-hex!!"), false);
});

// ---- isInside parity ------------------------------------------------------
await test("isInside child is inside", () => {
  const a = fresh("root");
  const b = path.join(a, "c");
  fs.mkdirSync(b);
  assert.equal(isInside(a, b), true);
});
await test("isInside root equal false", () => {
  const a = fresh("root");
  assert.equal(isInside(a, a), false);
});
await test("isInside sibling false", () => {
  const a = fresh("a");
  const b = fresh("b");
  assert.equal(isInside(a, b), false);
});

// ---- assertOutsideWorktree: refuses tempRoot inside repo ------------------
await test("createSession tempRoot inside repo throws", () => {
  const inside = path.join(process.cwd(), ".soc-brain-temp");
  if (fs.existsSync(inside)) fs.rmSync(inside, { recursive: true, force: true });
  assert.throws(() => createSessionManager({
    tempRoot: inside, projectId: "soc-brain", taskId: "task_1",
  }));
});

// ---- AC4b mixed-case Windows containment ----------------------------------
await test("createSession mixed-case tempRoot inside repo throws (Windows)", () => {
  if (!isWin) { skip("windows-only", "not Windows"); return; }
  // Use uppercase repo path; on Windows fs.cwd() may already be mixed-case.
  const upperRepo = process.cwd().toUpperCase();
  if (upperRepo === process.cwd()) {
    skip("mixed-case", "cwd already uppercase");
    return;
  }
  const inside = path.join(upperRepo, ".soc-brain-temp-case");
  assert.throws(() => createSessionManager({
    tempRoot: inside, projectId: "soc-brain", taskId: "task_1",
  }));
});

// ---- happy path: create -> cleanup -> CLEAN --------------------------------
await test("create + cleanup with no owners and no files -> CLEAN", () => {
  const root = fresh("happy");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "task_1",
  });
  const home = mgr.homeDir;
  assert.equal(fs.existsSync(home), true);
  const before = snapshotWorkspace(path.dirname(home));
  const res = mgr.cleanup({ workspaceBefore: before, projectRoot: path.dirname(home) });
  assert.equal(res.verdict, "CLEAN");
  assert.equal(res.readBack.homeGone, true);
  assert.equal(res.readBack.processesGone, true);
  assert.equal(res.readBack.remaining.length, 0);
  assert.equal(res.readBack.workspaceUnchanged, true);
  assert.equal(res.leftover.length, 0);
  assert.equal(fs.existsSync(home), false);
});

// ---- happy path with files/dirs -------------------------------------------
await test("create + files + dirs + cleanup -> CLEAN, all removed", () => {
  const root = fresh("full");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "task_2",
  });
  const f1 = mgr.createFile("a.txt", "hello");
  const f2 = mgr.createFile("sub/b.txt", "world");
  const d1 = mgr.createDir("sub2");
  assert.equal(fs.existsSync(f1), true);
  assert.equal(fs.existsSync(f2), true);
  assert.equal(fs.existsSync(d1), true);
  const res = mgr.cleanup();
  assert.equal(res.verdict, "CLEAN");
  assert.equal(res.readBack.homeGone, true);
  assert.equal(res.readBack.remaining.length, 0);
  assert.equal(res.removed.length >= 3, true);
});

// ---- cleanup with explicit workspace baseline passes -----------------------
await test("cleanup with workspace baseline returns workspaceUnchanged", () => {
  const root = fresh("ws");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "ws_1",
  });
  const projDir = path.dirname(mgr.homeDir);
  const before = snapshotWorkspace(projDir) || [];
  const res = mgr.cleanup({ workspaceBefore: before, projectRoot: projDir });
  assert.equal(res.verdict, "CLEAN");
  assert.equal(res.readBack.workspaceBaselinePresent, true);
  assert.equal(res.readBack.workspaceUnchanged, true);
});

// ---- cleanup idempotent ---------------------------------------------------
await test("cleanup twice -> second is CLEAN no-op (verdict CLEAN)", () => {
  const root = fresh("idem");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "idem_1",
  });
  const projDir = path.dirname(mgr.homeDir);
  const before = snapshotWorkspace(projDir) || [];
  const r1 = mgr.cleanup({ workspaceBefore: before, projectRoot: projDir });
  assert.equal(r1.verdict, "CLEAN");
  const r2 = mgr.cleanup({ workspaceBefore: before, projectRoot: projDir });
  assert.equal(r2.verdict, "CLEAN");
  assert.equal(r2.readBack.homeGone, true);
});

// ---- ownership marker is keyed by (projectId, taskId) --------------------
await test("hasOwnershipMarker keyed by projectId+taskId", () => {
  const root = fresh("mk");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "mk_1",
  });
  assert.equal(hasOwnershipMarker(mgr.homeDir, { projectId: "soc-brain", taskId: "mk_1" }), true);
  assert.equal(hasOwnershipMarker(mgr.homeDir, { projectId: "soc-brain", taskId: "mk_2" }), false);
  assert.equal(hasOwnershipMarker(mgr.homeDir, { projectId: "other", taskId: "mk_1" }), false);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- recovery: absent -> CLEAN -------------------------------------------
await test("recoverSession: absent -> CLEAN", () => {
  const root = fresh("rec0");
  const r = recoverSession({ projectId: "soc-brain", taskId: "rec_0", tempRoot: root });
  assert.equal(r.verdict, "CLEAN");
  assert.equal(r.leftover.length, 0);
});

// ---- recovery: present + no owners -> CLEAN ------------------------------
await test("recoverSession: present, no owners -> CLEAN", () => {
  const root = fresh("rec1");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "rec_1",
  });
  const home = mgr.homeDir;
  const r = recoverSession({ projectId: "soc-brain", taskId: "rec_1", tempRoot: root });
  assert.equal(r.verdict, "CLEAN");
  assert.equal(r.removed.includes(redactHome(home)), true);
  assert.equal(fs.existsSync(home), false);
});

// ---- recovery idempotent: second call is CLEAN ----------------------------
await test("recoverSession twice -> second is CLEAN no-op", () => {
  const root = fresh("rec2");
  createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "rec_2",
  });
  const r1 = recoverSession({ projectId: "soc-brain", taskId: "rec_2", tempRoot: root });
  const r2 = recoverSession({ projectId: "soc-brain", taskId: "rec_2", tempRoot: root });
  assert.equal(r1.verdict, "CLEAN");
  assert.equal(r2.verdict, "CLEAN");
});

// ---- AC1c: mutated manifest identity refuses cleanup --------------------
await test("AC1c: manifest homeDir swapped -> POC_CLEANUP_FAILED, home NOT deleted", () => {
  const root = fresh("tamper1");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "tamper_1",
  });
  const home = mgr.homeDir;
  // Tamper: rewrite manifest.homeDir to a different path.
  const mp = path.join(home, ".session-manifest.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.homeDir = path.join(root, "soc-brain", "tamper_OTHER");
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  const r = recoverSession({ projectId: "soc-brain", taskId: "tamper_1", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(fs.existsSync(home), true);
  assert.equal(r.leftover.length > 0, true);
});

await test("AC1c: manifest projectId swapped -> POC_CLEANUP_FAILED", () => {
  const root = fresh("tamper2");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "tamper_2",
  });
  const home = mgr.homeDir;
  const mp = path.join(home, ".session-manifest.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.projectId = "other-project";
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  const r = recoverSession({ projectId: "soc-brain", taskId: "tamper_2", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(fs.existsSync(home), true);
});

await test("AC1c: manifest taskId swapped -> POC_CLEANUP_FAILED", () => {
  const root = fresh("tamper3");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "tamper_3",
  });
  const home = mgr.homeDir;
  const mp = path.join(home, ".session-manifest.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.taskId = "tamper_OTHER";
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  const r = recoverSession({ projectId: "soc-brain", taskId: "tamper_3", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(fs.existsSync(home), true);
});

await test("AC1c: manifest tempRoot swapped -> POC_CLEANUP_FAILED", () => {
  const root = fresh("tamper4");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "tamper_4",
  });
  const home = mgr.homeDir;
  const mp = path.join(home, ".session-manifest.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.tempRoot = path.join(root, "other-root");
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  const r = recoverSession({ projectId: "soc-brain", taskId: "tamper_4", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(fs.existsSync(home), true);
});

await test("AC1c: manifest unparseable JSON -> POC_CLEANUP_FAILED", () => {
  const root = fresh("tamper5");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "tamper_5",
  });
  const home = mgr.homeDir;
  fs.writeFileSync(path.join(home, ".session-manifest.json"), "not-json{");
  const r = recoverSession({ projectId: "soc-brain", taskId: "tamper_5", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(fs.existsSync(home), true);
});

// ---- recovery: unowned home (no marker) -> POC_CLEANUP_FAILED -----------
await test("recovery: unowned home (no marker) -> POC_CLEANUP_FAILED, dir kept", () => {
  const root = fresh("unowned");
  const projectDir = path.join(root, "soc-brain");
  const home = path.join(projectDir, "unowned_1");
  fs.mkdirSync(home, { recursive: true });
  // No marker, no manifest.
  const r = recoverSession({ projectId: "soc-brain", taskId: "unowned_1", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(fs.existsSync(home), true);
  assert.equal(r.leftover.length > 0, true);
});

// ---- recovery: marker with wrong (projectId, taskId) -> POC_CLEANUP_FAILED -
await test("recovery: marker with wrong key -> POC_CLEANUP_FAILED, dir kept", () => {
  const root = fresh("wrongkey");
  const projectDir = path.join(root, "soc-brain");
  const home = path.join(projectDir, "wrongkey_1");
  fs.mkdirSync(home, { recursive: true });
  // Write a marker for a *different* task.
  fs.writeFileSync(path.join(home, ".soc-brain-session-marker"),
    "soc-brain session owner marker:other-project:other-task\n");
  fs.writeFileSync(path.join(home, ".session-manifest.json"), JSON.stringify({
    version: 2, projectId: "other-project", taskId: "other-task", sessionId: "deadbeef",
    createdAt: new Date().toISOString(),
    homeDir: home, projectDir: projectDir, tempRoot: root,
    dirs: [home], files: [], processes: [],
  }, null, 2));
  const r = recoverSession({ projectId: "soc-brain", taskId: "wrongkey_1", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(fs.existsSync(home), true);
});

// ---- AC7b: unverified owner refuses cleanup (real) -----------------------
await test("AC7b: unverified owner refuses cleanup (real external pid)", async () => {
  const root = fresh("pid7b");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "pid_7b",
  });
  // Spawn a long-lived external process that has nothing to do with the
  // session. Its CommandLine will not include mgr.sessionId.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
    stdio: "ignore", detached: false,
  });
  const externalPid = child.pid;
  // Inject the external pid into the manifest as if it were a tracked owner.
  const mp = path.join(mgr.homeDir, ".session-manifest.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.processes = [{ pid: externalPid, addedAt: new Date().toISOString() }];
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  // Sanity: the external pid is alive and is not us.
  assert.equal(isAlive(externalPid), true);
  const r = recoverSession({ projectId: "soc-brain", taskId: "pid_7b", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(r.readBack.survivors.includes(externalPid), true);
  assert.equal(r.readBack.processesGone, false);
  // External process must still be alive (we did not touch it).
  assert.equal(isAlive(externalPid), true);
  // Home must still exist.
  assert.equal(fs.existsSync(mgr.homeDir), true);
  // Clean up: kill external.
  try { process.kill(externalPid, "SIGKILL"); } catch {}
});

// ---- pid-reuse parity: external pid is NOT killed (parity with upstream) -
await test("pid-reuse: external pid is NOT killed when manifest has its pid", async () => {
  const root = fresh("pidreuse");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "pid_reuse",
  });
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
    stdio: "ignore", detached: false,
  });
  const externalPid = child.pid;
  const mp = path.join(mgr.homeDir, ".session-manifest.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.processes = [{ pid: externalPid, addedAt: new Date().toISOString() }];
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  const r = recoverSession({ projectId: "soc-brain", taskId: "pid_reuse", tempRoot: root });
  // Fail-closed: refused because unverified.
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  // processesGone read-back is false.
  assert.equal(r.readBack.processesGone, false);
  // External process must still be alive.
  assert.equal(isAlive(externalPid), true);
  try { process.kill(externalPid, "SIGKILL"); } catch {}
});

// ---- no-baseline: missing workspaceBefore -> POC_CLEANUP_FAILED ----------
await test("cleanup without workspaceBefore -> POC_CLEANUP_FAILED, workspaceUnchanged=false", () => {
  const root = fresh("nobs");
  const mgr = createSessionManager({
    tempRoot: root, projectId: "soc-brain", taskId: "nobs_1",
  });
  const projDir = path.dirname(mgr.homeDir);
  const r = mgr.cleanup({ projectRoot: projDir });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  assert.equal(r.readBack.workspaceUnchanged, false);
  assert.equal(r.readBack.workspaceBaselinePresent, false);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- junction: refuses cleanup, reports leftover, target outside untouched -
await test("junction: refuses cleanup, dir is leftover, target outside untouched", () => {
  if (!isWin) { skip("junction", "Windows only"); return; }
  const root = fresh("junc");
  const target = fresh("junc-target");
  fs.writeFileSync(path.join(target, "keep.txt"), "do-not-touch");
  // Create the project + task namespace manually.
  const projectDir = path.join(root, "soc-brain");
  const home = path.join(projectDir, "junc_1");
  fs.mkdirSync(home, { recursive: true });
  // Replace home with a directory junction pointing to target.
  fs.rmSync(home, { recursive: true, force: true });
  try {
    execSync("cmd /c mklink /J \"" + home + "\" \"" + target + "\"", { stdio: "ignore" });
  } catch (e) {
    skip("junction", "mklink /J failed on this host: " + e.message);
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  // Now make the home look like a real session for cleanup.
  fs.writeFileSync(path.join(home, ".soc-brain-session-marker"),
    "soc-brain session owner marker:soc-brain:junc_1\n");
  const r = recoverSession({ projectId: "soc-brain", taskId: "junc_1", tempRoot: root });
  assert.equal(r.verdict, "POC_CLEANUP_FAILED");
  // Target outside must still hold its file.
  assert.equal(fs.existsSync(path.join(target, "keep.txt")), true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

// ---- summary -------------------------------------------------------------
function summarize() {
  const dur = Date.now() - t0;
  for (const l of RESULTS.log) console.log(l);
  console.log("---");
  console.log("PASS " + RESULTS.pass);
  console.log("FAIL " + RESULTS.fail);
  console.log("SKIP " + RESULTS.skip);
  console.log("DUR ms " + dur);
  // Best-effort cleanup of test scratch.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(RESULTS.fail === 0 ? 0 : 1);
}
summarize();
