# File Primitives

`@toonflow/file` is the file operation entry shared by Node and Bun. It only manages atomic commits and in-process file queues. Paths for global files are decided by the owning module; workspace files still go through the server's `resolveWorkspacePath`, business locks, and endpoint permission checks first. Modules keep their own install transactions, rollback, data formats, and error messages.

```ts
import { readFile, writeAtomic } from "@toonflow/file";

await writeAtomic(absolutePath, JSON.stringify(snapshot));
const content = await readFile(absolutePath, "utf8");
```

- `writeAtomic` / `writeAtomicSync`: a short random temporary file in the same directory, created with `wx`, renamed after the full write; `exclusive: true` commits with a hard link and throws `EEXIST` if the target already exists. The default mode is `0o600`. It does not create parent directories automatically, does not merge snapshots, and does not guarantee durability across power loss.
- Plain `writeFile`, `appendFile`, and `copyFile` keep standard library semantics and participate in the queue. Business snapshots that need a full overwrite explicitly choose the atomic API; appends, development hot-update copies, and install staging are not switched to a different operation.
- `async-mutex` provides the FIFO queue: up to 64 concurrent reads per file, exclusive writes, and different files in parallel. Windows paths are case-insensitive; multiple paths are acquired in a fixed order to avoid waiting on each other. Calling modules are responsible for transaction boundaries involving realpath, links, and directory hierarchies.
- Read/write streams, handles returned by `open`, and directories returned by `opendir` hold an access permit until closed; callers must end, cancel, or close them. Queueing waits at most 30 seconds and supports the AbortSignal of `withFileAccess`; a synchronous call that hits an unfinished conflicting operation in this process throws `EBUSY` immediately.
- Path-based read/write streams support AbortSignal and `destroy()`; canceling while waiting for a permit never opens or truncates the file later. When the underlying close fails and the handle may still be valid, the permit is kept. External `fd` values or a custom `fs` that would bypass the queue are not accepted; for an existing file handle, use the stream methods of the object returned by `open`. A canceled waiter in the third-party Semaphore releases its permit after reaching its original position without running the business operation, and the original ordering is preserved meanwhile.
- `rename` and atomic commits use `stubborn-fs` for limited retries, up to about 5 seconds; persistent locking still throws the original error. Do not retry an entire multi-step install transaction, and do not retry input streams that have already been consumed. Atomic writes only clean up temporary files created by that write, and failures in closing or cleanup cannot mask the original write error; a failed temporary file cleanup after a successful commit only logs a warning and does not report the saved content as failed.
- `withFileAccess(paths, kind, action, signal?)` lets modules such as HTTP/SDK adapt native I/O; the callback must wait until the operation really finishes. It is not a reentrant lock: do not call this package's managed I/O on the same path inside the callback. When operations need to be combined, the business module decides the transaction scope.

Bun file methods `file` and `write` are imported from `@toonflow/file/bun`. Return values keep their real Blob identity, and `text/json/arrayBuffer/bytes/formData/stream/write/delete/unlink` go through the queue; string, URL, and byte paths share the same file queue. `file` does not accept external fds; the synchronous `FileSink.writer` is not exposed, so use `createWriteStream` for streaming writes. Once a Blob is handed to a native consumer such as `Response`, the calling module owns the consumption lifecycle; when it must be coordinated with modifications, use `withFileAccess` in the module.

`write` and `file(...).write` only accept non-stream data; for `Response`, `Request`, and `ReadableStream`, use the standard `pipeline` with `createWriteStream`, passing the cancellation signal to both the stream and `pipeline`. In Bun 1.3.14, some failing input streams make native `Bun.write` never finish, so this package rejects those inputs outright to avoid holding the file queue.

This package does not take over third-party libraries' internal file systems, external processes, C#/NSIS, or operating system file locks; SDK persistence, configuration, HTTP, FFmpeg, and the installer keep their own module boundaries. Do not introduce business SDKs here, and do not globally modify `node:fs`.
