import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGitCloneCommand } from "./git-clone-command";

describe("createGitCloneCommand", () => {
  it("prefers readable absolute CA env paths before hardcoded CA bundles", () => {
    const command = createGitCloneCommand({
      destinationPath: "/workspace/submitted code",
      repoUrl: "https://github.com/example/app",
      resetCommand: "rm -rf '/workspace/submitted code'",
    });

    expect(command.indexOf("GIT_SSL_CAINFO")).toBeLessThan(
      command.indexOf("/etc/daytona/netleash/ca.crt"),
    );
    expect(command.indexOf("SSL_CERT_FILE")).toBeLessThan(
      command.indexOf("/etc/daytona/netleash/ca.crt"),
    );
    expect(command.indexOf("CURL_CA_BUNDLE")).toBeLessThan(
      command.indexOf("/etc/daytona/netleash/ca.crt"),
    );
    expect(command.indexOf("REQUESTS_CA_BUNDLE")).toBeLessThan(
      command.indexOf("/etc/daytona/netleash/ca.crt"),
    );
    expect(command).toContain("test -r");
    expect(command).toMatch(/case .* in \/\*/s);
    expect(command).toMatch(/export GIT_SSL_CAINFO="\$makeademo_ca_bundle"/);
    expect(command).toMatch(/export SSL_CERT_FILE="\$makeademo_ca_bundle"/);
    expect(command).toMatch(/export CURL_CA_BUNDLE="\$makeademo_ca_bundle"/);
  });

  it("discovers CA bundle env values by name with POSIX shell indirection", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "makeademo-git-clone-command-"));
    const fakeGitPath = join(tempDir, "git");
    const caBundlePath = join(tempDir, "ca.crt");
    const selectedCaPath = join(tempDir, "selected-ca.txt");
    writeFileSync(caBundlePath, "test certificate");
    writeFileSync(
      fakeGitPath,
      `#!/bin/sh
printf '%s' "$GIT_SSL_CAINFO" > "$FAKE_GIT_SELECTED_CA_PATH"
`,
    );
    chmodSync(fakeGitPath, 0o755);

    const command = createGitCloneCommand({
      destinationPath: join(tempDir, "submitted code"),
      repoUrl: "https://github.com/example/app",
      resetCommand: ":",
    });

    expect(command).not.toContain("${$makeademo_ca_env_name-}");

    execFileSync("/bin/sh", ["-c", command], {
      env: {
        ...process.env,
        CURL_CA_BUNDLE: "relative-ca.crt",
        FAKE_GIT_SELECTED_CA_PATH: selectedCaPath,
        GIT_SSL_CAINFO: "relative-ca.crt",
        PATH: tempDir,
        SSL_CERT_FILE: caBundlePath,
      },
    });

    expect(readFileSync(selectedCaPath, "utf8")).toBe(caBundlePath);
  });

  it("prefers Daytona netleash and OpenShell TLS bundles before system CA bundles", () => {
    const command = createGitCloneCommand({
      destinationPath: "/workspace/submitted code",
      repoUrl: "https://github.com/example/app",
      resetCommand: "rm -rf '/workspace/submitted code'",
    });

    expect(command.indexOf("/etc/daytona/netleash/ca.crt")).toBeLessThan(
      command.indexOf("/etc/openshell-tls/ca-bundle.pem"),
    );
    expect(command.indexOf("/etc/daytona/netleash/ca.crt")).toBeLessThan(
      command.indexOf("/etc/ssl/certs/ca-certificates.crt"),
    );
    expect(command.indexOf("/etc/openshell-tls/ca-bundle.pem")).toBeLessThan(
      command.indexOf("/etc/pki/tls/certs/ca-bundle.crt"),
    );
    expect(command).toMatch(/export GIT_SSL_CAINFO=.*git clone/s);
    expect(command).not.toContain("GIT_SSL_NO_VERIFY");
    expect(command).not.toContain("sslVerify=false");
  });
});
