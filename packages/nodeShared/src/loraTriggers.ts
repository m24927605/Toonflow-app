/**
 * The prompt with every attached LoRA's trigger word: a missing one is added where the prompt starts describing the
 * shot (after "[Shot 1] " in a MiniMax H3 prompt), or else at the very start.
 */
export function withTriggers(prompt: string, loras: { trigger: string }[]) {
  const missing = loras.map(lora => lora.trigger).filter(trigger => !prompt.includes(trigger));
  if (!missing.length) return prompt;
  const marker = "[Shot 1] ";
  const at = prompt.indexOf(marker);
  return at < 0 ? `${missing.join(", ")}, ${prompt}` : `${prompt.slice(0, at + marker.length)}${missing.join(", ")}, ${prompt.slice(at + marker.length)}`;
}
