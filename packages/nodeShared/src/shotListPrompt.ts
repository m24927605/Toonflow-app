import { msg, type MessageDescriptor } from "@toonflow/i18n";

export const visualTextModelId = "mradermacher/Huihui-Qwen3-VL-32B-Instruct-abliterated-GGUF";

export const uncensoredTextModelId = "ttindall/Qwen3.8-27B-Defiance-Uncensored-MTP-GGUF";

export const storyScopeInstructions = "Character sheets, outfit references, empty environment references and blocking guides are production assets, not events or shots in the finished film. Keep reference-preparation instructions out of the narrative and shot table. Each delivered shot must advance the requested story; an empty establishing shot needs a narrative purpose, not merely an environment-reference requirement. Cuts may introduce a character, but the sequence must make sense to an audience rather than switch from a reference plate to a character render.";

/**
 * What a model is told to turn a script into a shot list that "Build shot nodes" reads, as message descriptors: the
 * canvas words them in the interface language and the production engine in English. `script` names the script in the
 * prompt, such as `{{ref 1}}`; `names` are the characters' names on the canvas, which the cast and state cells must use.
 */
export function shotListInstructions(script: string, names: string[]): MessageDescriptor[] {
  return [
    { id: storyScopeInstructions },
    msg`${script} is the script. Read the whole script first, then turn it into a shot list for AI video production, splitting it into time ranges by the pacing of the story. Output only one Markdown table with the columns Shot, Time, Shot size, Camera, Action, Dialogue, Cast and State.`,
    msg`Time is the range of the shot in seconds, such as 0–3.5; each shot starts where the previous one ends, with no gaps or overlaps.`,
    msg`One row represents one continuous camera take. Keep timed pauses, speech and reactions within that row's Action cell when the camera does not cut. An explicitly requested single continuous take overrides the default pacing and shot-duration preferences; never split its performance beats into separate shots.`,
    msg`Give each shot one main action that its people can play in full at a natural pace in its time: a look, a reaction or a short line takes 2–4 s, a walk across a room or taking off one garment 4–6 s, a kiss or a sexual position with its rhythm 5–10 s. When the script runs several actions together, give each its own shot instead of compressing them; keep every shot at most 10 s.`,
    msg`Show on screen what the script describes; never frame around it. Choose the camera each shot needs, such as a slow push-in, a pan following a walk or a handheld close shot, rather than a static camera for every shot.`,
    msg`Frame every shot with a line as a medium close-up or closer on the speaker, alone or over the listener's shoulder, and every reaction or meaningful look as a medium shot or closer; keep two-person medium shots, full shots and long shots for showing the place and the people moving through it, without lines, as faces that small come out blurred.`,
    msg`Keep each cell on one line: separate several parts of a cell, such as two people's lines or states, with a full-width semicolon (；), never with <br> or a line break.`,
    msg`Cast lists performing characters in frame by their exact names, separated by commas, including anyone only partly visible such as a hand or their back. Ordinary products, drinks, furniture and other props belong in Action and State, never Cast; leave Cast empty when no character is visible. An explicitly personified object may be a character when the story actually treats it as one.`,
    msg`State gives each cast member's posture, what they wear (or that they are unclothed) and what they hold at the start of the shot.`,
    msg`Prefix every utterance in Dialogue with its exact speaker name and a colon, including single-person shots.`,
    ...names.length ? [msg`The characters on the canvas are named ${names.join(", ")}. In Cast and State, call each person by exactly one of these names, matching the people of the script to them even when the script calls them differently; use another name only for someone who is none of them.`] : [],
    msg`Cover the whole script and write the cells in the language of the script.`,
    msg`After the table, write one line naming the master shot, the shot the other shots should match for lighting, colour, clothing and props (usually the widest shot that shows the whole set and every main character), with a short reason of your own, for example "Master shot: 4 - full shot showing the whole room and both characters".`,
  ];
}

/** Asks the same model to fix the problems the timing check found, as "Generate shot list" does once. */
export function shotListFixPrompt(prompt: string, shotList: string, problems: string[]) {
  return `${prompt}\n\nYour shot list:\n${shotList}\n\nFix these problems and output the whole shot list again, in the same format:\n${problems.map(issue => `- ${issue}`).join("\n")}`;
}
