import { describe, expect, it } from "vitest";
import { screenStaticRepoSecurity } from "./static-repo-security";

describe("screenStaticRepoSecurity", () => {
  it("rejects missing package metadata, committed secrets, private keys, and destructive scripts", () => {
    expect(
      screenStaticRepoSecurity({
        files: [
          { path: ".env", text: "OPENAI_API_KEY=sk-test" },
          { path: "id_rsa", text: "-----BEGIN OPENSSH PRIVATE KEY-----" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
      }),
    ).toMatchObject({
      status: "rejected",
      rejections: expect.arrayContaining([
        "package.json is required for JavaScript/TypeScript repos",
        "repo contains committed secret file .env",
        "repo contains private key material in id_rsa",
      ]),
    });

    expect(
      screenStaticRepoSecurity({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({ scripts: { clean: "rm -rf /" } }),
          },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
      }),
    ).toMatchObject({
      status: "rejected",
      rejections: ["package script clean contains a destructive command"],
    });
  });

  it("warns about dependency and runtime risks without executing submitted code", () => {
    const result = screenStaticRepoSecurity({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: { "@auth/core": "latest", stripe: "latest" },
            scripts: { postinstall: "node setup.js" },
          }),
        },
        { path: "Dockerfile", text: "FROM node\nRUN sudo apt update\n" },
        { path: "pnpm-lock.yaml", text: "" },
      ],
      repoStats: { fileCount: 3, sizeBytes: 300 },
    });

    expect(result.status).toBe("passed");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "package script postinstall may run setup code during dependency installation",
        "auth package @auth/core may require local demo bypass or mocks",
        "external service package stripe may require local mocks",
        "Dockerfile requests privileged operations",
      ]),
    );
  });

  it("rejects common private-key container extensions even when contents are binary", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
        { path: "certs/client.pem" },
        { path: "certs/client.key" },
        { path: "certs/signing.p12" },
        { path: "certs/signing.pfx" },
      ],
      repoStats: { fileCount: 6, sizeBytes: 1_024 },
    });

    expect(result.rejections).toEqual(
      expect.arrayContaining([
        "repo contains private key material in certs/client.pem",
        "repo contains private key material in certs/client.key",
        "repo contains private key material in certs/signing.p12",
        "repo contains private key material in certs/signing.pfx",
      ]),
    );
  });
});
