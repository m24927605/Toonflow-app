export type NodeMediaValue = { url: string; mimeType: string };
/** A character identity trained on a provider, e.g. a Higgsfield Soul ID; `kind` must match the image model's `character`. */
export type NodeCharacterValue = { id: string; name: string; kind: string };

export type NodeValueMap = {
  STRING: string;
  INT: number;
  FLOAT: number;
  BOOLEAN: boolean;
  IMAGE: NodeMediaValue;
  MASK: NodeMediaValue;
  VIDEO: NodeMediaValue;
  AUDIO: NodeMediaValue;
  CHARACTER: NodeCharacterValue;
};

export type NodeOutput = {
  [type in keyof NodeValueMap]: { dataType: type; value: NodeValueMap[type] }
}[keyof NodeValueMap];

export type NodeOutputs = Record<string, NodeOutput | undefined>;
export type NodeInputValue = (NodeOutput | { dataType: string | string[]; value: undefined }) & { source: string; sourceHandle: string };

export function isNodeOutput(output: unknown): output is NodeOutput {
  if (!output || typeof output !== "object" || !("dataType" in output) || !("value" in output)) return false;
  const { dataType, value } = output;
  switch (dataType) {
    case "STRING": return typeof value === "string";
    case "BOOLEAN": return typeof value === "boolean";
    case "INT": return typeof value === "number" && Number.isSafeInteger(value);
    case "FLOAT": return typeof value === "number" && Number.isFinite(value);
    case "IMAGE":
    case "MASK":
    case "VIDEO":
    case "AUDIO": {
      const mediaType = dataType === "MASK" ? "image" : dataType.toLowerCase();
      return !!value && typeof value === "object" && "url" in value && typeof value.url === "string" && !!value.url.trim()
        && "mimeType" in value && typeof value.mimeType === "string" && value.mimeType.startsWith(`${mediaType}/`)
        && value.mimeType.length > mediaType.length + 1;
    }
    case "CHARACTER":
      return !!value && typeof value === "object" && "id" in value && typeof value.id === "string" && /^[\w-]{1,128}$/.test(value.id)
        && "name" in value && typeof value.name === "string" && "kind" in value && typeof value.kind === "string" && /^[\w-]{1,64}$/.test(value.kind);
    default: return false;
  }
}
