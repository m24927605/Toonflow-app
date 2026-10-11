// Image and video models garble readable text, so captions, title cards, signs and logos belong in post-production.
// ACT: English phrasing only, matching the English prompts sent to the models; extend the list for other languages.
const textRequest = /\b(?:captions?|subtitles?|title cards?|text overlays?|lettering|logos?|headlines?|signage|typography|(?:signs?|banners?|placards?|posters?|screens?|labels?|plates?|boards?) (?:that )?(?:says?|reads?|reading|saying|showing the (?:words?|text))|(?:words?|text) ["“'][^"”']+["”'])/gi;
// A mention preceded by a negation within the same clause, such as "no text, no logos", is a constraint, not a request.
const negated = /\b(?:no|not|without|avoid|never|nor)\b[^.;:\n]{0,40}$/i;

/** Phrases of a prompt that ask the model to render on-screen text, ignoring negated mentions. */
export function findOnScreenText(prompt: string) {
  return [...prompt.matchAll(textRequest)]
    .filter(match => !negated.test(prompt.slice(Math.max(0, match.index - 60), match.index)))
    .map(match => match[0]);
}
