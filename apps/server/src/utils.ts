import * as assets from "@/utils/assets";
import * as browser from "@/utils/browser";
import * as singleAgent from "@/utils/singleAgent";
import * as providerDebug from "@/utils/media/debug";
import * as mediaGeneration from "@/utils/media/generation";
import * as mediaJobs from "@/utils/media/jobs";
import * as colabPool from "@/utils/media/colabPool";
import * as mediaSnapshots from "@/utils/media/snapshot";
import * as lora from "@/utils/media/lora";
import * as production from "@/utils/production";
import * as mediaProvider from "@/utils/media/provider";
import * as higgsfield from "@/utils/media/higgsfield";
import * as ffmpeg from "@/utils/ffmpeg";
import * as pluginInstall from "@/utils/plugins/install";
import conf from "@/utils/conf";
import * as ai from "@/utils/ai";
import * as plugins from "@/utils/plugins/tools";
import * as nodePlugins from "@/utils/plugins/nodes";
import * as extPlugins from "@/utils/plugins/ext";
import * as agent from "@/agent";
import * as canvas from "@/agent/bridge/canvas";
import * as question from "@/agent/bridge/question";
import * as workspace from "@/utils/workspace";
import * as workspaceFile from "@/utils/workspace/files";
import * as chatImages from "@/utils/workspace/chatImages";
import * as skillFile from "@/utils/skills/files";
import * as mcpControl from "@/utils/mcp/control";
import * as mcpRuntime from "@/utils/mcp/runtime";
import * as teams from "@/utils/teams";
import * as a2aSettings from "@/agent/a2a/settings";
import * as personalization from "@/utils/personalization";
import * as mentionFiles from "@/agent/mentionFiles";

export default {
  assets,
  browser,
  singleAgent,
  providerDebug,
  mediaGeneration,
  mediaJobs,
  colabPool,
  mediaSnapshots,
  lora,
  production,
  mediaProvider,
  higgsfield,
  ffmpeg,
  pluginInstall,
  conf,
  ai,
  plugins,
  nodePlugins,
  extPlugins,
  agent,
  canvas,
  question,
  workspace,
  workspaceFile,
  chatImages,
  skillFile,
  mcpControl,
  mcpRuntime,
  teams,
  a2aSettings,
  personalization,
  mentionFiles,
};
