// Puts a Claude Code session in letmeknow: one in a terminal, and one the Desktop app, VS Code or a phone attaches to,
// as a new letmeknow session, known by its fingerprint, which joins the groups of ~/.claude/letmeknow.json and goes when
// the Claude Code session ends in no group. Its `letmeknow listen` runs through npx, as letmeknow's skill has agents run it, but with the newest release of the
// minor version it speaks by its exact version, which it looks up on npm: npx takes any release it has cached for a
// range. What it prints reaches Claude as one prompt from this plugin, once none came for a moment; its `ready` names
// the session's fingerprint and its own program, which runs the commands of Claude's letmeknow tool, once ready. The
// tool's description tells Claude its session: where an organization manages Claude Code, only the plugins it lists can
// add to the system prompt.
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
		.sort((a, b) => a.split('.')[2] - b.split('.')[2])
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

// The groups each session joins as it starts, by id: `{ "join": ["<group id>"] }`.
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

// Joins the session `fp` to each listed group it is not in, through a sibling: a running one first; until the Claude Code
// session ends.
async function joinListed($, current, bin, fp) {
	if (!current.join.length) return
	const { sessions } = JSON.parse(await letmeknow($, [bin, 'sessions']))
	for (const group of current.join) {
		if (sessions.find(s => s.fp === fp)?.groups?.includes(group)) continue
		const siblings = sessions.filter(s => s.fp !== fp && s.groups?.includes(group)).sort((a, b) => Number(!!b.running) - Number(!!a.running))
		const failures = []
		for (const sibling of siblings) {
			if (session !== current) return
			try {
				await inviteFrom($, current, bin, sibling, group, link => letmeknow($, [bin, '--session', fp, 'join', link], { timeoutMs: 600_000 }))
				break
			} catch (error) {
				failures.push(`${sibling.fp}: ${error.message}`)
			}
		}
		if (failures.length === siblings.length && session === current) $.ui.log(`letmeknow: cannot join ${group} through a session of this machine${failures.length ? ` (${failures.join('; ')})` : ''}`)
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
	begin($, current).catch(error => {
		current.reject(error)
		if (session === current) $.ui.log(`letmeknow: ${error.message}`)
	})
}

async function begin($, current) {
	const [version, { join = [] }] = await Promise.all([
		newest($).catch(error => {
			$.ui.log(`letmeknow: cannot look up the newest ${MINOR} release (${error.message}); npx runs one it has`)
			return MINOR
		}),
		settings($),
	])
	current.join = join
	await run($, current, ['npx', '-y', `@letmeknow/cli@${version}`, 'listen'])
}

// Runs `argv`, `listen`: what it prints reaches Claude, and its `ready` names the session. Once it stops, `exited` hears
// its exit code and what it printed to stderr last.
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
					Object.assign(current, { bin: event.bin, fp: event.fp })
					await $.env.set('LETMEKNOW_SESSION', event.fp)
					$.ui.status(event.fp)
					current.resolve()
					joinListed($, current, event.bin, event.fp).catch(error => session === current && $.ui.log(`letmeknow: joining the groups of ~/.claude/letmeknow.json: ${error.message}`))
				}
			}
		}
		;({ code } = await listen.result)
	} catch (error) {
		errors = error.message
	}
	exited(code, errors.trim())
}

function stopped($, current, code, errors) {
	current.reject(new Error(`letmeknow stopped (exit ${code}): ${errors}`))
	if (session === current) $.ui.log(`letmeknow stopped (exit ${code}): ${errors}`)
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
	// Commands wait for the session to be ready, and run with the program its `ready` names.
	on('tool.call', { tool: TOOL }, async ($, e) => {
		const current = session
		await current.ready
		// The longest run allowed: `join` waits for its inviter.
		return { result: await letmeknow($, [current.bin, '--session', current.fp, ...e.args], { stdin: e.input ?? '', timeoutMs: 600_000 }) }
	}).catch(($, e, next) => ({ deny: next.error.message }))
	// After /clear or /resume the process goes on without a new session.start, and so does its letmeknow session.
	// letmeknow deletes one that stops in no group.
	on('session.end', ($, e, next) => {
		if (!session || e.reason === 'clear' || e.reason === 'resume') return next(e)
		session.listen.return()
		// A sibling run for a join stops too.
		session.sibling?.return()
		session.reject(new Error('this Claude Code session has left letmeknow'))
		session = undefined
		timer?.cancel()
		waiting = []
		return next(e)
	})
}
