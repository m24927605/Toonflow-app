# Skill Operator

Queries, reads, creates, and modifies skills through a single `skillOperator` tool. The source readme is embedded into `.tool.js` at build time, so installation only needs this JS file.

The three configuration switches for reading, creating, and modifying are on by default; when one is turned off, that operation is removed from the tool parameters and also refused at execution time. Directory queries are always available. These switches only constrain this tool and do not replace other tools' file permissions.

| action | Purpose | Parameters |
| --- | --- | --- |
| `list` | Lists skill names, descriptions, sources, and paths in real time | Optional `scope` |
| `read` | Reads a skill's content or referenced resources | `name`, optional `scope`, `path` |
| `create` | Creates a skill or resource file without overwriting existing files | `name`, `content`, optional `scope`, `path` |
| `update` | Modifies an existing file with complete content | `name`, `content`, optional `scope`, `path` |

`scope` is `workspace` (`skill/` in the current workspace) or `global` (the global `data/skills/`). When reading or modifying without a scope, the workspace version of a same-named skill takes priority; creation defaults to the workspace. Specify the global scope to access the shadowed version.

`path` is relative to the skill's directory and defaults to `SKILL.md`. Use paths such as `references/example.md` to operate on bundled resources; escaping the skill directory is forbidden. For a new skill, create `SKILL.md` first, and use lowerCamelCase for the name; the content must contain valid YAML frontmatter, with `name` matching the skill name and a non-empty `description`. Read the original content before modifying.

The directory is scanned in real time on each call, so a newly created skill can be queried and read immediately; `/skill:<name>` can still be invoked manually. `disableModelInvocation` in the list indicates whether the skill only applies when the user explicitly specifies it.
