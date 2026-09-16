// soc-attached-observability.js — F4 (P0): the REAL OpenCode 1.18.27 attached-
// observability surface. It is an OpenCode plugin (V1 root API), NOT a test-only
// host.
//
// Runtime evidence for the chosen surface (OpenCode 1.18.27, installed packages
// @opencode-ai/plugin@1.18.27 + @opencode-ai/sdk@1.18.27):
//   * The plugin Hooks interface (node_modules/@opencode-ai/plugin/dist/index.d.ts)
//     exposes `tool.execute.after`, `event`, `dispose`, `chat.message`, … — there is
//     NO hook that receives or renders an MCP `notifications/message`. So MCP
//     logging notifications are NOT a guaranteed OpenCode UI surface.
//   * The proven, first-class OpenCode UI surfaces a plugin CAN drive through the
//     injected `client` (createOpencodeClient) are `session.update({body:{title}})`
//     (rendered in the TUI header + session list) and `tui.showToast`. This very
//     repo's shipping plugin `soc-session-title.js` already renames sessions with
//     `client.session.update({ path:{id}, body:{title} })` — there is no
//     session.rename(). That is the automatic, user-visible channel we reuse here.
//
// Behavior: after ONE canonical submit/recover performed in THIS session, the
// plugin follows the pinned task's durable operational state (the SAME reader the
// MCP control surface uses, follow-snapshot.operationalView + effective-state) and
// surfaces it automatically:
//   * the session TITLE carries a live state marker (▶/⊗/⧗/✓/…) + short step;
//   * a TUI toast is shown on each MEANINGFUL transition (progress step, BLOCKED,
//     HUMAN_GATE, READY_FOR_REVIEW).
// Dedupe is by the durable `seq`, so idle ticks emit nothing (no flapping) and the
// user never calls get_task/get_progress/soc.follow. Bound to the submitting
// sessionID (per-task isolation) and disposed on shutdown. It is read-only: it
// never mutates lifecycle, never answers a gate, never carries a verdict, and
// relays only operational fields (no chain-of-thought).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Guarded runtime observability (default OFF). When SOC_ATTACH_TRACE names a file,
// the plugin appends a one-line JSON record for each real runtime step so the
// production wiring can be evidenced WITHOUT pixel/TUI capture and WITHOUT a mocked
// host: plugin load, tool.execute.after invocation, attachFollow identity, the
// durable snapshot, and the ACTUAL client.session.update / client.tui.showToast
// calls. It never changes behavior and stays silent when the env is unset.
const TRACE = process.env.SOC_ATTACH_TRACE || '';
function trace(rec) {
  if (!TRACE) return;
  try { fs.appendFileSync(TRACE, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', 'utf8'); } catch { /* trace only */ }
}


const STATE_BADGE = {
  RUNNING: '\u25b6 RUNNING',
  STARTING: '\u25b6 STARTING',
  HUMAN_GATE: '\u29d8 HUMAN GATE',
  READY_FOR_REVIEW: '\u2713 READY_FOR_REVIEW',
  RECOVERABLE_BLOCKED: '\u2297 BLOCKED (recoverable)',
  PENDING_RECONCILIATION: '\u2026 PENDING',
  UNKNOWN: '? UNKNOWN',
  COMPLETED: '\u2714 COMPLETED',
  FAILED: '\u2718 FAILED',
  TERMINAL_BLOCKED: '\u2297 BLOCKED',
};

function markerFor(operational) {
  const badge = STATE_BADGE[operational.effectiveState] || operational.effectiveState || '\u2026';
  const step = operational.progress && operational.progress.currentStep != null && operational.progress.totalSteps
    ? ` ${operational.progress.currentStep}/${operational.progress.totalSteps}` : '';
  const iss = operational.issueNumber != null ? `#${operational.issueNumber}` : '';
  return `${iss} ${badge}${step}`.trim();
}
function toastTitle(operational) {
  return `Soc_brain ${operational.issueNumber != null ? '#' + operational.issueNumber : 'task'}: ${operational.effectiveState}`;
}

export const SocAttachedObservabilityPlugin = async ({ client }) => {
  trace({ ev: 'plugin-load', version: 'soc-attached-observability/1' });
  let api;
  try {
    const snap = await import('../../packages/client-mcp/follow-snapshot.mjs');
    const bind = await import('../../packages/client-mcp/follow-binding.mjs');
    const watch = await import('../../packages/client-mcp/follow-watcher.mjs');
    const stateDir = process.env.SOC_CONTROL_STATE_DIR
      || (process.platform === 'win32'
        ? path.join(process.env.USERPROFILE || os.homedir(), '.soc-brain', 'state')
        : path.join(process.env.HOME || os.homedir(), '.soc-brain', 'state'));
    api = { snap, bind, watch, stateDir };
    trace({ ev: 'plugin-modules-ready', stateDir });
  } catch (e) { trace({ ev: 'plugin-load-failed', detail: String((e && e.message) || e) }); return {}; } // attach-observability must never break the OpenCode session

  // One follower per OpenCode sessionID (per-task isolation; no cross-stream).
  const followers = new Map();

  async function refreshTitle(sessionID, operational) {
    try {
      const getRes = await client.session.get({ path: { id: sessionID } });
      const current = (getRes && getRes.data && getRes.data.title) || '';
      // strip any prior soc marker (" … \u25b6 RUNNING" tail) so it never stacks.
      const base = current.replace(/\s*\u00b7\s*#\?\S*.*$/, '').trim() || current;
      const title = `${base} \u00b7 ${markerFor(operational)}`.trim();
      if (title !== current) {
        await client.session.update({ path: { id: sessionID }, body: { title } });
        trace({ ev: 'client.session.update', sessionID, from: current, to: title, effectiveState: operational.effectiveState });
      }
    } catch (e) { trace({ ev: 'client.session.update-error', detail: String((e && e.message) || e) }); /* title surface best-effort */ }
  }
  async function toast(operational) {
    try {
      if (client && client.tui && typeof client.tui.showToast === 'function') {
        const body = { title: toastTitle(operational), message: operational.progress && operational.progress.message || operational.effectiveState, variant: operational.effectiveState };
        await client.tui.showToast({ body });
        trace({ ev: 'client.tui.showToast', body });
      }
    } catch (e) { trace({ ev: 'client.tui.showToast-error', detail: String((e && e.message) || e) }); /* toast may need a live TUI; the title still surfaces */ }
  }

  function attach(sessionID, binding) {
    if (!binding || !binding.repo || !binding.issueNumber) return;
    if (followers.has(sessionID)) { followers.get(sessionID).watcher.resync(); trace({ ev: 'attach-follow-resync', sessionID, identityHash: binding.identityHash }); return; }
    trace({ ev: 'attach-follow', sessionID, repo: binding.repo, issueNumber: binding.issueNumber, identityHash: binding.identityHash });
    let lastMeaningful = null;
    const watcher = api.watch.createFollowWatcher({
      identity: { ...binding },
      snapshot: () => {
        const v = api.snap.operationalView({ stateDir: api.stateDir, repo: binding.repo, issueNumber: binding.issueNumber });
        if (!v || v.ok !== true) { trace({ ev: 'snapshot-unavailable', repo: binding.repo, issueNumber: binding.issueNumber }); return { ok: false }; }
        trace({ ev: 'snapshot', effectiveState: v.operational.effectiveState, seq: v.operational.seq });
        return { ok: true, seq: v.operational.seq, payload: v.operational };
      },
      emit: (operational) => {
        refreshTitle(sessionID, operational);
        const meaningful = ['RECOVERABLE_BLOCKED', 'HUMAN_GATE', 'READY_FOR_REVIEW', 'COMPLETED', 'FAILED', 'TERMINAL_BLOCKED'].includes(operational.effectiveState);
        const step = operational.progress ? operational.progress.currentStep : null;
        if (meaningful && operational.effectiveState !== lastMeaningful) { toast(operational); lastMeaningful = operational.effectiveState; }
        else if (!meaningful && step != null && step !== (lastMeaningful && lastMeaningful.__step)) { toast(operational); }
        lastMeaningful = operational.effectiveState;
      },
      onError: () => {},
    });
    watcher.start();
    followers.set(sessionID, { watcher, binding });
  }

  return {
    'tool.execute.after': async (input, output) => {
      try {
        const tool = String(input.tool || '');
        trace({ ev: 'tool.execute.after', tool, sessionID: input.sessionID });
        // React to the canonical submit / reattach (and the explicit follow) tools.
        if (!/submit_goal|recover|soc\.follow|followPinned/i.test(tool)) return;
        const parsed = (() => { try { return JSON.parse(output && output.output); } catch { return null; } })();
        const meta = (output && output.metadata) || parsed || {};
        const idHash = meta.identityHash || (parsed && parsed.identityHash) || (parsed && parsed.currentTaskIdentity && parsed.currentTaskIdentity.identityHash);
        const repo = meta.repo || (parsed && parsed.repo) || (parsed && parsed.currentTaskIdentity && parsed.currentTaskIdentity.repo);
        const issueNumber = meta.issueNumber || (parsed && parsed.issueNumber) || (parsed && parsed.currentTaskIdentity && parsed.currentTaskIdentity.issueNumber);
        if (repo && Number.isInteger(Number(issueNumber))) { attach(input.sessionID, { repo, issueNumber: Number(issueNumber), identityHash: idHash }); return; }
        // fall back to the persisted observable binding
        const b = api.bind.readFollowBinding({ stateDir: api.stateDir });
        if (b && b.binding) attach(input.sessionID, b.binding);
      } catch { /* observability only */ }
    },
    event: async ({ event }) => {
      // If OpenCode reports the pinned task advanced without a fresh tool call
      // (e.g. executor finished while the user idles), nudge each follower to tick.
      try {
        if (event && event.type === 'session.idle' && followers.size) {
          for (const { watcher } of followers.values()) watcher.tick();
        }
      } catch { /* ignore */ }
    },
    dispose: async () => { for (const { watcher } of followers.values()) { try { watcher.stop(); } catch { /* ignore */ } } followers.clear(); },
  };
};

// OpenCode 1.18.27 PATH-plugin loader (discovered from .opencode/plugins/*.js)
// requires the module to export an `id` (runtime error otherwise: "Path plugin
// <file> must export id"). It then consumes `server` as the Plugin factory. The
// named factory export is kept so the unit tests can drive it directly.
export const id = 'soc-attached-observability';
export const server = SocAttachedObservabilityPlugin;
export default { id, server: SocAttachedObservabilityPlugin };
