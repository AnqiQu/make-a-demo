import {
  readKilledCommandBuildSummary,
  readPlaintextServiceSslHint,
} from "./migration-failure-evidence";

describe("readPlaintextServiceSslHint", () => {
  // N168 (outline, wave-18): the app defaulted into its production config
  // because no .env existed, negotiated SSL against the plaintext sandbox
  // postgres, and rounds re-ran the migration unchanged.
  it("names the plaintext-by-design service and every SSL knob for the node-postgres refusal", () => {
    const hint = readPlaintextServiceSslHint({
      output:
        "error: The server does not support SSL connections\n    at Socket.<anonymous> (node_modules/pg/lib/connection.js:76:37)",
      service: "postgres",
    });

    expect(hint).toContain("plaintext by design");
    expect(hint).toContain("sslmode=disable");
    expect(hint).toContain("PGSSLMODE");
    expect(hint).toContain("environment selection");
  });

  it("recognizes the libpq required-SSL variant", () => {
    const hint = readPlaintextServiceSslHint({
      output:
        'psql: error: connection to server at "127.0.0.1", port 5432 failed: server does not support SSL, but SSL was required',
      service: "postgres",
    });

    expect(hint).toContain("sslmode=disable");
  });

  it("recognizes the lib/pq ssl-not-enabled variant", () => {
    const hint = readPlaintextServiceSslHint({
      output: "pq: SSL is not enabled on the server",
      service: "postgres",
    });

    expect(hint).toContain("sslmode=disable");
  });

  it("stays silent for non-postgres services", () => {
    expect(
      readPlaintextServiceSslHint({
        output: "The server does not support SSL connections",
        service: "mysql",
      }),
    ).toBeUndefined();
  });

  it("stays silent for unrelated postgres failures", () => {
    expect(
      readPlaintextServiceSslHint({
        output: 'error: relation "users" does not exist',
        service: "postgres",
      }),
    ).toBeUndefined();
  });
});

describe("readKilledCommandBuildSummary", () => {
  // N169 (twenty, wave-18): database:init built the entire frontend — vite
  // transformed 837 modules — before touching the database, and died at the
  // memory ceiling with only a heap-knob hint.
  it("summarizes the vite build the killed command ran before dying", () => {
    const summary = readKilledCommandBuildSummary(
      "vite v5.4.2 building for production...\n✓ 837 modules transformed.\nKilled",
    );

    expect(summary).toContain("vite transformed 837 modules");
    expect(summary).toContain("narrowest target");
  });

  it("names the nx targets the killed command built", () => {
    const summary = readKilledCommandBuildSummary(
      "> nx run twenty-shared:build\n> nx run twenty-front:build\nKilled",
    );

    expect(summary).toContain("twenty-shared:build");
    expect(summary).toContain("twenty-front:build");
    expect(summary).toContain("narrowest target");
  });

  it("names the turbo package fan-out the killed command ran", () => {
    const summary = readKilledCommandBuildSummary(
      "• Packages in scope: api, web, worker\n• Running build in 3 packages\nKilled",
    );

    expect(summary).toContain("turbo ran build in 3 packages");
  });

  it("stays silent when the killed output shows no workspace-graph build", () => {
    expect(
      readKilledCommandBuildSummary(
        "Applying migration 0042_add_projects\nKilled",
      ),
    ).toBeUndefined();
  });
});
