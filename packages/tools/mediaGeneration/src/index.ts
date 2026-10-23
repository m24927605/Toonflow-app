import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { audioGenerationSchema, imageGenerationSchema, listMediaModelsSchema, videoGenerationSchema } from "./runtime";

const configSchema = z.strictObject({
  allowImage: z.boolean().default(true),
  allowVideo: z.boolean().default(true),
  allowAudio: z.boolean().default(true),
});

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ media, config }) {
    if (!media) return [];
    const permissions = configSchema.parse(config);
    const generationTools = ([
      { name: "generateImage", mediaType: "image", enabled: permissions.allowImage, label: "Generate image", parameters: imageGenerationSchema, description: "Generate an image from a prompt and optional workspace reference images. Never ask the model to render readable text (captions, title cards, signs, logos); add it in post-production, and set skipTextCheck only after the user confirmed otherwise." },
      { name: "generateVideo", mediaType: "video", enabled: permissions.allowVideo, label: "Generate video", parameters: videoGenerationSchema, description: "Generate a video from a prompt and optional workspace images, video, audio, and first/last frames. Set the generation mode, duration, resolution and audio according to the model's capabilities. Supply a previs blocking video in videos and identify it as previsVideo, or use its depth export in videoControl mode. Without previs, ask the user first and set skipPrevis only after explicit consent. Never ask the model to render readable text (captions, title cards, signs, logos); add it in post-production, and set skipTextCheck only after the user confirmed otherwise." },
      { name: "generateAudio", mediaType: "audio", enabled: permissions.allowAudio, label: "Generate audio", parameters: audioGenerationSchema, description: "Generate audio from text or a prompt and optional workspace reference images and audio. Set voice, tone (emotion: describe the emotion and pace in words, such as \"low and slow\" or \"angry shouting\"), speed, volume, language, sample rate and format according to the model's capabilities." },
    ] as const).filter(operation => operation.enabled);
    if (!generationTools.length) return [];
    const listTool: ToolDefinition = {
      name: "listMediaModels",
      label: "Query media models",
      description: "Query the media models allowed for generation, returning providerId, modelId, type, modes, and the supported aspect ratios, durations, resolutions or voices. Query before generating; do not guess model IDs.",
      parameters: z.toJSONSchema(listMediaModelsSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        listMediaModelsSchema.parse(params);
        signal?.throwIfAborted();
        const result = (await media.listModels()).filter(model => generationTools.some(operation => operation.mediaType === model.type));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
    return [listTool, ...generationTools.map<ToolDefinition>(operation => ({
      name: operation.name,
      label: operation.label,
      description: `${operation.description}providerId and modelId must come from listMediaModels. The path of referenced assets and outputDirectory are workspace-relative paths; when the output directory is omitted, the default media directory is used. Waits for generation to finish and returns the saved file path, not Base64.`,
      promptSnippet: "Query listMediaModels before generating media, and reuse actual models and workspace reference assets.",
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const result = await media[operation.name](operation.parameters.parse(params), signal);
        const text = result.map(asset => {
          const url = asset.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
          const preview = asset.mediaType === "image" ? `![Generated image](<${url}>)` : `[${asset.mediaType === "audio" ? "Play generated audio" : "View generated video"}](<${url}>)`;
          return `${preview}
Workspace file: ${asset.path}`;
        }).join("\n\n");
        return { content: [{ type: "text", text }], details: result };
      },
    }))];
  },
};

export default plugin;
