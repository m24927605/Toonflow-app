import { msg, type MessageDescriptor } from "@toonflow/i18n";

/** The parts of a keyframe prompt as message descriptors, so the canvas words them in the interface language and the
 * production engine in English. Template lines that are plain strings, such as `{{shot}}`, are used as they are. */
export type PromptLine = MessageDescriptor | string;

export const withoutFullStop = (text: string) => text.replace(/[。.]+$/, "");

/**
 * The keyframe template "Build shot nodes" fills per shot: the set references first, then the reference naming each
 * person, and `{{shot}}` where the shot description goes. `sceneRefs` and each person's `ref` are reference numbers.
 */
export function keyframeTemplate(sceneRefs: number[], characters: { name: string; ref: number }[]): PromptLine[] {
  return [
    ...sceneRefs.length ? [msg`The set is ${sceneRefs.map(ref => `{{ref ${ref}}}`).join(", ")} and must match it exactly.`] : [],
    ...characters.map(item => msg`${item.name} is the person shown in ${`{{ref ${item.ref}}}`}.`),
    ...characters.length ? [msg`Draw only the people named in the shot description.`] : [],
    msg`One single full-frame photograph, not a grid, collage or character sheet.`,
    "{{shot}}",
    msg`Faces, hair and clothing match the references exactly; natural skin, sharp focus, no on-screen text.`,
  ];
}

/** The shot list's character state, fixed next to the shot description so a text model cannot change it. */
export const stateLine = (state: string) => msg`Character state at the start of this shot: ${withoutFullStop(state)}.`;

/**
 * A shot's previs layout fixes its keyframe's composition and leaves only the look to the image model, as Code Video
 * Model restyles its proxy frame (https://code-video-model.github.io).
 */
export const layoutLine = (ref: string) => msg`${ref} is this shot's previs layout and fixes its composition: keep its camera position, angle and crop, where each person stands, how large they are in the frame and who hides whom, and add or remove no one and nothing; take no shape, material or colour from its plain blocks.`;

/** Every keyframe but the master shot's follows the master's look while keeping its own composition. */
export const masterLine = (ref: string) => msg`Lighting, colour, clothing and props match ${ref}, but the composition, camera angle and poses follow the description below.`;

/**
 * What a text model is told to write one shot's still-frame description from the shot list; `names` are the people in
 * the shot, `state` its character-state cell and `blocking` where the previs put everyone.
 */
export function keyframeDescriptionInstructions(shot: number, time: string, names: string[], state?: string, blocking?: string): MessageDescriptor[] {
  return [
    // ACT: Qwen-Image reads at most 1024 prompt tokens and draws one moment best from a short paragraph, so the
    // description is capped at about 200 words (or characters in Chinese) next to the fixed template text.
    msg`Write a still-frame description of shot ${shot} (${time}) of the attached shot list as one paragraph of 80 to 200 words, based on that row's description and action columns: the shot size; the camera position, height and angle from the shot list; and for each person in frame their place in the picture (left, centre or right, foreground or background), posture, action, expression and gaze. Describe only the opening moment. Do not write reference markers, the setting, lighting, style words or anyone's appearance.`,
    names.length ? msg`The people in this shot are exactly: ${names.join(", ")}. Describe only them and call them by these names. When only part of someone is in frame, such as a hand, their back or a silhouette, say which part and how it is framed, so the rest of them is not drawn.`
      : msg`No one is in this shot; describe only the place.`,
    ...blocking ? [msg`The previs fixes the opening frame: ${blocking}. Place each person and the camera to match it.`] : [],
    state ? msg`At the start of this shot the character state is: ${withoutFullStop(state)}. Posture and what each person holds must match it.`
      : msg`Read the earlier rows too: unless this row says otherwise, each person keeps the posture (sitting, standing, lying) and what they hold from the previous shots.`,
    msg`Output only the heading line "### Shot ${shot}" followed by the paragraph.`,
  ];
}
