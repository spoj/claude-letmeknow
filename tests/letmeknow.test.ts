import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__letmeknow__letmeknow'
const NPX = ['npx', '-y', '@letmeknow/cli@0.22']
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

// Stubs what the mod calls, with a `listen` whose output the test writes.
function host(on: any, { groups = [] as unknown[], fail = undefined as string | undefined } = {}) {
  const h = {
    spawns: [] as string[][],
    tools: [] as any[],
    env: [] as [string, unknown][],
    status: [] as unknown[],
    logs: [] as string[],
    submits: [] as string[],
    runs: [] as { argv: string[]; stdin?: string }[],
    closed: false,
    write(text: string, stream = 'stdout') { h.pending.push({ stream, text }); h.wake() },
    exit(code: number) { h.code = code; h.wake() },
    pending: [] as { stream: string; text: string }[],
    code: undefined as number | undefined,
    wake: () => {},
  }
  on('tool.register', ($: any, e: any) => { h.tools.push(e); return { value: { tool: TOOL } } })
  on('env.set', ($: any, e: any) => { h.env.push([e.name, e.value]); return { value: {} } })
  on('ui.status', ($: any, e: any) => { h.status.push(e.text); return { value: undefined } })
  on('ui.log', ($: any, e: any) => { h.logs.push(e.text); return { value: undefined } })
  on('prompt.submit', ($: any, e: any) => { h.submits.push(e.text); return { text: e.text } })
  on('process.spawn', async function* ($: any, e: any, next: any) {
    h.spawns.push(e.argv)
    if (fail) return { deny: fail }
    next.signal.addEventListener('abort', () => { h.closed = true; h.wake() })
    for (;;) {
      while (h.pending.length) yield h.pending.shift()
      if (h.code !== undefined) return { value: { code: h.code, signal: null } }
      if (h.closed) return { value: { code: null, signal: 'SIGTERM' } }
      await new Promise<void>(resolve => (h.wake = resolve))
    }
  })
  on('process.run', ($: any, e: any) => {
    h.runs.push({ argv: e.argv, stdin: e.init?.stdin })
    if (e.argv.at(-1) === 'unreachable') return { deny: 'process.run(npx) failed to start: ENOENT' }
    const stdout = e.argv.at(-1) === 'sessions' ? JSON.stringify({ sessions: [{ handle: h.spawns[0][4], groups }] }) : `ran ${e.argv.join(' ')}`
    const failed = e.argv.includes('broken')
    return { value: { exitCode: failed ? 2 : 0, stdout: failed ? '' : stdout, stderr: failed ? 'error: no such group\n' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.attach', ($: any, e: any) => ({ clientId: e.clientId }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  return h
}

const command = ($: any, args: string[], input?: string) => $.tool.call({ tool: TOOL, args, ...(input === undefined ? {} : { input }) })
const end = ($: any, reason: string) => $.session.end({ reason, sessionId: 's', resume: { sessionId: 's' } })

test('a terminal session joins letmeknow, hears what listen prints, and runs commands with its program', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const handle = h.spawns[0][4]
  expect(handle).toMatch(/^claude-[0-9a-f]{8}$/)
  expect(h.spawns).toEqual([[...NPX, '--session', handle, 'listen']])
  expect(h.env).toEqual([['LETMEKNOW_SESSION', handle]])
  expect(h.tools[0].name).toBe('letmeknow')
  expect(h.tools[0].description).toContain(`session ${handle}`)
  expect(h.tools[0].isDeferred).toBe(false)

  expect(await command($, ['skill'])).toMatchObject({ result: `ran ${[...NPX, '--session', handle, 'skill'].join(' ')}` })

  h.write('{"type":"ready","session":"x","bin":"/cache/letmeknow"}\n{"type":"message","content":"h')
  await settle()
  expect(h.submits).toEqual([])
  expect(h.status).toEqual([handle])
  h.write('i"}\n')
  h.write('{"type":"joined","member":"ann"}\n{"type":"message","content":"two"}\n')
  await settle()
  expect(h.submits).toEqual(['{"type":"message","content":"hi"}', '{"type":"joined","member":"ann"}\n{"type":"message","content":"two"}'])

  expect(await command($, ['send', '--to', 'ann', '-'], 'hello')).toMatchObject({ result: `ran /cache/letmeknow --session ${handle} send --to ann -` })
  expect(h.runs.at(-1)).toEqual({ argv: ['/cache/letmeknow', '--session', handle, 'send', '--to', 'ann', '-'], stdin: 'hello' })
  expect(await command($, ['send', '--group', 'broken', 'hi'])).toEqual({ deny: 'error: no such group' })
  expect(await command($, ['unreachable'])).toMatchObject({ deny: expect.stringContaining('ENOENT') })
})

test('a session that draws nowhere at its start joins when the Desktop app, VS Code or a phone attaches', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  expect(h.spawns).toEqual([])
  expect(h.tools).toEqual([])
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:phone' })
  expect(h.spawns.length).toBe(1)
  expect(h.tools.length).toBe(1)
})

test('/clear and /resume keep the session; ending removes one in no group', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const handle = h.spawns[0][4]
  h.write('{"type":"ready","bin":"/cache/letmeknow"}\n')
  await settle()
  await end($, 'clear')
  await end($, 'resume')
  expect(h.closed).toBe(false)
  expect(h.runs).toEqual([])
  await end($, 'prompt_input_exit')
  await settle()
  expect(h.closed).toBe(true)
  expect(h.runs.map(run => run.argv)).toEqual([['/cache/letmeknow', 'sessions'], ['/cache/letmeknow', 'sessions', 'remove', handle]])
  expect(h.logs).toEqual([])
})

test('ending keeps a session that is in groups', async ($, on) => {
  const h = host(on, { groups: ['a group'] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  h.write('{"type":"ready","bin":"/cache/letmeknow"}\n')
  await settle()
  await end($, 'other')
  expect(h.closed).toBe(true)
  expect(h.runs.map(run => run.argv)).toEqual([['/cache/letmeknow', 'sessions']])
})

test('a listen that stops is told in the transcript', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  h.write('npm warn exec\n', 'stderr')
  h.write('error: cannot save state\n', 'stderr')
  h.exit(1)
  await settle()
  expect(h.logs).toEqual(['letmeknow stopped (exit 1): npm warn exec\nerror: cannot save state'])
})

test('a listen that cannot start is told in the transcript', async ($, on) => {
  const h = host(on, { fail: 'process.spawn(npx) failed to start: ENOENT' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  expect(h.logs).toEqual([expect.stringContaining('ENOENT')])
})
