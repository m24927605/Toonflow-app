const timers = new WeakMap<object, ReturnType<typeof setTimeout>>();

/**
 * Briefly highlights a node with a ripple and a badge, for example after another node fills it. `data` is the node's
 * reactive data; the flag is non-enumerable, so it is never saved to the canvas or copied with the node.
 */
export function flashNode(data: Record<string, unknown>, text: string, duration = 2400) {
  if (!Object.hasOwn(data, "flash")) Object.defineProperty(data, "flash", { value: undefined, writable: true, configurable: true, enumerable: false });
  // Assigning through the reactive proxy lets the node re-render; defining the property alone does not.
  data.flash = text;
  clearTimeout(timers.get(data));
  timers.set(data, setTimeout(() => { data.flash = undefined; }, duration));
}
