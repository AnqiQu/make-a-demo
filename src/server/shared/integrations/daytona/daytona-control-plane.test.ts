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

  it("stops retrying hung attempts after the hang cap instead of burning the ladder", async () => {
    // N133 (2026-08-13 incident): fs.sync attempts hung the full 10-minute
    // per-attempt bound each, and the 8-attempt ladder legally consumed
    // ~80 minutes — most of the job's wall clock — inside one envelope.
    // A hung attempt carries no new information after the first repeat;
    // two exhaust the envelope even when ladder steps remain.
    const { envelope, events } = createRecordingEnvelope();
    let attempts = 0;

    const thrown: unknown = await envelope
      .run(
        "fs.sync",
        () => {
          attempts += 1;
          return new Promise<void>(() => {});
        },
        {
          attemptTimeoutMs: 10,
          ladderMs: [1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000],
        },
      )
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(attempts).toBe(2);
    expect(thrown).toBeInstanceOf(AgentHarnessControlPlaneError);
    expect(thrown).toMatchObject({ attempts: 2, classification: "transient" });
    expect(events.at(-1)?.entry.event).toBe("daytona.fs.sync.failed");
  });

  it("recreates a wedged target after two consecutive hangs and finishes inside the remaining ladder", async () => {
    const { envelope, events, waits } = createRecordingEnvelope();
    let attempts = 0;
    let recreations = 0;
    let sandboxId = "submitted_wedged";

    const result = await envelope.run(
      "fs.upload",
      () => {
        attempts += 1;
        return sandboxId === "submitted_wedged"
          ? new Promise<string>(() => {})
          : Promise.resolve("uploaded");
      },
      {
        attemptTimeoutMs: 10,
        ladderMs: [1_000, 2_000],
        onTargetWedged: async () => {
          recreations += 1;
          sandboxId = "submitted_replacement";
          return true;
        },
        sandboxId: () => sandboxId,
      },
    );

    expect(result).toBe("uploaded");
    expect(attempts).toBe(3);
    expect(recreations).toBe(1);
    expect(waits).toEqual([1_000, 2_000]);
    expect(
      events.find(
        (event) => event.entry.event === "daytona.fs.upload.target-wedged",
      )?.entry,
    ).toMatchObject({
      classification: "wedged-sandbox-target",
      sandboxId: "submitted_wedged",
    });
    expect(
      events
        .filter((event) => event.entry.event === "daytona.fs.upload.attempt")
        .at(-1)?.entry,
    ).toMatchObject({ sandboxId: "submitted_replacement" });
  });

  it("fails fast when a hang follows the target to its wedge-remedy replacement", async () => {
    // N161 (ghostfolio, 2026-08-20): fs.upload hung two full attempt
    // windows, the wedged sandbox was recreated, and the upload hung two
    // MORE full windows against the fresh sandbox before the ladder ran
    // out — ~40 minutes for one transfer. A hang that survives recreation
    // indicts the transfer or the control plane, not the target; the
    // strongest remedy is already spent, so another window buys nothing.
    const { envelope, events } = createRecordingEnvelope();
    let attempts = 0;
    let recreations = 0;
    let sandboxId = "submitted_wedged";

    const thrown: unknown = await envelope
      .run(
        "fs.upload",
        () => {
          attempts += 1;
          return new Promise<string>(() => {});
        },
        {
          attemptTimeoutMs: 10,
          ladderMs: [1_000, 1_000, 1_000, 1_000],
          onTargetWedged: () => {
            recreations += 1;
            sandboxId = "submitted_replacement";
            return true;
          },
          sandboxId: () => sandboxId,
          wrapExhausted: false,
        },
      )
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Two hangs prove the wedge, one against the replacement — never more.
    expect(attempts).toBe(3);
    expect(recreations).toBe(1);
    expect(String((thrown as Error | undefined)?.message)).toMatch(
      /recreation did not clear the hang/,
    );
    expect(events.at(-1)?.entry).toMatchObject({
      classification: "hung-after-recreation",
      event: "daytona.fs.upload.failed",
      sandboxId: "submitted_replacement",
    });
  });

  it("leases the transfer slot per attempt so retry waits run unleased", async () => {
    // N177 (cyberchef, wave-21): the whole retry arc ran inside one held
    // bulk-transfer lease, serializing four runs' setup behind a wedged
    // upload. The envelope may hold the slot only while an attempt runs.
    const sequence: string[] = [];
    const envelope = createDaytonaControlPlaneEnvelope({
      logger: {
        error: async () => {},
        info: async () => {},
        warn: async () => {},
      },
      random: () => 0.5,
      wait: async () => {
        sequence.push("ladder wait");
      },
    });
    let attempts = 0;

    const result = await envelope.run(
      "fs.upload",
      () => {
        attempts += 1;
        sequence.push(`attempt ${attempts}`);
        return attempts === 1
          ? Promise.reject(transient502())
          : Promise.resolve("uploaded");
      },
      {
        acquireTransferSlot: async () => {
          sequence.push("slot acquired");
          return () => {
            sequence.push("slot released");
          };
        },
        ladderMs: [1_000],
      },
    );

    expect(result).toBe("uploaded");
    expect(sequence).toEqual([
      "slot acquired",
      "attempt 1",
      "slot released",
      "ladder wait",
      "slot acquired",
      "attempt 2",
      "slot released",
    ]);
  });

  it("recreates a wedged target while the transfer slot is released", async () => {
    // The N161 recreate-and-retry arc especially must not run inside a
    // held lease: recreation is control-plane work, not uplink work.
    const sequence: string[] = [];
    const envelope = createDaytonaControlPlaneEnvelope({
      logger: {
        error: async () => {},
        info: async () => {},
        warn: async () => {},
      },
      random: () => 0.5,
      wait: async () => {
        sequence.push("ladder wait");
      },
    });
    let attempts = 0;
    let sandboxId = "submitted_wedged";

    const result = await envelope.run(
      "fs.upload",
      () => {
        attempts += 1;
        sequence.push(`attempt ${attempts}`);
        return sandboxId === "submitted_wedged"
          ? new Promise<string>(() => {})
          : Promise.resolve("uploaded");
      },
      {
        acquireTransferSlot: async () => {
          sequence.push("slot acquired");
          return () => {
            sequence.push("slot released");
          };
        },
        attemptTimeoutMs: 10,
        ladderMs: [1_000, 2_000],
        onTargetWedged: async () => {
          sequence.push("target recreated");
          sandboxId = "submitted_replacement";
          return true;
        },
        sandboxId: () => sandboxId,
      },
    );

    expect(result).toBe("uploaded");
    expect(sequence).toEqual([
      "slot acquired",
      "attempt 1",
      "slot released",
      "ladder wait",
      "slot acquired",
      "attempt 2",
      "slot released",
      "target recreated",
      "ladder wait",
      "slot acquired",
      "attempt 3",
      "slot released",
    ]);
  });

  it("does not combine hangs from different sandbox targets", async () => {
    const { envelope, waits } = createRecordingEnvelope();
    let attempts = 0;
    let recreations = 0;
    let sandboxId = "submitted_first";

    const result = await envelope.run(
      "fs.upload",
      () => {
        attempts += 1;
        return attempts <= 2
          ? new Promise<string>(() => {})
          : Promise.resolve("uploaded");
      },
      {
        attemptTimeoutMs: 10,
        ladderMs: [1_000, 2_000],
        onRetry: () => {
          if (attempts === 1) {
            sandboxId = "submitted_second";
          }
        },
        onTargetWedged: () => {
          recreations += 1;
          return true;
        },
        sandboxId: () => sandboxId,
      },
    );

    expect(result).toBe("uploaded");
    expect(attempts).toBe(3);
    expect(recreations).toBe(0);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("does not recreate a wedged target after the transient ladder budget is spent", async () => {
    const { envelope } = createRecordingEnvelope();
    let attempts = 0;
    let recreations = 0;

    await expect(
      envelope.run(
        "fs.upload",
        () => {
          attempts += 1;
          return new Promise<void>(() => {});
        },
        {
          attemptTimeoutMs: 10,
          ladderMs: [1_000],
          onTargetWedged: () => {
            recreations += 1;
            return true;
          },
          sandboxId: "submitted_wedged",
        },
      ),
    ).rejects.toBeInstanceOf(AgentHarnessControlPlaneError);

    expect(attempts).toBe(2);
    expect(recreations).toBe(0);
  });

  it("keeps the full ladder for fast-rejecting transients after a hung attempt", async () => {
    // The hang cap must not shorten the escalating ladder that fast 502
    // storms need (the 2026-08-12 lesson): only attempts abandoned by the
    // per-attempt bound count against it.
    const { envelope } = createRecordingEnvelope();
    let attempts = 0;

    const result = await envelope.run(
      "fs.sync",
      () => {
        attempts += 1;
        if (attempts === 1) {
          return new Promise<string>(() => {});
        }
        if (attempts < 5) {
          return Promise.reject(transient502());
        }
        return Promise.resolve("synced");
      },
      { attemptTimeoutMs: 10, ladderMs: [1_000, 1_000, 1_000, 1_000] },
    );

    expect(result).toBe("synced");
    expect(attempts).toBe(5);
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

  it("lets a caller-supplied classifier mark a domain outcome fatal so it passes through raw", async () => {
    // A command deadline is the command's result, not transport loss: the
    // default classifier reads any /Timeout/ name as transient, so without
    // the override the envelope would blindly re-issue a command whose
    // outcome the harness must instead surface (N123).
    const { envelope, waits } = createRecordingEnvelope();
    const deadline = Object.assign(
      new Error("Daytona command did not finish within 5ms."),
      { name: "AgentHarnessCommandTimeoutError" },
    );
    let attempts = 0;

    await expect(
      envelope.run(
        "process.execute",
        () => {
          attempts += 1;
          throw deadline;
        },
        {
          classify: (error) =>
            error === deadline
              ? "fatal"
              : classifyDaytonaControlPlaneError(error),
        },
      ),
    ).rejects.toBe(deadline);

    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
  });
});
