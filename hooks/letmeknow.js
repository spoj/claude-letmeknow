// Puts a Claude Code session in letmeknow: one in a terminal, and one the Desktop app, VS Code or a phone attaches to,
// as a new letmeknow session, known by its fingerprint, which joins the groups of ~/.claude/letmeknow.json and goes
// when the Claude Code session ends in no group; or as the session that file names to attach to, which runs on its own,
// while it has no other reader. Its `letmeknow listen`, or `attach`, runs through npx, as letmeknow's skill has agents
// run it, but with the newest release of the minor version it speaks, by its exact version, which it looks up on npm:
// npx runs any release it has cached for a range. /letmeknow-update runs the session again with a newer one, as the
// same session. What the session prints reaches Claude as one prompt from this plugin, once none came for a moment; its
// `ready` names the session's fingerprint and its own program, which runs the commands of Claude's letmeknow tool, once
// ready. The tool's description tells Claude its session: where an organization manages Claude Code, only the plugins
// it lists can add to the system prompt.
const MINOR = '0.24'
const TOOL = 'mcp__letmeknow__letmeknow'
// How long a sibling has to start and make its invite: back from a while away, its invite first catches up, up to about
// two minutes.
const INVITE_WAIT = 180_000
// How long the lines the session prints wait for more before they reach Claude together.
const DEBOUNCE = 2000

let session
let waiting = []
let timer

function wake($, line) {
	waiting.push(line)
	timer?.cancel()
	timer = $.clock.after(DEBOUNCE, () => {
		void $.prompt.submit({ text: waiting.join('\n') })
		waiting = []
	})
}

// The newest stable MINOR release on npm.
async function newest($) {
	const found = await $.http.fetch('https://registry.npmjs.org/@letmeknow/cli', { headers: { accept: 'application/vnd.npm.install-v1+json' } })
	if (!found.ok) throw new Error(`npm has no @letmeknow/cli (${found.status})`)
	const latest = Object.keys(JSON.parse(found.text).versions)
		.filter(version => version.startsWith(`${MINOR}.`) && /^\d+\.\d+\.\d+$/.test(version))
		.sort((a, b) => Number(a.split('.')[2]) - Number(b.split('.')[2]))
		.at(-1)
	if (!latest) throw new Error(`letmeknow has no ${MINOR} release`)
	return latest
}

// Runs a letmeknow command, `argv`, and answers what it prints; one that fails throws what it printed to stderr.
async function letmeknow($, argv, init) {
	const { exitCode, stdout, stderr } = await $.process.run(argv, init)
	if (exitCode !== 0) throw new Error(stderr.trim() || `letmeknow exited with ${exitCode}`)
	return stdout
}

// The groups each session joins as it starts, by id, and the session to attach to rather than start a new one, by
// fingerprint: `{ "join": ["<group id>"], "attach": "<fp>" }`.
async function settings($) {
	const path = `${await $.env.get('HOME')}/.claude/letmeknow.json`
	return (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : {}
}

// An invite into `group` from `sibling`, another session of this machine in it: a running one, or a stopped one that runs
// only until `use` is done with the link, or the Claude Code session ends. A sibling that has no invite within
// INVITE_WAIT fails, so that the next one is asked.
async function inviteFrom($, current, bin, sibling, group, use) {
	const invite = async () => JSON.parse(await letmeknow($, [bin, '--session', sibling.fp, 'invite', '--group', group], { timeoutMs: INVITE_WAIT })).link
	if (sibling.running) return use(await invite())
	const listen = $.process.spawn({ argv: [bin, '--session', sibling.fp, 'listen'] })
	current.sibling = listen
	try {
		await new Promise((resolve, reject) => {
			$.clock.after(INVITE_WAIT, () => reject(new Error(`session ${sibling.fp} was not ready within ${INVITE_WAIT / 1000} s`)))
			;(async () => {
				let printed = ''
				let errors = ''
				for await (const { stream, text } of listen) {
					if (stream === 'stderr') errors += text
					// Its first line is its `ready`.
					else if ((printed += text).includes('\n')) resolve()
				}
				reject(new Error(`session ${sibling.fp} stopped (exit ${(await listen.result).code}): ${errors.trim()}`))
			})().catch(reject)
		})
		await use(await invite())
	} finally {
		listen.return()
	}
}

// Joins the session `fp` to each listed group it is not in, through a sibling: a running one first; while `listen` runs
// it for the Claude Code session.
async function joinListed($, current, listen, bin, fp) {
	if (!current.join.length) return
	const { sessions } = JSON.parse(await letmeknow($, [bin, 'sessions']))
	for (const group of current.join) {
		if (sessions.find(s => s.fp === fp)?.groups?.includes(group)) continue
		const siblings = sessions.filter(s => s.fp !== fp && s.groups?.includes(group)).sort((a, b) => Number(!!b.running) - Number(!!a.running))
		const failures = []
		for (const sibling of siblings) {
			if (current.listen !== listen) return
			try {
				await inviteFrom($, current, bin, sibling, group, link => letmeknow($, [bin, '--session', fp, 'join', link], { timeoutMs: 600_000 }))
				break
			} catch (error) {
				failures.push(`${sibling.fp}: ${error.message}`)
			}
		}
		if (failures.length === siblings.length && current.listen === listen) $.ui.log(`cannot join ${group} through a session of this machine${failures.length ? ` (${failures.join('; ')})` : ''}`)
	}
}

async function start($) {
	if (session) return
	const current = {}
	current.ready = new Promise((resolve, reject) => Object.assign(current, { resolve, reject }))
	// Commands wait for it; one never ready fails them.
	current.ready.catch(() => {})
	session = current
	await $.tool.register({
		name: 'letmeknow',
		description: `You are in letmeknow in a session of your own, which runs already; members know it by its fingerprint, which \`members\` shows as \`you\`: what it prints reaches you as messages from this plugin, and only what you send with it reaches anyone. This tool runs its commands: \`args\` as the command takes them, as ["send", "--to", "ann", "hi"], and \`input\` for an argument "-" to read; it answers with what the command prints. Read \`skill\` with it before you first use letmeknow.`,
		inputSchema: {
			type: 'object',
			properties: { args: { type: 'array', items: { type: 'string' } }, input: { type: 'string' } },
			required: ['args'],
		},
		isDeferred: false,
	})
	await $.command.register({
		name: 'letmeknow-update',
		description: `Runs this Claude Code session's letmeknow session again with the newest ${MINOR} release, as the same session, once Claude is idle`,
	})
	begin($, current).catch(error => {
		current.reject(error)
		if (session === current) $.ui.log(error.message)
	})
}

async function begin($, current) {
	const [version, { join = [], attach }] = await Promise.all([
		newest($).catch(error => {
			$.ui.log(`cannot look up the newest ${MINOR} release (${error.message}); npx runs one it has`)
			return MINOR
		}),
		settings($),
	])
	if (session !== current) return
	current.join = join
	// npm's notices would lead what letmeknow prints to stderr.
	const program = ['npx', '-y', '--loglevel=error', `@letmeknow/cli@${version}`]
	if (!attach) return run($, current, [...program, 'listen'])
	// One that has a reader already, or does not run, leaves this Claude Code session a new letmeknow session.
	await run($, current, [...program, '--session', attach, 'attach'], (code, errors) => {
		if (current.fp) return stopped($, current, code, errors)
		$.ui.log(`not attached to ${attach} (${errors}); this Claude Code session is a new letmeknow session`)
		return run($, current, [...program, 'listen'])
	})
}

// Runs `argv`, `listen` or `attach`: what it prints reaches Claude, and its `ready` names the session. Once it stops,
// `exited` hears its exit code and what it printed to stderr last.
async function run($, current, argv, exited = (code, errors) => stopped($, current, code, errors)) {
	// A new session, not the one a LETMEKNOW_SESSION this process holds names, as a Pi's or another Claude Code session's:
	// `listen` inherits the process's environment, and takes the session it names.
	await $.env.set('LETMEKNOW_SESSION', undefined)
	const listen = $.process.spawn({ argv })
	current.listen = listen
	let rest = ''
	let errors = ''
	let code = null
	try {
		for await (const { stream, text } of listen) {
			if (stream === 'stderr') {
				errors = (errors + text).slice(-2000)
				continue
			}
			const lines = (rest + text).split('\n')
			rest = lines.pop()
			for (const line of lines) {
				const event = JSON.parse(line)
				if (event.type !== 'ready') wake($, line)
				else {
					// An attached session's comes again as it runs again, with the program it runs then.
					Object.assign(current, { bin: event.bin, fp: event.fp, attached: argv.includes('attach') })
					await $.env.set('LETMEKNOW_SESSION', event.fp)
					$.ui.status(event.fp)
					current.resolve(event.fp)
					joinListed($, current, listen, event.bin, event.fp).catch(error => current.listen === listen && $.ui.log(`joining the groups of ~/.claude/letmeknow.json: ${error.message}`))
				}
			}
		}
		;({ code } = await listen.result)
	} catch (error) {
		errors = error.message
	}
	// One the update or the Claude Code session's end stopped stops nothing.
	if (current.listen === listen) return exited(code, errors.trim())
}

// What the plugin logs, as a command's output, shows under its name.
function stopped($, current, code, errors) {
	current.reject(new Error(`letmeknow stopped (exit ${code}): ${errors}`))
	$.ui.log(`stopped (exit ${code}): ${errors}`)
}

export function register(on) {
	// A session in a terminal draws from its start; the Desktop app, VS Code and phones attach to one.
	on('session.start', async ($, e, next) => {
		if (e.surface) await start($)
		return next(e)
	})
	on('session.attach', async ($, e, next) => {
		await start($)
		return next(e)
	})
	// Commands wait for the session to be ready, as long as a hook may (10 seconds, waits on `$` aside), and run with the
	// program its `ready` names. A hook that runs out of time has no message.
	on('tool.call', { tool: TOOL }, async ($, e) => {
		const current = session
		await current.ready
		// The longest run allowed: `join` waits for its inviter.
		return { result: await letmeknow($, [current.bin, '--session', current.fp, ...e.args], { stdin: e.input ?? '', timeoutMs: 600_000 }) }
	}).catch(($, e, next) => ({ deny: next.error.message ?? 'the letmeknow session is not ready yet' }))
	// A command typed while Claude works runs once the turn ends.
	on('command.run', { command: 'letmeknow-update' }, async $ => {
		const current = session
		const fp = await current.ready
		if (current.attached) return { text: `${fp} runs on its own; run it again with the newer program to update it` }
		const to = await newest($)
		const from = (await letmeknow($, [current.bin, '--version'])).trim().split(' ')[1]
		if (from === to) return { text: `${fp} runs ${to}, the newest ${MINOR} release` }
		const program = ['npx', '-y', '--loglevel=error', `@letmeknow/cli@${to}`]
		// npx fetches it while the session runs on.
		await letmeknow($, [...program, '--version'], { timeoutMs: 600_000 })
		// A session that stops in no group is deleted, so one in none runs again as a new session.
		const { groups } = JSON.parse(await letmeknow($, [current.bin, '--session', fp, 'groups']))
		// Tools wait for the session to run again.
		current.ready = new Promise((resolve, reject) => Object.assign(current, { resolve, reject }))
		current.ready.catch(() => {})
		const old = current.listen
		current.listen = undefined
		old.return()
		// The join it ran for goes no further.
		current.sibling?.return()
		const argv = [...program, ...(groups ? ['--session', fp, 'listen'] : ['listen'])]
		// The engine kills a process without waiting for it to go, and until it has, the session is running already.
		const again = () => session === current && run($, current, argv, (code, errors) => errors.endsWith('this session is already running') ? $.clock.after(500, again) : stopped($, current, code, errors))
		again()
		return { text: `${await current.ready} runs ${to}, updated from ${from}` }
	}).catch(($, e, next) => ({ text: next.error.message ?? 'the session is not ready yet' }))
	// After /clear or /resume the process goes on without a new session.start, and so does its letmeknow session.
	// letmeknow deletes one that stops in no group.
	on('session.end', ($, e, next) => {
		if (!session || e.reason === 'clear' || e.reason === 'resume') return next(e)
		// Between the update's stop and run, none runs.
		session.listen?.return()
		session.listen = undefined
		// A sibling run for a join stops too, and the join goes no further.
		session.sibling?.return()
		session.reject(new Error('this Claude Code session has left letmeknow'))
		session = undefined
		timer?.cancel()
		waiting = []
		return next(e)
	})
}
