# Markdown Document Extension

Supports `.md` and `.markdown` files. The extension ID is `ext-md`.

This package privately implements a Tiptap 3.31.3 editor. It defaults to rich text and can switch to the source view. The toolbar, find, image paste and drag-in, and relative images and links are all maintained by this package. Tiptap, marked, and DOMPurify reuse the host's dependencies through the scaffold's externals; they are not bundled again, and the editor component is not shared.

The body is bound to `context.text`, and `context.updateText` is called synchronously while editing. Autosave, version conflicts, error retries, and tab closing are still managed by the document host; this package keeps no separate draft and does not delay commits. File operations, opening links, the clipboard, search positioning, and view visibility all use capabilities passed in by the host.

The build output contains the extension metadata, the private editor, and styles; the host loads shared dependencies on demand before running the extension. Underline, highlight, superscript/subscript, paragraph alignment, and complex tables in older documents are still saved as mixed HTML; merely opening a file or switching modes does not rewrite the source automatically.

After installing dependencies at the repository root, run `bun run typecheck` in `packages/ext/md`. Run `bun run build` in the production environment; the output is `build/ext/ext-md.umd.js` under the repository root. Development builds and watch mode sync the output to `data/ext`.
