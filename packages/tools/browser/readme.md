# Browser

Lets the Toonflow Agent operate the local Chrome or Edge and shows the page being operated live in the workspace.

## Usage

1. Enable Web Browser (`网页浏览器`) in the tool settings. The tool looks for a local browser; you can also configure the absolute path of the browser executable.
2. In an Agent conversation, ask it to open a web page, search, or read information.
3. The first time the Agent uses the browser, a small preview card appears below the toolbar of that message. The Agent keeps updating this view as it works step by step; it does not add a card for every tool call or move the view to the end of the whole message list. You can hover, click, double-click, right-click, drag, type text, use modifier keys, and scroll to operate the page directly, or click "Enlarge" (`放大`) to see details. Mouse buttons and keys held down manually are released when the view loses focus, switches pages, or stops being watched.

The top bar of the enlarged view provides an address bar and Back, Forward, and Refresh buttons. Enter a full HTTP/HTTPS address and press Enter to visit it; Back and Forward use the current tab's real history and are disabled when there is no corresponding history. Navigation errors are shown directly in the enlarged view.

Each Agent conversation uses an independent browser session and shows only one view. The session can continue across multiple turns; multi-step operations and enlarging or collapsing keep reusing the same view connection. Watching pauses when you switch to another conversation and resumes when you switch back; the Agent can keep operating. Clicking Stop while a browser operation is running closes the current browser session so that nothing keeps executing after cancellation; it can be reopened. Browsers started in this run are cleaned up when the app exits.

The tool supports opening, navigation, page snapshots, paginated reading of body text, clicking, hovering, filling in text, key presses, scrolling, screenshots, and tab management. Operations use element references returned by snapshots; take a new snapshot after the page changes or a reference becomes invalid, and read the snapshot again after using `hover` to expand a menu. The view is transmitted through a separate interface and is not written to the chat history.

A local Chrome or Edge is required. The first version uses a separate temporary browser profile and does not read the login data of your personal browser. Login state is kept until the current browser session closes. Local browser session isolation is not the same as an operating system sandbox.

Common automation traits are reduced by default: the automation switch is removed at launch, the `AutomationControlled` flag is disabled, and the window and virtual screen sizes are set to match the preview; `HeadlessChrome` is removed from the User-Agent before page navigation, while keeping the local browser's real version, brand, platform, and Client Hints. No stealth plugin needs to be installed, and the page's language, GPU, and plugin objects are not modified. These settings take effect when a new browser process starts.

This is not full stealth. Tested on local Edge 153 and Chrome 154: the script environments of SharedWorker and ServiceWorker, and the requests they send, can still expose `HeadlessChrome`; new windows opened by the page itself also leak in their first request and first script before initialization. Page-level overrides in the main page, iframes, and DedicatedWorker do not cover these contexts. Websites may also detect automation by combining behavior, network, and other browser traits. When you hit a login or human verification, you can take over manually in the live view.

The earliest scripts on a page may also briefly read the window's outer size as `0×0` before it returns to normal. Waiting for a blank page's size to be ready cannot eliminate the transient state of the new document during navigation, so such an ineffective wait is not used, and size properties are not tampered with.

Verified on 2026-10-07 with the two browsers above: all 20 Fingerprint Scanner checks on [Sannysoft](https://bot.sannysoft.com/) were `ok`, both WebDriver checks passed, and [BotD v2](https://github.com/fingerprintjs/BotD) returned `bot: false`; an Edge control group launched with default Puppeteer was identified by BotD as `headless_chrome`. These public detection results only cover the corresponding checks and do not prove that a website's risk controls will not detect automation.

## Development

`bun run --filter @toonflow/tool-browser typecheck`

`NODE_ENV=dev bun run --filter @toonflow/tool-browser build`

`bun run --filter @toonflow/tool-browser demo` starts a temporary local web page, drives a real browser, and checks operations, the view, isolation, cancellation cleanup, and manual hover, drag, double-click, modifier keys, release, address navigation, back/forward, and refresh; it does not call model services.

Run `bun demo.ts --detect` in the subpackage directory to check the UA, Client Hints, webdriver, native descriptors, and sizes of the main page, a cross-origin iframe, the three kinds of Workers, a page popup, and an Agent-opened tab; add `--executable=<absolute browser path>` to specify Edge or Chrome. The probe uses in-memory local pages and does not visit detection websites. Missing detection results or regressions in guaranteed items cause a failing exit; known leaks are listed separately in `knownLeaks` and `geometryWarnings`. A successful process exit only means the probe completed and must not be taken to mean that all stealth checks passed.

The browser runtime and the input protocol are exported through `./host` and `./protocol` respectively. The host holds the runtime and injects the call entry through the tool context, ensuring the tool and the view interface share the same session.

The frontend filters browser tools with `isBrowserTool` from `./client`, keeps the full tool history data, and passes the filtered results to `browserPanel` from `./panel`: `tools: ToolCall[]`, `directory?: string`, `active: boolean`. The panel sits below the toolbar of the corresponding message; the virtual list additionally keeps the current browser message, so scrolling or appending messages does not unmount the view or rebuild the connection. When a historical session has expired, it is shown as ended, and tool failures and interruptions are still shown in the card.
