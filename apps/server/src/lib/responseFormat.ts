import { translateError, translateMessage } from "./i18n";
import type { MessageDescriptor } from "@toonflow/i18n";
import { z } from "zod";
export interface ApiResponse<T = unknown> {
  code: number;
  data: T | null;
  message: string;
}

// Success response
export function success<T = unknown>(data: T | null = null, message: string | MessageDescriptor = "Success"): ApiResponse<T> {
  return {
    code: 200,
    data,
    message: translateMessage(message),
  };
}

// Error response, defaults to a client error
export function error<T = unknown>(message: string | MessageDescriptor = "", data: T | null = null, code: number = 400): ApiResponse<T> {
  return {
    code,
    data,
    message: translateMessage(message),
  };
}

export function errorFromCause(cause: unknown): ApiResponse {
  if (cause instanceof z.ZodError) {
    return error("Parameter error", cause.issues.map(issue => ({ ...issue, message: translateMessage(issue.message) })), 400);
  }
  const failure = cause as { status?: number; code?: string } | null;
  const code = failure?.code;
  const status = failure?.status || ({ ENOENT: 404, ENOTDIR: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403, EPERM: 403 }[code ?? ""] ?? 500);
  const message =
    {
      ENOENT: "The file or folder cannot be found. It may have been moved, deleted, or the wrong location was selected.",
      ENOTDIR: "You selected a file, but you need to select a folder here. Please select again.",
      EEXIST: "This name is already occupied, please change it. The original content will not be overwritten.",
      ENOTEMPTY: "This folder still contains files and cannot be deleted directly. Empty it or move the files elsewhere first.",
      EACCES: "You do not have permission to access this file or folder. Please check permissions or try again from a different location.",
      EPERM: "The system does not allow this operation. The file may be in use by other programs, please close it and try again.",
      EISDIR: "You selected a folder, but what you need here is a file. Please select a specific file again.",
    }[code ?? ""] ?? translateError(cause);
  return error(message, code ? { code } : null, status);
}
