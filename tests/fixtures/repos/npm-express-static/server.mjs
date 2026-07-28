// Optional API companion to the static client. The demo target is the client served
// from dist/; this server exists so the repo has the express+client shape.
import express from "express";

const app = express();

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.use(express.static("dist"));

const port = Number(process.env.PORT ?? 4501);
app.listen(port, () => {
  process.stdout.write(`trailhead api listening on ${port}\n`);
});
