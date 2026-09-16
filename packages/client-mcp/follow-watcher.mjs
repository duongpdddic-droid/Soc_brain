#!/usr/bin/env node
// follow-watcher.mjs — F1 (P0): the minimum AUTOMATIC follower that removes manual
// get_task/get_progress polling from the normal UX. After ONE submit/attach the
// control client follows the SAME pinned canonical task and OPERATIONAL state
// changes appear on their own; execution stays detached (this only observes).
//
// Smallest mechanism compatible with #180/#182/#183: no socket, no WebSocket, no
// new lifecycle. It is a read-only poller over the durable canonical state that
// the detached worker already writes, and it pushes compact JSON-RPC
// `notifications/message` (MCP logging notification) onto the EXISTING stdio
// transport only when the effective state CHANGES.
//
// Invariants:
//   * bound to ONE identity -> a watcher never emits for another task (no
//     cross-stream contamination);
//   * dedupe by durable `seq` -> exactly-once per real change, no flapping, so a
//     transport restart that re-pins the same identity RESUMES following (the
//     first tick after reattach surfaces the current state; no resubmit);
//   * snapshot()/emit() are injected -> fully testable with no timers, no fs, no
//     real process; production wires snapshot to client-control.operationalView
//     and emit to the stdio writer;
//   * it NEVER mutates lifecycle and NEVER streams reasoning — it relays only the
//     operational view built from canonical reads.

export const FOLLOW_DEFAULT_INTERVAL_MS = 2000;

export function createFollowWatcher({
  identity,
  snapshot,
  emit,
  intervalMs = FOLLOW_DEFAULT_INTERVAL_MS,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (h) => clearInterval(h),
  onError = () => {},
} = {}) {
  if (!identity || typeof identity !== 'object') throw new Error('follow identity required');
  if (typeof snapshot !== 'function') throw new Error('follow snapshot required');
  if (typeof emit !== 'function') throw new Error('follow emit required');

  let lastSeq = null;
  let started = false;
  let handle = null;
  let stopped = false;
  let ticks = 0;

  // One deterministic observation. Returns the emitted notification or null (no
  // change). A snapshot failure is swallowed to onError and must never crash the
  // transport.
  function tick() {
    if (stopped) return null;
    ticks += 1;
    let view;
    try { view = snapshot(); } catch (e) { onError(e); return null; }
    if (!view || view.ok !== true) return null;
    const seq = view.seq;
    if (seq != null && seq === lastSeq) return null; // unchanged -> dedupe
    lastSeq = seq ?? `tick:${ticks}`;
    let payload = null;
    try { payload = view.payload ?? view; } catch { payload = null; }
    let res = null;
    try { res = emit(payload); } catch (e) { onError(e); return null; }
    return { emitted: res !== false, view: payload };
  }

  function start() {
    if (started || stopped) return;
    started = true;
    handle = setIntervalFn(() => { tick(); }, intervalMs);
    if (handle && typeof handle.unref === 'function') { try { handle.unref(); } catch { /* keep alive if host disallows */ } }
  }
  function stop() {
    stopped = true;
    if (handle != null) { try { clearIntervalFn(handle); } catch { /* best effort */ } handle = null; }
  }
  // Rebind the dedupe baseline (used on reconnect/reattach so the next tick always
  // re-surfaces current state for the SAME identity without a resubmit).
  function resync() { lastSeq = null; }

  return { identity, tick, start, stop, resync, get started() { return started; }, get stopped() { return stopped; } };
}
