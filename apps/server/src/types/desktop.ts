export type PluginInstallType = "node" | "tool" | "skill" | "provider" | "agent" | "ext";
export type PluginInstallRequest = { type: PluginInstallType; url: string; fileName: string };

export interface DesktopRuntime {
  openUrl(url: string): void;
  showItemInFolder(path: string): void;
  readClipboardText(): string | null;
  readClipboardImage(): Uint8Array | null;
  writeClipboardImage(image: Uint8Array): void;
  writeClipboardText(text: string): void;
  selectProviderFile(): Promise<string | null>;
  selectDirectory(): Promise<string | null>;
  selectSaveFile(fileName: string): Promise<string | null>;
  saveFile(token: string, content: Uint8Array): Promise<boolean>;
  ready(failed?: boolean): Promise<void>;
  openDevTools(): void;
}
