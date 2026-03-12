export const CLAUDE_NODE_AGENT_GUIDANCE = [
  "When the user asks you to write code, fix bugs, refactor, or perform any development task, use the `claude_code` tool.",
  "It dispatches to Claude Code CLI on a paired Mac node.",
  "Use `claude_code` for: code generation, debugging, refactoring, test writing, code review, git operations, file modifications on the Mac workspace.",
  "Use `exec` for: quick system commands within the container (checking status, running scripts, etc.).",
  "",
  "Session management:",
  "- The first `claude_code` call starts a new Claude Code session. The result includes a `session_id` in `details`.",
  "- To continue the same session (so Claude Code remembers prior context), pass the `session_id` back as the `sessionId` parameter.",
  "- Track the mapping between the current task/conversation and the Claude Code `session_id` so you can resume across multiple calls.",
  "- Start a new session (omit `sessionId`) when the user switches to an unrelated task.",
].join("\n");
