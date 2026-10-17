// packages/executor-launcher/test-plan.mjs — the CANONICAL, deterministic
// affected-test planner shared by every test entrypoint of this repo
// (scripts/run-tier.mjs `gate:tier`, scripts/run-tier-tests.mjs tier
// wrapper, and the control-plane ACTIVE test gate in
// executor-launcher/test-run-evidence.mjs).
//
// Responsibilities (ONE source, ONE selector):
//   * load + fail-closed validate the single manifest `tests/tiers.json`
//     (one owner tier per file; orphan/duplicate/ghost/malformed-smoke
//     references are rejected — never silently repaired);
//   * resolve the BASE binding to an exact 40-hex SHA inside THIS repo and
//     prove the candidate has a real git relationship to it (merge-base);
//   * compute the changed set = merge-base -> candidate, PLUS tracked
//     dirty content and untracked files (so a PRE-COMMIT candidate is
//     planned against what is actually there), ignoring only
//     artifacts/logs that are PROVEN non-runtime (manifest ignore rules);
//   * build the reverse dependency closure over static imports/re-exports,
//     literal dynamic `import('...')` and `require('...')`: a test is
//     selected when its import closure CONTAINS a changed file, so
//     A -> B -> C chains, cycles, renames and deletions all resolve;
//   * anything that cannot be PROVEN to have no effect (unknown
//     extension, no resolvable dependency, shared runtime/selector/manifest
//     change, entrypoint change) selects the FULL inventory with an
//     explicit reason — never a silent T1+T2 subset;
//   * bind the plan: mode, status, base/candidate SHA, selected files,
//     reasons, manifest digest, selector version+digest and a planDigest,
//     so a stale/tampered plan can be refused before execution.
//
// The planner NEVER executes anything and never trusts caller-provided
// argv: `validateTestPlan` + `testPlanGateCommand` are the only bridge to
// execution, and both re-derive the spawn argv from validated files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeWorktreeContentBinding } from './execution-content-binding.mjs';

export const TEST_PLAN_SELECTOR_VERSION = '1';

export const TEST_PLAN_CODES = Object.freeze({
  MANIFEST_INVALID: 'TEST_PLAN_MANIFEST_INVALID',
  BASE_UNRESOLVED: 'TEST_PLAN_BASE_UNRESOLVED',
  BASE_UNRELATED: 'TEST_PLAN_BASE_UNRELATED',
  BASE_MISMATCH: 'TEST_PLAN_BASE_MISMATCH',
  CANDIDATE_UNKNOWN: 'TEST_PLAN_CANDIDATE_UNKNOWN',
  CONTENT_BINDING_UNAVAILABLE: 'TEST_PLAN_CONTENT_BINDING_UNAVAILABLE',
  // Raised by the CONSUMER (review-evidence) when a plan-mode record exists
  // but the task's canonical BASE binding (ExecutionRecord/session baseSha) is
  // absent or malformed: nothing can vouch for the plan's own baseSha, so the
  // run is refused instead of silently skipping the BASE comparison.
  BASE_BINDING_UNAVAILABLE: 'TEST_PLAN_BASE_BINDING_UNAVAILABLE',
  PLAN_INVALID: 'TEST_PLAN_INVALID',
  PLAN_STALE: 'TEST_PLAN_PLAN_STALE',
  PATH_ESCAPE: 'TEST_PLAN_PATH_ESCAPE',
  PATH_NOT_TEST: 'TEST_PLAN_PATH_NOT_TEST',
  TAP_SUMMARY_INVALID: 'TEST_PLAN_TAP_SUMMARY_INVALID',
});

export const TEST_PLAN_NO_TESTS_REASONS = Object.freeze({
  DOCS_ONLY: 'docs-only: every changed path is a proven non-runtime doc/artifact',
  NO_CHANGES: 'empty changeset',
});

// Directories never walked for the import graph. `worktrees` holds OTHER
// tasks' isolated workspaces — importing from there would break isolation.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'worktrees', 'artifacts', 'coverage', '.codex', '.tmp']);
const JS_EXT = ['.mjs', '.js', '.cjs'];

// Specifier matchers. They run over the CODE VIEW produced by `lexJs` — where
// comments, regex bodies and string/template TEXT are already blanked with the
// delimiters kept — so prose can never be read as a specifier and a call site
// hidden in a comment or a template's literal text can never be seen. Each
// matcher ends by capturing the OPENING QUOTE of the specifier; the literal
// table from the SAME lexer supplies the DECODED value at that offset, so the
// extractor and the opaque detector can never disagree about a call site.
const STATIC_FROM_RE = /(?:^|[\s;)])(?:import|export)\b[^;'"]*?\bfrom\s*(['"])/g;
const DYN_IMPORT_RE = /\bimport\s*\(/g;      // literal dynamic import('spec') (validated below)
const SIDE_EFFECT_RE = /\bimport\s*(['"])/g; // bare side-effect import 'spec'
const REQUIRE_RE = /\brequire\s*\(/g;        // require('spec') (.cjs helpers)

// Every dynamic import() CALL SITE (any argument) is inspected below: only a
// call whose WHOLE argument is a plain single/double-quoted string literal —
// the exact form the literal extractor can resolve — is a known dependency.
// Any other argument (template, concatenation, identifier, call, a comment
// before the literal, spread...) has an INCOMPLETE dependency set, so a change
// to such a file cannot be reasoned about and the file is OPAQUE. A "starts
// with a quote" test is NOT enough: `import('../x/' + name)` resolves no edge
// but would have been silently treated as safe.

// ---------------------------------------------------------------------------
// Regex-vs-division needs TOKEN context, never a whitespace-stripped character
// string. Two things a character tail cannot see:
//   * `+ +` (two unary operators) is NOT the `++` token, so a `/` after it
//     OPENS a regex — gluing the characters together decided the opposite and
//     blanked a real `import(...)` that followed.
//   * a `}` that closes an OBJECT literal leaves an expression behind, so a
//     following `/` is DIVISION; a `}` that closes a BLOCK begins a new
//     statement, so `/` is a REGEX.
// The view therefore tracks the previous significant TOKEN's kind:
//   'operand'  — an expression just ended (identifier, literal, `)`, `]`,
//                object-`}`, postfix `++`/`--`, member PROPERTY NAME)
//                -> `/` is DIVISION
//   'exprOpen' — an expression just began (operators, `(`, `[`, keywords such
//                as `return`, `${`, block-`}`)    -> `/` is a REGEX
//   'unknown'  — the context could NOT be proven (an unbalanced / uncertain
//                brace)                          -> a `/` makes the file OPAQUE
//                (fail-closed: an unproven context must never blank code and
//                then be read as "this file has no import").
const OPERAND_WORDS = new Set(['this', 'super', 'true', 'false', 'null']);
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return',
  'static', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield',
]);
// `{` right after one of these opens a BLOCK, not an object literal.
const BLOCK_AFTER = new Set(['=>', 'else', 'do', 'try', 'finally', 'catch']);

function classifyWord(word) {
  if (OPERAND_WORDS.has(word)) return 'operand';
  return RESERVED_WORDS.has(word) ? 'exprOpen' : 'operand';
}

// (PR285-R3-02 r10) UNICODE IDENTIFIER CLASSES, STANDARD-SHAPED, SCANNED BY
// CODE POINT. `identAdvance` returns how many UTF-16 units the identifier
// character at `k` occupies (1 for BMP, 2 for a valid surrogate pair) and 0
// when the position is NOT an identifier character of the demanded class.
//   START = ID_Start  ~= L + Nl + Other_ID_Start (+ `$`, ASCII `_`, A-Za-z)
//   CONT  = ID_Continue ~= Mn + Mc + Nd + Pc + L + Nl + ZWJ/ZWNJ
//                       + Other_ID_Continue (+ `\w` ASCII, `$`)
// A valid surrogate PAIR is tested as ONE code point against the same
// classes, so astral-plane identifiers (`const 𐌰 = 1;`) no longer split
// mid-character; a LONE surrogate is never an identifier character. The
// finite Other_ID_* exception code points are the standard documented sets.
// Anything these classes REJECT cannot be proven to be part of any supported
// token and is failed CLOSED by the caller (uncertain -> OPAQUE), never
// silently reclassified.
const ID_START_CP = /[\p{L}\p{Nl}\u1885\u1886\u2118\u212E\u309B\u309C]/u;
const ID_CONT_CP = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\u200C\u200D\u00B7\u0387\u1369-\u1371\u19DA]/u;
function identAdvance(src, k, isStart) {
  if (k >= src.length) return 0; // end of input (also keeps `src[k]` a real char)
  const c1 = src.charCodeAt(k);
  if (c1 >= 0xD800 && c1 <= 0xDBFF) {
    const c2 = k + 1 < src.length ? src.charCodeAt(k + 1) : 0;
    if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
      return (isStart ? ID_START_CP : ID_CONT_CP).test(src.slice(k, k + 2)) ? 2 : 0;
    }
    return 0; // a lone high surrogate cannot be an identifier character
  }
  if (c1 >= 0x61 && c1 <= 0x7A) return 1; // a-z
  if (c1 >= 0x41 && c1 <= 0x5A) return 1; // A-Z
  if (c1 === 0x5F || c1 === 0x24) return 1; // `_` or `$`
  if (isStart) return ID_START_CP.test(src[k]) ? 1 : 0;
  if (c1 >= 0x30 && c1 <= 0x39) return 1; // 0-9 (continue only)
  if (ID_CONT_CP.test(src[k])) return 1;  // Unicode classes + ZWJ/ZWNJ + Other_ID_Continue
  return 0;
}

// A `{` is classified by its OPENING context into the PREVKIND its CLOSING
// `}` must take: 'operand' (an object literal leaves an expression behind,
// so a `/` after it is DIVISION), 'exprOpen' (a block returns to statement
// position, so a `/` may open a REGEX), 'unknown' (unprovable context).
function classifyBrace(prevKind, lastToken) {
  if (prevKind === 'unknown') return 'unknown';
  if (prevKind !== 'exprOpen') return 'exprOpen';
  return BLOCK_AFTER.has(lastToken) ? 'exprOpen' : 'operand';
}

// (PR285-R3-02 r8) FUNCTION EXPRESSION vs DECLARATION decides whether the `/`
// after a function body `}` is division or a regex. The `function` keyword
// lexes into a pending ARM (inside `lexJs`) that follows the shape keyword ->
// (optional `*`) -> (optional name) -> `(...)` -> body `{`, and — when the
// body opens — supplies the prevKind its closing `}` must leave behind. That
// verdict is computed ONLY from the token BEFORE the keyword, and only when
// that position PROVES the kind: after these tokens a `function` can only be
// an EXPRESSION (`const n = function () {} / 2` is division; `${...}` heads
// the same list — see round 9 below), after those it can only be a DECLARATION
// statement (a regex may follow its body). After anything else — an
// identifier, a number, a dangling `)`, `export default` — the kind cannot be
// proven, so the arm carries 'unknown' and the FIRST `/` after its body fails
// CLOSED (the file becomes OPAQUE) instead of opening a phantom regex that
// would blank the real `await import(...)` behind it.
// (PR285-R3-02 r9) The HEAD of a template interpolation (`${`) is an
// EXPRESSION position — a DISTINCT context from a program/statement start.
// Both used to share the empty-token sentinel, which put
// `${ function () {} / 2 }` in the DECLARATION bucket and let its body `}`
// open a phantom regex over the real import. The interpolation entry now
// leaves the sentinel `'${'` on the token tape, listed below.
const FN_EXPR_BOUNDARY = new Set([
  '${', '=', '(', ',', '[', ':', '?', '!', '+', '-', '*', '%', '<', '>', '&', '|', '^', '~',
  'return', 'typeof', 'void', 'delete', 'new', 'throw', 'instanceof', 'in', 'of', '=>',
]);
const FN_DECL_BOUNDARY = new Set(['', ';', '}', '{', 'export']);
function fnExpectation(boundaryToken) {
  if (FN_EXPR_BOUNDARY.has(boundaryToken)) return 'operand';
  if (FN_DECL_BOUNDARY.has(boundaryToken)) return 'exprOpen';
  return 'unknown';
}

// The next significant IDENTIFIER strictly after offset `from` — whitespace is
// skipped and line/block comments are stepped over. Used only by the
// `async function` composite-keyword handling: whether an `async` word belongs
// to the keyword pair or is an ordinary identifier (`const async = 1`,
// `o.async`) is decided by what immediately follows it, comments included.
function peekNextWord(src, from) {
  let k = from;
  for (;;) {
    while (k < src.length && /\s/.test(src[k])) k += 1;
    if (src[k] === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k += 1; continue; }
    if (src[k] === '/' && src[k + 1] === '*') {
      const end = src.indexOf('*/', k + 2);
      if (end < 0) return '';
      k = end + 2; continue;
    }
    break;
  }
  if (k < src.length && /[A-Za-z_$]/.test(src[k])) {
    let j = k;
    while (j < src.length && /[\w$]/.test(src[j])) j += 1;
    return src.slice(k, j);
  }
  return '';
}

/**
 * Return `source` with the CONTENTS of comments and string/template/regex
 * literals blanked out (quotes and newlines preserved) — the CODE VIEW.
 *
 * Why: opaque-import detection must read CODE, not prose. A doc comment, a
 * test name or an assertion string that merely mentions `import(` is not a
 * dynamic import; counting it would mark an unrelated file as an unbounded
 * importer and (through the conservative union below) inflate every affected
 * plan until the selector is useless. Only real non-literal dynamic imports
 * survive this view.
 *
 * A template literal is the one place where "blanked text" and "code" mix: its
 * literal TEXT is prose-ish and is blanked, but an expression inside `${...}`
 * is REAL CODE and stays visible — recursively, so `` `${ `${x}` }` `` works.
 * A dynamic import hidden in an interpolation is still a dynamic import;
 * hiding it here would let the selector drop a real consumer.
 */
export function stripCommentsAndStrings(source) {
  return lexJs(source).code;
}

/**
 * ONE lexer, ONE view — consumed by BOTH the opaque detector and the specifier
 * extractor (`parseImportSpecs`), so the two can never disagree about a call
 * site. Returns:
 *   `code`     — the CODE VIEW described above.
 *   `literals` — every single/double-quoted literal read in CODE position as
 *                `{ index, value }`, where `index` is the opening quote's
 *                offset in `code` and `value` is the DECODED text (null when an
 *                escape cannot be decoded — the call site is then OPAQUE).
 *
 * Five lexical facts the earlier single-pass versions got wrong. Each one blanked
 * a REAL dynamic import out of the code view — a false negative, i.e. a dropped
 * consumer and a false green:
 *   1. `${` opens a FRESH EXPRESSION, so a `/` immediately after it starts a
 *      REGEX (`` `${ /}/.test('}') ? await import(x) : 0 }` ``). Without
 *      resetting the lexical context the `/` was read as division and the `}`
 *      INSIDE the regex closed the interpolation early, blanking the real
 *      import that followed.
 *   2. `++`/`--` END an expression, so a following `/` is DIVISION (`n++ / 2`).
 *      A whitespace-stripped character tail could not tell `n++ / 2` from
 *      `+ + /}/`: it glued two unary operators into a postfix `++` and read the
 *      regex as a division, blanking the import that followed.
 *   3. A `}` that closes an OBJECT literal (`const n = {} / 2`) leaves an
 *      expression behind, so `/` is DIVISION — the object/block distinction is
 *      derived from real brace kinds, not from "the last char is `}`".
 *   4. When the context cannot be PROVEN, the view is marked `uncertain` and the
 *      caller treats the file as OPAQUE — never "blank it, then conclude there
 *      is no dynamic import".
 *   5. (round-7) After a member-access `.` — including optional chaining `?.`,
 *      comments/whitespace between them, and the private-name `#` — an
 *      identifier is a PROPERTY NAME, never a statement keyword. A reserved
 *      word in keyword position kept its keyword classification, so
 *      `o.default / 2` opened a PHANTOM regex that blanked the real import
 *      behind it (member access ends the expression: division).
 *   6. (round-8) The `}` closing a FUNCTION body is classified by whether the
 *      function was PROVEN to be an expression or a declaration: a body of
 *      `const n = function () {}` leaves an expression behind (`/ 2` is
 *      division), a declared `function f() {}` leaves a statement start
 *      (a regex may follow). The context is proven from the token BEFORE the
 *      `function` keyword; when it cannot be proven (`export default function`
 *      parses either way), the first `/` after the body fails CLOSED and the
 *      file is treated OPAQUE instead of opening a phantom regex.
 */
function lexJs(source) {
  const src = String(source == null ? '' : source);
  const out = new Array(src.length);
  const literals = [];
  let i = 0;
  let state = 'code';
  let prevKind = 'exprOpen'; // TOKEN kind of the previous significant token
  let lastToken = ''; // its text (only `{` classification needs it)
  let uncertain = false; // a `/` hit a context we could NOT prove
  let interpDepth = 0; // brace depth inside the CURRENT `${...}` interpolation
  let quoteStart = -1; // offset of the opening quote of the literal being read
  // Brace kinds: the stack stores the PREVKIND the closing `}` must take
  // ('operand' / 'exprOpen' / 'unknown'), so a `/` after `}` is decided by
  // what the `}` CLOSED.
  const braceStack = [];
  // (PR285-R3-02 r8) Pending `function` keyword arms. An arm follows the
  // function's shape from the keyword on (optional generator `*`, optional
  // NAME, counted `(...)` params, then the body `{`) and remembers what
  // prevKind the body's closing `}` must leave behind ('operand' for a PROVEN
  // function EXPRESSION — `/` is then division — 'exprOpen' for a PROVEN
  // DECLARATION — a regex may follow — 'unknown' when the context could not
  // be proven, which fails the next `/` CLOSED). Arms STACK, so a function
  // inside a default parameter value stays independent of its enclosing one,
  // and only the top arm follows the current keyword's shape.
  const fnTrack = [];
  // (PR285-R3-02 r9) EVERY arm drop outside the counted-'params' stage means
  // the function shape hit a token its header could not legally continue —
  // the file context becomes UNPROVABLE, so those drops FAIL CLOSED: they set
  // `uncertain = true` (OPAQUE) instead of quietly returning to block
  // semantics. The one exception is the interpolation-terminal `}` in the
  // round-8 path (a bodyless arm `${ f(function () {}) }` ends LEGALLY).
  const topArm = () => (fnTrack.length ? fnTrack[fnTrack.length - 1] : null);
  // Resume stack for nested contexts. Each entry keeps BOTH the state and the
  // interpolation brace depth to restore, so a nested template inside an
  // interpolation cannot corrupt the enclosing depth
  // (e.g. `` `${ { a: `x${y}` } }` ``).
  const stack = [];
  const enter = (s, freshInterp = false) => {
    stack.push([state, interpDepth]);
    state = s;
    // A `${` starts a NEW expression: reset the token context so its first
    // token is lexed from scratch (a leading `/` is then a REGEX, not division)
    // and so it cannot inherit the enclosing template's own delimiters.
    // (PR285-R3-02 r9) The head of an interpolation is an EXPRESSION position,
    // NOT a program/statement start. It leaves the sentinel `'${'` on the
    // token tape — listed in FN_EXPR_BOUNDARY — so a `function` there is an
    // expression whose `/` after the body is DIVISION (`${ fn () {} / 2 }`),
    // while a real program/statement start keeps the EMPTY sentinel, which
    // stays in FN_DECL_BOUNDARY so `function f() {}\n/regex/` still lexes the
    // regex as a regex.
    if (freshInterp) { interpDepth = 0; prevKind = 'exprOpen'; lastToken = '${'; }
  };
  const leave = () => { const [s, d] = stack.pop(); state = s; interpDepth = d; };
  // `code` and an interpolation body share the SAME lexical rules (an
  // interpolation IS code); the only difference is that a `}` may close it.
  const isCode = () => state === 'code' || state === 'interp';
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];
    if (isCode()) {
      // --- comments --------------------------------------------------------
      if (ch === '/' && nx === '/') { out[i] = ' '; out[i + 1] = ' '; enter('line'); i += 2; continue; }
      if (ch === '/' && nx === '*') { out[i] = ' '; out[i + 1] = ' '; enter('block'); i += 2; continue; }
      // --- regex vs division (TOKEN context, never a character tail) --------
      if (ch === '/') {
        if (prevKind === 'operand') { // an expression just ended -> DIVISION
          out[i] = '/'; i += 1; prevKind = 'exprOpen'; lastToken = '/'; continue;
        }
        // A regex cannot follow a function header mid-shape: any arm still
        // awaiting a body at this `/` is not a function after all (a regex
        // inside a default parameter value is lexed with its enclosing arm in
        // the 'params' stage, which survives here). (PR285-R3-02 r9) Any arm
        // dropped at a stage where its shape could NOT legally continue is an
        // UNPROVABLE file context — the drop now fails CLOSED, never silently.
        { const arm = topArm(); if (arm && arm.stage !== 'params') { uncertain = true; fnTrack.pop(); } }
        if (prevKind === 'unknown') uncertain = true; // unproven: fail closed
        out[i] = ' '; enter('regex'); i += 1; continue;
      }
      // --- string / template literals --------------------------------------
      if (ch === "'" || ch === '"' || ch === '`') {
        // A literal cannot appear inside a half-built function header: an arm
        // that has not reached its params/body yet is not a function after
        // all (literals inside `(...)` params keep their arm in 'params').
        { const arm = topArm(); if (arm && arm.stage !== 'params') { uncertain = true; fnTrack.pop(); } }
        out[i] = ch; enter(ch); i += 1; quoteStart = i - 1; continue;
      }
      // --- `{` : a pending function body, or object literal or block --------
      if (ch === '{') {
        let close;
        const arm = topArm();
        if (arm && arm.stage === 'expectBody') {
          // The body of the armed `function`: its closing `}` leaves the
          // arm's PROVEN verdict behind (division after a function
          // expression, a fresh statement after a declaration, unknown
          // => fail-closed when the context was unprovable).
          close = arm.closing;
          fnTrack.pop();
        } else {
          // `{` before/instead of `(...)`: not a function shape. A `{` inside
          // counted params (a default object/destructuring value) keeps the
          // arm and is classified on its own context. A dropped arm here
          // means `function {` — an unprovable header: fail closed (r9).
          if (arm && (arm.stage === 'start' || arm.stage === 'named')) { uncertain = true; fnTrack.pop(); }
          close = classifyBrace(prevKind, lastToken);
        }
        braceStack.push(close);
        if (state === 'interp') interpDepth += 1;
        out[i] = ch; i += 1; prevKind = 'exprOpen'; lastToken = '{'; continue;
      }
      // --- `}` : close an interpolation, or pop a brace kind ---------------
      if (ch === '}') {
        if (state === 'interp' && interpDepth === 0) {
          // The interpolation TERMINATES here: a bodyless function arm
          // `${ f(function () {}) }` has nothing more to await — drop it so
          // it can never consume an unrelated later `{`. This drop is LEGAL
          // (the shape was never left half-built): no uncertain here.
          { const arm = topArm(); if (arm && arm.stage !== 'params') fnTrack.pop(); }
          out[i] = ch; leave(); i += 1; prevKind = 'operand'; lastToken = '}'; continue;
        }
        if (state === 'interp') interpDepth -= 1;
        // A `}` before the body `{` cannot close a half-built function shape
        // (an arm inside counted `(...)` params survives nested braces).
        { const arm = topArm(); if (arm && arm.stage !== 'params') { uncertain = true; fnTrack.pop(); } }
        const close = braceStack.length ? braceStack.pop() : 'unknown';
        out[i] = ch; i += 1;
        prevKind = close; // already the closing PREVKIND decided at the `{`
        lastToken = '}'; continue;
      }
      // --- identifiers / keywords ------------------------------------------
      // (PR285-R3-02 r9) UNICODE IDENTIFIERS: a JS identifier may contain any
      // Unicode ID_Continue character (`function café() {} / 2`, a bare
      // Unicode variable divided by `/`). The ASCII-only scanner used to stop
      // mid-word, and the leftover portion fell to the single-char fallback
      // (exprOpen) — dropping the pending arm mid-header and letting `/`
      // open a phantom regex. (PR285-R3-02 r10) The scanner is now the
      // STANDARD ID_Start/ID_Continue shape scanned BY CODE POINT:
      // `identAdvance` consumes whole surrogate pairs (astral identifiers no
      // longer split), and U+200C/U+200D (ZWJ/ZWNJ — legit ID_Continue
      // characters with no visible glyph — no longer fall out mid-word to the
      // fallback and open a phantom regex over the real import).
      {
        const startAdv = identAdvance(src, i, true);
        if (startAdv > 0) {
          let j = i + startAdv;
          for (;;) {
            const contAdv = identAdvance(src, j, false);
            if (!contAdv) break;
            j += contAdv;
          }
        const word = src.slice(i, j);
        for (let k = i; k < j; k += 1) out[k] = src[k];
        // (PR285-R3-02 r7) MEMBER ACCESS: when the previous significant token
        // is the `.` of a member access (including OPTIONAL chaining `?.`;
        // comments/whitespace between `.` and the identifier are not tokens),
        // the following identifier is a PROPERTY NAME, never a statement
        // keyword — even when it IS a reserved word (`o.default / 2`,
        // `list.return / 2`, `o.function / 2`). A property name ENDS the
        // member expression, so the `/` after it is DIVISION; otherwise the
        // reserved word opened a phantom regex that blanked the REAL
        // `await import(...)` behind it and certified a false green. No
        // per-word whitelist: EVERY reserved word is a legal property name.
        // A keyword in its own keyword position keeps classifyWord (`return`
        // still opens an expression, so `return /re/` is still a regex).
        if (lastToken === '.') {
          prevKind = 'operand';
          lastToken = word;
          i = j; continue;
        }
        // (PR285-R3-02 r8) `async` + `function` is ONE composite keyword:
        // leave the boundary token of the PRECEDING code exposed so the
        // `function` arm below reads the real start (`=`, `;`, statement…).
        // An `async` that is an ordinary identifier (next significant word is
        // not `function`) keeps its normal classification.
        if (word === 'async' && peekNextWord(src, j) === 'function') { i = j; continue; }
        if (word === 'function') {
          // (PR285-R3-02 r8) arm the pending function with its PROVEN — or
          // fail-closed 'unknown' — closing kind, derived from the token
          // BEFORE the keyword. A dangling arm that never completed its
          // shape in front of a fresh `function` is dropped first (an arm
          // inside counted params is a nested default value and survives).
          const arm = topArm();
          if (arm && arm.stage !== 'params') { uncertain = true; fnTrack.pop(); }
          fnTrack.push({ stage: 'start', paren: 0, closing: fnExpectation(lastToken) });
          prevKind = 'exprOpen';
          lastToken = word;
          i = j; continue;
        }
        const arm = topArm();
        if (arm && arm.stage === 'start') {
          arm.stage = 'named'; // the optional function NAME
        } else if (arm && arm.stage === 'named') {
          // a word right after the name is not a function shape (r9: fail closed)
          uncertain = true; fnTrack.pop();
        } else if (arm && arm.stage === 'expectBody') {
          // tokens between `)` and the body `{`: not a function (r9: fail closed)
          uncertain = true; fnTrack.pop();
        }
        prevKind = classifyWord(word);
        lastToken = word;
        i = j; continue;
        } // end: startAdv > 0
      }
      // --- numbers ---------------------------------------------------------
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(nx))) {
        let j = i;
        while (j < src.length && /[\w.]/.test(src[j])) j += 1;
        for (let k = i; k < j; k += 1) out[k] = src[k];
        // A number cannot appear in a half-built function header.
        { const arm = topArm(); if (arm && arm.stage !== 'params') { uncertain = true; fnTrack.pop(); } }
        prevKind = 'operand'; lastToken = src.slice(i, j);
        i = j; continue;
      }
      // --- `=>` (so a following `{` is a BODY BLOCK, not an object) --------
      if (ch === '=' && nx === '>') {
        // An arrow may start a default parameter value; anywhere else it
        // breaks a half-built function shape.
        { const arm = topArm(); if (arm && arm.stage !== 'params') { uncertain = true; fnTrack.pop(); } }
        out[i] = '='; out[i + 1] = '>'; i += 2; prevKind = 'exprOpen'; lastToken = '=>'; continue;
      }
      // --- `++` / `--` : ONE token only when ADJACENT in the raw source ----
      if ((ch === '+' || ch === '-') && nx === ch) {
        // `++`/`--` may start a default parameter value; anywhere else they
        // break a half-built function shape.
        { const arm = topArm(); if (arm && arm.stage !== 'params') { uncertain = true; fnTrack.pop(); } }
        out[i] = ch; out[i + 1] = nx; i += 2;
        const postfix = prevKind === 'operand';
        prevKind = postfix ? 'operand' : 'exprOpen';
        lastToken = postfix ? (ch === '+' ? '++' : '--') : ch;
        continue;
      }
      // --- `(` / `)` : count the params of a pending function shape --------
      if (ch === '(') {
        const arm = topArm();
        if (arm) {
          if (arm.stage === 'start' || arm.stage === 'named') { arm.stage = 'params'; arm.paren = 1; }
          else if (arm.stage === 'params') arm.paren += 1;
          else { uncertain = true; fnTrack.pop(); } // `(` after `)`: not a function shape (r9 fail-closed)
        }
        out[i] = ch; i += 1; prevKind = 'exprOpen'; lastToken = '('; continue;
      }
      if (ch === ')') {
        const arm = topArm();
        if (arm) {
          if (arm.stage === 'params') { arm.paren -= 1; if (arm.paren === 0) arm.stage = 'expectBody'; }
          else { uncertain = true; fnTrack.pop(); } // a `)` without counted params cannot be the header (r9)
        }
        out[i] = ch; i += 1; prevKind = 'operand'; lastToken = ')'; continue;
      }
      // --- `function*` generator star: part of the pending keyword token ---
      if (ch === '*' && topArm() && topArm().stage === 'start') {
        out[i] = ch; i += 1; continue; // the arm survives with its boundary intact
      }
      // --- any other single code character ---------------------------------
      out[i] = ch;
      // Whitespace is NOT a token: it must never change the previous token's
      // kind, or `{} / 2` would look like `{}` + a fresh expression + regex.
      // A private-name `#` is equally transparent (PR285-R3-02 r7): it is
      // part of the member expression itself, so `this.#default / 2` must
      // still see the `.` as the previous token — and a class-declaration
      // `{` must not turn a `#<name>` into a fresh expression by itself.
      if (/\s/.test(ch) || ch === '#') { i += 1; continue; }
      // (PR285-R3-02 r9) Any other character cannot complete a half-built
      // function header — `\`-ESCAPE identifiers (`function f\u006f() {}`),
      // stray punctuation — so dropping the arm here FAILS CLOSED from now
      // on: never a silent return to block semantics.
      { const arm = topArm(); if (arm && arm.stage !== 'params') { uncertain = true; fnTrack.pop(); } }
      // (PR285-R3-02 r10) A NON-ASCII character that survived every scanner
      // cannot be PROVEN to be part of any supported token shape — an
      // identifier extension outside the standard ID_Start/ID_Continue sets,
      // a stray Unicode punctuation. Before its prevKind falls to exprOpen,
      // the context FAILS CLOSED: uncertain (OPAQUE), regardless of whether a
      // function arm is pending. ASCII structural characters (`; : = [ ] @`
      // and friends) keep their exact classification.
      if (ch.charCodeAt(0) >= 0x80) uncertain = true;
      prevKind = (ch === ')' || ch === ']') ? 'operand' : 'exprOpen';
      lastToken = ch;
      i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { out[i] = '\n'; leave(); i += 1; continue; }
      out[i] = ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && nx === '/') { out[i] = ' '; out[i + 1] = ' '; leave(); i += 2; continue; }
      out[i] = ch === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (state === 'regex') {
      if (ch === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (ch === '[') { out[i] = ' '; state = 'regexClass'; i += 1; continue; }
      if (ch === '/') { out[i] = '/'; leave(); i += 1; prevKind = 'operand'; lastToken = '/'; continue; }
      out[i] = ch === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (state === 'regexClass') {
      if (ch === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (ch === ']') { out[i] = ' '; state = 'regex'; i += 1; continue; }
      out[i] = ch === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // Inside a string/template literal: blank the contents, keep the quote.
    // `${` in a TEMPLATE opens real code (an interpolation) — surface it.
    if (state === '`' && ch === '$' && nx === '{') {
      out[i] = '$'; out[i + 1] = '{'; enter('interp', true); i += 2; continue;
    }
    if (ch === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
    if (ch === state) {
      out[i] = ch;
      // A closed '…' / "…" literal in CODE position: record its DECODED value
      // against the opening quote's offset. Only these two can be a specifier;
      // a template or regex is never a resolvable module literal.
      if (state === "'" || state === '"') {
        literals.push({ index: quoteStart, value: decodeStringBody(src.slice(quoteStart + 1, i)) });
      }
      leave(); i += 1; prevKind = 'operand'; lastToken = ch; continue;
    }
    out[i] = ch === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return { code: out.join(''), literals, uncertain };
}

/**
 * Decode a single/double-quoted literal BODY to the string JS would actually
 * load, WITHOUT eval/new Function. A raw `\u0075` would otherwise become a
 * WRONG graph target (`val\u0075e.mjs` instead of `value.mjs`). An escape this
 * decoder refuses to prove (malformed `\u`/`\x`, a trailing backslash, an
 * out-of-range code point) returns null, which makes the call site OPAQUE —
 * fail-closed, never a target that does not exist.
 */
function decodeStringBody(raw) {
  let decoded = '';
  for (let k = 0; k < raw.length; k += 1) {
    const c = raw[k];
    if (c !== '\\') { decoded += c; continue; }
    k += 1;
    if (k >= raw.length) return null; // trailing backslash: not a valid literal
    const e = raw[k];
    if (e === 'n') { decoded += '\n'; continue; }
    if (e === 't') { decoded += '\t'; continue; }
    if (e === 'r') { decoded += '\r'; continue; }
    if (e === 'b') { decoded += '\b'; continue; }
    if (e === 'f') { decoded += '\f'; continue; }
    if (e === 'v') { decoded += '\v'; continue; }
    if (e === '0') { decoded += '\0'; continue; }
    if (e === '\n') continue; // line continuation
    if (e === '\r') { if (raw[k + 1] === '\n') k += 1; continue; }
    if (e === 'x') {
      const h = raw.slice(k + 1, k + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return null;
      decoded += String.fromCharCode(parseInt(h, 16)); k += 2; continue;
    }
    if (e === 'u') {
      if (raw[k + 1] === '{') {
        const end = raw.indexOf('}', k + 2);
        if (end < 0) return null;
        const h = raw.slice(k + 2, end);
        if (!/^[0-9a-fA-F]+$/.test(h)) return null;
        const cp = parseInt(h, 16);
        if (cp > 0x10FFFF) return null;
        decoded += String.fromCodePoint(cp); k = end; continue;
      }
      const h = raw.slice(k + 1, k + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(h)) return null;
      decoded += String.fromCharCode(parseInt(h, 16)); k += 4; continue;
    }
    decoded += e; // \' \" \\ \` \/ and any other single-character escape
  }
  return decoded;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// (1b) Content binding of a PLAN — HEAD does not change when tracked content
// is dirty and untracked sources appear, so a plan built for "A modified"
// must prove the SAME content still exists the moment before it executes.
// The binding covers:
//   * every tracked file's bytes (computeWorktreeContentBinding — the SAME
//     digest the TestRunRecord before/after snapshots use), and
//   * every non-ignored untracked file (path + content digest), which the
//     tracked-only snapshot deliberately does not see.
// Producer and consumer both call THIS function, so the two sides can never
// disagree about serialization detail.
// ---------------------------------------------------------------------------
export function computePlanContentBinding({ root } = {}) {
  if (typeof root !== 'string' || !root) return { ok: false, reason: 'root is required' };
  const t = computeWorktreeContentBinding({ worktreePath: root });
  if (!t.ok) return { ok: false, reason: `tracked content unavailable: ${t.reason}` };
  const lm = loadManifestForRoot(root);
  const ignored = lm.ok
    ? (p) => lm.ignorePrefixes.some((x) => p.startsWith(x)) || lm.ignoreSuffixes.some((x) => p.endsWith(x))
    : () => false;
  const untracked = String(git(['ls-files', '--others', '--exclude-standard'], { root }) || '')
    .split('\n').map((s) => s.trim()).filter((p) => p && !ignored(p)).sort();
  const h = crypto.createHash('sha256');
  for (const rel of untracked) {
    h.update(rel); h.update('\0');
    let d = 'MISSING';
    try { d = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex'); } catch { /* unreadable IS the state */ }
    h.update(d); h.update('\n');
  }
  const untrackedDigest = h.digest('hex');
  const digest = sha256(`${t.value.contentDigest}\0${untrackedDigest}\0${untracked.length}`);
  if (!HEX64.test(digest)) return { ok: false, reason: 'content binding digest could not be computed' };
  return {
    ok: true,
    value: {
      digest,
      contentDigest: t.value.contentDigest,
      untrackedCount: untracked.length,
      untrackedDigest,
    },
  };
}

const toPosix = (p) => p.split(path.sep).join('/');

function git(args, { root, allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    if (allowFail) return null;
    return null;
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// (1) Manifest — ONE source: tests/tiers.json. Every entrypoint resolves it
// against its OWN root (never the process CWD).
// ---------------------------------------------------------------------------
export function manifestPath(root) {
  return path.join(root, 'tests', 'tiers.json');
}

export function loadManifestForRoot(root) {
  const { readFileSync, readdirSync } = fs; // eslint-disable-line no-unused-vars
  const fp = manifestPath(root);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `manifest unreadable at ${fp}: ${String((e && e.message) || e)}` };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, reason: 'manifest is not an object' };
  }
  if (!m.tiers || typeof m.tiers !== 'object') {
    return { ok: false, reason: 'manifest has no `tiers` object' };
  }
  for (const t of Object.keys(m.tiers)) {
    const def = m.tiers[t];
    if (!def || !Array.isArray(def.files)) {
      return { ok: false, reason: `tier '${t}' has no files[] array` };
    }
  }
  // `all` is NEVER stored: it is the filesystem inventory, derived below.
  if (Array.isArray(m.all)) {
    return { ok: false, reason: 'manifest must not store an independent `all` list (all is derived from inventory)' };
  }
  let onDisk;
  try {
    onDisk = fs.readdirSync(path.join(root, 'tests'))
      .filter((f) => f.endsWith('.test.mjs') && fs.statSync(path.join(root, 'tests', f)).isFile())
      .sort();
  } catch (e) {
    return { ok: false, reason: `tests/ unreadable: ${String((e && e.message) || e)}` };
  }
  const owner = new Map();
  for (const [tier, def] of Object.entries(m.tiers)) {
    for (const f of def.files) {
      if (owner.has(f)) return { ok: false, reason: `${f} is assigned to both ${owner.get(f)} and ${tier}` };
      owner.set(f, tier);
    }
  }
  const orphans = onDisk.filter((f) => !owner.has(f));
  if (orphans.length) return { ok: false, reason: `test files with no tier (fail-closed): ${orphans.join(', ')}` };
  const ghosts = [...owner.keys()].filter((f) => !onDisk.includes(f));
  if (ghosts.length) return { ok: false, reason: `manifest lists files that do not exist: ${ghosts.join(', ')}` };
  for (const f of m.always || []) if (!owner.has(f)) return { ok: false, reason: `always[] lists unknown test ${f}` };
  // Smoke is a REFERENCE subset, never a second ownership tier.
  const smoke = Array.isArray(m.smoke) ? m.smoke.slice() : [];
  for (const f of smoke) {
    if (!owner.has(f)) return { ok: false, reason: `smoke[] references unknown test ${f}` };
  }
  if (new Set(smoke).size !== smoke.length) return { ok: false, reason: 'smoke[] contains duplicates' };
  // Explicit path mapping: files read through fs/spawn (not import) whose
  // affected tests CANNOT be derived from the import graph.
  const pathMappings = {};
  for (const [k, v] of Object.entries(m.pathMappings || {})) {
    if (!Array.isArray(v) || v.some((t) => !owner.has(t))) {
      return { ok: false, reason: `pathMappings['${k}'] must list known test files` };
    }
    pathMappings[k] = v.slice();
  }
  const fullTriggerPaths = Array.isArray(m.fullTriggerPaths) ? m.fullTriggerPaths.slice() : [];
  const fullTriggerPrefixes = Array.isArray(m.fullTriggerPrefixes) ? m.fullTriggerPrefixes.slice() : [];
  const ignorePrefixes = Array.isArray(m.ignorePrefixes) ? m.ignorePrefixes.slice() : [];
  // Extension-only ignores are DELIBERATELY unsupported: docs/.md have to be
  // proven non-runtime by path, not by extension.
  const ignoreSuffixes = Array.isArray(m.ignoreSuffixes) ? m.ignoreSuffixes.slice() : [];
  if (ignoreSuffixes.includes('.md') || ignoreSuffixes.includes('.txt')) {
    return { ok: false, reason: 'ignoreSuffixes must not blanket-ignore .md/.txt (runtime instruction files are inputs)' };
  }
  const manifestDigest = sha256(fs.readFileSync(fp));
  return {
    ok: true,
    root, manifestDigest, onDisk, owner, smoke, pathMappings,
    fullTriggerPaths, fullTriggerPrefixes, ignorePrefixes, ignoreSuffixes,
    tiers: m.tiers, always: (m.always || []).slice(), coreSubsystems: m.coreSubsystems || {},
  };
}

export function loadManifest(root) {
  const r = loadManifestForRoot(root);
  if (!r.ok) throw new Error(`TEST_PLAN_MANIFEST_INVALID: ${r.reason}`);
  return r;
}

// ---------------------------------------------------------------------------
// (2) Git — BASE/candidate binding. The base ALWAYS comes from the task
// binding (session.baseSha / execution record), resolved to an exact SHA.
// ---------------------------------------------------------------------------
/**
 * BASE always comes from the task binding (session.baseSha / execution
 * record) or an explicit ref; it is resolved to an EXACT 40-hex commit
 * inside this repository. The `^{commit}` suffix keeps the argument from
 * ever being read as a git option; anything that does not resolve fails
 * closed (wrong repo / unresolvable / unrelated history).
 */
export function resolveBaseSha(root, base) {
  if (typeof base !== 'string' || !base.trim()) {
    return { ok: false, reason: `base is empty: ${base}` };
  }
  const b = base.trim();
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', root, 'rev-parse', '--verify', '--quiet', `${b}^{commit}`], {
    encoding: 'utf8', windowsHide: true,
  });
  const out = (r.stdout || '').trim();
  if (r.status !== 0 || !HEX40.test(out)) {
    return { ok: false, reason: `base '${b}' does not resolve to a commit in ${root}` };
  }
  return { ok: true, value: out };
}

export function resolveCandidateSha(root) {
  const out = git(['rev-parse', 'HEAD'], { root });
  if (typeof out !== 'string' || !HEX40.test(out.trim())) {
    return { ok: false, reason: `candidate HEAD is unresolvable in ${root}` };
  }
  return { ok: true, value: out.trim() };
}

function parseNameStatus(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const files = rest.filter(Boolean).map((s) => s.trim()).filter(Boolean);
    if (!files.length) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      // rename/copy: BOTH sides are part of the change
      for (const f of files) out.push(f);
    } else {
      out.push(files[0]);
    }
  }
  return out;
}

/**
 * The changed set for BASE..candidate, PLUS tracked dirty content and
 * untracked source (so a pre-commit candidate is planned against reality).
 * Generated runner artifacts (evidence JSON / raw logs) are excluded at the
 * manifest ignore rules — they can never masquerade as changed source.
 */
export function computeChangedPaths({ root, baseSha, candidateSha, manifest }) {
  const mb = git(['merge-base', baseSha, candidateSha], { root, allowFail: true });
  if (typeof mb !== 'string' || !HEX40.test(mb.trim())) {
    return { ok: false, reason: `no merge-base between ${baseSha} and ${candidateSha} in ${root} (unrelated repositories or missing object)` };
  }
  const mergeBase = mb.trim();
  const committed = parseNameStatus(git(['diff', '--name-status', '-M', `${mergeBase}..${candidateSha}`], { root, allowFail: true }));
  const dirty = parseNameStatus(git(['diff', '--name-status', '-M', 'HEAD'], { root, allowFail: true }));
  const untracked = String(git(['ls-files', '--others', '--exclude-standard'], { root, allowFail: true }) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const all = [...new Set([...committed, ...dirty, ...untracked])]
    .map((p) => toPosix(p.trim()))
    .filter(Boolean)
    .sort();
  const ignorePrefixes = manifest.ignorePrefixes;
  const ignoreSuffixes = manifest.ignoreSuffixes;
  const isIgnored = (p) => ignorePrefixes.some((x) => p.startsWith(x)) || ignoreSuffixes.some((x) => p.endsWith(x));
  return {
    ok: true,
    mergeBase,
    changed: all.filter((p) => !isIgnored(p)),
    ignored: all.filter(isIgnored),
  };
}

// ---------------------------------------------------------------------------
// (3) Import graph — static imports/re-exports, literal dynamic import(),
// require(); a visited set makes cycles finite. Deleted/renamed targets
// stay in the graph as literal edges, so their importers are still found.
// ---------------------------------------------------------------------------
export function parseImportSpecs(source) {
  const { code, literals } = lexJs(source);
  const byIndex = literalIndex(literals);
  const specs = [];
  // Index of the specifier's OPENING QUOTE = last character of each match.
  STATIC_FROM_RE.lastIndex = 0;
  for (const m of code.matchAll(STATIC_FROM_RE)) pushLiteral(specs, byIndex, m.index + m[0].length - 1);
  DYN_IMPORT_RE.lastIndex = 0;
  for (const m of code.matchAll(DYN_IMPORT_RE)) pushSpec(specs, resolvableArgument(code, byIndex, m.index + m[0].length));
  SIDE_EFFECT_RE.lastIndex = 0;
  for (const m of code.matchAll(SIDE_EFFECT_RE)) pushLiteral(specs, byIndex, m.index + m[0].length - 1);
  REQUIRE_RE.lastIndex = 0;
  for (const m of code.matchAll(REQUIRE_RE)) pushSpec(specs, resolvableArgument(code, byIndex, m.index + m[0].length));
  return specs;
}

function literalIndex(literals) {
  const byIndex = new Map();
  for (const lit of literals) byIndex.set(lit.index, lit);
  return byIndex;
}

function pushLiteral(specs, byIndex, idx) {
  const lit = byIndex.get(idx);
  if (lit && lit.value != null) specs.push(lit.value);
}

function pushSpec(specs, value) {
  if (value != null) specs.push(value);
}

// The DECODED specifier of the argument starting at `open` when the WHOLE
// argument is one plain single/double-quoted literal with nothing but `)`
// after it — the exact form the extractor resolves. In the code view the
// delimiters survive and literal contents are blanked, so the next same-quote
// character IS the closer; the literal table supplies the decoded value at that
// offset. Anything else (template, concatenation, identifier, call, a comment
// before the literal, an undecodable escape, an unterminated literal) returns
// null and the call site is OPAQUE — fail-closed: an unproven argument must
// never be read as "this file has no dependencies".
function resolvableArgument(code, byIndex, open) {
  let j = open;
  while (j < code.length && /\s/.test(code[j])) j += 1;
  const q = code[j];
  if (q !== "'" && q !== '"') return null;
  const lit = byIndex.get(j);
  j += 1;
  while (j < code.length && code[j] !== q) j += 1;
  if (j >= code.length) return null; // unterminated literal: not provable
  j += 1;
  while (j < code.length && /\s/.test(code[j])) j += 1;
  if (code[j] !== ')') return null;
  return lit ? lit.value : null;
}

export function hasOpaqueDynamicImport(source) {
  // CODE only: prose in a comment or a string literal that merely mentions
  // `import(` must never mark a file as an unbounded dynamic importer. The
  // SAME lexer/literal table backs `parseImportSpecs`, so "resolvable" here is
  // exactly "the extractor produces the specifier" — they cannot disagree.
  const { code, literals, uncertain } = lexJs(source);
  // A lexer that could not PROVE a regex-vs-division context may have blanked
  // real code, so it must never certify "no dynamic import": OPAQUE (fail-closed).
  if (uncertain) return true;
  const byIndex = literalIndex(literals);
  DYN_IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = DYN_IMPORT_RE.exec(code)) !== null) {
    if (resolvableArgument(code, byIndex, m.index + m[0].length) == null) return true;
  }
  return false;
}

function walkRepoFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(childRel);
      } else if (ent.isFile() && JS_EXT.includes(path.extname(ent.name))) {
        out.push(childRel);
      }
    }
  };
  walk('');
  return out.sort();
}

function resolveSpecToCandidates(importerRel, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null; // bare/external
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), spec));
  const cands = [joined];
  if (!JS_EXT.includes(path.posix.extname(joined))) {
    cands.push(`${joined}.mjs`, `${joined}.js`, `${joined}.cjs`);
    cands.push(path.posix.join(joined, 'index.mjs'), path.posix.join(joined, 'index.js'));
  }
  return [...new Set(cands)];
}

/**
 * Build the reverse graph for `root`: every repo JS file's dependencies.
 * Returned `nodes` = existing files; `edges` = importer -> spec candidates
 * (literals kept even when the target no longer exists, for deletions).
 */
export function buildImportGraph(root) {
  const files = walkRepoFiles(root);
  const fileSet = new Set(files);
  const edges = new Map(); // importer -> Set(candidate paths)
  const opaque = new Set(); // importer has a non-literal dynamic import
  for (const rel of files) {
    let source;
    try { source = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (hasOpaqueDynamicImport(source)) opaque.add(rel);
    const targets = new Set();
    for (const spec of parseImportSpecs(source)) {
      for (const cand of (resolveSpecToCandidates(rel, spec) || [])) targets.add(cand);
    }
    edges.set(rel, targets);
  }
  // dependents: target -> importers (target may be a literal that no
  // longer exists on disk — rename/delete still resolves to consumers).
  const dependents = new Map();
  for (const [importer, targets] of edges) {
    for (const t of targets) {
      if (!dependents.has(t)) dependents.set(t, new Set());
      dependents.get(t).add(importer);
    }
  }
  return { root, files: fileSet, edges, dependents, opaque };
}

export function impactedTestsOf(graph, changedPath) {
  // BFS upward over importers with a visited set (cycles terminate).
  const seen = new Set();
  const stack = [changedPath];
  while (stack.length) {
    const cur = stack.pop();
    for (const importer of (graph.dependents.get(cur) || [])) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      stack.push(importer);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// (4) Selection — the ONE selector behind every entrypoint.
// ---------------------------------------------------------------------------
export function selectAffectedTests({ manifest, graph, changed }) {
  const picked = new Map();
  const add = (f, why) => { if (manifest.owner.has(f) && !picked.has(f)) picked.set(f, why); };

  // `always` is the manifest's unconditional subset (smoke-grade regressions).
  // Smoke itself is a REFERENCE subset (used by the t0 entrypoint), never
  // silently added to every plan — plans select by effect only + `always`.
  for (const f of manifest.always) add(f, 'always');

  const fullReasons = [];
  const sources = [];
  const ignored = [];
  for (const p of changed) {
    const ign = manifest.ignorePrefixes.some((x) => p.startsWith(x)) || manifest.ignoreSuffixes.some((x) => p.endsWith(x));
    if (ign) { ignored.push(p); continue; }
    sources.push(p);
  }

  for (const p of sources) {
    // A changed test file is selected directly.
    if (p.startsWith('tests/') && p.endsWith('.test.mjs') && !p.slice('tests/'.length).includes('/') && manifest.owner.has(p.slice('tests/'.length))) {
      add(p.slice('tests/'.length), 'changed-test');
      continue;
    }
    // Shared runtime/selector/manifest => FULL with an explicit reason.
    if (manifest.fullTriggerPaths.includes(p)) { fullReasons.push(`full-trigger:${p}`); continue; }
    if (manifest.fullTriggerPrefixes.some((x) => p.startsWith(x))) { fullReasons.push(`full-trigger:${p}`); continue; }
    // Explicit fs/spawn mapping: proven consumers of a non-imported file.
    // A mapping ADDS consumers — it never REPLACES the reverse import closure.
    let mapped = false;
    for (const [key, tests] of Object.entries(manifest.pathMappings)) {
      if (p === key || (key.endsWith('/') && p.startsWith(key))) {
        for (const t of tests) add(t, `path-mapping:${key}`);
        mapped = true;
      }
    }
    // Subsystem mapping (explicit, for config-style subsystems) — also a
    // UNION with the graph, never an early exit that drops real importers.
    let sub = false;
    for (const [subsystemPath, targetTests] of Object.entries(manifest.coreSubsystems)) {
      if (p.startsWith(subsystemPath)) {
        for (const t of targetTests) add(t, `core-subsystem:${subsystemPath}`);
        sub = true;
      }
    }
    const provenByMapping = mapped || sub;
    // Import-derived closure. A DELETED or renamed-away file is still fully
    // resolvable: its importers' literal edges remain in the graph, so both
    // the old and the new path of a change keep finding their consumers.
    if (!JS_EXT.includes(path.posix.extname(p))) {
      // Non-JS input: the mapping is the only admissible proof of consumers.
      if (!provenByMapping) fullReasons.push(`unclassified-change:${p}`);
      continue;
    }
    const hasDependents = graph.dependents.has(p);
    if (!graph.files.has(p) && !hasDependents) {
      // Not on disk, imported by nobody in the graph: its loading semantics
      // cannot be proven (fs/spawn/side effect). An explicit mapping that
      // named its consumers IS that proof; otherwise -> full, with a reason.
      if (!provenByMapping) fullReasons.push(`unresolved-dependency:${p}`);
      continue;
    }
    if (graph.files.has(p) && graph.opaque.has(p)) {
      // The changed file itself carries a non-literal dynamic import: its
      // real dependency set cannot be enumerated from the text, so mapped
      // consumers alone can never prove the WHOLE affected set.
      fullReasons.push(`opaque-dynamic-import:${p}`);
      continue;
    }
    const tests = [...impactedTestsOf(graph, p)].filter((n) => {
      if (!n.startsWith('tests/') || !n.endsWith('.test.mjs')) return false;
      const rest = n.slice('tests/'.length); // top-level only: manifest keys are basenames
      return !rest.includes('/');
    });
    if (!tests.length) {
      if (!provenByMapping) fullReasons.push(`unresolved-dependency:${p}`);
      continue;
    }
    // Union: mapped consumers AND every graph-derived importer are selected.
    for (const t of tests) {
      const f = t.slice('tests/'.length); // owner keys are basenames (manifest format)
      if (!picked.has(f)) add(f, `dependency:${p}`);
    }
  }

  // (PR285-R3-02) OPAQUE dynamic consumers. A file with a non-literal dynamic
  // import import(<expr>) has an UNBOUNDED dependency set: it may load ANY
  // module, so for a change to any JS module it is a potential consumer — and
  // so is every test that statically depends on it. This is a PROVEN superset,
  // not a guess: on ANY test -> changed path, take the FIRST dynamic edge
  // (whose importer is O); the prefix up to O is purely static, so that test
  // lies in O's static reverse closure. Unioning the static closure of every
  // opaque importer therefore COMPLETES the affected set without dropping a
  // consumer and without collapsing every change into a run of the whole
  // inventory.
  //
  // This closes the gap where only the CHANGED file's own opacity was
  // considered: a source with both a static consumer and an opaque dynamic
  // consumer used to certify a plan containing only the static one.
  //
  // Scope: only when a JS module actually changed (a docs-only/empty
  // changeset has no module an opaque importer could load). `stripCommentsAndStrings`
  // keeps the opaque set to REAL dynamic imports, so the union stays small:
  // on this repository it adds 4 of 104 tests — all statically tied to the one
  // opaque importer that has any test closure — instead of forcing FULL on
  // every change because some unrelated file mentions `import(` in prose.
  const changedJs = sources.some((p) => JS_EXT.includes(path.posix.extname(p)));
  if (changedJs) {
    const ownerTestOf = (rel) => {
      if (typeof rel !== 'string' || !rel.startsWith('tests/') || !rel.endsWith('.test.mjs')) return null;
      const base = rel.slice('tests/'.length);
      return (!base.includes('/') && manifest.owner.has(base)) ? base : null;
    };
    for (const o of graph.opaque) {
      const ownTest = ownerTestOf(o);
      if (ownTest) add(ownTest, `opaque-importer:${o}`);
      for (const dep of impactedTestsOf(graph, o)) {
        const base = ownerTestOf(dep);
        if (base) add(base, `opaque-consumer:${o}`);
      }
    }
  }

  return {
    sources,
    ignored,
    selected: [...picked.keys()].sort(),
    reasons: Object.fromEntries(picked),
    fullReasons,
    fallback: fullReasons.length > 0,
  };
}

// ---------------------------------------------------------------------------
// (5) Plan — deterministic, deduplicated, digest-bound.
// ---------------------------------------------------------------------------
// Canonical JSON: every object's keys sorted at EVERY depth, arrays kept in
// order, all values preserved. A JSON.stringify replacer array drops nested
// keys whose names are not in the array — with a dynamic `reasons` map that
// meant a changed selection reason never moved the digest. This function
// exists so it can never happen again.
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function canonicalPlanForDigest(plan) {
  const clone = JSON.parse(JSON.stringify(plan));
  delete clone.planDigest; // the digest is never part of its own input
  return canonicalJson(clone);
}

export function recomputePlanDigest(plan) {
  return sha256(canonicalPlanForDigest(plan));
}

export function buildTestPlan({ root, base, mode = 'auto' } = {}) {
  if (typeof root !== 'string' || !root || !path.isAbsolute(root) && root !== path.resolve(root)) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, detail: 'root must be an absolute path' };
  }
  // (F1/round-2) The FULL planning bracket: observed BEFORE the manifest,
  // changed-path and graph reads below, re-observed at assembly. buildTestPlan
  // is a pure read — if any byte in the worktree moved while it computed (a
  // tracked edit, or a new untracked source between the changed-path scan and
  // the final snapshot), the selection was made against a state nobody
  // observed end-to-end: TEST_PLAN_PLAN_STALE on EVERY branch (full, fallback,
  // no-tests, affected) — never a plan, never a silent retry.
  const bindingBefore = computePlanContentBinding({ root });
  if (!bindingBefore.ok) {
    return { ok: false, code: TEST_PLAN_CODES.CONTENT_BINDING_UNAVAILABLE, detail: bindingBefore.reason };
  }

  const manifest = loadManifestForRoot(root);
  if (!manifest.ok) return { ok: false, code: TEST_PLAN_CODES.MANIFEST_INVALID, detail: manifest.reason };

  const baseResolved = resolveBaseSha(root, base);
  if (!baseResolved.ok) return { ok: false, code: TEST_PLAN_CODES.BASE_UNRESOLVED, detail: baseResolved.reason };
  const baseSha = baseResolved.value;

  const candidate = resolveCandidateSha(root);
  if (!candidate.ok) return { ok: false, code: TEST_PLAN_CODES.CANDIDATE_UNKNOWN, detail: candidate.reason };
  const candidateSha = candidate.value;

  const changed = computeChangedPaths({ root, baseSha, candidateSha, manifest });
  if (!changed.ok) return { ok: false, code: TEST_PLAN_CODES.BASE_UNRELATED, detail: changed.reason };

  // The plan is bound to the CONTENT it was planned against, not just to a
  // commit label: HEAD does not move when tracked files are dirty or new
  // untracked sources appear. This is the closing half of the planning
  // bracket (F1/round-2): the worktree is re-observed HERE, at assembly, and
  // must be byte-identical to bindingBefore — anything the graph/selection
  // reads while a byte is moving is a plan nobody observed end-to-end.
  // Returns the full result shape, so every branch carries the check.
  const withBinding = (plan) => {
    const bindingAfter = computePlanContentBinding({ root });
    if (!bindingAfter.ok) {
      return { ok: false, code: TEST_PLAN_CODES.CONTENT_BINDING_UNAVAILABLE, detail: bindingAfter.reason };
    }
    if (bindingAfter.value.digest !== bindingBefore.value.digest) {
      return {
        ok: false,
        code: TEST_PLAN_CODES.PLAN_STALE,
        detail: `worktree content changed while the plan was being built (planned ${bindingBefore.value.digest.slice(0, 12)}… -> observed ${bindingAfter.value.digest.slice(0, 12)}…): recompute the plan`,
      };
    }
    const b = { ...plan, contentBinding: bindingAfter.value };
    return { ok: true, plan: { ...b, planDigest: recomputePlanDigest(b) } };
  };

  const requestedMode = ['auto', 'affected', 'full'].includes(mode) ? mode : 'auto';
  // plan.files are ALWAYS repo-relative `tests/<name>` paths: they are the
  // exact spawn argv, validated against the manifest inventory by basename.
  const toPlanPath = (f) => (f.startsWith('tests/') ? f : `tests/${f}`);
  const fullFiles = manifest.onDisk.map(toPlanPath);
  const fullReasons = Object.fromEntries(fullFiles.map((f) => [f, 'full']));
  if (requestedMode === 'full') {
    const plan = {
      version: TEST_PLAN_SELECTOR_VERSION,
      mode: 'full',
      status: 'READY',
      fullReason: 'requested-full',
      base, baseSha, candidateSha,
      changedCount: changed.changed.length,
      changedPaths: changed.changed,
      ignoredPaths: changed.ignored,
      files: fullFiles,
      reasons: fullReasons,
      manifestDigest: manifest.manifestDigest,
      selectorVersion: TEST_PLAN_SELECTOR_VERSION,
      selectorDigest: selectorDigest(),
    };
    return withBinding(plan);
  }

  const graph = buildImportGraph(root);
  const sel = selectAffectedTests({ manifest, graph, changed: changed.changed });
  if (sel.fallback) {
    const plan = {
      version: TEST_PLAN_SELECTOR_VERSION,
      mode: 'full',
      status: 'READY',
      fullReason: sel.fullReasons.join('; '),
      base, baseSha, candidateSha,
      changedCount: changed.changed.length,
      changedPaths: changed.changed,
      ignoredPaths: changed.ignored,
      files: fullFiles,
      reasons: fullReasons,
      manifestDigest: manifest.manifestDigest,
      selectorVersion: TEST_PLAN_SELECTOR_VERSION,
      selectorDigest: selectorDigest(),
    };
    return withBinding(plan);
  }
  if (!changed.changed.length) {
    // Two DISTINCT explicit no-tests states: a genuinely empty changeset, or
    // a docs/artifact-only changeset (every changed path was proven
    // non-runtime by the manifest ignore rules). Neither is ever a PASS.
    const docsOnly = changed.ignored.length > 0;
    const plan = {
      version: TEST_PLAN_SELECTOR_VERSION,
      mode: 'affected',
      status: 'NO_TESTS',
      fullReason: docsOnly ? TEST_PLAN_NO_TESTS_REASONS.DOCS_ONLY : TEST_PLAN_NO_TESTS_REASONS.NO_CHANGES,
      base, baseSha, candidateSha,
      changedCount: 0,
      changedPaths: [],
      ignoredPaths: changed.ignored,
      files: [],
      reasons: {},
      manifestDigest: manifest.manifestDigest,
      selectorVersion: TEST_PLAN_SELECTOR_VERSION,
      selectorDigest: selectorDigest(),
    };
    return withBinding(plan);
  }
  if (!sel.selected.length) {
    const plan = {
      version: TEST_PLAN_SELECTOR_VERSION,
      mode: 'affected',
      status: 'NO_TESTS',
      fullReason: TEST_PLAN_NO_TESTS_REASONS.DOCS_ONLY,
      base, baseSha, candidateSha,
      changedCount: changed.changed.length,
      changedPaths: changed.changed,
      ignoredPaths: changed.ignored,
      files: [],
      reasons: {},
      manifestDigest: manifest.manifestDigest,
      selectorVersion: TEST_PLAN_SELECTOR_VERSION,
      selectorDigest: selectorDigest(),
    };
    return withBinding(plan);
  }
  const plan = {
    version: TEST_PLAN_SELECTOR_VERSION,
    mode: 'affected',
    status: 'READY',
    fullReason: null,
    base, baseSha, candidateSha,
    changedCount: changed.changed.length,
    changedPaths: changed.changed,
    ignoredPaths: changed.ignored,
    files: sel.selected.map(toPlanPath),
    reasons: Object.fromEntries(
      Object.entries(sel.reasons).map(([f, w]) => [toPlanPath(f), w]),
    ),
    manifestDigest: manifest.manifestDigest,
    selectorVersion: TEST_PLAN_SELECTOR_VERSION,
    selectorDigest: selectorDigest(),
  };
  return withBinding(plan);
}

// The selector digest binds the IMPLEMENTATION, not a version string: it is
// the hash of this module's source bytes (plus the version). Editing the
// selection/validation logic moves the digest, so every plan built under the
// old selector becomes STALE instead of silently validating against new code.
// Read fresh on every call — a process-level cache would let an upgraded
// on-disk selector hide behind a value computed before the upgrade.
export function selectorDigest() {
  const self = fs.readFileSync(fileURLToPath(import.meta.url));
  return sha256(`${TEST_PLAN_SELECTOR_VERSION}\0${self}`);
}

// ---------------------------------------------------------------------------
// (6) Validation at the execution boundary + the ONLY spawn argv builder.
// Nothing in this file executes tests: a plan is data, validated and turned
// into argv HERE or not at all.
// ---------------------------------------------------------------------------
export function isSafeTestPath(root, file) {
  if (typeof file !== 'string' || !file) return { ok: false, reason: 'empty path' };
  if (file.includes('\\') || file.includes('\0')) return { ok: false, reason: 'backslash/NUL in path' };
  if (path.isAbsolute(file) || file.startsWith('/')) return { ok: false, reason: 'absolute path' };
  if (file.startsWith('-')) return { ok: false, reason: 'option-like path' };
  const parts = file.split('/');
  if (parts.some((p) => p === '..')) return { ok: false, reason: 'traversal segment' };
  if (!/^tests\/[A-Za-z0-9._@%+=-]+\.test\.mjs$/.test(file)) return { ok: false, reason: 'not a top-level tests/*.test.mjs path' };
  const abs = path.resolve(root, file);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return { ok: false, reason: 'escapes the repo root' };
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    if (!real.startsWith(fs.realpathSync(path.resolve(root)) + path.sep)) return { ok: false, reason: 'symlink escape' };
    if (!fs.statSync(abs).isFile()) return { ok: false, reason: 'not a file' };
  }
  return { ok: true, abs };
}

export function validateTestPlan({ root, plan, expectHeadSha = undefined, inventory = null, expectedBaseSha = undefined, liveContent = null } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'plan is not an object' };
  }
  const manifest = loadManifestForRoot(root);
  if (!manifest.ok) return { ok: false, code: TEST_PLAN_CODES.MANIFEST_INVALID, reason: manifest.reason };
  if (plan.manifestDigest !== manifest.manifestDigest) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: 'manifest changed since the plan was built' };
  }
  if (plan.selectorDigest !== selectorDigest()) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: 'selector changed since the plan was built' };
  }
  if (recomputePlanDigest(plan) !== plan.planDigest) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'planDigest does not match plan content (tampered plan)' };
  }
  // A plan without a content binding is not a plan: it could only claim a
  // commit label while the actual bytes under it drifted. Refused, always.
  if (!plan.contentBinding || typeof plan.contentBinding !== 'object'
    || !HEX64.test(String(plan.contentBinding.digest || ''))
    || !HEX64.test(String(plan.contentBinding.contentDigest || ''))) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'plan carries no valid contentBinding (unbound to the content it planned against)' };
  }
  if (!HEX40.test(plan.baseSha || '')) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'plan.baseSha is not a 40-hex SHA' };
  }
  if (!HEX40.test(plan.candidateSha || '')) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'plan.candidateSha is not a 40-hex SHA' };
  }
  // The task's canonical BASE (record/session baseSha) is the ONLY authority:
  // a self-consistent plan built from a DIFFERENT base covers a different
  // changeset and can never execute for THIS task, however valid it looks.
  if (expectedBaseSha !== undefined && expectedBaseSha !== null) {
    if (!HEX40.test(String(expectedBaseSha || ''))) {
      return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'expectedBaseSha is not a 40-hex SHA' };
    }
    if (plan.baseSha !== expectedBaseSha) {
      return { ok: false, code: TEST_PLAN_CODES.BASE_MISMATCH,
        reason: `plan was built from base ${plan.baseSha.slice(0, 12)} but the task BASE binding is ${expectedBaseSha.slice(0, 12)}: replan against the task BASE` };
    }
  }
  const baseResolved = resolveBaseSha(root, plan.baseSha);
  if (!baseResolved.ok) return { ok: false, code: TEST_PLAN_CODES.BASE_UNRESOLVED, reason: baseResolved.reason };
  const head = resolveCandidateSha(root);
  if (!head.ok) return { ok: false, code: TEST_PLAN_CODES.CANDIDATE_UNKNOWN, reason: head.reason };
  // A plan is ALWAYS bound to its own candidate by default: if HEAD moved
  // after the plan was built, it is stale and must be rebuilt, not reused.
  const boundHead = expectHeadSha === undefined || expectHeadSha === null ? plan.candidateSha : expectHeadSha;
  if (boundHead && boundHead !== head.value) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: `candidate HEAD moved (${String(boundHead).slice(0, 12)} -> ${head.value.slice(0, 12)}): replan before execution` };
  }
  const mb = git(['merge-base', plan.baseSha, plan.candidateSha], { root, allowFail: true });
  if (typeof mb !== 'string' || !HEX40.test(mb.trim())) {
    return { ok: false, code: TEST_PLAN_CODES.BASE_UNRELATED, reason: 'base and candidate have no merge-base in this repository' };
  }
  const owner = inventory || manifest.owner;
  for (const f of plan.files || []) {
    const safe = isSafeTestPath(root, f);
    if (!safe.ok) return { ok: false, code: TEST_PLAN_CODES.PATH_ESCAPE, reason: `${f}: ${safe.reason}` };
    if (!owner.has(f.slice('tests/'.length))) {
      return { ok: false, code: TEST_PLAN_CODES.PATH_NOT_TEST, reason: `${f} is not a manifest-owned test` };
    }
    if (!fs.existsSync(path.join(root, f))) {
      return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: `${f} no longer exists` };
    }
  }
  if (plan.status !== 'READY' && plan.status !== 'NO_TESTS') {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: `unknown plan status ${plan.status}` };
  }
  if (plan.status === 'READY' && (!Array.isArray(plan.files) || !plan.files.length)) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'READY plan has no files' };
  }
  if (plan.status === 'NO_TESTS' && Array.isArray(plan.files) && plan.files.length) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'NO_TESTS plan must select nothing' };
  }
  if (!plan.planDigest || recomputePlanDigest(plan) !== plan.planDigest) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: 'plan is stale against its recorded digest' };
  }
  // Final gate before the plan may become argv: the CONTENT it planned
  // against must still be exactly the content observed NOW. Dirty tracked
  // edits or new untracked sources between planning and execution make the
  // selection unknowable — replan, never execute a stale selection.
  if (liveContent) {
    if (!liveContent.digest || liveContent.digest !== plan.contentBinding.digest) {
      return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE,
        reason: `planned content drifted (planned ${String(plan.contentBinding.digest).slice(0, 12)}… -> live ${String(liveContent.digest || 'none').slice(0, 12)}…): replan before execution` };
    }
  }
  return { ok: true, manifest, headSha: head.value };
}

/** The single bridge from a validated plan to a spawnable command. The plan
 * is bound to ITS EXACT candidate HEAD (a plan built before a later commit
 * is stale and is refused), to the TASK's canonical BASE, and — when the
 * caller supplies the freshly observed content — to the bytes still on disk. */
export function testPlanGateCommand({ root, plan, expectedBaseSha = undefined, liveContent = null }) {
  const v = validateTestPlan({
    root, plan, expectHeadSha: plan && plan.candidateSha, expectedBaseSha, liveContent,
  });
  if (!v.ok) return { ok: false, code: v.code, reason: v.reason };
  if (plan.status !== 'READY') {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: `plan status ${plan.status} cannot be executed`, status: plan.status, fullReason: plan.fullReason };
  }
  const argv = ['--test', '--test-reporter=tap', ...plan.files];
  return { ok: true, command: `node --test --test-reporter=tap ${plan.files.join(' ')}`, executable: process.execPath, argv, plan };
}

// ---------------------------------------------------------------------------
// (7) TAP evaluation — exit code alone is NEVER proof of a run.
// ---------------------------------------------------------------------------
export function parseTapSummary(text) {
  const s = {};
  for (const m of String(text || '').matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    s[m[1]] = Number(m[2]);
  }
  return s;
}

export function evaluateSummary({ exitCode, summary, fileCount, minTests = 0 }) {
  const reasons = [];
  for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    if (!Number.isInteger(summary[k])) reasons.push(`TAP summary is missing '${k}' (unproven run)`);
  }
  if (reasons.length) return { ok: false, reasons };
  if (exitCode !== 0) reasons.push(`exit code ${exitCode}`);
  if (summary.tests === 0) reasons.push('0 tests executed');
  if (summary.tests < fileCount) reasons.push(`${summary.tests} tests total for ${fileCount} files (aggregate check failed)`);
  if (summary.tests < minTests) reasons.push(`${summary.tests} tests < minTests ${minTests}`);
  if (summary.fail > 0) reasons.push(`${summary.fail} failed`);
  if (summary.cancelled > 0) reasons.push(`${summary.cancelled} cancelled`);
  if (summary.skipped > 0) reasons.push(`${summary.skipped} skipped (skip is not allowed)`);
  if (summary.todo > 0) reasons.push(`${summary.todo} todo (todo is not allowed)`);
  if (summary.pass !== summary.tests) reasons.push(`pass ${summary.pass} != tests ${summary.tests}`);
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// (8) Back-compat helpers kept for existing callers of scripts/run-tier.mjs.
// ---------------------------------------------------------------------------
export function unitOf(p) {
  const parts = p.split('/');
  return parts[0] === 'packages' && parts.length > 2 ? `packages/${parts[1]}/` : p;
}

export function unitsImportedBy(testRelPath, source) {
  const units = new Set();
  const base = path.posix.dirname(testRelPath);
  const add = (spec) => {
    const rel = path.posix.normalize(path.posix.join(base, spec));
    if (!rel.startsWith('..')) units.add(unitOf(rel));
  };
  for (const spec of parseImportSpecs(source)) {
    if (spec.startsWith('./') || spec.startsWith('../')) add(spec);
  }
  return units;
}
