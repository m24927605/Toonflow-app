import { ElMessageBox } from "element-plus";
import { t, translate } from "@toonflow/i18n/vue";

// A grid split names each cell node "<source label> · <row>-<column>", so cells of one turnaround share a prefix.
const gridCell = /^(.*) · \d+-\d+$/;

/** The label of the image a grid-split cell was cut from, or undefined when the label is not a grid cell. */
export function gridCellSource(label: string) {
  return gridCell.exec(label)?.[1];
}

/**
 * Checks how a prompt names its connected references before generation and asks before sending a prompt with
 * reference mistakes: no {{ref N}} at all, a number past the connected references, a connected reference the prompt
 * never names (models tend to draw it as an extra subject), or several cells of one grid split, which are usually
 * angles of the same character. `labels` are the source node labels in reference order; with `control` set the first
 * reference is a control map (such as a depth map) that the prompt does not need to name. Throws when the user goes
 * back to edit the prompt, or right away when `ask` is false (batch runs).
 */
export async function confirmReferences(prompt: string, labels: string[], control = false, ask = true) {
  if (!labels.length) return;
  const named = new Set([...prompt.matchAll(/\{\{ref (\d+)\}\}/g)].map(match => Number(match[1])));
  const name = (index: number) => `{{ref ${index}}} (${labels[index - 1] || translate("Unnamed node")})`;
  const issues: string[] = [];
  const first = control ? 2 : 1;
  if (labels.length >= first && ![...named].some(index => index >= first)) issues.push(translate("The prompt names no reference with {{ref N}}, so the model does not know which connected image is which."));
  for (const index of named) {
    if (index < 1 || index > labels.length) issues.push(t`Reference ${index} is not connected: this node has ${labels.length} references.`);
  }
  const unnamed = labels.flatMap((_, offset) => offset + 1 >= first && !named.has(offset + 1) ? [name(offset + 1)] : []);
  if (named.size && unnamed.length) issues.push(t`Connected but not named in the prompt, so the model may draw them as extra subjects: ${unnamed.join(", ")}. Disconnect the ones this shot does not use.`);
  const cells = new Map<string, number[]>();
  for (const index of named) {
    const source = gridCellSource(labels[index - 1] ?? "");
    if (source) cells.set(source, [...cells.get(source) ?? [], index]);
  }
  for (const [source, indexes] of cells) {
    if (indexes.length > 1) issues.push(t`${indexes.sort((a, b) => a - b).map(index => `{{ref ${index}}}`).join(", ")} are cells of the same split image (${source}), usually angles of one character; name one per character or the model may draw several people.`);
  }
  if (!issues.length) return;
  if (!ask) throw new Error(`${issues.join("\n")}\n${translate("Fix the prompt, or generate this node on its own to send it anyway.")}`);
  const send = await ElMessageBox.confirm(issues.map(issue => `• ${issue}`).join("\n"), translate("Reference check"), {
    confirmButtonText: translate("Send anyway"), cancelButtonText: translate("Edit prompt"), type: "warning", closeOnClickModal: false,
    customStyle: { whiteSpace: "pre-line", maxWidth: "640px" },
  }).then(() => true, () => false);
  if (!send) throw new Error(translate("Generation cancelled: fix the reference numbers in the prompt first"));
}
