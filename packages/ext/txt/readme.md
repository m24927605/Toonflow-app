# Text Editor

Provides plain-text file editing. File reading, the save queue, and saving before close are managed by the document host. The component receives text through `context.text` and submits changes through `context.updateText(text)`.

The extension declares its own file icon, font size, and word-wrap settings, and reads the current configuration through `context.config`.

Run `bun run --cwd packages/ext/txt build` from the repository root; the output is `build/ext/ext-txt.umd.js`. See `packages/extScaffold/readme.md` for extension development and the context interface.
