import { describe, expect, it } from "vitest";
import {
  AgentHarnessControlPlaneError,
  isAgentHarnessInfrastructureError,
} from "../../../agent-harness/daytona/workspace.interface";
import {
  classifyDaytonaControlPlaneError,
  createDaytonaControlPlaneEnvelope,
} from "./daytona-control-plane";

type RecordedEvent = {
  entry: Record<string, unknown>;
  level: "error" | "info" | "warn";
};

function createRecordingEnvelope(options: { random?: () => number } = {}) {
  const events: RecordedEvent[] = [];
  const waits: number[] = [];
  const envelope = createDaytonaControlPlaneEnvelope({
    logger: {
      error: async (entry) => {
        events.push({ entry, level: "error" });
      },
      info: async (entry) => {
        events.push({ entry, level: "info" });
      },
      warn: async (entry) => {
        events.push({ entry, level: "warn" });
      },
    },
    random: options.random ?? (() => 0.5),
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
  });
  return { envelope, events, waits };
}

function conflict409(): Error {
  return Object.assign(
    new Error("An operation is already in progress for this resource"),
    { statusCode: 409 },
  );
}

function transient502(): Error {
  return Object.assign(new Error("Request failed with status code 502"), {
    statusCode: 502,
  });
}

describe("classifyDaytonaControlPlaneError", () => {
  it("classifies the conflict class by status, code, and message shapes", () => {
    expect(classifyDaytonaControlPlaneError(conflict409())).toBe("conflict");
    expect(
      classifyDaytonaControlPlaneError(
        Object.assign(new Error("nope"), { errorCode: "Conflict" }),
      ),
    ).toBe("conflict");
    expect(
      classifyDaytonaControlPlaneError(
        new Error("sandbox state change in progress"),
      ),
    ).toBe("conflict");
    expect(
      classifyDaytonaControlPlaneError(new Error("sandbox state is changing")),
    ).toBe("conflict");
  });

  it("classifies 5xx and connection-transport failures as transient", () => {
    expect(classifyDaytonaControlPlaneError(transient502())).toBe("transient");
    expect(classifyDaytonaControlPlaneError(new Error("read ECONNRESET"))).toBe(
      "transient",
    );
    expect(
      classifyDaytonaControlPlaneError(
        Object.assign(new Error("connect failed"), {
          name: "DaytonaConnectionError",
        }),
      ),
    ).toBe("transient");
    expect(
      classifyDaytonaControlPlaneError(
        new Error("Request failed with status code 503"),
      ),
    ).toBe("transient");
  });

  it("leaves everything else fatal so call-site matchers keep their errors raw", () => {
    expect(
      classifyDaytonaControlPlaneError(
        Object.assign(new Error("bad request"), { statusCode: 400 }),
      ),
    ).toBe("fatal");
    expect(
      classifyDaytonaControlPlaneError(
        new Error(
          "Network access is restricted and cannot be overridden at the sandbox level",
        ),
      ),
    ).toBe("fatal");
    expect(classifyDaytonaControlPlaneError(new Error("boom"))).toBe("fatal");
  });
});

describe("createDaytonaControlPlaneEnvelope", () => {
  it("retries a transient failure up the ladder and returns the eventual result", async () => {
    const { envelope, events, waits } = createRecordingEnvelope();
    let attempts = 0;

    const result = await envelope.run(
      "sandbox.create",
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw transient502();
        }
        return "sandbox-ready";
      },
      { ladderMs: [1_000, 4_000, 10_000] },
    );

    expect(result).toBe("sandbox-ready");
    expect(attempts).toBe(3);
    // random 0.5 centers the jitter, so delays are the ladder verbatim.
    expect(waits).toEqual([1_000, 4_000]);
    expect(events.map((event) => [event.level, event.entry.event])).toEqual([
      ["info", "daytona.sandbox.create.attempt"],
      ["warn", "daytona.sandbox.create.retrying"],
      ["info", "daytona.sandbox.create.attempt"],
      ["warn", "daytona.sandbox.create.retrying"],
      ["info", "daytona.sandbox.create.attempt"],
    ]);
  });

  it("waits and polls patiently through the conflict class instead of dying on it", async () => {
    // An in-progress operation means wait for it: midday's run died on the
    // first unclassified 409 from a network toggle (2026-08-09).
    const { envelope, events, waits } = createRecordingEnvelope();
    let attempts = 0;

    await envelope.run(
      "sandbox.network-update",
      async () => {
        attempts += 1;
        if (attempts < 4) {
          throw conflict409();
        }
      },
      { sandboxId: "sandbox_123" },
    );

    expect(attempts).toBe(4);
    expect(waits).toEqual([5_000, 5_000, 5_000]);
    const retrying = events.filter(
      (event) =>
        event.entry.event === "daytona.sandbox.network-update.retrying",
    );
    expect(retrying).toHaveLength(3);
    expect(retrying[0]?.entry).toMatchObject({
      classification: "conflict",
      sandboxId: "sandbox_123",
    });
  });

  it("jitters retry delays around the base so herds spread instead of resynchronizing", async () => {
    const { envelope, waits } = createRecordingEnvelope({ random: () => 0 });
    let attempts = 0;

    await envelope.run(
      "sandbox.create",
      async () => {
        attempts += 1;
        if (attempts < 2) {
          throw transient502();
        }
      },
      { ladderMs: [8_000] },
    );

    // random 0 sits at the bottom of the ±25% jitter window.
    expect(waits).toEqual([6_000]);
  });

  it("rethrows fatal errors raw on the first attempt so call-site matchers still fire", async () => {
    const { envelope, events } = createRecordingEnvelope();
    const policyError = new Error(
      "Network access is restricted and cannot be overridden at the sandbox level",
    );
    let attempts = 0;

    await expect(
      envelope.run("sandbox.network-update", async () => {
        attempts += 1;
        throw policyError;
      }),
    ).rejects.toBe(policyError);

    expect(attempts).toBe(1);
    expect(events.at(-1)?.entry).toMatchObject({
      classification: "fatal",
      event: "daytona.sandbox.network-update.failed",
    });
  });

  it("wraps exhausted retryable failures as infrastructure with the seam attributed", async () => {
    const { envelope, events } = createRecordingEnvelope();

    const thrown: unknown = await envelope
      .run(
        "sandbox.create",
        async () => {
          throw transient502();
        },
        { ladderMs: [10, 20], sandboxId: "sandbox_123" },
      )
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AgentHarnessControlPlaneError);
    expect(isAgentHarnessInfrastructureError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      attempts: 3,
      classification: "transient",
      operation: "sandbox.create",
      sandboxId: "sandbox_123",
    });
    expect(events.at(-1)?.entry).toMatchObject({
      attempt: 3,
      event: "daytona.sandbox.create.failed",
    });
  });

  it("bounds the conflict polling and wraps the exhausted conflict as infrastructure", async () => {
    const { envelope, waits } = createRecordingEnvelope();

    const thrown: unknown = await envelope
      .run(
        "sandbox.delete",
        async () => {
          throw conflict409();
        },
        { conflictPollLimit: 2 },
      )
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(waits).toEqual([5_000, 5_000]);
    expect(thrown).toBeInstanceOf(AgentHarnessControlPlaneError);
    expect(thrown).toMatchObject({
      attempts: 3,
      classification: "conflict",
    });
  });

  it("rethrows the raw error on exhaustion for seams that carry their own infrastructure wrapping", async () => {
    const { envelope } = createRecordingEnvelope();
    const raw = transient502();

    await expect(
      envelope.run(
        "fs.upload",
        async () => {
          throw raw;
        },
        { ladderMs: [10], wrapExhausted: false },
      ),
    ).rejects.toBe(raw);
  });

  it("invokes the caller's retry hook with the failure and the chosen delay", async () => {
    const { envelope } = createRecordingEnvelope();
    const observed: Array<{ delayMs: number; error: unknown }> = [];
    let attempts = 0;

    await envelope.run(
      "fs.download",
      async () => {
        attempts += 1;
        if (attempts < 2) {
          throw transient502();
        }
      },
      {
        ladderMs: [2_000],
        onRetry: (error, delayMs) => {
          observed.push({ delayMs, error });
        },
      },
    );

    expect(observed).toHaveLength(1);
    expect(observed[0]?.delayMs).toBe(2_000);
    expect(observed[0]?.error).toBeInstanceOf(Error);
  });

  it("converts a hung attempt into a transient retry instead of awaiting it forever", async () => {
    const { envelope, events } = createRecordingEnvelope();
    let attempts = 0;

    const result = await envelope.run(
      "sandbox.delete",
      () => {
        attempts += 1;
        if (attempts === 1) {
          // Neither resolves nor rejects: the hung-HTTP-call shape that
          // wedged the 2026-08-11 batch for 40 minutes.
          return new Promise<string>(() => {});
        }
        return Promise.resolve("deleted");
      },
      { attemptTimeoutMs: 20, ladderMs: [1_000] },
    );

    expect(result).toBe("deleted");
    expect(attempts).toBe(2);
    const retrying = events.find(
      (event) => event.entry.event === "daytona.sandbox.delete.retrying",
    );
    expect(retrying?.entry.classification).toBe("transient");
    expect(String(retrying?.entry.error)).toContain("20ms");
  });

  it("fails a persistently hung operation through the ladder instead of wedging the run", async () => {
    const { envelope, events } = createRecordingEnvelope();
    let attempts = 0;

    await expect(
      envelope.run(
        "sandbox.delete",
        () => {
          attempts += 1;
          return new Promise<void>(() => {});
        },
        { attemptTimeoutMs: 10, ladderMs: [1_000] },
      ),
    ).rejects.toBeInstanceOf(AgentHarnessControlPlaneError);

    expect(attempts).toBe(2);
    expect(events.at(-1)?.entry.event).toBe("daytona.sandbox.delete.failed");
    expect(events.at(-1)?.entry.classification).toBe("transient");
  });

  it("ignores a timed-out attempt's late settlement without an unhandled rejection", async () => {
    const { envelope } = createRecordingEnvelope();
    let attempts = 0;

    const result = await envelope.run(
      "sandbox.network-update",
      () => {
        attempts += 1;
        if (attempts === 1) {
          return new Promise<string>((_resolve, reject) => {
            setTimeout(() => reject(new Error("late transport failure")), 40);
          });
        }
        return Promise.resolve("updated");
      },
      { attemptTimeoutMs: 10, ladderMs: [1_000] },
    );

    expect(result).toBe("updated");
    // Let the abandoned attempt reject; vitest fails the test run if that
    // rejection surfaces as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("runs an attempt unbounded when the caller disables the attempt timeout", async () => {
    const { envelope } = createRecordingEnvelope();

    const result = await envelope.run(
      "fs.upload",
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("uploaded"), 30);
        }),
      { attemptTimeoutMs: Number.POSITIVE_INFINITY },
    );

    expect(result).toBe("uploaded");
  });
});
