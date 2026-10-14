import { msg, type MessageDescriptor } from "@toonflow/i18n";
import type { ShotSpan } from "./shotList";

const seconds = (value: number) => Number(value.toFixed(2));

/**
 * The director agent's instruction for every shot of a shot list, in order, as message descriptors plus the shot's
 * table lines: the first builds the set with every person as one cylinder, each later one keeps the set and starts
 * people where the previous shot left them. `scripts` original scripts come first in the references, the shot list last.
 */
export function previsInstructions(spans: ShotSpan[], scripts: number): { shot: number; lines: (MessageDescriptor | string)[] }[] {
  const listRef = `{{ref ${scripts + 1}}}`;
  const intro = scripts
    ? msg`${Array.from({ length: scripts }, (_, index) => `{{ref ${index + 1}}}`).join(", ")} is the original script and ${listRef} is the shot list.`
    : msg`${listRef} is the shot list.`;
  return spans.map((span, index) => {
    const time = `${seconds(span.start)}–${seconds(span.end)}s`;
    const duration = seconds(span.end - span.start);
    const task = index === 0
      ? msg`Block shot ${span.shot} (${time}) for previs. First build the set at real-world scale from the shot list and the script: the room, the furniture, and every person who appears in any shot as one cylinder named as in the shot list. Then block only this shot from its row: where each person starts, how they move, and the camera, following its shot size and camera cells. The plan lasts ${duration} s.`
      : msg`Block shot ${span.shot} (${time}) for previs. Keep the set and the people; each person starts where the previous shot left them unless the row says otherwise. Block only this shot from its row: where each person starts, how they move, and the camera, following its shot size and camera cells. The plan lasts ${duration} s.`;
    return { shot: span.shot, lines: [intro, task, ...span.row ? [span.header ?? "", span.row] : []].filter(line => line !== "") };
  });
}
