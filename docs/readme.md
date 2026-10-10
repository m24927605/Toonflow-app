# Toonflow Documentation

[Back to the project home page](../README.md)

## Overview

- [README](../README.md): project introduction, installation, and model providers.

## Usage and Development

- [Development and Extension Guide](./development.md): running from source, plugin extensions, and desktop packaging.
- [Development Conventions](../AGENTS.md): conventions for working on the project.
- [i18n Maintenance Guide](../packages/i18n/readme.md): dictionary extraction, dynamic text, frontend and backend integration, and language fallback.
- [MCP Integration Guide](../packages/mcp/README.md): connecting external clients and the available tools.

## Directory Conventions

```text
docs/
  readme.md          documentation index
  development.md     development and extension guide
  images/            logo
    screenshots/     product screenshots
```

Implementation and maintenance notes for each subpackage stay in the corresponding `packages/` directory. Images are shared from `images/`; when you move a file, update the relative links in both Markdown and HTML.
