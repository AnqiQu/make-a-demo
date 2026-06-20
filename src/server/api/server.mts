import { join, normalize } from "node:path";

import { createGitHubAppIntegrationFromEnv } from "../shared/integrations/github/github-app";
import { createR2UploadPresignerFromEnv } from "../shared/integrations/storage/r2-client";
import { createPipelineEventLogger } from "../shared/logging/pipeline-event-logger";
import { createNeonContextGatheringStore } from "../shared/persistence/neon-context-gathering-store";
import { createNeonDemoRequestFinalVideoStore } from "../shared/persistence/neon-demo-request-final-video-store";
import { type FrontendAssetReader, createApiApp } from "./app";

const logger = createPipelineEventLogger({
  base: { component: "api" },
  sinks: [{ write: (line) => void process.stdout.write(line) }],
});
const app = createApiApp({
  demoRequests: createNeonDemoRequestFinalVideoStore(),
  frontend: createFileSystemFrontendAssetReader("dist"),
  github: createGitHubAppIntegrationFromEnv(),
  logger,
  store: createNeonContextGatheringStore(),
  uploads: createR2UploadPresignerFromEnv(),
});

const port = Number.parseInt(
  process.env.PORT ?? process.env.API_PORT ?? "8787",
  10,
);

Bun.serve({
  fetch: (request) => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    return app.fetch(request);
  },
  port,
});

await logger.info(
  {
    event: "api.server.started",
    port,
    url: `http://localhost:${port}`,
  },
  "Owlet API listening.",
);

function createFileSystemFrontendAssetReader(
  root: string,
): FrontendAssetReader {
  return {
    async readAsset(pathname) {
      if (pathname.includes("\0")) {
        return null;
      }

      const requestedPath = pathname === "/" ? "/index.html" : pathname;
      const relativePath = normalize(requestedPath).replace(/^\.?(\/)*/, "");
      if (relativePath.startsWith("..")) {
        return null;
      }

      const filePath = join(root, relativePath);
      const file = Bun.file(filePath);

      if (await file.exists()) {
        return new Response(file);
      }

      const fallback = Bun.file(join(root, "index.html"));
      if (await fallback.exists()) {
        return new Response(fallback, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return null;
    },
  };
}
