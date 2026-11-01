// Puts a Claude Code session in letmeknow: one in a terminal, and one the Desktop app, VS Code or a phone attaches to,
// as a new letmeknow session, known by its fingerprint, which goes when the Claude Code session ends in no group.
// Its `letmeknow listen` runs through npx, as letmeknow's skill has agents run it, but with the newest release of the
// minor version it speaks by its exact version, which it looks up on npm: npx takes any release it has cached for a
// range. What it prints reaches Claude as one prompt from this plugin, once none came for a moment; its `ready` names
// the session's fingerprint and its own program, which runs the commands of Claude's letmeknow tool, once ready. The
// tool's description tells Claude its session: where an organization manages Claude Code, only the plugins it lists can
// add to the system prompt.
const MINOR = '0.24'
const TOOL = 'mcp__letmeknow__letmeknow'
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
	void begin($, current)
}

async function begin($, current) {
	const version = await newest($).catch(error => {
		$.ui.log(`letmeknow: cannot look up the newest ${MINOR} release (${error.message}); npx runs one it has`)
		return MINOR
	})
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
		const { exitCode, stdout, stderr } = await $.process.run(
			[current.bin, '--session', current.fp, ...e.args],
			{ stdin: e.input ?? '', timeoutMs: 600_000 },
		)
		return exitCode === 0 ? { result: stdout } : { deny: stderr.trim() || `letmeknow exited with ${exitCode}` }
	}).catch(($, e, next) => ({ deny: next.error.message }))
	// After /clear or /resume the process goes on without a new session.start, and so does its letmeknow session.
	// letmeknow deletes one that stops in no group.
	on('session.end', ($, e, next) => {
		if (!session || e.reason === 'clear' || e.reason === 'resume') return next(e)
		session.listen.return()
		session.reject(new Error('this Claude Code session has left letmeknow'))
		session = undefined
		timer?.cancel()
		waiting = []
		return next(e)
	})
}
