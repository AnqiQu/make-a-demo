// Stands in for hook installers like husky: a root `prepare` script that must run
// during install for the fixture to mirror real-world repos, but whose absence must
// not break the app (script suppression during the install window is expected).
import { writeFile } from "node:fs/promises";

await writeFile(
  new URL("../.prepare-marker", import.meta.url),
  `prepared at install time\n`,
);
