import { createGitHubAppIntegrationFromEnv } from "../shared/integrations/github/github-app";
import { createR2UploadPresignerFromEnv } from "../shared/integrations/storage/r2-client";
import { createNeonContextGatheringStore } from "../shared/persistence/neon-context-gathering-store";
import { createNeonDemoRequestFinalVideoStore } from "../shared/persistence/neon-demo-request-final-video-store";
import { createApiApp } from "./app";

const app = createApiApp({
  demoRequests: createNeonDemoRequestFinalVideoStore(),
  github: createGitHubAppIntegrationFromEnv(),
  store: createNeonContextGatheringStore(),
  uploads: createR2UploadPresignerFromEnv(),
});

const port = Number.parseInt(process.env.API_PORT ?? "8787", 10);

Bun.serve({
  fetch: (request) => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    return app.fetch(request);
  },
  port,
});

process.stdout.write(`Owlet API listening on http://localhost:${port}\n`);
