export default {
  id: "claudeCode" as const,
  label: "Claude Code",
  version: "2.2.0",
  apiUrl: "",
  protocol: "claude-code",
  readme: "Runs the Claude Code CLI that is installed and signed in on the computer running Toonflow. Supports text generation and tool calls in nodes, such as the 3D Director's Studio: one CLI process serves a whole tool loop, keeping Claude's reasoning between turns, and node tools reach it as local MCP tools. Not available to agents.",
  rules: [],
  // Claude Code model aliases always resolve to the latest model of each family.
  models: [
    { id: "fable", label: "Claude Fable", type: "text" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", type: "text" },
    { id: "opus", label: "Claude Opus", type: "text" },
    { id: "sonnet", label: "Claude Sonnet", type: "text" },
    { id: "haiku", label: "Claude Haiku", type: "text" },
  ],
} satisfies ProviderDefinition<[]>;
