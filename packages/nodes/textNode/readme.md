# Text Node

Writes, saves, and generates text in Markdown, for scripts, storyboard notes, or asset analysis.

## Inputs and outputs

- Inputs accept text, image, and video references.
- Outputs the node's current full Markdown string, which can be connected to downstream nodes that accept text input.

## Usage

1. The node shows the text as a Markdown preview. Click "Edit" to open the rich text editor, or switch to source mode to edit the Markdown directly.
2. To generate with AI, select the node, enter your request below, and choose a model; if there is none, add one in Settings first.
3. Connect reference nodes and explain in the prompt how they should be used.
4. Click the generate button and the text appears progressively; newly generated content replaces the current text output.
5. After generation you can keep editing by hand, then connect the text output to the next production nodes.

The text is saved automatically to the node's `content.md`, and downloads use the `.md` format. If the content on disk conflicts, you can first view and copy the current text, then choose to reload it from disk; the AI prompt below is edited independently.

The node ships its own Markdown editing and preview implementation and only reuses the Tiptap, Marked, and DOMPurify dependencies provided by the host. Rich text editing normalizes the Markdown; to keep raw HTML exactly as written, use source mode.

How well image and video references are understood depends on the selected model.
