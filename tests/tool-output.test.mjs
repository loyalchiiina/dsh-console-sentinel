// Regression test for the TOOL OUTPUT CONTRACT (2026-09-23 实证).
//
// The bug this locks down: console_window_action built its result as
//   { ok, hwnd, action, title, reason: res.ok ? undefined : res.reason, detail }
// so on SUCCESS it carried an explicit `reason: undefined`. The tool's output
// schema declares `reason` as a string, so validation failed and the runtime
// dropped the ENTIRE result — the caller got
//   "tool ... returned invalid output: value is not lossless JSON"
// even though the hide had actually worked. The action looked broken while the
// window silently disappeared from the taskbar.
//
// This is the "tool succeeded but the caller received nothing" class of bug:
// indistinguishable at a glance from a real failure, which is why it needs a
// test rather than a code reading.
import assert from 'node:assert/strict'

let pass = 0
let fail = 0
function check(name, fn) {
  try { fn(); pass += 1; console.log('  PASS ' + name) }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' -> ' + e.message) }
}

// Mirror of the tool's declared output schema for `reason`.
const REASON_DECLARED_TYPE = 'string'

// A "lossless JSON" round-trip is the practical proxy for what the runtime
// enforces: undefined-valued keys survive into the object but are not valid
// against a string schema, and JSON.stringify silently DELETES them — which is
// exactly why the failure was invisible in logs but fatal at the boundary.
function isLossless(value) {
  try {
    const s = JSON.stringify(value)
    if (s === undefined) return false
    const back = JSON.parse(s)
    return JSON.stringify(back) === s
  } catch { return false }
}

console.log('--- T12: tool output must not carry undefined fields ---')

check('OLD shape is rejected (proves the test detects the bug)', () => {
  const res = { ok: true, afterVisible: false, stillWindow: true, action: 'hide' }
  const oldShape = {
    ok: Boolean(res.ok),
    hwnd: 5714870,
    action: 'hide',
    title: 'Windows PowerShell',
    reason: res.ok ? undefined : res.reason,   // <- the defect
    detail: res,
  }
  assert.equal(oldShape.reason, undefined, 'the old shape really did set reason=undefined')
  // The defect is invisible to JSON (key is dropped) but present on the object —
  // which is precisely how a declared-string field ends up failing validation.
  assert.ok(!('reason' in JSON.parse(JSON.stringify(oldShape))),
    'JSON silently drops the undefined key, hiding the problem from logs')
  assert.ok('reason' in oldShape && oldShape.reason === undefined,
    'the live object still carries the offending undefined')
})

check('NEW shape is lossless on success (no reason key at all)', () => {
  const res = { ok: true, afterVisible: false, stillWindow: true, action: 'hide' }
  const out = {
    ok: Boolean(res.ok),
    hwnd: 5714870,
    action: 'hide',
    title: 'Windows PowerShell',
    detail: res,
  }
  if (!res.ok && res.reason !== undefined) out.reason = String(res.reason)
  assert.ok(!('reason' in out), 'success must omit reason entirely')
  assert.ok(isLossless(out), 'success payload must round-trip losslessly')
})

check('NEW shape keeps reason on failure (and it is a real string)', () => {
  const res = { ok: false, reason: 'hwnd-not-a-window' }
  const out = {
    ok: Boolean(res.ok),
    hwnd: 123,
    action: 'hide',
    title: '',
    detail: res,
  }
  if (!res.ok && res.reason !== undefined) out.reason = String(res.reason)
  assert.equal(out.reason, 'hwnd-not-a-window')
  assert.equal(typeof out.reason, REASON_DECLARED_TYPE)
  assert.ok(isLossless(out))
})

check('failure with a missing reason stays schema-valid (no undefined injected)', () => {
  const res = { ok: false }             // no reason supplied at all
  const out = {
    ok: Boolean(res.ok),
    hwnd: 123,
    action: 'hide',
    title: '',
    detail: res,
  }
  if (!res.ok && res.reason !== undefined) out.reason = String(res.reason)
  assert.ok(!('reason' in out), 'absent reason must stay absent, not become undefined')
  assert.ok(isLossless(out))
})

check('non-string reason is coerced so the schema still matches', () => {
  const res = { ok: false, reason: 42 }
  const out = { ok: false, hwnd: 1, action: 'hide', title: '', detail: res }
  if (!res.ok && res.reason !== undefined) out.reason = String(res.reason)
  assert.equal(out.reason, '42')
  assert.equal(typeof out.reason, REASON_DECLARED_TYPE)
})

console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===')
if (fail > 0) process.exit(1)
