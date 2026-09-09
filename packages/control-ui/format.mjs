#!/usr/bin/env node
// format.mjs — presentation-only time formatting (Issue #136, step 5).
// Canonical timestamps stay UTC ISO everywhere (never mutated); this converts
// to the VIEWER's local timezone at render time using local Date getters.
// No timezone is hardcoded (no UTC+7): correctness follows the browser/OS.
// `d` is duck-typed (any object with the local getters) so tests are
// developer-machine independent.

export function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// 'dd/MM/yyyy HH:mm:ss' in local time; null for absent/invalid input.
// Duck-typed input (any object with the local getters) renders directly so
// tests never depend on the developer machine's timezone.
export function formatLocalIso(d) {
  if (d == null) return null;
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    return render(d);
  }
  if (typeof d === 'object' && typeof d.getFullYear === 'function') return render(d);
  const x = new Date(d);
  if (!x || isNaN(x.getTime())) return null;
  return render(x);
}

function render(x) {
  return pad2(x.getDate()) + '/' + pad2(x.getMonth() + 1) + '/' + x.getFullYear()
    + ' ' + pad2(x.getHours()) + ':' + pad2(x.getMinutes()) + ':' + pad2(x.getSeconds());
}
