// The submitted-code image is Ubuntu noble with OpenSSL 3, which is the only
// platform prisma's downloads can target inside the sandbox.
const prismaEnginePlatform = "debian-openssl-3.0.x";

// Engine artifacts prisma's suppressed postinstall would have downloaded:
// the query-engine library the runtime loads and the schema engine that
// migrate/db-push style demo seeding shells out to.
const prismaEngineArtifacts = [
  {
    remote: "libquery_engine.so.node.gz",
    target: `libquery_engine-${prismaEnginePlatform}.so.node`,
  },
  {
    remote: "schema-engine.gz",
    target: `schema-engine-${prismaEnginePlatform}`,
  },
] as const;

/**
 * Builds the shell command that warms every installed `@prisma/engines`
 * package with its pinned engine binaries while the dependency-install
 * network window is still open (N72b). Lifecycle scripts stay suppressed —
 * the backend derives each package's engine commit from the installed
 * `@prisma/engines-version` and downloads the artifacts itself, so no
 * third-party install code runs with the network open. The command is
 * best-effort by construction: engines are written atomically (tmp + mv),
 * every failure path cleans up and continues, and the overall command always
 * exits 0 so a prefetch stumble can never fail an install that succeeded.
 */
export function createPrismaEnginePrefetchCommand(): string {
  const resolveCommit =
    'node -e \'const m=require(require.resolve("@prisma/engines-version/package.json",{paths:[process.argv[1]]})).version.match(/[0-9a-f]{40}/);if(m)console.log(m[0]);\' "$dir" 2>/dev/null';
  const fetchArtifact = (artifact: (typeof prismaEngineArtifacts)[number]) =>
    [
      `target="$dir/${artifact.target}";`,
      `if [ ! -f "$target" ]; then`,
      `curl -fsSL "$base/${artifact.remote}" | gunzip > "$target.tmp"`,
      `&& mv "$target.tmp" "$target" && chmod +x "$target"`,
      `&& echo "makeademo: prefetched ${artifact.target} for $commit"`,
      `|| rm -f "$target.tmp"; fi;`,
    ].join(" ");
  return [
    "for dir in $(find /workspace/repo -type d -path '*/node_modules/@prisma/engines' -not -path '*/@prisma/engines/*' 2>/dev/null); do",
    `commit="$(${resolveCommit})";`,
    '[ -n "$commit" ] || continue;',
    `base="https://binaries.prisma.sh/all_commits/$commit/${prismaEnginePlatform}";`,
    ...prismaEngineArtifacts.map(fetchArtifact),
    "done;",
    "true",
  ].join(" ");
}
