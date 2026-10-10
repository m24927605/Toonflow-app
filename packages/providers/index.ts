/// <reference path="./types.d.ts" />

import openaiCodex from "./src/language/openaiCodex";
import claudeCode from "./src/language/claudeCode";
import deepSeek from "./src/language/deepSeek";
import openai from "./src/media/openai";
import higgsfield from "./src/media/higgsfield";
import apiMart from "./src/media/apiMart";
import metaso from "./src/media/metaso";
import compshare from "./src/media/compshare";

export type Provider = ProviderDefinition;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [openaiCodex, claudeCode, deepSeek] as const;
export const mediaProviders = [openai, higgsfield, apiMart, metaso, compshare] as const;
