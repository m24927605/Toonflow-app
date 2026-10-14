import type { Edge, GraphNode } from "@vue-flow/core";
import { referenceKey } from "./shotLabel";
import { roleOf, shotNumberOf } from "./nodeRole";

export type MasterShotChange = { nodeId: string; shot: number; prompt: string; referenceOrder: string[]; hasImage: boolean };
export type MasterShotPlan = { changes: MasterShotChange[]; already: number[]; otherMaster: number[] };

/**
 * Plans making one keyframe the master shot of every other keyframe with a shot number: each gets the master's image
 * as its last reference and a line naming it, placed before the {{shot}} marker or the distributed description, or at
 * the end. `line` builds that line from the reference marker. Nodes already
 * following another master are left alone, since moving them would renumber references the user may have edited.
 */
export function planMasterShot(master: GraphNode, nodes: GraphNode[], edges: Edge[], line: (marker: string) => string): MasterShotPlan {
  const masterKey = referenceKey({ source: master.id, sourceHandle: "image" });
  const plan: MasterShotPlan = { changes: [], already: [], otherMaster: [] };
  for (const node of nodes) {
    const shot = roleOf(node) === "keyframe" && node.id !== master.id ? shotNumberOf(node) : undefined;
    if (shot === undefined) continue;
    const saved: string[] = node.data?.referenceOrder?.in ?? [];
    if (saved.includes(masterKey)) { plan.already.push(shot); continue; }
    if (node.data?.masterShotId && node.data.masterShotId !== master.id) { plan.otherMaster.push(shot); continue; }
    // The node lists its saved order first, then connections it has not ordered yet, so both keep their numbers.
    const keys = edges.filter(edge => edge.target === node.id && edge.targetHandle === "in").map(referenceKey);
    const order = [...saved.filter(key => keys.includes(key)), ...keys.filter(key => !saved.includes(key)), masterKey];
    const lines = String(node.data?.prompt ?? "").split("\n");
    const description = String(node.data?.shotText ?? "").split("\n")[0]?.trim();
    let at = lines.findIndex(text => text.includes("{{shot}}"));
    if (at < 0 && description) at = lines.findIndex(text => text.trim() === description);
    if (at < 0) at = lines.length;
    lines.splice(at, 0, line(`{{ref ${order.length}}}`));
    plan.changes.push({ nodeId: node.id, shot, prompt: lines.join("\n"), referenceOrder: order, hasImage: !!node.data?.outputs?.image });
  }
  plan.changes.sort((a, b) => a.shot - b.shot);
  return plan;
}
