// Python sources bundled as text with `import source from "./file.py" with { type: "text" }`.
declare module "*.py" {
  const source: string;
  export default source;
}
