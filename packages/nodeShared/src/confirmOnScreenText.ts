import { ElMessageBox } from "element-plus";
import { findOnScreenText } from "@toonflow/tools-scaffold/onScreenText";

/**
 * Asks before sending a prompt that wants the model to render readable text. Returns true when the user sends it
 * anyway, so the request can carry skipTextCheck; throws when the user goes back to edit the prompt.
 */
export async function confirmOnScreenText(prompt: string) {
  const phrases = findOnScreenText(prompt);
  if (!phrases.length) return false;
  const send = await ElMessageBox.confirm(
    `The prompt asks the model to render on-screen text (${phrases.join(", ")}). Models garble text, so captions, title cards and signs belong in post-production. Send it anyway?`,
    "On-screen text",
    { confirmButtonText: "Send anyway", cancelButtonText: "Edit prompt", type: "warning", closeOnClickModal: false },
  ).then(() => true, () => false);
  if (!send) throw new Error("Generation cancelled: remove the on-screen text from the prompt and add it in post-production");
  return true;
}
