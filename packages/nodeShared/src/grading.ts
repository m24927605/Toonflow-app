export type GradeLevel = 1 | 2 | 3 | 4;
export type Grade = { level: GradeLevel; checks: Record<string, boolean> };
/** Grades stored on a node's data, keyed by output file path, so a new output starts ungraded. */
export type NodeGrades = Record<string, Grade>;

export const gradeLevels: { level: GradeLevel; label: string; hint: string }[] = [
  { level: 1, label: "L1 Discard", hint: "Broken face, deformed limbs or heavy flicker; regenerate" },
  { level: 2, label: "L2 Material", hint: "Usable with flaws; keep for B-roll or transitions" },
  { level: 3, label: "L3 Main", hint: "No visible faults; ready for the main cut" },
  { level: 4, label: "L4 Hero", hint: "Composition, light and expression all hold up as a still; cover or poster" },
];

// The per-shot checklist of the 30-second review; any unchecked item caps the grade at L2.
const imageChecks = [
  { key: "face", label: "Faces are clear and recognisable" },
  { key: "hands", label: "At most two visible hands, with whole fingers" },
  { key: "identity", label: "Same character and design as the references" },
  { key: "structure", label: "Furniture, ships and buildings keep their structure" },
  { key: "lighting", label: "No conflicting strong light directions" },
  { key: "artifacts", label: "No glossy AI look, garbled text or skin blotches" },
];
const videoChecks = [
  ...imageChecks,
  { key: "flicker", label: "No flicker or colour blotches between frames" },
  { key: "motion", label: "Motion has no tearing or melting" },
  { key: "duration", label: "Length within 1 s of the planned shot" },
];

export function gradeChecks(kind: "image" | "video") {
  return kind === "video" ? videoChecks : imageChecks;
}

export function gradeOf(data: { grades?: NodeGrades } | undefined, url: string | undefined) {
  return url ? data?.grades?.[url] : undefined;
}

/** True when a node has graded at least three outputs and fewer than 30 % reached L3. */
export function lowKeeperRate(grades: NodeGrades | undefined) {
  const levels = Object.values(grades ?? {}).map(grade => grade.level);
  return levels.length >= 3 && levels.filter(level => level >= 3).length / levels.length < 0.3;
}
