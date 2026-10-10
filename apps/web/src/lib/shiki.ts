// ACT: Markdown currently uses plain-text coloring; keep the library's web entry to avoid bundling all languages.
export * from "shiki/bundle/web";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";
