# FFmpeg Media Processing

Provides `ffmpeg` and `ffprobe` to the Agent, connecting directly to `context.ffmpeg()` and reusing the executables configured in Settings → Plugins → FFmpeg and the call bridge that nodes already use.

## Calling

`ffprobe` takes a file path and optional native options:

```json
{ "path": "assets/input.mp4", "options": ["-count_frames"] }
```

`ffmpeg`'s `steps` call fluent methods in order, and `operation` specifies the method executed last; `run()` is used when it is omitted. For example, to output an image sequence:

```json
{
  "steps": [
    { "method": "input", "args": ["assets/input.mp4"] },
    { "method": "fps", "args": [1] },
    { "method": "output", "args": ["assets/frame%03d.png"] }
  ]
}
```

You can also use `operation: { "method": "save", "args": ["assets/output.mp4"] }`, or native operations such as `screenshots` and `concat`. To query available encoders, codecs, formats, or filters, omit `steps` and set `operation.method` to `availableEncoders`, `availableCodecs`, `availableFormats`, or `availableFilters`.

`options` maps to the fluent constructor options supported by the host: `source`, `cwd`, `niceness`, `priority`, `stdoutLines`, `timeout`. `steps` supports all configuration methods and aliases the host already has; JSON values in `args` are passed as is, and `undefinedArgs` can specify positions that should receive `undefined`.

## Native Capabilities and Execution

- There is no separate whitelist of FFmpeg arguments, and `inputOptions`, `outputOptions`, and filter arguments are not split or rewritten.
- Output is not restricted to a single file; image sequences, HLS/DASH segments, and multiple inputs and outputs are all handled natively.
- Output is not redirected to temporary files, and no execution time limit is enforced. Output directories are prepared as the native tool requires, and overwriting existing files follows FFmpeg's native rules; when overwriting is not requested, use new file names.
- The host's existing explicit workspace path checks, the install prompt when FFmpeg is missing, error propagation, and conversion cancellation are kept. Cancellation or failure may leave partial files produced by native processing; the tool does not delete assets automatically.

This tool passes JSON call data and does not accept JavaScript, callbacks, or Node streams; the executables are configured in Settings → Plugins → FFmpeg. The host only checks explicit file entries; indirect access through raw arguments, filters, and media lists is not a file system sandbox. The native FFprobe and capability query interfaces do not expose the child process; canceling stops waiting, and the underlying query exits on its own.
