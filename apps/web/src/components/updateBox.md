### New

- The canvas can paste text, images, videos and audio from the clipboard as the corresponding basic nodes, making it easy to import creative content directly.
- New Android client (experimental, ARM64): use projects, canvases and the Agent locally on your phone, with system file import and export, landscape display and interface zoom.
- New Device Link: the desktop and Android clients can connect to another computer by scanning a QR code, reading a QR code image or entering a pairing code, and use that computer's projects, model configuration and computing power.
- Device Link supports local networks and self-configured HTTPS public connections, with shared directory management, online device viewing and authorization revocation; when a connection fails, you can retry or switch back to this device.
- New web browser tool: the desktop Agent can operate the local Chrome or Edge and show the web page live, with zoomed viewing, manual operation and address navigation.
- New global asset management tool: the Agent can find, read and organize assets, archive generated results into the asset library, or copy assets into the current workspace for use.
- Media providers support AI-assisted integration: read API documentation through a conversation, generate the configuration, and preview the models and source code before using or downloading them (requires a configured text model and the enabled web browser tool).
- The canvas list supports a directory tree and search: create folders, move canvases and folders, rename them and delete empty folders.
- The Plugins panel can enable and disable bundled nodes, tools and global skills, and uninstall global skills you no longer need.
- New image relighting tool: adjust the direction, intensity and color of the key light and rim light, choose a lighting preset or enter a description, and call an image model to generate the new lighting.
- New image multi-angle tool: adjust horizontal orbit, vertical pitch, shooting distance and lens type, and call an image model to generate a new viewpoint.
- New entries for generating 360° orbit images and 720° panoramas, with rotating preview, image correction, and capturing a single image, a 4-grid or a 12-grid image to add to the canvas.

### Improvements

- When copying a single node that already has an image output, the image content can be written to the clipboard for pasting into other apps that support images.
- Pasted content is placed at the mouse position inside the canvas, or at the center of the current viewport when the mouse is outside the canvas.
- After confirming an inpainting, a separate image generation node is created first, so you can keep adjusting the model, parameters and reference images before generating.
- Web images in Agent conversations are saved to the workspace before being previewed, and image links support thumbnails; the workspace tool can also download web images as assets.
- The Agent can reference canvases in workspace subfolders, so you can keep working through the conversation after organizing a project into directories.
- Media provider configuration supports more custom form fields, and the provider list now shows icons.
- Improved media model list refreshing, added image models, and synced capability parameters such as size, aspect ratio, duration and resolution.
- Some media providers proportionally adjust the height of reference images and video first/last frame images before generation, reducing generation failures caused by asset sizes that do not meet API requirements.
- Agent browser operations in the same turn share one preview, reducing duplicate cards; improved connection stability for long replies and media generation.
- Desktop updates show download progress and the preparation stage, making the update status easier to follow.
- Video nodes generate a cover preview after loading, improving the display while paused.

### Fixes

- Fixed the canvas being unable to paste clipboard images in some desktop environments, and improved native clipboard reading and media content detection.
- Fixed screen jumping caused by the list height and auto-scroll getting out of sync when Agent streaming replies wrap lines.
- Fixed parts of the same turn remaining in the list after an Agent reply was deleted.
- Fixed later operations losing the directory path after renaming a canvas inside a subfolder through the Agent.
- Fixed the reasoning effort being unexpectedly reset when the model selection was initialized.
- Fixed reference-style Markdown images displaying incorrectly, and some tool results being unable to preview workspace images correctly.
- Fixed existing extension information being lost when editing a text provider.
- Fixed related edges and connection points staying invisible when selecting or dragging nodes after canvas edges were hidden.
- Fixed some resources missing after the image processing component was bundled, which prevented image processing features from loading.
