# Web Search

Searches public web pages and provides the Agent with titles, source links, and snippets. By default it uses `duck-duck-scrape` to call DuckDuckGo, with no registration or API key required; it can also switch to DeepSeek or Tavily.

## How to Use

Give a search task directly in the conversation, for example: "Search for recent material on AI video production and list the sources and key points."
Search results are good for discovering material; when you need to check the full text, use it together with the Read Web Page (`读取网页`) tool.

## Configuration

In Settings → Plugins → Installed, find Web Search (`联网搜索`) and click "Configuration".

- "Search service" (`搜索服务`): defaults to DuckDuckGo (no key); DeepSeek and Tavily are optional.
- "DeepSeek API Key": required when DeepSeek is selected; enter an official DeepSeek key. Previously saved keys remain compatible.
- "Tavily API Key": required when Tavily is selected; enter a Tavily key. The keys for the two services are saved separately.
- "Maximum results" (`最多返回结果`): defaults to 8 and can be set to 1–20.
- "Timeout (ms)" (`超时（毫秒）`): defaults to 30000 and can be set to 1000–60000.

DuckDuckGo requires that the current network can reach it, and you may run into rate limits or CAPTCHAs; on failure, retry later or switch the search service manually. It never switches to a paid service automatically.
DeepSeek uses the official search service, and keys from other providers or relay platforms cannot replace its configuration; Tavily uses basic search.
Results include source URLs that the Agent can cite; a search snippet does not mean the full page has been read.
