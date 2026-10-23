/** The prompt with every attached LoRA's trigger word: a missing one is added at the very start. */
export function withTriggers(prompt: string, loras: { trigger: string }[]) {
  const missing = loras.map(lora => lora.trigger).filter(trigger => !prompt.includes(trigger));
  return missing.length ? `${missing.join(", ")}, ${prompt}` : prompt;
}
