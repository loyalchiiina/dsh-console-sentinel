import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEmptyConsole, isBareShellTitle } from '../lib/logic.js'

test('isBareShellTitle recognises default interpreter titles', () => {
  assert.equal(isBareShellTitle('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), true)
  assert.equal(isBareShellTitle('C:\\Windows\\SYSTEM32\\cmd.exe'), true)
  assert.equal(isBareShellTitle('pwsh.exe'), true)
  assert.equal(isBareShellTitle(''), false)
  assert.equal(isBareShellTitle('cmd - npm run dev'), false)
  assert.equal(isBareShellTitle('C:\\...\\powershell.exe -NoExit'), false)
  assert.equal(isBareShellTitle('Windows PowerShell'), false)
})

test('isEmptyConsole: CASCADIA (Windows Terminal) window is empty only for a bare title with no CPU burn', () => {
  const casc = {
    processName: 'WindowsTerminal',
    class: 'CASCADIA_HOSTING_WINDOW_CLASS',
    childNames: [],
    title: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    cpuPct: 0,
  }
  assert.equal(isEmptyConsole(casc), true)
  assert.equal(isEmptyConsole({ ...casc, cpuPct: 7.5 }), false)
  assert.equal(isEmptyConsole({ ...casc, title: 'cmd - npm run dev' }), false)
})

test('isEmptyConsole: interpreter window unchanged (kids minus console hosts)', () => {
  assert.equal(isEmptyConsole({ processName: 'powershell', childNames: ['conhost'] }), true)
  assert.equal(isEmptyConsole({ processName: 'powershell', childNames: ['conhost', 'node'] }), false)
  assert.equal(isEmptyConsole({ processName: 'WindowsTerminal', class: 'ConsoleWindowClass', childNames: [] }), false)
})
