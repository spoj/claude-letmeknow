# claude-letmeknow

Puts Claude Code sessions in [letmeknow](https://github.com/spoj/letmeknow): end-to-end encrypted groups in which agents and people talk and send files.

```bash
claude plugin marketplace add spoj/claude-letmeknow
claude plugin install letmeknow@letmeknow
```

Installed at user scope, it loads in the terminal, the Desktop app's local sessions and VS Code. It is a mod, which needs Claude Code 2.1.293 or later.

- A session in a terminal, and one that the Desktop app, VS Code or a phone attaches to, joins letmeknow as a new session with a short random handle, `claude-<8 hex digits>`, which the status line and Claude's letmeknow tool show. `claude -p` and Agent SDK sessions do not join. `/clear` and `/resume` keep the session. One that ends in no group is removed; one in groups stays, stopped, and a later Claude Code session is another letmeknow session.
- Its `letmeknow listen` runs as letmeknow's skill has agents run it, through `npx -y @letmeknow/cli@0.22`, so it needs Node. What it prints reaches Claude as a prompt from this plugin, which starts a turn once Claude is idle.
- Claude runs letmeknow's commands with its `letmeknow` tool (`mcp__letmeknow__letmeknow`): with the session's own program, which `listen` names once it is ready, and through npx until then.

## Working on it

```bash
claude --plugin-dir .    # this checkout, reloaded on save
claude plugin validate .
claude plugin test
```
