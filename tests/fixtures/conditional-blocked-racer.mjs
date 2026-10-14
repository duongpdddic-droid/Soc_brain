// tests/fixtures/conditional-blocked-racer.mjs — PROCESS-BACKED racer for the
// conditional BLOCKED write (review finding on the sequential T15 "race").
//
// This script runs in its OWN OS process: it takes a real checkpoint, reports
// READY (pid + start time) to the parent, blocks on stdin until the parent
// sends GO, then calls the REAL taskBlock with the REAL terminalizePrecondition
// — no mocked ownership lock, no in-process sequencing, no fake session write.
// The parent spawns TWO of these to force genuine cross-process contention on
// the per-session ownership lock file.
//
// Usage: node conditional-blocked-racer.mjs '<json>'
//   { sessionPath, identityHash, stateDir, token, markerPath }
//
// Protocol (one JSON object per line on stdout):
//   READY { pid, startedAt }  — checkpoint taken, waiting for GO
//   DONE  { pid, ok, reason } — taskBlock outcome
import fs from 'node:fs';

import { terminalizePrecondition, ledgerCheckpoint, readTransitions } from '../../packages/control-loop/control-loop.mjs';
import { taskBlock } from '../../packages/runtime-sandbox/runtime-sandbox.mjs';

const opts = JSON.parse(process.argv[2]);
const { sessionPath, identityHash, stateDir, token, markerPath, exitBeforeReady = false } = opts;
if (!sessionPath || !identityHash || !stateDir || !token || !markerPath) {
  fs.writeSync(2, 'usage: conditional-blocked-racer.mjs <json:{sessionPath,identityHash,stateDir,token,markerPath}>\n');
  process.exit(2);
}

// Each racer takes its OWN checkpoint from the same ledger state it believes
// is current — exactly what the production wrapper does before its write.
const checkpoint = ledgerCheckpoint(readTransitions({ stateDir, identityHash }));

// The winner's notification seam: a marker file the parent can count, instead
// of a real transport (offline, deterministic).
const spawn = () => {
  fs.appendFileSync(markerPath, `${process.pid}\n`);
  return { stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 707 })}\n` };
};

function say(obj) { fs.writeSync(1, `${JSON.stringify(obj)}\n`); }

// Failure-path fixture mode: lets the parent prove its finally/after cleanup
// reaps the sibling that is still waiting on stdin when one racer exits early.
if (exitBeforeReady) {
  say({ event: 'EXIT_EARLY', pid: process.pid, startedAt: new Date().toISOString() });
  process.exit(17);
}

say({ event: 'READY', pid: process.pid, startedAt: new Date().toISOString() });

// Block until the parent releases this racer (real contention window: the
// sibling is READY too when the parent writes GO to both pipes).
const gate = Buffer.alloc(1);
fs.readSync(0, gate, 0, 1, null);

const result = taskBlock({
  sessionPath,
  dispatchOptions: { stateDir, spawn, allowNonCanonicalStateRoot: true },
  precondition: terminalizePrecondition({ authority: { token }, stateDir, identityHash, checkpoint }),
});
say({ event: 'DONE', pid: process.pid, ok: Boolean(result && result.ok), reason: (result && result.reason) || null });
process.exit(0);
