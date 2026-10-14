import { msg, type MessageDescriptor } from "@toonflow/i18n";

/**
 * What a model is told to turn a script into a shot list that "Build shot nodes" reads, as message descriptors: the
 * canvas words them in the interface language and the production engine in English. `script` names the script in the
 * prompt, such as `{{ref 1}}`; `names` are the characters' names on the canvas, which the cast and state cells must use.
 */
export function shotListInstructions(script: string, names: string[]): MessageDescriptor[] {
  return [
    msg`${script} is the script. Read the whole script first, then turn it into a shot list for AI video production, splitting it into time ranges by the pacing of the story. Output only one Markdown table with the columns Shot, Time, Shot size, Camera, Action, Dialogue, Cast and State.`,
    msg`Time is the range of the shot in seconds, such as 0–3.5; each shot starts where the previous one ends, with no gaps or overlaps.`,
    msg`Keep every shot at most 8 s and most shots at 3–4 s.`,
    msg`Keep each cell on one line: separate several parts of a cell, such as two people's lines or states, with a full-width semicolon (；), never with <br> or a line break.`,
    msg`Cast lists the characters in frame by the names the script uses, separated by commas, including anyone only partly visible such as a hand or their back; leave it empty when nobody is in frame.`,
    msg`State gives each cast member's posture, what they wear (or that they are unclothed) and what they hold at the start of the shot.`,
    ...names.length ? [msg`The characters on the canvas are named ${names.join(", ")}. In Cast and State, call each person by exactly one of these names, matching the people of the script to them even when the script calls them differently; use another name only for someone who is none of them.`] : [],
    msg`Cover the whole script and write the cells in the language of the script.`,
    msg`After the table, write one line naming the master shot, the shot the other shots should match for lighting, colour, clothing and props (usually the widest shot that shows the whole set and every main character), with a short reason of your own, for example "Master shot: 4 - full shot showing the whole room and both characters".`,
  ];
}

/** Asks the same model to fix the problems the timing check found, as "Generate shot list" does once. */
export function shotListFixPrompt(prompt: string, shotList: string, problems: string[]) {
  return `${prompt}\n\nYour shot list:\n${shotList}\n\nFix these problems and output the whole shot list again, in the same format:\n${problems.map(issue => `- ${issue}`).join("\n")}`;
}
