export type DemoServerHandle = {
  kill(): void;
};

export async function ensureDemoServer(
  baseUrl: string,
): Promise<DemoServerHandle | undefined> {
  if (await serverIsReachable(baseUrl)) {
    return undefined;
  }

  const server = Bun.spawn([process.execPath, "run", "demo"], {
    stderr: "pipe",
    stdout: "pipe",
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await serverIsReachable(baseUrl)) {
      return {
        kill() {
          server.kill();
        },
      };
    }
    await Bun.sleep(250);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(server.stdout).text(),
    new Response(server.stderr).text(),
  ]);

  server.kill();
  throw new Error(
    `Demo server did not start at ${baseUrl}.\n${stdout}\n${stderr}`.trim(),
  );
}

async function serverIsReachable(baseUrl: string) {
  try {
    const response = await fetch(baseUrl);
    return response.ok;
  } catch {
    return false;
  }
}
