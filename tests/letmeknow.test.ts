import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__letmeknow__letmeknow'
const LISTEN = ['npx', '-y', '@letmeknow/cli@0.24.0', 'listen']
const READY = '{"type":"ready","fp":"0123456789abcdef","bin":"/cache/letmeknow"}\n'
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

type Child = { argv: string[]; env: [string, unknown][]; closed: boolean; write(text: string, stream?: string): void; exit(code: number): void }

// Stubs what the mod calls: npm lists `versions` (none: it cannot be reached), ~/.claude/letmeknow.json holds `settings`,
// each spawn is a child whose output the test writes, and `answer` answers each command run, by default with what it ran.
function host(on: any, { versions = ['0.24.0'] as string[] | null, settings = undefined as object | undefined, fail = undefined as string | undefined } = {}) {
  mock.env(on, { HOME: '/home/me' })
  const h = {
    clock: mock.clock(on),
    versions,
    fetches: [] as unknown[],
    children: [] as Child[],
    get spawns() { return h.children.map(child => child.argv) },
    tools: [] as any[],
    commands: [] as any[],
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
  on('fs.exists', ($: any, e: any) => ({ value: settings !== undefined && e.path === '/home/me/.claude/letmeknow.json' }))
  on('fs.read', ($: any, e: any) => ({ value: JSON.stringify(settings) }))
  on('tool.register', ($: any, e: any) => { h.tools.push(e); return { value: { tool: TOOL } } })
  on('command.register', ($: any, e: any) => { h.commands.push(e); return { value: { command: e.name } } })
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
  return h
}

const command = ($: any, args: string[], input?: string) => $.tool.call({ tool: TOOL, args, ...(input === undefined ? {} : { input }) })
const end = ($: any, reason: string) => $.session.end({ reason, sessionId: 's', resume: { sessionId: 's' } })
const update = ($: any) => $.command.run({ command: 'letmeknow-update' })

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
  expect(h.logs).toEqual(['cannot look up the newest 0.24 release (letmeknow: $.http.fetch: getaddrinfo ENOTFOUND registry.npmjs.org); npx runs one it has'])
  expect(h.spawns).toEqual([['npx', '-y', '@letmeknow/cli@0.24', 'listen']])
})

const sessions = (...list: object[]) => ({ stdout: JSON.stringify({ sessions: list }) })

test('a new session joins the listed groups it is not in, through a running sibling first, else a stopped one it runs meanwhile', async ($, on) => {
  const h = host(on, { settings: { join: ['G1', 'G2', 'G3'] } })
  h.answer = argv => {
    if (argv[1] === 'sessions') return sessions({ fp: '0123456789abcdef' }, { fp: 'running', running: true, groups: ['G1'] }, { fp: 'stopped', groups: ['G1', 'G2'] })
    if (argv[3] === 'invite') return { stdout: JSON.stringify({ link: `link-${argv[2]}-${argv[5]}` }) }
    return { stdout: '{}' }
  }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  h.children[0].write(READY)
  await settle()
  expect(h.spawns.at(-1)).toEqual(['/cache/letmeknow', '--session', 'stopped', 'listen'])
  h.children[1].write('{"type":"ready","fp":"stopped","bin":"/cache/letmeknow"}\n')
  await settle()
  expect(h.runs.map(run => [run.argv.slice(1).join(' '), run.timeoutMs])).toEqual([
    ['sessions', undefined],
    ['--session running invite --group G1', 180_000],
    ['--session 0123456789abcdef join link-running-G1', 600_000],
    ['--session stopped invite --group G2', 180_000],
    ['--session 0123456789abcdef join link-stopped-G2', 600_000],
  ])
  expect(h.children[1].closed).toBe(true)
  expect(h.logs).toEqual(['cannot join G3 through a session of this machine'])
})

test('a sibling that has no invite within 3 minutes fails, and the next is asked', async ($, on) => {
  const h = host(on, { settings: { join: ['G1'] } })
  h.answer = argv => {
    if (argv[1] === 'sessions') return sessions({ fp: 'slow', groups: ['G1'] }, { fp: 'quick', groups: ['G1'] })
    if (argv[3] === 'invite') return { stdout: JSON.stringify({ link: `link-${argv[2]}` }) }
    return { stdout: '{}' }
  }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  h.children[0].write(READY)
  await settle()
  expect(h.spawns.at(-1)).toEqual(['/cache/letmeknow', '--session', 'slow', 'listen'])
  await h.clock.advance(179_999)
  expect(h.spawns.length).toBe(2)
  await h.clock.advance(1)
  expect(h.children[1].closed).toBe(true)
  expect(h.spawns.at(-1)).toEqual(['/cache/letmeknow', '--session', 'quick', 'listen'])
  h.children[2].write('{"type":"ready","fp":"quick","bin":"/cache/letmeknow"}\n')
  await settle()
  expect(h.runs.map(run => run.argv.slice(1).join(' '))).toEqual(['sessions', '--session quick invite --group G1', '--session 0123456789abcdef join link-quick'])
  expect(h.children[2].closed).toBe(true)
  expect(h.logs).toEqual([])
})

test('a Claude Code session that ends during a join stops the sibling it runs meanwhile, and joins no further', async ($, on) => {
  const h = host(on, { settings: { join: ['G1', 'G2'] } })
  let refuse = () => {}
  h.answer = argv => {
    if (argv[1] === 'sessions') return sessions({ fp: 'stopped', groups: ['G1', 'G2'] })
    return new Promise(resolve => (refuse = () => resolve({ exitCode: 1, stderr: 'letmeknow: session stopped is not running\n' })))
  }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  h.children[0].write(READY)
  await settle()
  h.children[1].write('{"type":"ready","fp":"stopped","bin":"/cache/letmeknow"}\n')
  await settle()
  await end($, 'prompt_input_exit')
  await settle()
  expect(h.children.map(child => child.closed)).toEqual([true, true])
  refuse()
  await settle()
  expect(h.runs.map(run => run.argv.slice(1).join(' '))).toEqual(['sessions', '--session stopped invite --group G1'])
  expect(h.spawns.length).toBe(2)
  expect(h.logs).toEqual([])
})

test('a Claude Code session attaches to the session letmeknow.json names, as its reader, and runs its commands with that session\'s program', async ($, on) => {
  const h = host(on, { settings: { attach: 'fedcba9876543210' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  expect(h.spawns).toEqual([['npx', '-y', '@letmeknow/cli@0.24.0', '--session', 'fedcba9876543210', 'attach']])
  h.children[0].write('{"type":"ready","fp":"fedcba9876543210","bin":"/detached/letmeknow"}\n')
  await settle()
  expect(h.status).toEqual(['fedcba9876543210'])
  await command($, ['groups'])
  expect(h.runs.at(-1)?.argv).toEqual(['/detached/letmeknow', '--session', 'fedcba9876543210', 'groups'])
  // Run again, maybe by a newer program, the session says so in a new `ready`.
  h.children[0].write('{"type":"ready","fp":"fedcba9876543210","bin":"/detached/newer"}\n')
  await settle()
  await command($, ['groups'])
  expect(h.runs.at(-1)?.argv).toEqual(['/detached/newer', '--session', 'fedcba9876543210', 'groups'])
  // One that runs on its own is updated by running it again.
  expect(await update($)).toEqual({ text: 'fedcba9876543210 runs on its own; run it again with the newer program to update it' })
  expect(h.runs.length).toBe(2)
  await end($, 'prompt_input_exit')
  await settle()
  // Ending the Claude Code session only stops its reading.
  expect(h.children[0].closed).toBe(true)
  expect(h.spawns.length).toBe(1)
  expect(h.logs).toEqual([])
})

test('a Claude Code session whose session to attach to has a reader already is a new letmeknow session', async ($, on) => {
  const h = host(on, { settings: { attach: 'fedcba9876543210' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  h.children[0].write('letmeknow: session fedcba9876543210 has a reader attached already\n', 'stderr')
  h.children[0].exit(1)
  await settle()
  expect(h.logs).toEqual(['not attached to fedcba9876543210 (letmeknow: session fedcba9876543210 has a reader attached already); this Claude Code session is a new letmeknow session'])
  expect(h.spawns.at(-1)).toEqual(LISTEN)
  h.children[1].write(READY)
  await settle()
  expect(h.status).toEqual(['0123456789abcdef'])
  await end($, 'prompt_input_exit')
  await settle()
  expect(h.children[1].closed).toBe(true)
})

test('/letmeknow-update runs the session again with the newest patch, as the same session, or a new one if it is in no group', async ($, on) => {
  const h = host(on)
  let groups = '{"groups":[{"group":"G1"}]}'
  h.answer = argv => {
    if (argv.at(-1) === '--version') return { stdout: `letmeknow ${argv[0] === 'npx' ? argv[2].split('@')[2] : argv[0].split('/')[1]}\n` }
    if (argv[3] === 'groups') return { stdout: groups }
    return { stdout: `ran ${argv.join(' ')}` }
  }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  expect(h.commands).toEqual([{ name: 'letmeknow-update', description: "Runs this Claude Code session's letmeknow session again with the newest 0.24 release, as the same session, once Claude is idle" }])
  h.children[0].write(READY.replace('/cache/letmeknow', '/0.24.0/letmeknow'))
  await settle()
  expect(await update($)).toEqual({ text: '0123456789abcdef runs 0.24.0, the newest 0.24 release' })
  expect(h.spawns.length).toBe(1)

  h.versions = ['0.24.0', '0.24.1']
  h.env.length = 0
  const updating = update($)
  await settle()
  expect(h.children[0].closed).toBe(true)
  expect(h.spawns.at(-1)).toEqual(['npx', '-y', '@letmeknow/cli@0.24.1', '--session', '0123456789abcdef', 'listen'])
  expect(h.children[1].env).toEqual([['LETMEKNOW_SESSION', undefined]])
  const waiting = command($, ['skill'])
  // Killed, the session's process goes a moment later: until then, it runs already.
  h.children[1].write('npm notice run npx\nletmeknow: this session is already running\n', 'stderr')
  h.children[1].exit(1)
  await settle()
  await h.clock.advance(499)
  expect(h.spawns.length).toBe(2)
  await h.clock.advance(1)
  expect(h.spawns.at(-1)).toEqual(['npx', '-y', '@letmeknow/cli@0.24.1', '--session', '0123456789abcdef', 'listen'])
  h.children[2].write(READY.replace('/cache/letmeknow', '/0.24.1/letmeknow'))
  expect(await updating).toEqual({ text: '0123456789abcdef runs 0.24.1, updated from 0.24.0' })
  // Tools wait for the session to run again.
  expect(await waiting).toMatchObject({ result: 'ran /0.24.1/letmeknow --session 0123456789abcdef skill' })
  expect(h.runs.map(run => [run.argv.join(' '), run.timeoutMs])).toEqual([
    ['/0.24.0/letmeknow --version', undefined],
    ['/0.24.0/letmeknow --version', undefined],
    ['npx -y @letmeknow/cli@0.24.1 --version', 600_000],
    ['/0.24.0/letmeknow --session 0123456789abcdef groups', undefined],
    ['/0.24.1/letmeknow --session 0123456789abcdef skill', 600_000],
  ])
  expect(h.status).toEqual(['0123456789abcdef', '0123456789abcdef'])

  // letmeknow deletes a session that stops in no group, so one in none runs again as a new session.
  h.versions = ['0.24.0', '0.24.1', '0.24.2']
  groups = '{}'
  const renewing = update($)
  await settle()
  expect([h.children[2].closed, h.spawns.at(-1)]).toEqual([true, ['npx', '-y', '@letmeknow/cli@0.24.2', 'listen']])
  h.children[3].write('{"type":"ready","fp":"3123456789abcdef","bin":"/0.24.2/letmeknow"}\n')
  expect(await renewing).toEqual({ text: '3123456789abcdef runs 0.24.2, updated from 0.24.1' })
  expect(h.status.at(-1)).toBe('3123456789abcdef')
  expect(h.env.at(-1)).toEqual(['LETMEKNOW_SESSION', '3123456789abcdef'])
  expect(h.logs).toEqual([])
  await end($, 'prompt_input_exit')
  await settle()
  expect(h.children[3].closed).toBe(true)
})

test('/letmeknow-update during a join stops the sibling it runs, and the join goes no further', async ($, on) => {
  const h = host(on, { settings: { join: ['G1', 'G2'] } })
  let refuse = () => {}
  h.answer = argv => {
    if (argv.at(-1) === '--version') return { stdout: `letmeknow ${argv[0] === 'npx' ? argv[2].split('@')[2] : '0.24.0'}\n` }
    if (argv[3] === 'groups') return { stdout: '{}' }
    if (argv[1] === 'sessions') return sessions({ fp: 'stopped', groups: ['G1', 'G2'] })
    return new Promise(resolve => (refuse = () => resolve({ exitCode: 1, stderr: 'letmeknow: session process stopped\n' })))
  }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  h.children[0].write(READY)
  await settle()
  h.children[1].write('{"type":"ready","fp":"stopped","bin":"/cache/letmeknow"}\n')
  await settle()
  h.versions = ['0.24.0', '0.24.1']
  const updating = update($)
  await settle()
  expect(h.children.map(child => child.closed)).toEqual([true, true, false])
  refuse()
  await settle()
  expect(h.runs.map(run => run.argv.slice(1).join(' ')).filter(args => !args.includes('version') && !args.includes('groups'))).toEqual(['sessions', '--session stopped invite --group G1'])
  expect(h.logs).toEqual([])
  h.children[2].write('{"type":"ready","fp":"3123456789abcdef","bin":"/cache/letmeknow"}\n')
  expect(await updating).toEqual({ text: '3123456789abcdef runs 0.24.1, updated from 0.24.0' })
  await settle()
  // The new session joins the listed groups.
  expect(h.spawns.at(-1)).toEqual(['/cache/letmeknow', '--session', 'stopped', 'listen'])
})

test('/letmeknow-update leaves the session as it is where npm cannot be reached', async ($, on) => {
  const h = host(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  h.children[0].write(READY)
  await settle()
  h.versions = null
  expect(await update($)).toEqual({ text: 'letmeknow: $.http.fetch: getaddrinfo ENOTFOUND registry.npmjs.org' })
  expect([h.children[0].closed, h.spawns.length, h.runs.length]).toEqual([false, 1, 0])
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
  expect(h.logs).toEqual(['stopped (exit 1): npm warn exec\nerror: cannot save state'])
})

test('a listen that cannot start is told in the transcript', async ($, on) => {
  const h = host(on, { fail: 'process.spawn(npx) failed to start: ENOENT' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await settle()
  expect(h.logs).toEqual([expect.stringContaining('ENOENT')])
})
