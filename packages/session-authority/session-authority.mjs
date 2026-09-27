// session-authority.mjs — public surface of the Centralized Session Admission
// Authority (SOC_TASK_CONTRACT §2-§3).
//
// Layering:
//   protocol.mjs            framing, canonicalization, endpoint naming, codes
//   authority-server.mjs    ONE daemon -> ONE registry (bind-locked endpoint)
//   authority-client.mjs    fail-closed transport client (no file fallback)
//   guard.mjs               per-process mutation fence (sync boundary check)
//
// The activity-lease (runtime-sandbox/activity-lease.mjs) is deliberately NOT
// re-exported here: it remains a pure liveness signal for the idle supervisor
// and never grants mutation rights.

export * from './protocol.mjs';
export { createSessionAuthority, classifyIncarnation, acquireBindLock, releaseBindLock, ENTRY_STATE } from './authority-server.mjs';
export { createAuthorityClient, AUTHORITY_CODES } from './authority-client.mjs';
export {
  admitSession, assertAdmissionFence, refreshAdmissionFence, releaseAdmission,
  attachAdmissionWorker, detachAdmissionWorker, closeSessionAdmission,
  describeAdmission, sessionAdmissionMode, setSessionAdmissionMode,
  isSessionAdmissionArmed, ADMISSION_MODE_ENV, FENCE_RENEW_MS, FENCE_MAX_STALE_MS,
  __resetAdmissionForTests,
} from './guard.mjs';
