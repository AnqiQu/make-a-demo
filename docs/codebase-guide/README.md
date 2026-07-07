# MakeADemo Codebase Guide

Static, build-free guide to the MakeADemo codebase. It is intentionally plain:
more like an interactive text document than a marketing page.

The generated assets are intentionally checked in with the guide:

- `generated/file-inventory.js` is generated from `git ls-files`.
- `generated/src-dependency-graph.dot` and `.svg` are generated with dependency-cruiser.
- `generated/*.mmd` and matching `.svg` files are Mermaid flowchart sources and rendered outputs.

Open directly:

```text
file:///home/milo/Work/personal/MakeADemo/docs/codebase-guide/index.html
```

Or serve the folder with any static server. The page only references local `styles.css` and `script.js` files.

Regenerate the dependency graph from the repo root:

```bash
bunx depcruise src --config .dependency-cruiser.graph.cjs --include-only "^src" --output-type dot > docs/codebase-guide/generated/src-dependency-graph.dot
dot -Tsvg docs/codebase-guide/generated/src-dependency-graph.dot > docs/codebase-guide/generated/src-dependency-graph.svg
```
