// Puts a Claude Code session in letmeknow: one in a terminal, and one the Desktop app, VS Code or a phone attaches to,
// as a new letmeknow session, known by its fingerprint, which goes when the Claude Code session ends in no group.
// Its `letmeknow listen` runs as letmeknow's skill has agents run it, through npx. What it prints reaches Claude as a
// prompt from this plugin; its `ready` names the session's fingerprint and its own program, which runs the commands of
// Claude's letmeknow tool, once ready. The tool's description tells Claude its session: where an organization manages Claude Code, only the plugins
// it lists can add to the system prompt.
const NPX = ['npx', '-y', '@letmeknow/cli@0.23']
const TOOL = 'mcp__letmeknow__letmeknow'

let session

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
	// A new session, not the one a LETMEKNOW_SESSION this process started with names, as a Pi's or another Claude Code
	// session's: `listen` inherits the process's environment, and takes the session it names.
	await $.env.set('LETMEKNOW_SESSION', undefined)
	current.listen = $.process.spawn({ argv: [...NPX, 'listen'] })
	void deliver($, current)
}

async function deliver($, current) {
	let rest = ''
	let errors = ''
	try {
		for await (const { stream, text } of current.listen) {
			if (stream === 'stderr') {
				errors = (errors + text).slice(-2000)
				continue
			}
			const lines = (rest + text).split('\n')
			rest = lines.pop()
			const events = []
			for (const line of lines) {
				const event = JSON.parse(line)
				if (event.type !== 'ready') events.push(line)
				else {
					Object.assign(current, { bin: event.bin, fp: event.fp })
					await $.env.set('LETMEKNOW_SESSION', event.fp)
					$.ui.status(event.fp)
					current.resolve()
				}
			}
			if (events.length) void $.prompt.submit({ text: events.join('\n') })
		}
		const stopped = `letmeknow stopped (exit ${(await current.listen.result).code}): ${errors.trim()}`
		current.reject(new Error(stopped))
		if (session === current) $.ui.log(stopped)
	} catch (error) {
		current.reject(error)
		if (session === current) $.ui.log(`letmeknow: ${error.message}`)
	}
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
		return next(e)
	})
}
