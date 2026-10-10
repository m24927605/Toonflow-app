import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Resolves a CLI the user installed on this computer, or throws `missing` as a 400 error. */
export function findCommand(name: string, missing: string) {
  // ACT: Servers started from a launcher or service manager can get a short PATH, so also search the default
  // locations of official installers, npm/Homebrew globals. Add more directories here if users report misses.
  const path = [process.env.PATH, join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter);
  const command = Bun.which(name, { PATH: path });
  if (!command) throw Object.assign(new Error(missing), { status: 400 });
  return command;
}
