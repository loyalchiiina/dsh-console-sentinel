// Regression test for the desktop-cleanup selection rule.
// Pure selection logic: no live Windows, no PowerShell — guards the core
// guarantee that powershell/python windows are never selected for cleanup.
import assert from 'node:assert/strict'
import { selectCleanupTargets, DEFAULT_PROTECTED_PROCESSES, SHELL_CLASSES } from '../lib/desktop.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try { fn(); pass += 1; console.log('  PASS ' + name) }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' -> ' + e.message) }
}

const FG = 4288750
const W = (hwnd, process, title, extra = {}) => ({
  hwnd, class: 'Chrome_WidgetWin_1', title, pid: 1000 + hwnd, process, ...extra,
})

console.log('--- D1: protected processes never selected ---')
check('powershell.exe window is kept', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(1, 'powershell.exe', 'Windows PowerShell')], { fgHwnd: FG })
  assert.equal(targets.length, 0)
  assert.equal(kept[0].keepReason, 'protected-process')
})
check('pwsh.exe window is kept', () => {
  const { targets } = selectCleanupTargets([W(2, 'pwsh.exe', 'PowerShell 7')], { fgHwnd: FG })
  assert.equal(targets.length, 0)
})
check('python.exe window is kept', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(3, 'python.exe', 'E:\\Python311\\python.exe')], { fgHwnd: FG })
  assert.equal(targets.length, 0)
  assert.equal(kept[0].keepReason, 'protected-process')
})
check('pythonw.exe window is kept', () => {
  const { targets } = selectCleanupTargets([W(4, 'pythonw.exe', 'gui script')], { fgHwnd: FG })
  assert.equal(targets.length, 0)
})
check('Windows Terminal hosting python is NOT protected by name (documented boundary)', () => {
  // WT window belongs to WindowsTerminal.exe; the console path (probe.js)
  // classifies it as script-console by title. Desktop cleanup closes by taskbar
  // app; keepTitle covers this case when needed.
  const { targets } = selectCleanupTargets(
    [W(5, 'WindowsTerminal', 'E:\\Python311\\python.exe')], { fgHwnd: FG })
  assert.equal(targets.length, 1)
})

console.log('--- D2: foreground / self / shell always kept ---')
check('foreground window kept', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(FG, 'chrome', 'Google Chrome')], { fgHwnd: FG })
  assert.equal(targets.length, 0)
  assert.equal(kept[0].keepReason, 'foreground')
})
check('self pid kept', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(6, 'node', 'cli window', { pid: 777 })], { fgHwnd: FG, selfPid: 777 })
  assert.equal(targets.length, 0)
  assert.equal(kept[0].keepReason, 'self')
})
check('shell classes kept (taskbar, desktop)', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(7, 'explorer', 'Taskbar', { class: 'Shell_TrayWnd' })], { fgHwnd: FG })
  assert.equal(targets.length, 0)
  assert.equal(kept[0].keepReason, 'shell-class')
})

console.log('--- D3: keep lists honored ---')
check('keepPid honored', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(8, 'chrome', 'Google Chrome')], { fgHwnd: FG, keepPids: [1008] })
  assert.equal(targets.length, 0)
  assert.equal(kept[0].keepReason, 'keep-pid')
})
check('keepTitle substring (case-insensitive) honored', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(9, 'chrome', 'Google Chrome')], { fgHwnd: FG, keepTitles: ['CHROME'] })
  assert.equal(targets.length, 0)
  assert.equal(kept[0].keepReason, 'keep-title')
})

console.log('--- D4: ordinary apps are selected ---')
check('chrome/notepad/edge selected', () => {
  const { targets } = selectCleanupTargets(
    [W(10, 'chrome', 'Google Chrome'), W(11, 'Notepad', 'notes.txt'), W(12, 'msedge', 'Edge')],
    { fgHwnd: FG })
  assert.equal(targets.length, 3)
})
check('mixed batch: protected kept, ordinary selected', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(20, 'powershell.exe', 'Windows PowerShell'), W(21, 'chrome', 'Google Chrome'),
     W(22, 'python.exe', 'E:\\Python311\\python.exe'), W(23, 'WINWORD', 'report.docx')],
    { fgHwnd: FG })
  assert.equal(targets.length, 2)
  assert.deepEqual(targets.map((t) => t.process.toLowerCase()).sort(), ['chrome', 'winword'])
  assert.equal(kept.length, 2)
  assert.ok(kept.every((k) => k.keepReason === 'protected-process'))
})

console.log('--- D5: custom protected list ---')
check('custom list replaces default', () => {
  const { targets, kept } = selectCleanupTargets(
    [W(30, 'powershell.exe', 'PS'), W(31, 'spotify', 'Spotify')],
    { fgHwnd: FG, protectedProcesses: ['spotify'] })
  assert.equal(targets.length, 1)
  assert.equal(targets[0].process, 'powershell.exe')
  assert.equal(kept[0].keepReason, 'protected-process')
})
check('default list contents', () => {
  assert.deepEqual(
    DEFAULT_PROTECTED_PROCESSES,
    ['powershell', 'pwsh', 'python', 'pythonw', 'dsh desktop', 'explorer', 'taskmgr', 'fluent', 'launcher1'])
  assert.ok(SHELL_CLASSES.includes('Shell_TrayWnd'))
})

console.log('--- D6: empty / edge inputs ---')
check('empty window list -> nothing', () => {
  const { targets, kept } = selectCleanupTargets([], { fgHwnd: FG })
  assert.equal(targets.length, 0)
  assert.equal(kept.length, 0)
})
check('null windows tolerated', () => {
  const { targets } = selectCleanupTargets(null, { fgHwnd: FG })
  assert.equal(targets.length, 0)
})
check('process with mixed case + .exe suffix still protected', () => {
  const { targets } = selectCleanupTargets(
    [W(40, 'PowerShell.EXE', 'admin shell')], { fgHwnd: FG })
  assert.equal(targets.length, 0)
})

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
