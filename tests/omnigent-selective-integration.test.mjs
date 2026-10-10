#!/usr/bin/env node
// omnigent-selective-integration.test.mjs — tests for the three ported
// Omnigent-derived modules (PR #283, upstream omnigent @ 12a0d5c8):
//   1. packages/executor-launcher/capability-declaration.mjs
//   2. packages/permission-orchestration/opencode-permission.mjs
//   3. packages/executor-launcher/event-delivery.mjs
// Hand-rolled check collector (repo pattern), process.exit(0|1).
import {
  CAPABILITY_STATUS,
  OPENCODE_CLI_EXECUTOR_CAPABILITIES,
  CAPABILITY_AXES,
  capabilitiesAsDict,
  resolveCapabilityStatus,
  capabilityReport,
  parseSemver,
  versionInSupportedWindow,
  probeOpenCodeCapabilities,
  probeCapabilityReport,
} from '../packages/executor-launcher/capability-declaration.mjs';
import {
  parsePermissionRequest,
  normalizeForPolicy,
  extractResourceFields,
  mapVerdictToDecision,
  outcomeToDecision,
  decisionToReply,
  replyBody,
  adjudicatePermissionRequest,
  PERMISSION_DECISION,
  OPENCODE_REPLY,
} from '../packages/permission-orchestration/opencode-permission.mjs';
import {
  EventDelivery,
  DELIVERY_STATE,
} from '../packages/executor-launcher/event-delivery.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

// =========================================================================
// 1. capability declaration — tri-state + live probe
// =========================================================================
eq('status VERIFIED', CAPABILITY_STATUS.VERIFIED, 'VERIFIED');
eq('status DECLARED', CAPABILITY_STATUS.DECLARED, 'DECLARED');
eq('status UNKNOWN', CAPABILITY_STATUS.UNKNOWN, 'UNKNOWN');

// declared record shape
const dict = capabilitiesAsDict();
eq('dict steering null (no claim)', dict.steering, null);
eq('dict liveQueue null (no claim)', dict.liveQueue, null);
eq('dict images null (no claim)', dict.images, null);
eq('dict compaction null (no claim)', dict.compaction, null);
eq('dict integrationMode', dict.integrationMode, 'cli-subprocess');
eq('dict streaming declared', dict.streaming, true);
eq('axes count', CAPABILITY_AXES.length, 13);

// null claim => UNKNOWN regardless of evidence (never upgraded)
const nullClaim = resolveCapabilityStatus(null, { proven: true, observed: true });
eq('null claim => UNKNOWN', nullClaim.status, CAPABILITY_STATUS.UNKNOWN);
falsy('null claim never drifts', nullClaim.drift);

// declared claim without evidence => DECLARED (never auto-VERIFIED)
const bare = resolveCapabilityStatus(true, undefined);
eq('declared w/o evidence => DECLARED', bare.status, CAPABILITY_STATUS.DECLARED);

// declared claim + proven evidence agreeing => VERIFIED
const verified = resolveCapabilityStatus(true, { proven: true, observed: true });
eq('claim+evidence agree => VERIFIED', verified.status, CAPABILITY_STATUS.VERIFIED);
falsy('no drift when agree', verified.drift);

// claim contradicted by probe => DECLARED + drift (fail-closed reporting)
const drifted = resolveCapabilityStatus(true, { proven: true, observed: false });
eq('contradicted claim stays DECLARED', drifted.status, CAPABILITY_STATUS.DECLARED);
eq('contradicted claim flags drift', drifted.drift, true);

// probe ran but could not establish => DECLARED with probeFailed, not VERIFIED
const unproven = resolveCapabilityStatus(true, { proven: false });
eq('unproven probe => DECLARED', unproven.status, CAPABILITY_STATUS.DECLARED);
eq('unproven probe flagged', unproven.probeFailed, true);

// proven probe that supplied NO observed verdict => DECLARED + probeFailed
// (nothing was established about the claim — never VERIFIED on proven alone)
const noVerdict = resolveCapabilityStatus(true, { proven: true });
eq('proven w/o observed => DECLARED', noVerdict.status, CAPABILITY_STATUS.DECLARED);
eq('proven w/o observed flagged probeFailed', noVerdict.probeFailed, true);

// contradicted STRING claim => DECLARED + drift (verdict is boolean, not enum)
const strDrift = resolveCapabilityStatus('cli-subprocess', { proven: true, observed: false });
eq('string claim contradicted => DECLARED', strDrift.status, CAPABILITY_STATUS.DECLARED);
eq('string claim contradicted drifts', strDrift.drift, true);

// invalid declaration shape => UNKNOWN (fail closed, reported not fixed)
const invalid = resolveCapabilityStatus(42, undefined);
eq('invalid declaration => UNKNOWN', invalid.status, CAPABILITY_STATUS.UNKNOWN);
eq('invalid declaration reason', invalid.reason, 'INVALID_DECLARATION');

// report: only probed axes can reach VERIFIED; unprobed stay DECLARED/UNKNOWN
const rep = capabilityReport(OPENCODE_CLI_EXECUTOR_CAPABILITIES, {
  integrationMode: { proven: true, observed: true, version: '1.18.25' },
});
eq('report integrationMode VERIFIED', rep.integrationMode.status, CAPABILITY_STATUS.VERIFIED);
eq('report steering UNKNOWN', rep.steering.status, CAPABILITY_STATUS.UNKNOWN);
eq('report streaming DECLARED (unproven)', rep.streaming.status, CAPABILITY_STATUS.DECLARED);

// semver window
eq('parseSemver ok', parseSemver('1.18.25').minor, 18);
eq('parseSemver junk', parseSemver('abc'), null);
eq('window: 1.18.25 in', versionInSupportedWindow('1.18.25'), true);
eq('window: 1.17.7 boundary in', versionInSupportedWindow('1.17.7'), true);
eq('window: 1.19.0 out (exclusive)', versionInSupportedWindow('1.19.0'), false);
eq('window: 1.17.6 out', versionInSupportedWindow('1.17.6'), false);

// live probe with REAL spawn semantics (injected spawnSync at the probe call
// site — evidence produced explicitly, not fabricated by the caller)
const okProbe = probeOpenCodeCapabilities({
  executable: 'fake-opencode.exe',
  spawnSync: () => ({ stdout: '1.18.25\n', error: undefined }),
});
eq('probe ok', okProbe.ok, true);
eq('probe version', okProbe.version, '1.18.25');
eq('probe evidence proven', okProbe.probes.integrationMode.proven, true);
eq('probe observed (boolean verdict on the claim)', okProbe.probes.integrationMode.observed, true);

const failProbe = probeOpenCodeCapabilities({
  executable: 'missing.exe',
  spawnSync: () => { throw new Error('ENOENT'); },
});
eq('probe failure not proven', failProbe.ok, false);
eq('failed probe observed undefined', failProbe.probes.integrationMode.observed, undefined);
const failReport = capabilityReport(OPENCODE_CLI_EXECUTOR_CAPABILITIES, failProbe.probes);
eq('failed probe keeps DECLARED (no downgrade)', failReport.integrationMode.status, CAPABILITY_STATUS.DECLARED);

const noExe = probeOpenCodeCapabilities({});
eq('probe without executable fails closed', noExe.ok, false);

const pcr = probeCapabilityReport({
  executable: 'fake.exe',
  spawnSync: () => ({ stdout: 'opencode 1.18.25\n', error: undefined }),
});
eq('probeCapabilityReport ok', pcr.ok, true);
eq('probeCapabilityReport VERIFIED axis', pcr.report.integrationMode.status, CAPABILITY_STATUS.VERIFIED);

// =========================================================================
// 2. permission normalization — v1/v2 parse, fail-closed, never "always"
// =========================================================================
// v1 shape (verified live on 1.17.7): category in `permission`, resources = patterns
const v1 = parsePermissionRequest({
  id: 'per_abc', sessionID: 'ses_1', permission: 'bash',
  patterns: ['npm test'], metadata: { cwd: 'C:/wt' }, always: false, tool: 'bash',
});
eq('v1 requestId', v1.requestId, 'per_abc');
eq('v1 session', v1.sessionId, 'ses_1');
eq('v1 action extracted from `permission`', v1.action, 'bash');
eq('v1 resources from patterns', v1.resources[0], 'npm test');
eq('v1 metadata kept', v1.metadata.cwd, 'C:/wt');

// v2 shape: category in `action`, resources = objects
const v2 = parsePermissionRequest({
  id: 'per_def', sessionID: 'ses_2', action: 'edit',
  resources: [{ path: 'packages/x.mjs' }], save: false, source: 'tool',
});
eq('v2 action extracted from `action`', v2.action, 'edit');
eq('v2 resources', v2.resources[0].path, 'packages/x.mjs');
eq('v2 source', v2.source, 'tool');

// requestID / request_id alternates + missing id => null
eq('requestID alternate', parsePermissionRequest({ requestID: 'p1', action: 'read' }).requestId, 'p1');
eq('missing id => null', parsePermissionRequest({ action: 'read' }), null);
eq('null payload => null', parsePermissionRequest(null), null);
eq('array payload => null', parsePermissionRequest([]), null);

// resource extraction: metadata first, then resources; path/filePath/file fallbacks
const rf = extractResourceFields({ metadata: {}, resources: [{ path: 'a.txt' }] });
eq('extract path', rf.path, 'a.txt');
eq('extract file fallback', extractResourceFields({ metadata: { file: 'b.txt' } }).path, 'b.txt');
eq('extract command wins in order', extractResourceFields({ metadata: { command: 'node x' }, resources: [{ command: 'node y' }] }).command, 'node x');

// normalizeForPolicy
const pol = normalizeForPolicy(v1, { executionRoot: 'C:/wt', identityHash: 'def41' });
eq('policy harness', pol.harness, 'opencode-native');
eq('policy requestId', pol.requestId, 'per_abc');
eq('policy executionRoot', pol.executionRoot, 'C:/wt');

// verdict mapping (fail closed)
eq('decision allow_once', mapVerdictToDecision({ decision: 'allow' }), PERMISSION_DECISION.ALLOW_ONCE);
eq('decision allow_always', mapVerdictToDecision({ decision: 'allow_always' }), PERMISSION_DECISION.ALLOW_ALWAYS);
eq('decision deny', mapVerdictToDecision({ action: 'deny' }), PERMISSION_DECISION.REJECT);
eq('decision unknown => ask', mapVerdictToDecision({ decision: 'maybe' }), PERMISSION_DECISION.ASK);
eq('decision null => ask', mapVerdictToDecision(null), PERMISSION_DECISION.ASK);
eq('decision garbage => ask', mapVerdictToDecision({ decision: 12345 }), PERMISSION_DECISION.ASK);

// outcome mapping
eq('outcome ALLOW => allow_once', outcomeToDecision('ALLOW'), PERMISSION_DECISION.ALLOW_ONCE);
// DENY_AND_RECOVER is a definitive deny with the recovery/reroute handled at
// the operation layer — the permission reply itself is still a reject.
eq('outcome DENY_AND_RECOVER => reject', outcomeToDecision('DENY_AND_RECOVER'), PERMISSION_DECISION.REJECT);
eq('outcome HUMAN_GATE => ask', outcomeToDecision('BLOCKED_HUMAN_GATE'), PERMISSION_DECISION.ASK);

// reply mapping: NEVER "always"
eq('allow_once => once', decisionToReply(PERMISSION_DECISION.ALLOW_ONCE), OPENCODE_REPLY.ONCE);
eq('allow_always => once (never always)', decisionToReply(PERMISSION_DECISION.ALLOW_ALWAYS), OPENCODE_REPLY.ONCE);
eq('reject => reject', decisionToReply(PERMISSION_DECISION.REJECT), OPENCODE_REPLY.REJECT);
eq('ask => null (no auto reply)', decisionToReply(PERMISSION_DECISION.ASK), null);
// The invariant is about EMISSION, not the enum: OPENCODE_REPLY keeps the
// upstream wire vocabulary (once|always|reject) for fidelity, but no decision
// may ever produce an "always" reply (it persists a vendor-side auto-allow
// that bypasses the policy engine), and replyBody refuses it outright.
falsy('no decision maps to an always reply',
  [PERMISSION_DECISION.ALLOW_ONCE, PERMISSION_DECISION.ALLOW_ALWAYS, PERMISSION_DECISION.REJECT, PERMISSION_DECISION.ASK]
    .some((d) => decisionToReply(d) === OPENCODE_REPLY.ALWAYS));

// replyBody
eq('replyBody once', replyBody('once').reply, 'once');
eq('replyBody always refused', replyBody('always'), null);

// adjudicatePermissionRequest end to end (fail-closed chain).
// NOTE: adjudicatePermissionRequest takes a RAW payload (it parses internally),
// so these calls pass the original raw objects, not the parsed v1/v2 above.
const rawV1 = {
  id: 'per_abc', sessionID: 'ses_1', permission: 'bash',
  patterns: ['npm test'], metadata: { cwd: 'C:/wt' }, always: false, tool: 'bash',
};
const rawV2 = {
  id: 'per_def', sessionID: 'ses_2', action: 'edit',
  resources: [{ path: 'packages/x.mjs' }], save: false, source: 'tool',
};
const noGuard = adjudicatePermissionRequest(rawV1, { executionRoot: 'C:/wt' });
eq('no guard => ask', noGuard.decision, PERMISSION_DECISION.ASK);
eq('no guard => no reply', noGuard.reply, null);

const allowGuard = adjudicatePermissionRequest(rawV1, {
  executionRoot: 'C:/wt',
  guard: () => ({ verdict: 'ALLOW' }),
});
eq('guard ALLOW => reply once', allowGuard.reply, 'once');
eq('guard ALLOW reply body', allowGuard.replyBody.reply, 'once');

const gateGuard = adjudicatePermissionRequest(rawV2, {
  executionRoot: 'C:/wt',
  guard: () => ({ verdict: 'BLOCKED_HUMAN_GATE' }),
});
eq('gate => ask', gateGuard.decision, PERMISSION_DECISION.ASK);
eq('gate => no reply', gateGuard.reply, null);

const badGuard = adjudicatePermissionRequest(rawV2, {
  guard: () => { throw new Error('boom'); },
});
eq('guard throw => fail-closed ask', badGuard.decision, PERMISSION_DECISION.ASK);

const unparseable = adjudicatePermissionRequest({ action: 'bash' }, {});
eq('unparseable => invalid', unparseable.ok, false);
eq('unparseable => no reply', unparseable.reply, null);

// =========================================================================
// 3. event delivery — bounded queue, ACK-retain-replay, generation check
// =========================================================================
const tick = () => new Promise((r) => setImmediate(r));
// sleep must yield a MACROTASK: a resolved-promise sleep spins the retry
// loop on the microtask queue and starves setImmediate (tick never runs).
const sleepless = () => new Promise((r) => setImmediate(r));

function makeDelivery(overrides = {}) {
  return new EventDelivery({ sleep: sleepless, retryDelayMs: 0, ackTimeoutMs: 60000, ...overrides });
}

{ // happy path: submit -> send -> full ACK => cursor advanced
  const d = makeDelivery();
  const sent = [];
  d.connect(async (batch) => { sent.push(batch); });
  d.ready();
  const p = d.submit({ sourceId: 's1', events: [{ n: 1 }, { n: 2 }] });
  await tick();
  eq('happy: one send', sent.length, 1);
  eq('happy: batch has 2 events', sent[0].events.length, 2);
  const acked = d.acknowledge({ id: sent[0].id, applied: 2, retryable: false });
  eq('happy: ack accepted', acked.ok, true);
  const res = await p;
  eq('happy: resolved ok', res.ok, true);
  eq('happy: applied 2', res.applied, 2);
  eq('happy: cursor advanced', d.cursor('s1'), 2);
  eq('happy: lastDispatchAt set', d.lastDispatchAt !== null, true);
  eq('happy: nothing pending', d.hasPending, false);
}

{ // partial retryable ACK => resend remainder only
  const d = makeDelivery();
  const sent = [];
  d.connect(async (batch) => { sent.push(batch); });
  d.ready();
  const p = d.submit({ sourceId: 's1', events: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  await tick();
  d.acknowledge({ id: sent[0].id, applied: 1, retryable: true });
  await tick(); await tick();
  eq('partial: second send happened', sent.length, 2);
  eq('partial: remainder only', sent[1].events.length, 2);
  eq('partial: remainder starts at n=2', sent[1].events[0].n, 2);
  d.acknowledge({ id: sent[1].id, applied: 2, retryable: false });
  const res = await p;
  eq('partial: resolved ok', res.ok, true);
  eq('partial: full cursor', d.cursor('s1'), 3);
}

{ // invalid ACK (applied out of range) => rejected, batch stays retained
  const d = makeDelivery();
  const sent = [];
  d.connect(async (batch) => { sent.push(batch); });
  d.ready();
  const p = d.submit({ sourceId: 's1', events: [{ n: 1 }] });
  await tick();
  const bad = d.acknowledge({ id: sent[0].id, applied: 5, retryable: false });
  eq('invalid ack rejected', bad.ok, false);
  eq('invalid ack reason', bad.reason, 'INVALID_ACK');
  const unknown = d.acknowledge({ id: 'nope', applied: 1 });
  eq('unknown batch ack rejected', unknown.ok, false);
  // batch still pending: a valid ACK can still settle it
  const good = d.acknowledge({ id: sent[0].id, applied: 1, retryable: false });
  eq('valid ack after invalid accepted', good.ok, true);
  const res = await p;
  eq('settled after valid ack', res.ok, true);
}

{ // stale-generation ACK is ignored (connection replaced during flight)
  const d = makeDelivery();
  const sent = [];
  d.connect(async (batch) => { sent.push(batch); });
  d.ready();
  const p = d.submit({ sourceId: 's1', events: [{ n: 1 }] });
  await tick();
  const gen = d.generation;
  d.connect(async () => {}); // new generation; the old ACK layer fails
  await tick();
  const stale = d.acknowledge({ id: sent[0].id, applied: 1, generation: gen });
  eq('stale-generation ack ignored', stale.ok, false);
  // Durable semantics (upstream): a generation replace never settles the
  // producer — the batch is retained at the queue HEAD for replay.
  eq('durable batch retained after generation replace', d.queueDepth, 1);
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  eq('producer stays pending through outage', settled, false);
  // The next generation replays the SAME batchId and ACKs it.
  d.connect(async (batch) => { sent.push(batch); });
  d.ready();
  await tick();
  eq('replay sent after ready', sent.length, 2);
  d.acknowledge({ id: sent[1].id, applied: 1, retryable: false });
  const res = await p;
  eq('replay resolves producer', res.ok, true);
  eq('cursor after generation replay', d.cursor('s1'), 1);
}

{ // partial ACK + generation replace => replay carries ONLY the remainder
  // (the confirmed prefix already advanced the cursor; replaying it too
  // would double-count and make a resume-from-cursor consumer SKIP events)
  const d = makeDelivery();
  const sent = [];
  d.connect(async (batch) => { sent.push(batch); });
  d.ready();
  const p = d.submit({ sourceId: 's1', events: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  await tick();
  d.acknowledge({ id: sent[0].id, applied: 1, retryable: true });
  await tick(); await tick();
  eq('genreplace: second send happened', sent.length, 2);
  eq('genreplace: prefix already in cursor', d.cursor('s1'), 1);
  d.connect(async (batch) => { sent.push(batch); }); // replaced mid-remainder
  await tick();
  eq('genreplace: un-ACKed remainder retained', d.queueDepth, 1);
  d.ready();
  await tick();
  eq('genreplace: replay is remainder only', sent[2].events.length, 2);
  d.acknowledge({ id: sent[2].id, applied: 2, retryable: false });
  const res = await p;
  eq('genreplace: resolved ok', res.ok, true);
  eq('genreplace: whole-batch applied reported', res.applied, 3);
  eq('genreplace: cursor = total, no double count', d.cursor('s1'), 3);
}

{ // QUEUE_FULL backpressure (bounded queue, never unbounded)
  const d = makeDelivery({ maxPending: 2 });
  d.connect(async () => { /* never ACKs */ });
  d.ready();
  const p1 = d.submit({ sourceId: 's1', events: [{ n: 1 }] });
  const p2 = d.submit({ sourceId: 's2', events: [{ n: 2 }] });
  let settledCount = 0;
  const markSettled = () => { settledCount += 1; };
  p1.then(markSettled, markSettled);
  p2.then(markSettled, markSettled);
  let full = null;
  try { await d.submit({ sourceId: 's3', events: [{ n: 3 }] }); } catch (e) { full = e; }
  eq('queue full rejects', full && full.code, 'QUEUE_FULL');
  d.disconnected();
  await tick(); await tick(); // let the delivery loops observe the outage
  // Disconnect retains durable batches (producer stays pending until a
  // future generation ACKs them) — never a silent settle, never unbounded.
  eq('durable batches retained after disconnect', d.queueDepth, 2);
  eq('no ACK handshake survives disconnect', d.hasPending, false);
  eq('durable producers never settle through outage', settledCount, 0);
}

{ // backoff items still count against the bound (READY-but-failing channel
  // must never admit unbounded live items — backpressure under sustained failure)
  const d = makeDelivery({ maxPending: 1 });
  d.connect(async () => { throw new Error('pipe broken'); }); // every send fails
  d.ready();
  const p1 = d.submit({ sourceId: 's1', events: [{ n: 1 }] });
  await tick(); await tick(); // p1 is now parked in retry backoff (inFlight)
  let full = null;
  try { await d.submit({ sourceId: 's2', events: [{ n: 2 }] }); } catch (e) { full = e; }
  eq('backoff item keeps the bound (QUEUE_FULL)', full && full.code, 'QUEUE_FULL');
  d.disconnected();
  await tick();
  let settled = false;
  p1.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  eq('backoff producer retained, not settled', settled, false);
}

{ // disconnect retains durable batch for replay on next ready cycle
  const d = makeDelivery();
  const sent = [];
  let failSend = true;
  d.connect(async (batch) => { if (failSend) throw new Error('pipe closed'); sent.push(batch); });
  d.ready();
  const p = d.submit({ sourceId: 's1', events: [{ n: 1 }, { n: 2 }] });
  await tick(); await tick();
  // send threw => durable retry loop; now simulate outage then recovery
  failSend = false;
  await tick(); await tick(); await tick();
  eq('replay after send recovery', sent.length >= 1, true);
  d.acknowledge({ id: sent[sent.length - 1].id, applied: 2, retryable: false });
  const res = await p;
  eq('durable replay resolved', res.ok, true);
  eq('cursor after replay', d.cursor('s1'), 2);
}

{ // preview batch fails fast on outage (never blocks the producer)
  const d = makeDelivery();
  d.connect(async () => { throw new Error('down'); });
  d.ready();
  let err = null;
  try { await d.submit({ sourceId: 's1', events: [{ n: 1 }], preview: true }); } catch (e) { err = e; }
  eq('preview fails fast', err && err.name, 'DeliveryError');
}

{ // UNSUPPORTED state refuses submit
  const d = makeDelivery();
  d.unsupported();
  let err = null;
  try { await d.submit({ sourceId: 's1', events: [{ n: 1 }] }); } catch (e) { err = e; }
  eq('unsupported refuses submit', err && err.code, 'UNSUPPORTED');
}

{ // validation: empty batch, oversize batch
  const d = makeDelivery({ maxEvents: 2 });
  let e1 = null; let e2 = null;
  try { await d.submit({ sourceId: 's', events: [] }); } catch (e) { e1 = e; }
  try { await d.submit({ sourceId: 's', events: [{ a: 1 }, { b: 2 }, { c: 3 }] }); } catch (e) { e2 = e; }
  eq('empty batch rejected', e1 && e1.code, 'EMPTY_BATCH');
  eq('oversize batch rejected', e2 && e2.code, 'BATCH_TOO_LARGE');
}

{ // non-retryable PARTIAL ack => terminal failure with partial count
  const d = makeDelivery();
  const sent = [];
  d.connect(async (batch) => { sent.push(batch); });
  d.ready();
  const p = d.submit({ sourceId: 's1', events: [{ n: 1 }, { n: 2 }] });
  await tick();
  d.acknowledge({ id: sent[0].id, applied: 1, retryable: false, error: 'forbidden' });
  let out = null;
  await p.then((v) => { out = v; }, (v) => { out = v; });
  eq('partial non-retryable settles', out !== null, true);
  eq('partial non-retryable applied', out.applied, 1);
  eq('partial cursor advanced', d.cursor('s1'), 1);
}

// =========================================================================
const failed = checks.filter((c) => !c.ok);
for (const f of failed) console.error(`FAIL ${f.name}: got=${JSON.stringify(f.got)} want=${JSON.stringify(f.want)}`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
