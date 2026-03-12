import type { OpenClawPluginApi } from "openclaw/plugin-sdk/claude-node";
import { CLAUDE_NODE_AGENT_GUIDANCE } from "./src/prompt-guidance.js";
import { createClaudeCodeTool, type ClaudeNodePluginConfig } from "./src/tool.js";

const plugin = {
  id: "claude-node",
  name: "Claude Code (Node)",
  description: "Dispatch Claude Code CLI tasks to a paired node.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as ClaudeNodePluginConfig;

    api.registerTool(
      createClaudeCodeTool({
        api,
        pluginConfig,
      }),
    );

    api.on("before_prompt_build", async () => ({
      prependSystemContext: CLAUDE_NODE_AGENT_GUIDANCE,
    }));
  },
};

export default plugin;
