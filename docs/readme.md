# Toonflow Documentation

[Back to the project home page](../README.md)

## Overview

- [README](../README.md): project introduction, installation, and model providers.

## Usage and Development

- [User Guide](https://qcn7xdsqgc4z.feishu.cn/docx/RXFqdgR2Xo0dXZxGfd0cZCGgnwf): everyday operations and the creative workflow.
- [Development and Extension Guide](./development.md): running from source, plugin extensions, desktop packaging, and release updates.
- [Android Guide](../apps/mobile/readme.md): ARM64 APK, local runtime, Device Link, and builds.
- [Contributing Guide](../CONTRIBUTING.md) and [Development Conventions](../AGENTS.md): conventions for taking part in the project.
- [i18n Maintenance Guide](../packages/i18n/readme.md): dictionary extraction, dynamic text, frontend and backend integration, and language fallback.
- [i18n Regression Record](../packages/i18n/regression.md): completed checks and known scope.
- [MCP Integration Guide](../packages/mcp/README.md): connecting external clients and the available tools.

## Directory Conventions

```text
docs/
  readme.md          documentation index
  development.md     development and extension guide
  images/            logos, certificates, and community images
    screenshots/     product screenshots
    sponsors/        sponsor images
```

Implementation and maintenance notes for each subpackage stay in the corresponding `packages/` directory. Images are shared from `images/`; when you move a file, update the relative links in both Markdown and HTML.
