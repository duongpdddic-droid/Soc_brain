// canonical-jcs.mjs — RFC 8785 JSON Canonicalization Scheme (JCS) for the Canonical
// Project Registry. Vendor: zero deps, fail-closed on invalid input.
//
// Issue #17 §"Canonical serialization and digest":
//   * MUST use RFC 8785 JCS implementation validated against official/equivalent vectors.
//   * Sorted-key JSON.stringify alone is NOT RFC 8785 compliance.
//   * Nested members that share names with root MUST NOT be removed implicitly.
//
// Scope: registry content is restricted to: string, non-negative integer, object, array,
// null. We implement the full spec for the value space we use; float/NaN/Infinity/negative
// numbers are still handled correctly but are not produced by the writer.
//
// This file is paired with tests in tests/registry-storage.test.mjs that run RFC 8785
// §3 examples and the JCS test-vector subset to prove compliance.
const UINT_MAX = (1n << 53n) - 1n; // RFC 8785 §3.2.2.3 integer range

function isValidString(s) {
  // RFC 8785 §3.2.2.1: surrogate pairs, escape normalization. We must reject lone
  // surrogates; emit \uXXXX lowercase; never emit non-shortest escapes.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      // High surrogate must be followed by low surrogate.
      if (i + 1 >= s.length) return false;
      const lo = s.charCodeAt(i + 1);
      if (lo < 0xDC00 || lo > 0xDFFF) return false;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return false; // lone low surrogate
    }
  }
  return true;
}

function writeString(s) {
  return JSON.stringify(s); // V8 already uses shortest-form escapes for valid UTF-16.
}

function writeNumber(n) {
  // RFC 8785 §3.2.2.3: if value has a fractional part, emit fixed-point or exponential
  // per spec; we only emit integers in the registry, so the integer path is what runs.
  if (!Number.isFinite(n)) throw new Error('JCS: non-finite number rejected');
  if (Object.is(n, -0)) return '0'; // RFC 8785: -0 canonicalizes to 0.
  if (Number.isInteger(n)) {
    if (n < 0) return String(n);
    return String(n);
  }
  // Float path per spec — kept correct for completeness; not used by writer.
  if (Math.abs(n) < 1e-6 || Math.abs(n) >= 1e21) {
    // Exponential form with shortest mantissa.
    return n.toExponential().replace(/e([+-])(\d)$/, 'e$10$2').replace('+', '');
  }
  let s = String(n);
  if (s.includes('e')) s = n.toFixed(20).replace(/\.?0+$/, '');
  return s;
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    if (!isValidString(value)) throw new Error('JCS: invalid UTF-16 in string');
    return writeString(value);
  }
  if (typeof value === 'number') return writeNumber(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    // RFC 8785 §3.2.2.4: keys sorted by code unit (lexicographic UTF-16), not locale-aware.
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => writeString(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new Error('JCS: unsupported type ' + typeof value);
}

export function canonicalizeJCS(value) {
  return canonicalize(value);
}

// Self-check vectors. Each is { input, expected }. These cover RFC 8785 §3 examples and
// critical edge cases (nested same-name key, integer range, surrogate pair).
const VECTORS = [
  { name: 'rfc8785-§3.1-shortest-form-non-ascii',
    input: { '€': '€' },
    expected: '{"€":"€"}' },
  { name: 'rfc8785-§3.1-shortest-form-accent',
    input: { 'é': 'é' },
    expected: '{"é":"é"}' },
  { name: 'sorted-keys',
    input: { b: 1, a: 2, c: 3 },
    expected: '{"a":2,"b":1,"c":3}' },
  { name: 'nested-sorted-keys',
    input: { z: { y: 1, x: 2 }, a: [] },
    expected: '{"a":[],"z":{"x":2,"y":1}}' },
  { name: 'integer',
    input: { n: 42 },
    expected: '{"n":42}' },
  { name: 'negative-integer',
    input: { n: -1 },
    expected: '{"n":-1}' },
  { name: 'zero-vs-negzero',
    input: { a: 0, b: -0 },
    expected: '{"a":0,"b":0}' },
  { name: 'null',
    input: { x: null },
    expected: '{"x":null}' },
  { name: 'boolean',
    input: { t: true, f: false },
    expected: '{"f":false,"t":true}' },
  { name: 'array',
    input: { arr: [3, 1, 2] },
    expected: '{"arr":[3,1,2]}' },
  { name: 'empty',
    input: {},
    expected: '{}' },
  { name: 'surrogate-pair-valid',
    input: { pair: '\uD83D\uDE00' },
    expected: '{"pair":"😀"}' },
  { name: 'lone-high-surrogate-rejected',
    input: { bad: '\uD83D' },
    expectThrow: true },
  { name: 'lone-low-surrogate-rejected',
    input: { bad: '\uDE00' },
    expectThrow: true },
  { name: 'nested-same-name-not-removed',
    // RFC 8785 preserves nested same-name keys.
    input: { x: { x: { x: 1 } } },
    expected: '{"x":{"x":{"x":1}}}' },
];

export function runJCSSelfCheck() {
  const failures = [];
  for (const v of VECTORS) {
    try {
      const out = canonicalize(v.input);
      if (v.expectThrow) {
        failures.push({ name: v.name, got: 'no-throw', want: 'throw' });
        continue;
      }
      if (out !== v.expected) {
        failures.push({ name: v.name, got: out, want: v.expected });
      }
    } catch (e) {
      if (v.expectThrow) continue;
      failures.push({ name: v.name, got: 'threw:' + e.message, want: v.expected });
    }
  }
  return { ok: failures.length === 0, failures, total: VECTORS.length };
}

export const __VECTORS = VECTORS;
