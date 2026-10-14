import type { GraphNode } from "@vue-flow/core";

/**
 * What a node is for in the production flow, stored on its data as `role`, so actions and shot planning never guess
 * it from the label or the content. Text: the original script, its shot list, or a per-shot prompt. Image: a shot's
 * keyframe, a view of a character, a scene, or a previs layout frame. Video: a previs render. A node without a role
 * is plain and takes part in none of these flows.
 */
export type NodeRole = "script" | "shotList" | "prompt" | "keyframe" | "character" | "scene" | "layout" | "previs";

/**
 * Role fields on node data: `shot` for keyframes, layouts, previs renders and shot videos, `character` for character
 * views (`outfit` tells one person's outfits apart, such as kimono or nude), `scene` for the place a scene image shows.
 * Trained LoRAs live in the workspace's `loras/` folder, named by person for characters and by place for scenes.
 */
export type NodeRoleData = { role?: NodeRole; shot?: number; character?: string; outfit?: string; scene?: string };

export const roleOf = (node?: Pick<GraphNode, "data">) => node?.data?.role as NodeRole | undefined;

/** The shot a node belongs to, as set by the shot flow or by hand. */
export function shotNumberOf(node?: Pick<GraphNode, "data">) {
  const shot = node?.data?.shot;
  return typeof shot === "number" && Number.isInteger(shot) && shot > 0 ? shot : undefined;
}
