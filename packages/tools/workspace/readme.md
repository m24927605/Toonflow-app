# Workspace Files

Lets the Agent read, list, and edit files in the current project workspace, and download remote images.

## How to Use

Select or open a project first, then give the file name and the task, for example: "Read storyboard.md and summarize it", "Save this setting as characterSettings.md".
File locations are relative to the current workspace; before modifying existing content, the Agent reads the relevant file first.

## Features

- List directory contents and read files.
- Create or write files, and edit content in existing files.
- Download public HTTP(S) images to `assets/chatImages/` and return a workspace-relative path that can be previewed directly; supports PNG, JPEG, WebP, GIF, AVIF, and BMP, up to 20 MB per image. SVG, images behind a login, and internal network addresses are not supported.
- Read available global skills and their bundled resources; the global skills directory is read-only.

## Configuration

In Settings → Plugins → Installed, find Workspace Files and click "Configuration".
"Read-only mode" is off by default. When enabled, this tool only provides file reading and directory listing, and no longer provides writing, editing, or image download.
Read-only mode only restricts this tool; it does not turn off the modification capabilities of other tools such as Canvas Operations.

File modifications are limited to the current workspace. This tool has no features for deleting, renaming, or running terminal commands.
