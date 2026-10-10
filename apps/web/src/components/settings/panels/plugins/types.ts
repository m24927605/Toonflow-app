import type { Rule } from "@form-create/element-ui";
import type { Raw } from "vue";

export type PluginType = "node" | "skill" | "tool" | "agent" | "ext";

export interface Plugin {
  key: string;
  type: PluginType;
  name: string;
  displayName: string;
  author?: string;
  description?: string;
  readme?: string;
  github?: string;
  version?: string;
  enabled?: boolean;
  canConfigure?: boolean;
  canManage?: boolean;
  configRules?: Raw<Rule[]>;
  config?: Record<string, unknown>;
  kind?: "local" | "remote";
  cardUrl?: string;
  loadError?: string;
}
