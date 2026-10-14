/// <reference path="./types.d.ts" />

import openaiCodex from "./src/language/openaiCodex";
import claudeCode from "./src/language/claudeCode";
import deepSeek from "./src/language/deepSeek";
import colab from "./src/language/colab";
import openai from "./src/media/openai";
import higgsfield from "./src/media/higgsfield";
import gemini from "./src/media/gemini";
import metaso from "./src/media/metaso";
import minimaxH3 from "./src/media/minimaxH3";
import qwenImage from "./src/media/qwenImage";
import suno from "./src/media/suno";

export type Provider = ProviderDefinition;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [openaiCodex, claudeCode, deepSeek, colab] as const;
export const mediaProviders = [openai, higgsfield, gemini, metaso, minimaxH3, qwenImage, suno] as const;
