#!/usr/bin/env node
// event-delivery.mjs — Soc_brain: bounded, ACK-retained, replayable event
// delivery over a single ordered channel (deterministic core).
//
// Ported (Node/ESM adaptation) from Omnigent
// (https://github.com/omnigent-ai/omnigent)
// omnigent/runner/transports/ws_tunnel/event_delivery.py @ 12a0d5c8737571980b84869c2df00b17d0b42c9b.
// Copyright (2026) Databricks, Inc. Licensed under the Apache License 2.0.
// (RunnerEventDispatcher: bounded queue 32, per-source ACK-retain-replay,
// partial-ack slicing, retryable/non-retryable semantics, preview vs durable
// distinction, generation-checked acknowledgement.)
//
// Why this exists (proven gap): Soc_brain's executor event path is an
// append-only NDJSON file with tail reads — no producer-side bounded queue,
// no ACK, no replay-on-reconnect. Any future live event channel (SSE, WS,
// broker streaming) needs exactly this deterministic core; porting it now as
// a pure state machine keeps the semantics testable WITHOUT a network.
//
// Adaptation decisions (documented, not silent):
//   - No asyncio/websockets/httpx: pure JS state machine + injected clock/
//     sleep/send. The transport (SSE/WS/pipe) is a caller concern; this
//     module owns queueing, ordering, ACK validation, replay and backoff.
//   - Two promise layers, deliberately separated (the upstream Future layering):
//     the PRODUCER promise (submit's return) is resolved only on terminal
//     outcome (full acceptance / non-retryable partial / error), while the
//     per-attempt ACK handshake uses an internal pending map keyed by
//     batchId. Conflating the two loses the batch on a partial ACK.
//   - Generation tokens replace tunnel generations: every connect() bumps a
//     generation; an ACK stamped with a stale generation is IGNORED (an ACK
//     can arrive after its connection died — it must not resolve a newer
//     delivery attempt).
//   - Preview vs durable: preview batches (best-effort display deltas) fail
//     fast instead of retaining; durable batches keep their source cursor
//     and are retained at the queue HEAD for replay on the next generation.
//   - Bounded queue: submit() rejects with QUEUE_FULL when queue+in-flight
//     reach the bound (backpressure — never unbounded memory).
//   - Only an ACK-covered batch advances the source replay cursor (upstream:
//     each forwarder awaits delivery before advancing its on-disk cursor).
//
// Pure except injected sleep/clock. No framework. Node >= 22.

export const MAX_PENDING_BATCHES = 32;
export const MAX_BATCH_EVENTS = 32;
export const RETRY_DELAY_MS = 250;
export const ACK_TIMEOUT_MS = 30000;

export const DELIVERY_STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  NEGOTIATING: 'negotiating',
  READY: 'ready',
  UNSUPPORTED: 'unsupported',
});

const noopSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultClock() { return Date.now(); }

// Local error classes (no dependency).
export class DeliveryError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'DeliveryError'; }
}
export class ConnectionError extends Error {
  constructor(message) { super(message); this.code = 'CONNECTION'; this.name = 'ConnectionError'; }
}

export class EventDelivery {
  constructor({
    maxPending = MAX_PENDING_BATCHES,
    maxEvents = MAX_BATCH_EVENTS,
    retryDelayMs = RETRY_DELAY_MS,
    ackTimeoutMs = ACK_TIMEOUT_MS,
    sleep = noopSleep,
    clock = defaultClock,
    newBatchId = null,
  } = {}) {
    this.maxPending = maxPending;
    this.maxEvents = maxEvents;
    this.retryDelayMs = retryDelayMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.sleep = sleep;
    this.clock = clock;
    this._newBatchId = typeof newBatchId === 'function' ? newBatchId : (() => `b${Math.random().toString(16).slice(2)}${clock()}`);
    this.state = DELIVERY_STATE.DISCONNECTED;
    this.generation = 0;             // bumped on every connect()
    this.send = null;                 // async (batch) => void, set by connect()
    this.pending = new Map();         // batchId -> { resolve, reject, generation, timer } (ACK layer)
    this.queue = [];                  // retained durable items, FIFO replay order
    this.inFlight = new Set();        // items owned by an active _deliver (backoff included)
    this.sourceCursors = new Map();   // sourceId -> ACKed event count (replay cursor)
    this.lastDispatchAt = null;       // clock() of the last ACK-covered progress
  }

  get hasPending() { return this.pending.size > 0; }
  get queueDepth() { return this.queue.length; }

  // ---- connection lifecycle ----------------------------------------------------
  // connect() starts a NEW generation in NEGOTIATING; only ready() enables
  // delivery (upstream: capability negotiation before event.ready). Every
  // in-flight ACK from the previous generation is failed; source events
  // remain retained for replay.
  connect(send) {
    if (typeof send !== 'function') throw new TypeError('connect(send): send must be a function');
    this.send = send;
    this.generation += 1;
    this.state = DELIVERY_STATE.NEGOTIATING;
    for (const batchId of [...this.pending.keys()]) {
      this._settleAck(batchId, { transportError: new ConnectionError('connection generation replaced') });
    }
  }

  ready() {
    this.state = DELIVERY_STATE.READY;
    // Replay every retained durable item in order (upstream: retransmit
    // source-keyed items on the next ready tunnel generation).
    const retained = this.queue.splice(0, this.queue.length);
    for (const item of retained) {
      this._deliver(item).catch(() => { /* terminal outcomes settle on the item */ });
    }
  }

  unsupported() {
    this.state = DELIVERY_STATE.UNSUPPORTED;
  }

  disconnected() {
    this.send = null;
    this.state = DELIVERY_STATE.DISCONNECTED;
    for (const batchId of [...this.pending.keys()]) {
      this._settleAck(batchId, { transportError: new ConnectionError('disconnected') });
    }
    // queue + sourceCursors are RETAINED: durable events replay on reconnect.
  }

  // ---- acknowledgement (transport side) -----------------------------------------
  // Matches an ACK to the current in-flight attempt. Unknown batch, stale
  // generation, or an out-of-range `applied` => { ok:false, reason } and
  // NOTHING settles (an ACK that arrives after its connection died must
  // never resolve a newer attempt). Range validation happens HERE, before
  // the handshake settles: a malformed ACK never advances the cursor and
  // never kills a deliverable batch — the attempt keeps waiting for a
  // valid one (upstream raises in its delivery loop; we reject at the
  // gate instead so the batch stays recoverable).
  acknowledge({ id, applied = 0, retryable = false, error = null, generation = this.generation } = {}) {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, reason: 'UNKNOWN_BATCH' };
    if (entry.generation !== generation) return { ok: false, reason: 'STALE_GENERATION' };
    if (!Number.isInteger(applied) || applied < 0 || applied > entry.size) {
      return { ok: false, reason: 'INVALID_ACK' };
    }
    this._settleAck(id, { applied, retryable, error });
    return { ok: true, id, applied };
  }

  // Settle the ACK LAYER only (the per-attempt handshake promise).
  // transportError => REJECT the handshake (connection lost / ACK timeout).
  // ack `error` is DATA (a vendor refusal such as 'forbidden') carried on a
  // SUCCESSFUL handshake — conflating the two wedges the delivery loop into
  // an infinite transport retry on a terminal vendor rejection.
  _settleAck(batchId, result) {
    const entry = this.pending.get(batchId);
    if (!entry) return;
    this.pending.delete(batchId);
    if (entry.timer) clearTimeout(entry.timer);
    if (result.transportError) entry.reject(result.transportError);
    else entry.resolve({ applied: result.applied, retryable: result.retryable, error: result.error || null });
  }

  // ---- submit (producer entry point) -------------------------------------------
  // Enqueue one ordered batch; the returned promise resolves only on terminal
  // outcome: full acceptance ({ok:true, applied}) or an accepted partial with
  // a non-retryable vendor error. Connection loss NEVER resolves a durable
  // producer promise — it stays pending until a future generation ACKs the
  // retained batch (source cursor semantics). Rejection modes:
  // EMPTY_BATCH, BATCH_TOO_LARGE, QUEUE_FULL, UNSUPPORTED, PREVIEW_BACKPRESSURE,
  // ACK_TIMEOUT, INVALID_ACK.
  submit({ sourceId, events, preview = false }) {
    if (typeof sourceId !== 'string' || !sourceId) {
      return Promise.reject(new DeliveryError('SOURCE_ID_REQUIRED', 'sourceId must be a non-empty string'));
    }
    if (!Array.isArray(events) || events.length === 0) {
      return Promise.reject(new DeliveryError('EMPTY_BATCH', 'events must be a non-empty array'));
    }
    if (events.length > this.maxEvents) {
      return Promise.reject(new DeliveryError('BATCH_TOO_LARGE', `batch exceeds ${this.maxEvents} events`));
    }
    if (this.queue.length + this.inFlight.size >= this.maxPending) {
      // Bound covers items parked in retry backoff too (they are owned by an
      // active _deliver, not queued): a READY-but-failing channel must never
      // admit unbounded live items — backpressure holds under sustained failure.
      return Promise.reject(new DeliveryError('QUEUE_FULL', `delivery queue is full (${this.maxPending})`));
    }
    if (this.state === DELIVERY_STATE.UNSUPPORTED) {
      return Promise.reject(new DeliveryError('UNSUPPORTED', 'channel does not support event ingestion'));
    }
    const batchId = this._newBatchId();
    const item = { sourceId, events: events.slice(), preview: Boolean(preview), batchId, appliedBefore: 0 };
    return new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
      if (this.state === DELIVERY_STATE.READY && typeof this.send === 'function') {
        this._deliver(item).catch(() => { /* terminal outcomes settle on the item */ });
        return;
      }
      if (item.preview) {
        // Preview is best-effort: fail fast instead of retaining (upstream).
        item.reject(new DeliveryError('PREVIEW_BACKPRESSURE', 'preview batch dropped: channel not ready'));
        return;
      }
      // Durable: retain; the next ready() re-drains in FIFO order.
      this.queue.push(item);
    });
  }

  // Requeue the UN-ACKed remainder at the queue HEAD for the next generation.
  // The ACK-covered prefix already advanced the source cursor; replaying it
  // too would double-count (cursor > unique ACKed events => a resume-from-
  // cursor consumer silently SKIPS events). appliedBefore carries the
  // already-confirmed count so the producer's terminal report stays whole.
  _retain(item, remaining) {
    item.appliedBefore += item.events.length - remaining.length;
    item.events = remaining.slice();
    this.queue.unshift(item);
  }

  // ---- internal delivery ------------------------------------------------------------
  // Ownership wrapper: every item inside the delivery loop counts against the
  // submit() bound for its WHOLE lifetime (send + ACK wait + retry backoff),
  // and is released exactly when the loop returns (requeued -> queue, or
  // terminal -> settled).
  async _deliver(item) {
    this.inFlight.add(item);
    try {
      await this._runDelivery(item);
    } finally {
      this.inFlight.delete(item);
    }
  }

  async _runDelivery(item) {
    let remaining = item.events.slice();
    const generationAtStart = this.generation;
    for (;;) {
      if (this.state !== DELIVERY_STATE.READY || typeof this.send !== 'function') {
        if (item.preview) {
          item.reject(new DeliveryError('PREVIEW_BACKPRESSURE', 'preview batch dropped: channel lost'));
          return;
        }
        // Durable: retain at the HEAD for the next generation, in order.
        // The producer promise stays PENDING until that generation ACKs it.
        this._retain(item, remaining);
        return;
      }
      const batch = { id: item.batchId, sourceId: item.sourceId, events: remaining, generation: this.generation };
      let ack;
      try {
        ack = await new Promise((resolveAck, rejectAck) => {
          // size = events in THIS attempt's batch: the range bound for acknowledge().
          this.pending.set(item.batchId, { resolve: resolveAck, reject: rejectAck, generation: this.generation, timer: null, size: remaining.length });
          const entry = this.pending.get(item.batchId);
          entry.timer = setTimeout(() => {
            this._settleAck(item.batchId, { transportError: new DeliveryError('ACK_TIMEOUT', `no ACK within ${this.ackTimeoutMs}ms`) });
          }, this.ackTimeoutMs);
          if (entry.timer.unref) entry.timer.unref();
          this.send(batch).catch(rejectAck);
        });
      } catch (e) {
        // Send failure, ACK timeout, or disconnect mid-flight. The ACK may
        // still have been committed upstream — durable batches replay with
        // the SAME batchId (receiver dedupes by id); preview fails fast.
        const stale = this.pending.get(item.batchId);
        if (stale && stale.timer) clearTimeout(stale.timer);
        this.pending.delete(item.batchId);
        if (item.preview) {
          item.reject(e instanceof DeliveryError ? e : new DeliveryError('PREVIEW_BACKPRESSURE', String((e && e.message) || e)));
          return;
        }
        if (generationAtStart !== this.generation) {
          // Connection replaced: retain the UN-ACKed remainder only.
          this._retain(item, remaining);
          return;
        }
        await this.sleep(this.retryDelayMs);
        continue;
      }
      // ACK validation: applied MUST be an integer within [0, remaining.length]
      // (upstream raises ValueError on out-of-range ack.applied — an invalid
      // ACK is never trusted and never advances the cursor).
      if (!Number.isInteger(ack.applied) || ack.applied < 0 || ack.applied > remaining.length) {
        item.reject(new DeliveryError('INVALID_ACK', 'ack.applied out of range'));
        return;
      }
      remaining = remaining.slice(ack.applied);
      // Cursor advance: exactly the events this attempt's ACK confirmed
      // (ack.applied), never the whole original batch — a batch that went
      // through a retryable partial ACK would otherwise double-count the
      // already-confirmed prefix when a later attempt is fully accepted.
      this.sourceCursors.set(item.sourceId, (this.sourceCursors.get(item.sourceId) || 0) + ack.applied);
      if (remaining.length === 0) {
        this.lastDispatchAt = this.clock();
        // applied reports the WHOLE original batch: previously-confirmed
        // prefix (appliedBefore, carried across a requeue) + this generation.
        item.resolve({ id: item.batchId, ok: true, applied: item.appliedBefore + item.events.length, error: ack.error || null });
        return;
      }
      if (!ack.retryable) {
        // Partial, non-retryable: report what WAS accepted across ALL
        // attempts (including any prefix confirmed before a requeue);
        // remainder is the caller's error surface (upstream returns the
        // partial ack + error).
        const accepted = item.appliedBefore + item.events.length - remaining.length;
        item.resolve({ id: item.batchId, ok: false, applied: accepted, retryable: false, error: ack.error || new Error('batch partially accepted') });
        return;
      }
      // Retryable partial ACK: cursor already advanced for what WAS accepted
      // above; wait out the backoff and resend only the remainder.
      this.lastDispatchAt = this.clock();
      await this.sleep(this.retryDelayMs);
    }
  }

  // Replay support: the last ACKed event count per source (upstream forwarder
  // cursor semantics — the producer advances its cursor only after ACK).
  cursor(sourceId) { return this.sourceCursors.get(sourceId) || 0; }
}
