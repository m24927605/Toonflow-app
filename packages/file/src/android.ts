import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { getSystemErrorName } from "node:util";

// ACT: The APK only ships arm64/x64;
// use the basic syscall export for API 26 compatibility instead of depending on the API 30 renameat2 symbol.
const syscallNumber = process.arch === "arm64" ? 276 : process.arch === "x64" ? 316 : undefined;
if (syscallNumber === undefined) throw Object.assign(new Error(`不支持的 Android 架构：${process.arch}`), { code: "ENOTSUP" });
const library = dlopen("libc.so", {
  __errno: { args: [], returns: "ptr" },
  syscall: { args: ["i64", "i64", "ptr", "i64", "ptr", "i64"], returns: FFIType.i64_fast },
});

export function renameExclusive(source: string, target: string) {
  if (source.includes("\0") || target.includes("\0")) {
    throw Object.assign(new TypeError("文件路径不能包含空字节"), { code: "ERR_INVALID_ARG_VALUE" });
  }
  const sourceBytes = Buffer.from(source + "\0");
  const targetBytes = Buffer.from(target + "\0");
  const errnoAddress = library.symbols.__errno()!;
  // RENAME_NOREPLACE guarantees both no-overwrite and complete publication in the kernel;
  // never downgrade to check-then-rename or copying.
  if (library.symbols.syscall(syscallNumber!, -100, ptr(sourceBytes), -100, ptr(targetBytes), 1) === 0) return;
  const errno = -read.i32(errnoAddress);
  const code = getSystemErrorName(errno);
  throw Object.assign(new Error(`${code}: renameat2 '${source}' -> '${target}'`), { code, errno, syscall: "renameat2", path: source, dest: target });
}
