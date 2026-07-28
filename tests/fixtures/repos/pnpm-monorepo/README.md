# Crewboard workspace

pnpm monorepo: `apps/web` is Crewboard, a small task board; `docs` is its documentation
site; `packages/shared` holds formatting helpers used by the app.

MakeADemo pipeline fixture — workspace target selection, scoped installs with a root
`prepare` script, and docs-role exclusion (see `../README.md`).

```
pnpm install
pnpm dev
```
