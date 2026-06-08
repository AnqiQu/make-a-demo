import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DockerizedOpencodeServerCommandInput = {
  containerPort: number;
  hostPort: number;
  opencodeBinaryPath: string;
  opencodeHomeDirectory: string;
  workspaceDirectory: string;
};

export type DockerizedOpencodeServerCommand = {
  args: string[];
  executable: "docker";
};

export type DockerizedOpencodeServerOptions = {
  opencodeBinaryPath?: string;
  timeoutMs?: number;
  workspaceDirectory: string;
};

export type DockerizedOpencodeServer = {
  close(): Promise<void> | void;
  url: string;
};

const containerPort = 4096;

export function createDockerizedOpencodeServerCommand(
  input: DockerizedOpencodeServerCommandInput,
): DockerizedOpencodeServerCommand {
  const user = getHostUser();
  const envArgs = createModelProviderEnvArgs();

  return {
    executable: "docker",
    args: [
      "run",
      "--rm",
      "--init",
      "--name",
      `makeademo-opencode-${randomUUID()}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=4g",
      "--cpus=4",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=512m",
      "--env",
      "HOME=/tmp/opencode-home",
      "--env",
      `OPENCODE_CONFIG_CONTENT=${JSON.stringify(createOpencodeConfig())}`,
      ...envArgs,
      ...(user === undefined ? [] : ["--user", user]),
      "--publish",
      `127.0.0.1:${input.hostPort}:${input.containerPort}`,
      "--volume",
      `${input.opencodeBinaryPath}:/usr/local/bin/opencode:ro`,
      "--volume",
      `${input.opencodeHomeDirectory}:/tmp/opencode-home`,
      "--volume",
      `${input.workspaceDirectory}:/workspace`,
      "--workdir",
      "/workspace",
      "node:22-bookworm-slim",
      "opencode",
      "serve",
      "--hostname=0.0.0.0",
      `--port=${input.containerPort}`,
    ],
  };
}

export async function createDockerizedOpencodeServer(
  options: DockerizedOpencodeServerOptions,
): Promise<DockerizedOpencodeServer> {
  const hostPort = await findOpenPort();
  const opencodeBinaryPath =
    options.opencodeBinaryPath ?? (await resolveExecutablePath("opencode"));
  const opencodeHomeDirectory = await createTemporaryOpencodeHome();
  const command = createDockerizedOpencodeServerCommand({
    containerPort,
    hostPort,
    opencodeBinaryPath,
    opencodeHomeDirectory,
    workspaceDirectory: options.workspaceDirectory,
  });
  const child = spawn(command.executable, command.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${hostPort}`;

  await waitForOpencodeServer({
    child,
    timeoutMs: options.timeoutMs ?? 10_000,
  });

  return {
    async close() {
      child.kill("SIGTERM");
      await rm(opencodeHomeDirectory, { force: true, recursive: true });
    },
    url,
  };
}

async function createTemporaryOpencodeHome(): Promise<string> {
  const homeDirectory = await mkdtemp(
    join(tmpdir(), "makeademo-opencode-home-"),
  );
  const authDirectory = join(homeDirectory, ".local", "share", "opencode");
  await mkdir(authDirectory, { recursive: true });

  const hostAuthFile = join(
    process.env.HOME ?? "",
    ".local",
    "share",
    "opencode",
    "auth.json",
  );
  if (await fileExists(hostAuthFile)) {
    await copyFile(hostAuthFile, join(authDirectory, "auth.json"));
  }

  return homeDirectory;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createOpencodeConfig() {
  return {
    permission: {
      bash: "allow",
      doom_loop: "allow",
      edit: "allow",
      external_directory: "allow",
      question: "deny",
      webfetch: "allow",
    },
    tools: {
      question: false,
    },
  };
}

function createModelProviderEnvArgs(): string[] {
  const envNames = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
  ];

  return envNames.flatMap((name) =>
    process.env[name] === undefined ? [] : ["--env", name],
  );
}

function getHostUser(): string | undefined {
  if (process.getuid === undefined || process.getgid === undefined) {
    return undefined;
  }

  return `${process.getuid()}:${process.getgid()}`;
}

async function findOpenPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a host port for OpenCode.");
  }

  return address.port;
}

async function resolveExecutablePath(command: string): Promise<string> {
  const child = spawn("sh", ["-lc", `command -v ${command}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(
      `${command} must be installed on PATH to run Repo Preparation.`,
    );
  }

  return chunks.join("").trim();
}

async function waitForOpencodeServer(input: {
  child: ReturnType<typeof spawn>;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      input.child.kill("SIGTERM");
      reject(
        new Error(
          `Timeout waiting for Dockerized OpenCode server after ${input.timeoutMs}ms`,
        ),
      );
    }, input.timeoutMs);
    let output = "";
    let resolved = false;

    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolve();
    };

    input.child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("opencode server listening")) {
        finish();
      }
    });
    input.child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    input.child.on("exit", (code) => {
      if (resolved) {
        return;
      }
      clearTimeout(timeout);
      reject(
        new Error(`Dockerized OpenCode server exited with ${code}: ${output}`),
      );
    });
    input.child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
