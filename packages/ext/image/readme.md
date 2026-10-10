# Image Preview

Supports JPG, JPEG, PNG, WebP, GIF, BMP, SVG, AVIF, and ICO. Resources are read through file URLs shared by the host, and the URL is released when the tab is switched or closed.

The extension declares its own icon. The "Fit image to window" setting is enabled by default; when disabled, images are shown at their original size with scrolling.

The extension ID is `ext-image` and the package name is `@toonflow/ext-image`. Run `bun run --cwd packages/ext/image build` from the repository root; the output is `build/ext/ext-image.umd.js`. See `packages/extScaffold/readme.md` for extension development and the context interface.
