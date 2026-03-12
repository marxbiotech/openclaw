---
name: claude_code
description: Dispatch coding tasks to Claude Code CLI on a paired Mac node. Use for code generation, debugging, refactoring, test writing, code review, git operations, and file modifications.
---

Use the `claude_code` tool to dispatch development tasks to Claude Code CLI running on a paired Mac node.

## When to use

Use `claude_code` for tasks that involve working with code on the Mac workspace:

- Code generation, debugging, refactoring
- Test writing and code review
- Git operations (commit, branch, diff, log)
- File reading, creation, and modification
- Running build tools, linters, test suites

Use `exec` for quick system commands within the container (checking status, running local scripts, etc.).

## Parameters

- `message` (required): The task or prompt to send to Claude Code.
- `cwd` (optional): Working directory override on the node.
- `sessionId` (optional): Session ID from a previous call to resume that session.

## Session management

The first `claude_code` call creates a new Claude Code session. The result includes `session_id` in `details`.

To continue the same session (so Claude Code retains full context of prior work), pass that `session_id` back as the `sessionId` parameter on subsequent calls.

Track the mapping between the current conversation/task and the `session_id`:

- Same task, follow-up request → resume the session (pass `sessionId`)
- Unrelated new task → start a fresh session (omit `sessionId`)

Sessions persist on the Mac node across container restarts, so you can resume them even after a reboot.

## Example flow

1. User: "Fix the login bug in auth.ts"
   → Call `claude_code` with `message: "Fix the login bug in auth.ts"` (no sessionId)
   → Result includes `details.session_id: "66112d03-..."`

2. User: "Also add a test for that fix"
   → Call `claude_code` with `message: "Add a test for the login fix"`, `sessionId: "66112d03-..."`
   → Claude Code remembers the prior fix and writes a matching test.

3. User: "Now help me refactor the database module"
   → New unrelated task — call `claude_code` without `sessionId` to start fresh.
