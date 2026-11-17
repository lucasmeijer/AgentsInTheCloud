const extensionLanguages = new Map(Object.entries({
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  html: "html", htm: "html", erb: "erb", rhtml: "erb", xml: "xml", svg: "xml", css: "css", scss: "scss", cs: "csharp", csx: "csharp",
  json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", md: "markdown", markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", regex: "regex", sql: "sql", dockerfile: "docker",
  vue: "vue", svelte: "svelte", astro: "astro", tf: "terraform", tfvars: "terraform", hcl: "hcl", php: "php", phtml: "php", proto: "proto",
  mts: "typescript", cts: "typescript", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
  m: "objc", mm: "objc", kt: "kotlin", kts: "kotlin", swift: "swift", dart: "dart", scala: "scala", sc: "scala", sbt: "scala",
  groovy: "groovy", gradle: "groovy", lua: "lua", pl: "perl", pm: "perl", r: "r", jl: "julia", zig: "zig", nim: "nim",
  ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", hs: "haskell", ml: "ocaml", mli: "ocaml", fs: "fsharp", fsx: "fsharp",
  clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure", elm: "elm", gleam: "gleam", sol: "solidity", cu: "cuda",
  ps1: "powershell", psm1: "powershell", bat: "bat", cmd: "bat", toml: "toml", json5: "json5", jsonl: "jsonl", mdx: "mdx",
  sass: "sass", less: "less", graphql: "graphql", gql: "graphql", wgsl: "wgsl", wat: "wasm", nix: "nix", tex: "latex",
  diff: "diff", patch: "diff", mk: "make", cmake: "cmake", gd: "gdscript", gdshader: "gdshader",
  glsl: "glsl", vert: "glsl", frag: "glsl", geom: "glsl", tesc: "glsl", tese: "glsl", comp: "glsl", hlsl: "hlsl", fx: "hlsl", fxh: "hlsl",
}));
const basenameLanguages = new Map(Object.entries({
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", "cmakelists.txt": "cmake",
}));
export function languageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  const named = basenameLanguages.get(basename);
  if (named) return named;
  const dot = basename.lastIndexOf(".");
  const extension = dot > 0 ? basename.slice(dot + 1) : "";
  return extensionLanguages.get(extension);
}
