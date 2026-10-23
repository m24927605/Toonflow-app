import useWorkspaceFiles from "@/lib/workspaceFiles";
import type { AgentAttachment } from "./types";

/** Store selected files once; retain successful uploads when a later file or message fails. */
export async function uploadAttachments(attachments: AgentAttachment[], directory: string, folder: string, signal?: AbortSignal) {
  if (!attachments.some(item => item.file)) return;
  const files = useWorkspaceFiles(directory);
  const segments = folder.split("/");
  for (let index = 1; index <= segments.length; index++) {
    await files.mkdir(segments.slice(0, index).join("/")).catch(error => {
      if (error?.response?.data?.data?.code !== "EEXIST") throw error;
    });
    signal?.throwIfAborted();
  }
  for (const attachment of attachments) {
    if (!attachment.file) continue;
    const extension = attachment.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
    const path = `${folder}/reference${crypto.randomUUID().replaceAll("-", "")}${extension}`;
    await files.write(path, attachment.file, true, signal);
    attachment.path = path;
    attachment.file = undefined;
    signal?.throwIfAborted();
  }
}
