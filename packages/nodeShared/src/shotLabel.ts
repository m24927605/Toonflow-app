// A shot heading or node label: the Chinese ordinal "第 N" followed by any measure word, since local models
// often misspell "鏡" (shot), or "Shot 3" / "Shot_003".
const shotNumber = /第\s*(\d+)|\bshot[\s_#-]*0*(\d+)/i;

/** The shot number a heading or node label carries, if any. */
export function shotOf(text: string) {
  const match = shotNumber.exec(text);
  return match ? Number(match[1] ?? match[2]) : undefined;
}

/** The key a node's `referenceOrder` uses for one incoming connection. */
export function referenceKey(edge: { source: string; sourceHandle?: string | null }) {
  return encodeURIComponent(JSON.stringify([edge.source, edge.sourceHandle]));
}
