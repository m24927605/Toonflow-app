export default {
  id: "claudeCode" as const,
  label: "Claude Code",
  version: "2.0.0",
  apiUrl: "",
  protocol: "claude-code",
  readme: "Runs the Claude Code CLI that is installed and signed in on the computer running Toonflow. Supports single-turn text generation in nodes only: no tool calls, not available to agents.",
  rules: [],
  // Claude Code model aliases always resolve to the latest model of each family.
  models: [
    { id: "fable", label: "Claude Fable", type: "text" },
    { id: "opus", label: "Claude Opus", type: "text" },
    { id: "sonnet", label: "Claude Sonnet", type: "text" },
    { id: "haiku", label: "Claude Haiku", type: "text" },
  ],
} satisfies ProviderDefinition<[]>;
