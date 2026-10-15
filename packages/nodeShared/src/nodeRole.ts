import { useNode, type GraphNode } from "@vue-flow/core";
import { nodeTools, z } from "@toonflow/nodes-scaffold/runtime";

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

/**
 * Lets the AI agent set a node's role as the role menu does, so it can mark the script, shot list, character views and
 * scene images the shot flow works from. Called in the setup of a node that shows the menu, with the same roles.
 */
export function registerRoleTool(roles: NodeRole[]) {
  const { node } = useNode<NodeRoleData>();
  const name = z.string().trim().min(1).max(64).optional();
  nodeTools.register({
    name: "setRole",
    description: `Set what this node is for in the shot flow, as its role menu does: role is one of ${roles.join(", ")}, or "" for a plain node; shot is the shot number of a keyframe, previs layout or previs render; character is the person a character view shows (the name the shot list's cast uses) and outfit tells that person's outfits apart; scene is the place a scene image shows. Fields left out are cleared.`,
    parameters: z.strictObject({ role: z.enum(["", ...roles] as [string, ...string[]]), shot: z.number().int().positive().optional(), character: name, outfit: name, scene: name })
      .refine(value => value.role !== "character" || value.character, "A character view needs the character's name")
      .refine(value => !["keyframe", "layout", "previs"].includes(value.role) || value.shot, "A keyframe, previs layout or previs render needs its shot number"),
    execute({ role, shot, character, outfit, scene }) {
      for (const key of ["role", "shot", "character", "outfit", "scene"] as const) delete node.data[key];
      if (role) Object.assign(node.data, { role, ...shot ? { shot } : {}, ...character ? { character } : {}, ...outfit ? { outfit } : {}, ...scene ? { scene } : {} });
      return { role, shot, character, outfit, scene };
    },
  });
}
