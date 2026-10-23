/**
 * The JSON a model reply holds, inside a code fence or not. Asked for an object with a list, the model often replies
 * with the list alone, which is read as that object; it throws when there is no JSON to read.
 */
export function replyJson(reply: string, list: string): Record<string, unknown> {
  // Each code fence, then the whole reply; in each the outermost object, then a list, so brackets in the prose around
  // the JSON do not spoil it.
  for (const text of [...[...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1]!), reply]) {
    for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
      const [start, end] = [text.indexOf(open), text.lastIndexOf(close)];
      if (start < 0 || end < start) continue;
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(value)) return { [list]: value };
        if (value && typeof value === "object") return value as Record<string, unknown>;
      } catch {
        // The next span may still be JSON.
      }
    }
  }
  throw new SyntaxError("The reply holds no readable JSON");
}

/** A text model reply cut off at its length limit on every try, such as one caught in a loop. */
export class ReplyCutError extends Error {}
