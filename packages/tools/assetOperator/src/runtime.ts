import { z } from "zod";

const requestSchema = z.object({
  action: z.enum(["list", "read", "create", "update", "mkdir", "move", "delete", "import"]),
  path: z.string().max(4096).optional().describe("Relative path inside the global asset library. For list it may be omitted or empty to query the root directory; required for other operations"),
  query: z.string().max(500).optional().describe("Optional for list: recursively filter files under path by name or path; when omitted, only the current directory is listed"),
  cursor: z.string().max(1024).optional().describe("Optional for list: use the nextCursor returned last time to continue reading; do not construct it yourself"),
  offset: z.number().int().min(1).optional().describe("Optional for read: starting line number of the text, from 1"),
  limit: z.number().int().min(1).max(2000).optional().describe("list returns at most 50 items per page; read returns at most 2000 lines per call"),
  content: z.string().max(200000).optional().describe("Full text content for create/update, mutually exclusive with sourcePath; must not be used to write fake Base64 media"),
  sourcePath: z.string().min(1).max(4096).optional().describe("Source file for create/update; must be a relative path to a file that actually exists in the current workspace, at most 100 MB, mutually exclusive with content"),
  revision: z.string().regex(/^[a-f\d]{64}$/i).optional().describe("Required for update: the SHA-256 revision returned by the most recent read, to avoid overwriting an asset that has changed"),
  target: z.string().min(1).max(4096).optional().describe("Required for move: target relative path inside the global asset library; optional for import: target relative path inside the current workspace, a unique new file is created when omitted"),
}).strict();

const actionFields: Record<z.infer<typeof requestSchema>["action"], readonly string[]> = {
  list: ["path", "query", "cursor", "limit"],
  read: ["path", "offset", "limit"],
  create: ["path", "content", "sourcePath"],
  update: ["path", "content", "sourcePath", "revision"],
  mkdir: ["path"],
  move: ["path", "target"],
  delete: ["path"],
  import: ["path", "target"],
};

export const assetRequestSchema = requestSchema.superRefine((request, context) => {
  for (const [field, value] of Object.entries(request)) {
    if (field !== "action" && value !== undefined && !actionFields[request.action].includes(field)) {
      context.addIssue({ code: "custom", path: [field], message: `${request.action} does not accept ${field}` });
    }
  }
  if (request.action !== "list" && !request.path?.trim()) {
    context.addIssue({ code: "custom", path: ["path"], message: `${request.action} requires an asset path` });
  }
  if (request.action === "list" && request.limit !== undefined && request.limit > 50) {
    context.addIssue({ code: "custom", path: ["limit"], message: "list returns at most 50 items per page" });
  }
  if ((request.action === "create" || request.action === "update") && (request.content !== undefined) === (request.sourcePath !== undefined)) {
    context.addIssue({ code: "custom", path: ["content"], message: "Exactly one of content and sourcePath must be provided" });
  }
  if (request.action === "update" && !request.revision) {
    context.addIssue({ code: "custom", path: ["revision"], message: "You must read before modifying and provide the returned revision" });
  }
  if (request.action === "move" && !request.target?.trim()) {
    context.addIssue({ code: "custom", path: ["target"], message: "move requires a target path" });
  }
});

