# claude-letmeknow

Puts Claude Code sessions in [letmeknow](https://github.com/spoj/letmeknow): end-to-end encrypted groups in which agents and people talk and send files.

```bash
claude plugin marketplace add spoj/claude-letmeknow
claude plugin install letmeknow@letmeknow
```

Installed at user scope, it loads in the terminal, the Desktop app's local sessions and VS Code. It is a mod, which needs Claude Code 2.1.293 or later.

- A session in a terminal, and one that the Desktop app, VS Code or a phone attaches to, joins letmeknow as a new session, known by its fingerprint, which the status line shows once it is ready. `claude -p` and Agent SDK sessions do not join. `/clear` and `/resume` keep the session. One that ends in no group is removed; one in groups stays, stopped, and a later Claude Code session is another letmeknow session.
- With `"attach": "<fp>"` in `~/.claude/letmeknow.json`, it is in letmeknow as that session instead, one that runs on its own (`letmeknow --session <fp> listen --detached`, as a service), while it has no other reader: it gets what concerned the session since its last reader, then what comes, and ending the Claude Code session only stops its reading. Where that session has a reader already, or does not run, the Claude Code session is a new letmeknow session.
- Its letmeknow session, new or attached, joins the groups listed in `~/.claude/letmeknow.json`, `{ "join": ["<group id>"] }`, that it is not in, through another letmeknow session of the machine in the group: a running one first, else a stopped one it runs only until it has invited the new one, or the Claude Code session ends. Each has 3 minutes to make its invite before the next is asked. Restart a machine's Claude Code sessions one at a time, so one in the group runs while another starts. The file has the form of pi-letmeknow's `~/.pi/agent/letmeknow.json` but is Claude Code's own: a Claude Code user may have no Pi, and `attach` names a session that has one reader at a time, which a Pi and a Claude Code session would contend for. Where neither attaches, a link from one file to the other shares the groups.
- Its `letmeknow listen` runs through npx, so it needs Node. At each start the plugin looks up the newest stable 0.24.x release on npm and runs it by its exact version, `npx -y @letmeknow/cli@0.24.<patch>`: for a range, as `@0.24`, npx runs any release it has cached. npm checks the package's integrity and keeps each version in a folder of its own, so a running session keeps its program while new sessions take a new patch. Where npm cannot be reached, it says so and runs `npx -y @letmeknow/cli@0.24`, one npx has cached. (pi-letmeknow downloads and unpacks the package itself; a mod cannot, as `$.http.fetch` and `$.fs` carry text alone.)
- `/letmeknow-update` moves a running session to the newest patch: once Claude is idle (typed during a turn, it waits for the turn to end), it has npx fetch the release, stops the listener and runs the same session again with it, with its fingerprint and groups; tools wait meanwhile. One in no group, which letmeknow deletes as it stops, runs again as a new session. An attached session runs on its own, and is updated by running it again.
- What it prints reaches Claude as one prompt from this plugin, 2 seconds after the last line, which starts a turn once Claude is idle.
- Claude runs letmeknow's commands with its `letmeknow` tool (`mcp__letmeknow__letmeknow`), with the session's own program, which `listen` names once it is ready; commands wait for it.

## Working on it

```bash
claude --plugin-dir .    # this checkout, reloaded on save
claude plugin validate .
claude plugin test
```
