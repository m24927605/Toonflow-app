# Read Web Page

Lets the Agent read the body text of a specified public URL; suitable for summarizing articles, checking facts, or analyzing public text and JSON.

## How to Use

Provide the URL and the task in the conversation, for example: "Read this web page, extract the points related to video production, and cite the source."
This tool reads known URLs; when you first need to find relevant websites, use it together with Web Search.

## Features

- Extracts text from static HTML, and can also read text and JSON.
- Returns the actual URL, HTTP status, and body, and marks the content as truncated when it exceeds the limit.
- Reads HTTP(S) addresses with Bun's native fetch, does not execute page scripts, and does not allow a username or password in the URL.
- Follows at most 5 redirects, validating the protocol at each hop; reads at most 2 MiB of decompressed response body.
- Uses the runtime environment's DNS and network, does not pre-check the addresses a domain resolves to, and is compatible with proxy Fake-IP. This tool does not provide internal network isolation; when isolation is needed, network access should be restricted by the deployment environment.

## Configuration

In Settings → Plugins → Installed, find Read Web Page and click "Configuration".

- "Timeout (ms)": defaults to 20000 and can be set to 1000–60000.
- "Maximum body characters": defaults to 40000 and can be set to 1000–100000; body text beyond the limit is truncated.

No API key is required. Pages that depend on script rendering may not return their full content.
