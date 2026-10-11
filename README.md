<div align="center">

<p align="center">
  <img src="./docs/images/logo.png" alt="Toonflow Logo" width="120" height="120" />
</p>

# Toonflow

**An open-source AI platform for short dramas, animated comics, and video creation**

> 🚀 **All-in-one short drama creation**: Write scripts, manage assets, and generate images and videos, with your entire creative workflow organized on an infinite canvas.

</div>

## 1. 🌟 Highlights

Toonflow is an open-source AI creation platform for short dramas, animated comics, and short videos, bringing scripts, assets, and video clips together on one infinite canvas.

| Capability | Description |
| --- | --- |
| 🏠 **Local deployment** | Keep projects and assets on your own device or server, with Docker and server deployment options. |
| 🖼️ **Infinite canvas** | Organize scripts, characters, scenes, and video clips on the same canvas. |
| 🔌 **MCP** | Connect external tools and services through MCP. |
| 🧩 **Plugins** | Extend Toonflow with node, tool, skill, agent, and editor extension plugins, installed from local packages and managed under Settings → Plugins. |
| 🤖 **Open Agent** | Open access to prompts, tools, and A2A to customize Agent behavior and collaborate with external Agents. |
| 🔧 **Flexible model integration** | Sign in with OpenAI Codex, use a local Claude Code, add API providers such as DeepSeek or any OpenAI- or Anthropic-compatible service, or connect local ComfyUI instances and LLMs. See [Model Providers](#4--model-providers). |
| 🌐 **Interface languages** | English, Traditional Chinese, and Simplified Chinese. |

---

## 2. 📸 Screenshots

<div align="center">

<a href="./docs/images/screenshots/projectHome.png"><img src="./docs/images/screenshots/projectHome.png" alt="Toonflow project home and idea creation" width="80%" /></a><br /><sub>Project home and idea creation</sub>

<a href="./docs/images/screenshots/canvasDark.png"><img src="./docs/images/screenshots/canvasDark.png" alt="Toonflow dark canvas and AI assistant" width="80%" /></a><br /><sub>Creative canvas · Dark theme</sub>

<a href="./docs/images/screenshots/canvasLight.png"><img src="./docs/images/screenshots/canvasLight.png" alt="Toonflow light canvas and AI assistant" width="80%" /></a><br /><sub>Creative canvas · Light theme</sub>

<a href="./docs/images/screenshots/assetCanvas.png"><img src="./docs/images/screenshots/assetCanvas.png" alt="Toonflow canvas for character, scene, and prop assets" width="80%" /></a><br /><sub>Character, scene, and prop assets</sub>

<a href="./docs/images/screenshots/directorStudio.png"><img src="./docs/images/screenshots/directorStudio.png" alt="Toonflow 3D director's studio and shot previsualization" width="80%" /></a><br /><sub>3D director's studio and shot previsualization</sub>

<a href="./docs/images/screenshots/characterImageGeneration.png"><img src="./docs/images/screenshots/characterImageGeneration.png" alt="Toonflow three-view character sheets and image generation" width="80%" /></a><br /><sub>Three-view character sheets and image generation</sub>

<a href="./docs/images/screenshots/videoGeneration.png"><img src="./docs/images/screenshots/videoGeneration.png" alt="Toonflow video generation with multiple reference assets" width="80%" /></a><br /><sub>Video generation with multiple reference assets</sub>

<a href="./docs/images/screenshots/nodeMenu.png"><img src="./docs/images/screenshots/nodeMenu.png" alt="Toonflow node menu and grouping operations" width="80%" /></a><br /><sub>Node menu and grouping operations</sub>

</div>

---

## 3. 🚀 Install

### 3.1 Docker Installation

Install Git, [Docker Engine](https://docs.docker.com/engine/install/), and Docker Compose first. On Windows and macOS, you can use Docker Desktop in Linux container mode. The repository includes a [Dockerfile](./Dockerfile), [Compose configuration](./compose.yaml), and [build exclusions](./.dockerignore). The image is built with Bun 1.4.2 and includes FFmpeg.

<details>
<summary><strong>Expand Docker installation steps</strong></summary>

Clone the source and run the following in the repository root:

```sh
git clone <repository-url> Toonflow-app
cd Toonflow-app
docker compose up -d --build
```

The first build installs dependencies and builds the bundled nodes, tools, Web, and Server. Once started, open `http://127.0.0.1:3000`. For a remote host, use an SSH tunnel as described under “Access and Data” below. The first startup initializes the bundled plugins and provides a `myProject` working directory.

Settings, plugins, and project files are stored in the Docker named volume `toonflowData`, mounted at `/app/data/` inside the container. The actual volume name includes the Compose project prefix. Stopping or rebuilding the container preserves your data. **Do not use `docker compose down -v`: this command deletes the data volume.**

```sh
docker compose logs -f toonflow  # View logs
docker compose stop             # Stop the service
docker compose start            # Start it again
docker compose down             # Remove containers, keeping the data volume
```

To add a project directory, click “New Folder” in the “Select Server Working Directory” dialog. The dialog also supports renaming and deleting files and folders. Alternatively, create a directory from the command line while the service is running:

```sh
docker compose exec toonflow mkdir -p /app/data/workspaces/newProject
```

To back up, stop the service first, copy the data, then start it again:

```sh
docker compose stop
docker compose cp toonflow:/app/data ./toonflowBackup
docker compose start
```

</details>

---

### 3.2 Server Installation

Use this option to run Web and Server directly on a Linux server. The example below uses Ubuntu / Debian and the project's pinned version, [Bun 1.4.2](https://bun.sh/docs/installation).

<details>
<summary><strong>Expand server installation steps</strong></summary>

Install the runtime environment:

```sh
sudo apt-get update
sudo apt-get install -y git curl unzip ffmpeg
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Clone the source and start the service:

```sh
git clone <repository-url> Toonflow-app
cd Toonflow-app
bun install --frozen-lockfile

# Build bundled nodes, tools, Web, and Server
bun run build:server
mkdir -p data/workspaces/myProject
bun run start:server
```

When the log prints the service address, open `http://127.0.0.1:3000` on the server itself. The command above runs in the foreground; press `Ctrl+C` to stop it. For startup at boot and process management, see [Bun's systemd deployment guide](https://bun.sh/guides/ecosystem/systemd): set the working directory to the repository directory and the start command to the absolute path of Bun followed by `run start:server`, and run it as a user with read and write access to that directory.

</details>

---

### 3.3 Access and Data

- The service uses the fixed port `3000`. The web interface and API have no separate login authentication. For server installations, restrict access to port `3000` with a firewall or security group. Public access requires a reverse proxy with authentication.
- For personal remote access, run `ssh -N -L 3000:127.0.0.1:3000 username@server-address` on your own computer, keep the connection open, then visit `http://127.0.0.1:3000`. You do not need to expose the server's port `3000` to the internet.
- With a direct installation, settings, plugins, and workspaces are stored in the repository's `data/` directory by default. With Docker, they are stored at `/app/data/` inside the data volume. Keep the entire directory when migrating or backing up. After opening the page, select `myProject` in the server workspace. Create subdirectories under the corresponding `workspaces/` directory for additional projects.
- Both installation methods include system FFmpeg. You still need to set up model providers in the interface; see [Model Providers](#4--model-providers).

---

## 4. 🤖 Model Providers

Set up models under **Settings → Text models** and **Settings → Media models**. On first launch, **Quick start** lets you set up a language model right away or skip it and do it later.

Credentials stay in your local data directory and are only sent to the provider they belong to. Toonflow does not collect usage telemetry.

**Language models**

| Provider | How it connects |
| --- | --- |
| OpenAI Codex | Sign in with a ChatGPT Plus or Pro subscription through OAuth. Credentials are stored in `auth.json` in the local data directory and refreshed automatically. Available to agents and nodes. |
| Claude Code | Runs the Claude Code CLI that is installed and signed in on the computer running Toonflow. Single-turn text generation in nodes only: no tool calls, and not available to agents. |
| DeepSeek | API key. |
| Custom providers | Any OpenAI-compatible or Anthropic-compatible API. |

**Media models**

| Provider | How it connects |
| --- | --- |
| OpenAI | Images API with GPT Image 2.5 Sunburst (`gpt-image-2.5-sunburst`). The API key is sent only to `api.openai.com`. |
| Higgsfield | Video generation with Seedance 2.0 and Seedance 2.5 (2.5 can also extend a video), plus Soul 2.0 and Soul Cinematic images with trained character identities (Soul ID), through the Higgsfield CLI on the computer running Toonflow. Install it with `npm install -g @higgsfield/cli`, then sign in once with `higgsfield auth login`. Jobs use the credits of your Higgsfield plan; Toonflow never reads the CLI credentials. |
| Google Gemini | Text-to-speech with Gemini 3.8 Flash TTS (30 preset voices). The API key is sent only to `generativelanguage.googleapis.com`. A style prompt or emotion controls tone and pace; the text is read verbatim. |
| Metaso | API key. |
| MiniMax H3 (Colab) | Video with sound from the open-weight MiniMax H3 model at 480p, 720p or 1080p, 4–15 seconds, with up to 9 reference images, run on a Google Colab A100 through the Colab CLI on the computer running Toonflow. Install it with `uv tool install google-colab-cli`, then sign in once by running `colab sessions`. Each video starts and stops its own session and uses the compute units of your Colab plan (about 10 minutes at 480p or 720p, about 35 minutes at 1080p). The Colab CLI logs sign-in tokens to `~/.config/colab-cli/colab.log` in plain text, so Toonflow points that log at the null device and refuses to run while a regular log file exists; it never reads the Colab credentials. |

You can also add a custom media provider under Settings → Media models.

To keep a media provider's API key out of Toonflow's settings, enter `env:VARIABLE_NAME` in its key field. Toonflow then reads that variable each time it is needed, first from its own process environment and then from `~/.env`, so it also works when the server is started without your shell variables.

---

## 5. 📜 Open-Source License

Toonflow is licensed under the [MIT License](./LICENSE). Third-party dependencies and assets remain subject to their own licenses and copyright notices.

> **Non-retroactivity clause**: Users who used versions released before v1.0.8 under AGPL-3.0 remain subject to AGPL-3.0. Versions v1.0.8 through v1.1.8 remain subject to Apache-2.0 and its additional agreement. These users are not bound by this license change.
