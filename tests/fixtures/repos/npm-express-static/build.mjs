// Minimal build: copy the static client into dist/. Exists so the repo genuinely
// requires a build before `start` (`serve -s dist`) can serve anything.
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { force: true, recursive: true });
await mkdir("dist", { recursive: true });
await cp("client", "dist", { recursive: true });
process.stdout.write("built client into dist/\n");
