import { z } from "zod";

export const teamLimits = { maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxEntries: 2000 };

const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export const teamNameSchema = z.string().min(1).max(96).regex(/^[a-z][a-zA-Z0-9]*$/)
  .refine(name => !reservedName.test(name) && !["constructor", "prototype", "__proto__"].includes(name), "Name cannot be a reserved word");

export const teamResourcePathSchema = z.string().min(1).max(512).refine(path => {
  return !/[\\:<>"|?*\u0000-\u001f\u007f]/.test(path) && path.split("/").every(part =>
    !!part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !reservedName.test(part));
}, "Resources must use safe relative paths separated by /, without parent directories, drive letters or reserved file names");

const namesSchema = z.array(teamNameSchema).max(64).refine(names => new Set(names).size === names.length, "Names must be unique");
const memberSchema = z.strictObject({
  description: z.string().trim().min(1).max(2000),
  instructions: teamResourcePathSchema.refine(path => path.startsWith("members/") && path.endsWith(".md"), "Member prompts must be Markdown files under members/"),
  delegates: namesSchema.optional(),
  tools: z.array(z.string().min(1).max(128)).max(128).refine(names => new Set(names).size === names.length, "Tool names cannot be repeated").optional(),
  skills: namesSchema.optional(),
  knowledge: z.array(teamResourcePathSchema).max(128).optional(),
});

export const teamSchema = z.strictObject({
  name: teamNameSchema,
  displayName: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(4000),
  version: z.string().trim().min(1).max(100),
  author: z.string().trim().max(100),
  github: z.string().max(2048).refine(value => !value || (URL.canParse(value) && new URL(value).origin === "https://github.com" && !new URL(value).username && !new URL(value).password), "Invalid GitHub URL"),
  entry: teamNameSchema,
  members: z.record(teamNameSchema, memberSchema).refine(members => Object.keys(members).length > 0 && Object.keys(members).length <= 64, "A team needs 1 to 64 members"),
  tools: z.record(teamNameSchema, z.record(z.string(), z.json())).optional(),
}).superRefine((team, context) => {
  if (!Object.hasOwn(team.members, team.entry)) context.addIssue({ code: "custom", path: ["entry"], message: "Entry member does not exist" });
  const memberNames = Object.keys(team.members);
  if (new Set(memberNames.map(name => name.toLowerCase())).size !== memberNames.length) {
    context.addIssue({ code: "custom", path: ["members"], message: "Member names cannot differ only in case" });
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      context.addIssue({ code: "custom", path: ["members", name, "delegates"], message: "Member delegation relationships cannot form a cycle" });
      return;
    }
    visiting.add(name);
    for (const target of team.members[name]?.delegates ?? []) {
      if (!Object.hasOwn(team.members, target)) context.addIssue({ code: "custom", path: ["members", name, "delegates"], message: `Member ${target} does not exist` });
      else visit(target);
    }
    visiting.delete(name);
    visited.add(name);
  }
  memberNames.forEach(visit);
});

export type TeamManifest = z.infer<typeof teamSchema>;

export function validateTeamResources(team: TeamManifest, entries: Iterable<string>) {
  const paths = new Set(entries);
  const requirePath = (path: string, allowDirectory = false) => {
    if (paths.has(path) || (allowDirectory && [...paths].some(entry => entry.startsWith(`${path}/`)))) return;
    throw new Error(`Resource referenced by the team does not exist: ${path}`);
  };
  for (const member of Object.values(team.members)) {
    requirePath(member.instructions);
    for (const skill of member.skills ?? []) requirePath(`skills/${skill}/SKILL.md`);
    for (const knowledge of member.knowledge ?? []) requirePath(`knowledge/${knowledge}`, true);
  }
  for (const plugin of Object.keys(team.tools ?? {})) requirePath(`tools/${plugin}.tool.js`);
}
