import type { Edge, GraphNode } from "@vue-flow/core";
import { referenceKey, shotOf } from "@toonflow/node-shared/shotLabel";
import { shotNumberOf } from "@toonflow/node-shared/nodeRole";

const generationTypes = new Set(["remote-imageGenerationNode", "remote-videoGenerationNode"]);

export type PromptAssignment = {
  shot: number;
  nodeId: string;
  prompt: string;
  /** The section as inserted into a {{shot}} prompt, so a later distribution can find and replace it. */
  shotText?: string;
  /** Incoming reference edges to remove because the prompt does not name them. */
  removedEdgeIds: string[];
  referenceOrder: string[];
};

export type PromptPlan = { assignments: PromptAssignment[]; missingNodes: number[]; duplicateNodes: number[]; emptyShots: number[] };

/** Splits Markdown into the bodies under headings that carry a shot number, keyed by that number. */
export function splitShotSections(markdown: string) {
  const sections = new Map<number, string>();
  let shot: number | undefined;
  let lines: string[] = [];
  const flush = () => { if (shot !== undefined && !sections.has(shot)) sections.set(shot, lines.join("\n").trim()); };
  for (const line of markdown.split("\n")) {
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (!heading) { lines.push(line); continue; }
    flush();
    shot = shotOf(heading[1]!);
    lines = [];
  }
  flush();
  return sections;
}


// The cast line a text model writes under a shot heading: "Cast:", or the Chinese "\u4eba\u7269" (people),
// "\u89d2\u8272" (characters) or "\u51fa\u5834\u4eba\u7269" / "\u51fa\u573a\u4eba\u7269" (people on screen), with either colon.
const castLine = /^\s*(?:cast|characters?|\u4eba\u7269|\u89d2\u8272|\u51fa[\u5834\u573a]\u4eba\u7269)\s*[:\uff1a]\s*(.*)$/i;

/** Marks where a distributed section goes in a node prompt that keeps its own fixed text around it. */
export const shotMarker = "{{shot}}";

/**
 * Plans filling each generation node that belongs to a shot (its `shot` field) with the matching section. A node whose prompt
 * contains {{shot}} keeps its text around the marker, such as fixed reference names, and only the marker is replaced;
 * the inserted text is remembered, so distributing again replaces it and keeps any edits made around it. Who is in a
 * shot is fixed when its node is built, never by the text model: a cast line it writes anyway ("Cast: A, B") is dropped. References the prompt
 * does not name are disconnected and the remaining {{ref N}} markers renumbered to the new order; a depth-control
 * model keeps its first reference, the control map. A prompt that names no reference keeps every connection, so the
 * node's reference check reports it instead.
 */
export function planPromptDistribution(markdown: string, nodes: GraphNode[], edges: Edge[]): PromptPlan {
  const sections = splitShotSections(markdown);
  const targets = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const shot = generationTypes.has(node.type) ? shotNumberOf(node) : undefined;
    if (shot !== undefined) targets.set(shot, [...targets.get(shot) ?? [], node]);
  }
  const plan: PromptPlan = { assignments: [], missingNodes: [], duplicateNodes: [], emptyShots: [] };
  for (const [shot, body] of [...sections].sort(([a], [b]) => a - b)) {
    const matches = targets.get(shot) ?? [];
    if (!body) { plan.emptyShots.push(shot); continue; }
    if (!matches.length) { plan.missingNodes.push(shot); continue; }
    if (matches.length > 1) { plan.duplicateNodes.push(shot); continue; }
    const node = matches[0]!;
    const current = String(node.data?.prompt ?? "");
    const previous: string | undefined = node.data?.shotText;
    const template = previous && current.includes(previous) ? current.replace(previous, shotMarker) : current.includes(shotMarker) ? current : undefined;
    const [firstLine = "", ...rest] = body.split("\n");
    const text = castLine.test(firstLine) ? rest.join("\n").trim() : body;
    if (!text) { plan.emptyShots.push(shot); continue; }
    const prompt = template ? template.replace(shotMarker, text) : text;
    // Same order as the node's reference list: the saved order first, then connections it does not list yet.
    const order: string[] = node.data?.referenceOrder?.in ?? [];
    const incoming = edges.filter(edge => edge.target === node.id && edge.targetHandle === "in")
      .sort((a, b) => (order.indexOf(referenceKey(a)) + 1 || order.length + 1) - (order.indexOf(referenceKey(b)) + 1 || order.length + 1));
    const named = new Set([...prompt.matchAll(/\{\{ref (\d+)\}\}/g)].map(match => Number(match[1])));
    const control = /depth/i.test(String(node.data?.model ?? ""));
    const kept = named.size ? incoming.filter((_, index) => named.has(index + 1) || (control && index === 0)) : incoming;
    const renumber = new Map(kept.map(edge => [incoming.indexOf(edge) + 1, kept.indexOf(edge) + 1]));
    // Markers past the connected references stay as written so the reference check can report them.
    const renumbered = (text: string) => text.replace(/\{\{ref (\d+)\}\}/g, (marker, index) => renumber.has(Number(index)) ? `{{ref ${renumber.get(Number(index))}}}` : marker);
    plan.assignments.push({
      shot, nodeId: node.id,
      prompt: renumbered(prompt),
      shotText: template ? renumbered(text) : undefined,
      removedEdgeIds: incoming.filter(edge => !kept.includes(edge)).map(edge => edge.id),
      referenceOrder: kept.map(referenceKey),
    });
  }
  return plan;
}
