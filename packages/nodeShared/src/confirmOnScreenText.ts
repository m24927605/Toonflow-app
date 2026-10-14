import { ElMessageBox } from "element-plus";
import { findOnScreenText } from "@toonflow/tools-scaffold/onScreenText";
import { t, translate } from "@toonflow/i18n/vue";

/**
 * Asks before sending a prompt that wants the model to render readable text. Returns true when the user sends it
 * anyway, so the request can carry skipTextCheck; throws when the user goes back to edit the prompt, or right away
 * when `ask` is false (batch runs).
 */
export async function confirmOnScreenText(prompt: string, ask = true) {
  const phrases = findOnScreenText(prompt);
  if (!phrases.length) return false;
  if (!ask) throw new Error(t`The prompt asks the model to render on-screen text (${phrases.join(", ")}). Remove it, or generate this node on its own to send it anyway.`);
  const send = await ElMessageBox.confirm(
    t`The prompt asks the model to render on-screen text (${phrases.join(", ")}). Models garble text, so captions, title cards and signs belong in post-production. Send it anyway?`,
    translate("On-screen text"),
    { confirmButtonText: translate("Send anyway"), cancelButtonText: translate("Edit prompt"), type: "warning", closeOnClickModal: false },
  ).then(() => true, () => false);
  if (!send) throw new Error(translate("Generation cancelled: remove the on-screen text from the prompt and add it in post-production"));
  return true;
}
