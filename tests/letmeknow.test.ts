import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__letmeknow__letmeknow'
const LISTEN = ['npx', '-y', '@letmeknow/cli@0.24.0', 'listen']
const READY = '{"type":"ready","fp":"0123456789abcdef","bin":"/cache/letmeknow"}\n'
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

type Child = { argv: string[]; env: [string, unknown][]; closed: boolean; write(text: string, stream?: string): void; exit(code: number): void }

// Stubs what the mod calls: npm lists `versions` (none: it cannot be reached), each spawn is a child whose output the
// test writes, and `answer` answers each command run, by default with what it ran.
function host(on: any, { versions = ['0.24.0'] as string[] | null, fail = undefined as string | undefined } = {}) {
  const h = {
    clock: mock.clock(on),
    fetches: [] as unknown[],
    children: [] as Child[],
    get spawns() { return h.children.map(child => child.argv) },
    tools: [] as any[],
    env: [] as [string, unknown][],
    status: [] as unknown[],
    logs: [] as string[],
    submits: [] as string[],
    runs: [] as { argv: string[]; stdin?: string; timeoutMs?: number }[],
    answer: (argv: string[]): any => argv.includes('broken') ? { exitCode: 2, stderr: 'error: no such group\n' } : { stdout: `ran ${argv.join(' ')}` },
  }
  on('http.fetch', ($: any, e: any) => {
    h.fetches.push(e)
    if (!h.versions) return { deny: 'getaddrinfo ENOTFOUND registry.npmjs.org' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ versions: Object.fromEntries(h.versions.map(v => [v, {}])) }) } }
  })
  on('tool.register', ($: any, e: any) => { h.tools.push(e); return { value: { tool: TOOL } } })
  on('env.set', ($: any, e: any) => { h.env.push([e.name, e.value]); return { value: {} } })
  on('ui.status', ($: any, e: any) => { h.status.push(e.text); return { value: undefined } })
  on('ui.log', ($: any, e: any) => { h.logs.push(e.text); return { value: undefined } })
  on('prompt.submit', ($: any, e: any) => { h.submits.push(e.text); return { text: e.text } })
  on('process.spawn', async function* ($: any, e: any, next: any) {
    const pending: { stream: string; text: string }[] = []
    let code: number | undefined
    let wake = () => {}
    const child: Child = {
      argv: e.argv,
      env: [...h.env],
      closed: false,
      write(text, stream = 'stdout') { pending.push({ stream, text }); wake() },
      exit(exitCode) { code = exitCode; wake() },
    }
    h.children.push(child)
    if (fail) return { deny: fail }
    next.signal.addEventListener('abort', () => { child.closed = true; wake() })
    for (;;) {
      while (pending.length) yield pending.shift()
      if (code !== undefined) return { value: { code, signal: null } }
      if (child.closed) return { value: { code: null, signal: 'SIGTERM' } }
      await new Promise<void>(resolve => (wake = resolve))
    }
  })
  on('process.run', async ($: any, e: any) => {
    h.runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })
    if (e.argv.at(-1) === 'unreachable') return { deny: 'process.run(npx) failed to start: ENOENT' }
    const { exitCode = 0, stdout = '', stderr = '' } = await h.answer(e.argv)
    return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.attach', ($: any, e: any) => ({ clientId: e.clientId }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  return Object.assign(h, { versions })
}

const command = ($: any, args: string[], input?: string) => $.tool.call({ tool: TOOL, args, ...(input === undefined ? {} : { input }) })
const end = ($: any, reason: string) => $.session.end({ reason, sessionId: 's', resume: { sessionId: 's' } })

test('a terminal session joins letmeknow, hears what listen prints, and runs commands with its program', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(h.tools[0].name).toBe('letmeknow')
  expect(h.tools[0].description).toContain('a session of your own')
  expect(h.tools[0].isDeferred).toBe(false)

  const early = command($, ['skill'])
  await settle()
  expect(h.spawns).toEqual([LISTEN])
  // `listen` inherits the process's environment: a LETMEKNOW_SESSION it started with, as a Pi's, would name its session.
  expect(h.children[0].env).toEqual([['LETMEKNOW_SESSION', undefined]])
  expect(h.runs).toEqual([])
  const listen = h.children[0]
  listen.write(READY + '{"type":"message","content":"h')
  expect(await early).toMatchObject({ result: 'ran /cache/letmeknow --session 0123456789abcdef skill' })
  await settle()
  expect(h.submits).toEqual([])
  expect(h.status).toEqual(['0123456789abcdef'])
  expect(h.env).toEqual([['LETMEKNOW_SESSION', undefined], ['LETMEKNOW_SESSION', '0123456789abcdef']])
  listen.write('i"}\n')
  await settle()
  await h.clock.advance(2000)
  listen.write('{"type":"joined","member":"ann"}\n')
  await settle()
  await h.clock.advance(1500)
  listen.write('{"type":"message","content":"two"}\n')
  await settle()
  await h.clock.advance(1999)
  expect(h.submits).toEqual(['{"type":"message","content":"hi"}'])
  // Lines wake Claude together, 2 seconds after the last.
  await h.clock.advance(1)
  expect(h.submits).toEqual(['{"type":"message","content":"hi"}', '{"type":"joined","member":"ann"}\n{"type":"message","content":"two"}'])

  expect(await command($, ['send', '--to', 'ann', '-'], 'hello')).toMatchObject({ result: 'ran /cache/letmeknow --session 0123456789abcdef send --to ann -' })
  expect(h.runs.at(-1)).toMatchObject({ argv: ['/cache/letmeknow', '--session', '0123456789abcdef', 'send', '--to', 'ann', '-'], stdin: 'hello' })
  expect(await command($, ['send', '--group', 'broken', 'hi'])).toEqual({ deny: 'error: no such group' })
  expect(await command($, ['unreachable'])).toMatchObject({ deny: expect.stringContaining('ENOENT') })
})

test('a session runs the newest stable 0.24 release on npm, by its exact version: npx takes any it has cached for a range', async ($, on) => {
  const h = host(on, { versions: ['0.23.19', '0.24.2', '0.24.10', '0.24.11-beta.1', '0.25.0'] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  expect(h.fetches).toEqual([{ url: 'https://registry.npmjs.org/@letmeknow/cli', init: { headers: { accept: 'application/vnd.npm.install-v1+json' } } }])
  expect(h.spawns).toEqual([['npx', '-y', '@letmeknow/cli@0.24.10', 'listen']])
  expect(h.logs).toEqual([])
})

test('a session that cannot look up the newest release runs one npx has', async ($, on) => {
  const h = host(on, { versions: null })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  expect(h.logs).toEqual(['letmeknow: cannot look up the newest 0.24 release (letmeknow: $.http.fetch: getaddrinfo ENOTFOUND registry.npmjs.org); npx runs one it has'])
  expect(h.spawns).toEqual([['npx', '-y', '@letmeknow/cli@0.24', 'listen']])
})

test('a session that draws nowhere at its start joins when the Desktop app, VS Code or a phone attaches', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await settle()
  expect(h.spawns).toEqual([])
  expect(h.tools).toEqual([])
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:phone' })
  await settle()
  expect(h.spawns.length).toBe(1)
  expect(h.tools.length).toBe(1)
})

test('/clear and /resume keep the session; ending stops it', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  h.children[0].write(READY)
  await settle()
  await end($, 'clear')
  await end($, 'resume')
  expect(h.children[0].closed).toBe(false)
  expect(h.runs).toEqual([])
  await end($, 'prompt_input_exit')
  await settle()
  expect(h.children[0].closed).toBe(true)
  expect(h.runs).toEqual([])
  expect(h.logs).toEqual([])
})

test('a listen that stops is told in the transcript', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  h.children[0].write('npm warn exec\n', 'stderr')
  h.children[0].write('error: cannot save state\n', 'stderr')
  h.children[0].exit(1)
  await settle()
  expect(h.logs).toEqual(['letmeknow stopped (exit 1): npm warn exec\nerror: cannot save state'])
})

test('a listen that cannot start is told in the transcript', async ($, on) => {
  const h = host(on, { fail: 'process.spawn(npx) failed to start: ENOENT' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  expect(h.logs).toEqual([expect.stringContaining('ENOENT')])
})
