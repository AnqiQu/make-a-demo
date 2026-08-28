const markerPrefixes = {
  action: "[makeademo:action] ",
  navigation: "[makeademo:navigation] ",
  network: "[makeademo:network-blocked] ",
  scene: "[makeademo:scene] ",
  step: "[makeademo:step] ",
  validation: "[makeademo:validation] script ",
  video: "[makeademo:video] ",
} as const;

const visibleAssertionLabels = new Set([
  "toBeInViewport",
  "toBeVisible",
  "toContainText",
  "toHaveCount",
  "toHaveText",
  "toHaveTitle",
  "toHaveURL",
]);

export type CaptureRuntimeOutput = {
  stderr: string;
  stdout: string;
};

type CaptureSceneMarker = {
  elapsedMs: number;
  event: "failed" | "started" | "succeeded";
  message?: string;
  sceneId: string;
};

type CaptureActionMarker = CaptureSceneMarker & {
  label: string;
  timeoutMs?: number;
};

type CaptureStepMarker = CaptureSceneMarker & {
  stepId: string;
};

export type CaptureValidationMarker = {
  event: "failed" | "started" | "succeeded";
  message?: string;
  screenshotPath?: string;
};

export type CaptureRuntimeProtocol = {
  actions: CaptureActionMarker[];
  blockedNetworkAttempts: Array<{
    direction: "outbound";
    hasCredentials?: boolean;
    host: string;
    method?: string;
    phase: "runtime";
    resourceType?: string;
    url?: string;
  }>;
  navigations: Array<{ status: number; url: string }>;
  scenes: CaptureSceneMarker[];
  steps: CaptureStepMarker[];
  runtimeEvents: Array<
    | ({ kind: "action" } & CaptureActionMarker)
    | ({ kind: "scene" } & CaptureSceneMarker)
    | ({ kind: "step" } & CaptureStepMarker)
  >;
  validation: CaptureValidationMarker[];
  /**
   * Recorded video files the capture wrapper named through its own page
   * handles, so collection can identify the continuous take when extra pages
   * (popups, previews) recorded their own videos.
   */
  videos: Array<{ path: string }>;
};

type OrderedRuntimeMarker =
  | ({ kind: "action"; sequence: number } & CaptureActionMarker)
  | ({ kind: "scene"; sequence: number } & CaptureSceneMarker)
  | ({ kind: "step"; sequence: number } & CaptureStepMarker);

/** Indicates malformed backend-owned Capture SDK output. */
export class CaptureRuntimeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureRuntimeProtocolError";
  }
}

/** Indicates that a generated script violated the declared capture protocol. */
export class CaptureScriptProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureScriptProtocolViolationError";
  }
}

/** Indicates a well-formed browser action that failed during execution. */
export class CaptureBrowserActionFailureError extends Error {
  readonly actionId: string | undefined;
  readonly label: string | undefined;
  readonly sceneId: string;

  constructor(input: {
    actionId?: string | undefined;
    label?: string | undefined;
    message?: string | undefined;
    sceneId: string;
  }) {
    super(
      `Browser action ${input.actionId ?? input.label ?? "unknown"} failed in Scene ${input.sceneId}.${input.message ? ` ${input.message}` : ""}`,
    );
    this.name = "CaptureBrowserActionFailureError";
    this.actionId = input.actionId;
    this.label = input.label;
    this.sceneId = input.sceneId;
  }
}

/**
 * Parses the backend-owned Capture SDK protocol from both process streams.
 * Marker consumers must not assume that a sandbox preserves console stream
 * routing.
 */
export function readCaptureRuntimeProtocol(
  output: CaptureRuntimeOutput,
): CaptureRuntimeProtocol {
  const orderedMarkers: OrderedRuntimeMarker[] = [];
  const blockedNetworkAttempts: CaptureRuntimeProtocol["blockedNetworkAttempts"] =
    [];
  const navigations: CaptureRuntimeProtocol["navigations"] = [];
  const validation: CaptureValidationMarker[] = [];
  const videos: CaptureRuntimeProtocol["videos"] = [];
  let sequence = 0;

  for (const stream of [output.stdout, output.stderr]) {
    for (const rawLine of stream.split("\n")) {
      const line = rawLine.trim();
      sequence += 1;
      if (line.startsWith(markerPrefixes.scene)) {
        orderedMarkers.push({
          ...readSceneMarker(line),
          kind: "scene",
          sequence,
        });
        continue;
      }
      if (line.startsWith(markerPrefixes.action)) {
        orderedMarkers.push({
          ...readActionMarker(line),
          kind: "action",
          sequence,
        });
        continue;
      }
      if (line.startsWith(markerPrefixes.step)) {
        orderedMarkers.push({
          ...readStepMarker(line),
          kind: "step",
          sequence,
        });
        continue;
      }
      if (line.startsWith(markerPrefixes.navigation)) {
        navigations.push(readNavigationMarker(line));
        continue;
      }
      if (line.startsWith(markerPrefixes.network)) {
        blockedNetworkAttempts.push(readNetworkMarker(line));
        continue;
      }
      if (line.startsWith(markerPrefixes.video)) {
        videos.push(readVideoMarker(line));
        continue;
      }
      if (line.startsWith(markerPrefixes.validation)) {
        validation.push(readValidationMarker(line));
      }
    }
  }

  orderedMarkers.sort(
    (left, right) =>
      left.elapsedMs - right.elapsedMs || left.sequence - right.sequence,
  );

  return {
    actions: orderedMarkers
      .filter(
        (marker): marker is Extract<OrderedRuntimeMarker, { kind: "action" }> =>
          marker.kind === "action",
      )
      .map(withoutOrderingMetadata),
    blockedNetworkAttempts,
    navigations,
    runtimeEvents: orderedMarkers.map((marker) => {
      const { kind, sequence: _sequence, ...value } = marker;
      return {
        ...value,
        kind,
      } as CaptureRuntimeProtocol["runtimeEvents"][number];
    }),
    scenes: orderedMarkers
      .filter(
        (marker): marker is Extract<OrderedRuntimeMarker, { kind: "scene" }> =>
          marker.kind === "scene",
      )
      .map(withoutOrderingMetadata),
    steps: orderedMarkers
      .filter(
        (marker): marker is Extract<OrderedRuntimeMarker, { kind: "step" }> =>
          marker.kind === "step",
      )
      .map(withoutOrderingMetadata),
    validation,
    videos,
  };
}

/**
 * Verifies a successful run against the exact declared browser Scene order and
 * returns the marker ranges used to trim captured footage.
 */
export function readSuccessfulCaptureProtocol(input: {
  expectedStepIdsByScene?: Readonly<Record<string, readonly string[]>>;
  protocol: CaptureRuntimeProtocol;
  requireValidationLifecycle?: boolean;
  requireVisibleAssertions?: boolean;
  sceneIds: string[];
}): {
  executedStepIdsByScene: Map<string, string[]>;
  sceneRanges: Map<string, { endedAtMs: number; startedAtMs: number }>;
} {
  assertUniqueSceneIds(input.sceneIds);

  const events = input.protocol.runtimeEvents;
  const declaredSceneIds = new Set(input.sceneIds);
  const ranges = new Map<string, { endedAtMs: number; startedAtMs: number }>();
  const scenesWithVisibleAssertions = new Set<string>();
  const executedStepIdsByScene = new Map<string, string[]>([
    ["setup", []],
    ...input.sceneIds.map((sceneId): [string, string[]] => [
      sceneId,
      [] as string[],
    ]),
  ]);
  let activeAction: { label: string; sceneId: string } | undefined;
  let activeScene: { sceneId: string; startedAtMs: number } | undefined;
  let activeStep: { sceneId: string; stepId: string } | undefined;
  const completedSteps = new Set<string>();
  let nextSceneIndex = 0;

  for (const marker of events) {
    if (marker.kind === "step") {
      if (marker.sceneId !== "setup" && !declaredSceneIds.has(marker.sceneId)) {
        throw violation(
          `Capture script emitted a step marker for undeclared Scene ${marker.sceneId}.`,
        );
      }
      if (
        marker.sceneId !== "setup" &&
        activeScene?.sceneId !== marker.sceneId
      ) {
        throw violation(
          `Step ${marker.stepId} was emitted outside Scene ${marker.sceneId} boundaries.`,
        );
      }
      if (marker.sceneId === "setup" && activeScene !== undefined) {
        throw violation(
          `Setup step ${marker.stepId} was emitted inside Scene ${activeScene.sceneId}.`,
        );
      }
      const stepKey = `${marker.sceneId}\u0000${marker.stepId}`;
      if (marker.event === "started") {
        if (activeStep !== undefined) {
          throw violation("Capture script emitted nested step markers.");
        }
        if (completedSteps.has(stepKey)) {
          throw violation(
            `Capture script emitted duplicate markers for step ${marker.stepId} in ${marker.sceneId}.`,
          );
        }
        activeStep = { sceneId: marker.sceneId, stepId: marker.stepId };
        continue;
      }
      if (
        activeStep?.sceneId !== marker.sceneId ||
        activeStep.stepId !== marker.stepId
      ) {
        throw violation(
          `Capture script emitted ${marker.event} marker before start for step ${marker.stepId} in ${marker.sceneId}.`,
        );
      }
      activeStep = undefined;
      if (marker.event === "failed") {
        throw new CaptureBrowserActionFailureError({
          actionId: marker.stepId,
          message: marker.message,
          sceneId: marker.sceneId,
        });
      }
      completedSteps.add(stepKey);
      executedStepIdsByScene.get(marker.sceneId)?.push(marker.stepId);
      continue;
    }

    if (marker.kind === "action") {
      const isSetupAction = marker.sceneId === "setup";
      // Dropping these would let a failed action hide behind a mistyped or
      // fabricated Scene id, exactly as step and Scene markers already refuse.
      if (!isSetupAction && !declaredSceneIds.has(marker.sceneId)) {
        throw violation(
          `Capture script emitted a Browser Action marker for undeclared Scene ${marker.sceneId}.`,
        );
      }
      if (
        (isSetupAction && activeScene !== undefined) ||
        (!isSetupAction && activeScene?.sceneId !== marker.sceneId)
      ) {
        throw violation(
          `Browser Action marker for Scene ${marker.sceneId} was emitted outside its Scene boundaries.`,
        );
      }
      if (marker.event === "started") {
        if (activeAction !== undefined) {
          throw violation(
            `Capture script emitted nested Browser Action markers: ${activeAction.label} was still open when ${marker.label} started.`,
          );
        }
        activeAction = { label: marker.label, sceneId: marker.sceneId };
        continue;
      }
      if (
        activeAction?.sceneId !== marker.sceneId ||
        activeAction.label !== marker.label
      ) {
        throw violation(
          `Capture script emitted ${marker.event} Browser Action marker before its start in Scene ${marker.sceneId}.`,
        );
      }
      activeAction = undefined;
      if (marker.event === "failed") {
        throw new CaptureBrowserActionFailureError({
          ...(activeStep === undefined ? {} : { actionId: activeStep.stepId }),
          label: marker.label,
          message: marker.message,
          sceneId: marker.sceneId,
        });
      }
      if (isVisibleAssertionLabel(marker.label)) {
        scenesWithVisibleAssertions.add(marker.sceneId);
      }
      continue;
    }

    if (!declaredSceneIds.has(marker.sceneId)) {
      throw violation(
        `Capture script emitted undeclared Scene marker ${marker.sceneId}.`,
      );
    }
    if (marker.event === "started") {
      if (activeScene !== undefined) {
        throw violation("Capture script emitted nested Scene markers.");
      }
      if (ranges.has(marker.sceneId)) {
        throw violation(
          `Capture script emitted duplicate markers for Scene ${marker.sceneId}.`,
        );
      }
      const expectedSceneId = input.sceneIds[nextSceneIndex];
      if (marker.sceneId !== expectedSceneId) {
        throw violation(
          `Capture script emitted Scene ${marker.sceneId} out of order; expected ${expectedSceneId ?? "no additional Scene"}.`,
        );
      }
      activeScene = {
        sceneId: marker.sceneId,
        startedAtMs: marker.elapsedMs,
      };
      continue;
    }

    if (activeScene?.sceneId !== marker.sceneId) {
      throw violation(
        `Capture script emitted ${marker.event} marker before start for Scene ${marker.sceneId}.`,
      );
    }
    if (activeAction !== undefined) {
      throw violation(
        `Scene ${marker.sceneId} ended before Browser Action ${activeAction.label} completed.`,
      );
    }
    if (activeStep !== undefined) {
      throw violation(
        `Scene ${marker.sceneId} ended before step ${activeStep.stepId} completed.`,
      );
    }
    const startedAtMs = activeScene.startedAtMs;
    activeScene = undefined;
    if (marker.event === "failed") {
      throw violation(
        `Scene ${marker.sceneId} failed.${marker.message ? ` ${marker.message}` : ""}`,
      );
    }
    ranges.set(marker.sceneId, {
      endedAtMs: marker.elapsedMs,
      startedAtMs,
    });
    nextSceneIndex += 1;
  }

  if (activeScene !== undefined) {
    throw violation(
      `Capture script emitted Scene start marker without an end marker for Scene ${activeScene.sceneId}.`,
    );
  }
  if (activeStep !== undefined) {
    throw violation(
      `Capture script emitted step start marker without an end marker for step ${activeStep.stepId}.`,
    );
  }
  if (input.requireValidationLifecycle !== false) {
    assertSuccessfulValidationLifecycle(input.protocol.validation);
  }
  for (const sceneId of input.sceneIds) {
    if (!ranges.has(sceneId)) {
      throw violation(`Scene ${sceneId} did not emit complete markers.`);
    }
    if (
      input.requireVisibleAssertions !== false &&
      !scenesWithVisibleAssertions.has(sceneId)
    ) {
      throw violation(
        `Scene ${sceneId} did not emit a successful visible Playwright assertion.`,
      );
    }
    const expectedStepIds = input.expectedStepIdsByScene?.[sceneId];
    if (expectedStepIds !== undefined) {
      const executedStepIds = executedStepIdsByScene.get(sceneId) ?? [];
      if (!sameStrings(executedStepIds, expectedStepIds)) {
        throw violation(
          `Scene ${sceneId} executed compiled steps ${formatStepIds(executedStepIds)}; expected ${formatStepIds(expectedStepIds)}.`,
        );
      }
    }
  }
  const expectedSetupStepIds = input.expectedStepIdsByScene?.setup;
  if (expectedSetupStepIds !== undefined) {
    const executedSetupStepIds = executedStepIdsByScene.get("setup") ?? [];
    if (!sameStrings(executedSetupStepIds, expectedSetupStepIds)) {
      throw violation(
        `Setup executed compiled steps ${formatStepIds(executedSetupStepIds)}; expected ${formatStepIds(expectedSetupStepIds)}.`,
      );
    }
  }

  return { executedStepIdsByScene, sceneRanges: ranges };
}

function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function formatStepIds(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

/** Serializes all normalized capture evidence for durable diagnostics. */
export function formatCaptureRuntimeProtocolLog(
  protocol: CaptureRuntimeProtocol,
): string {
  return [
    ...protocol.runtimeEvents.map((event) => JSON.stringify(event)),
    ...protocol.blockedNetworkAttempts.map((attempt) =>
      JSON.stringify({ ...attempt, kind: "network-blocked" }),
    ),
    ...protocol.validation.map((event) =>
      JSON.stringify({ ...event, kind: "validation" }),
    ),
    ...protocol.videos.map((video) =>
      JSON.stringify({ ...video, kind: "video" }),
    ),
  ]
    .map((line) => `${line}\n`)
    .join("");
}

export function readCaptureValidationFailure(
  protocol: CaptureRuntimeProtocol,
): CaptureValidationMarker | undefined {
  for (let index = protocol.validation.length - 1; index >= 0; index -= 1) {
    const marker = protocol.validation[index];
    if (marker?.event === "failed") {
      return marker;
    }
  }
  return undefined;
}

/**
 * Returns the first main-document navigation whose response came from the app's
 * own origin with a server-error (5xx) status. A server error on the app's own
 * route is a hard capture failure that no external-resource hydration or retry
 * can fix, so the caller treats it as a sticky verdict. Cross-origin responses
 * and sub-500 statuses are never app server errors and return undefined.
 */
export function readCaptureAppServerError(
  protocol: CaptureRuntimeProtocol,
  baseUrl: string,
): { status: number; url: string } | undefined {
  let appOrigin: string;
  try {
    appOrigin = new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
  return protocol.navigations.find((navigation) => {
    if (navigation.status < 500) {
      return false;
    }
    try {
      return new URL(navigation.url).origin === appOrigin;
    } catch {
      return false;
    }
  });
}

function readSceneMarker(line: string): CaptureSceneMarker {
  const value = readObjectPayload(line, markerPrefixes.scene, "Scene");
  return readLifecycleMarker(value, "Scene");
}

function readActionMarker(line: string): CaptureActionMarker {
  const value = readObjectPayload(
    line,
    markerPrefixes.action,
    "Browser Action",
  );
  const marker = readLifecycleMarker(value, "Browser Action");
  if (typeof value.label !== "string" || value.label.length === 0) {
    throw malformed("Browser Action marker must include a non-empty label.");
  }
  const timeoutMs = value.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))
  ) {
    throw malformed("Browser Action marker timeoutMs must be finite.");
  }
  return {
    ...marker,
    label: value.label,
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

function readStepMarker(line: string): CaptureStepMarker {
  const value = readObjectPayload(line, markerPrefixes.step, "step");
  const marker = readLifecycleMarker(value, "step");
  if (typeof value.stepId !== "string" || value.stepId.length === 0) {
    throw malformed("Step marker must include a non-empty stepId.");
  }
  return { ...marker, stepId: value.stepId };
}

function readLifecycleMarker(
  value: Record<string, unknown>,
  label: string,
): CaptureSceneMarker {
  if (
    typeof value.sceneId !== "string" ||
    value.sceneId.length === 0 ||
    typeof value.elapsedMs !== "number" ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    (value.event !== "started" &&
      value.event !== "succeeded" &&
      value.event !== "failed") ||
    (value.message !== undefined && typeof value.message !== "string")
  ) {
    throw malformed(`Malformed ${label} marker emitted by capture script.`);
  }
  return {
    elapsedMs: value.elapsedMs,
    event: value.event,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    sceneId: value.sceneId,
  };
}

function readNavigationMarker(
  line: string,
): CaptureRuntimeProtocol["navigations"][number] {
  const value = readObjectPayload(
    line,
    markerPrefixes.navigation,
    "navigation",
  );
  if (
    typeof value.status !== "number" ||
    !Number.isFinite(value.status) ||
    typeof value.url !== "string" ||
    value.url.length === 0
  ) {
    throw malformed("Malformed navigation marker emitted by capture script.");
  }
  return { status: value.status, url: value.url };
}

function readNetworkMarker(
  line: string,
): CaptureRuntimeProtocol["blockedNetworkAttempts"][number] {
  const value = readObjectPayload(line, markerPrefixes.network, "network");
  if (
    value.direction !== "outbound" ||
    typeof value.host !== "string" ||
    value.host.length === 0 ||
    value.phase !== "runtime" ||
    (value.hasCredentials !== undefined &&
      typeof value.hasCredentials !== "boolean") ||
    (value.method !== undefined &&
      (typeof value.method !== "string" || value.method.length === 0)) ||
    (value.resourceType !== undefined &&
      (typeof value.resourceType !== "string" ||
        value.resourceType.length === 0)) ||
    (value.url !== undefined &&
      (typeof value.url !== "string" || value.url.length === 0))
  ) {
    throw malformed(
      "Malformed blocked-network marker emitted by capture script.",
    );
  }
  return {
    direction: "outbound",
    ...(typeof value.hasCredentials === "boolean"
      ? { hasCredentials: value.hasCredentials }
      : {}),
    host: value.host,
    ...(typeof value.method === "string" ? { method: value.method } : {}),
    phase: "runtime",
    ...(typeof value.resourceType === "string"
      ? { resourceType: value.resourceType }
      : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  };
}

function readVideoMarker(
  line: string,
): CaptureRuntimeProtocol["videos"][number] {
  const value = readObjectPayload(line, markerPrefixes.video, "video");
  if (typeof value.path !== "string" || value.path.length === 0) {
    throw malformed("Malformed video marker emitted by capture script.");
  }
  return { path: value.path };
}

function readValidationMarker(line: string): CaptureValidationMarker {
  const suffix = line.slice(markerPrefixes.validation.length);
  const separatorIndex = suffix.indexOf(" ");
  if (separatorIndex < 0) {
    throw malformed("Malformed validation marker emitted by capture script.");
  }
  const event = suffix.slice(0, separatorIndex);
  if (event !== "started" && event !== "succeeded" && event !== "failed") {
    throw malformed(`Unknown validation marker event ${event}.`);
  }
  const value = readJsonObject(suffix.slice(separatorIndex + 1), "validation");
  if (
    (value.message !== undefined && typeof value.message !== "string") ||
    (value.screenshotPath !== undefined &&
      typeof value.screenshotPath !== "string")
  ) {
    throw malformed("Malformed validation marker emitted by capture script.");
  }
  return {
    event,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.screenshotPath === "string"
      ? { screenshotPath: value.screenshotPath }
      : {}),
  };
}

function assertUniqueSceneIds(sceneIds: string[]) {
  if (new Set(sceneIds).size !== sceneIds.length) {
    throw malformed("Declared browser Scene IDs must be unique.");
  }
}

function assertSuccessfulValidationLifecycle(
  markers: CaptureValidationMarker[],
) {
  const startedCount = markers.filter(
    (marker) => marker.event === "started",
  ).length;
  const succeededCount = markers.filter(
    (marker) => marker.event === "succeeded",
  ).length;
  const failedCount = markers.filter(
    (marker) => marker.event === "failed",
  ).length;
  if (startedCount !== 1 || succeededCount !== 1 || failedCount !== 0) {
    throw malformed(
      "A successful capture run must emit exactly one validation started marker and one validation succeeded marker.",
    );
  }
}

function isVisibleAssertionLabel(label: string) {
  const match = label.match(/^expect\.([A-Za-z0-9_]+)\(/);
  return match?.[1] !== undefined && visibleAssertionLabels.has(match[1]);
}

function readObjectPayload(
  line: string,
  prefix: string,
  label: string,
): Record<string, unknown> {
  return readJsonObject(line.slice(prefix.length), label);
}

function readJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw malformed(`Malformed ${label} marker emitted by capture script.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CaptureRuntimeProtocolError) {
      throw error;
    }
    throw malformed(
      `Malformed ${label} marker JSON emitted by capture script: ${value}`,
    );
  }
}

function withoutOrderingMetadata<T extends OrderedRuntimeMarker>(marker: T) {
  const { kind: _kind, sequence: _sequence, ...value } = marker;
  return value;
}

function malformed(message: string) {
  return new CaptureRuntimeProtocolError(message);
}

function violation(message: string) {
  return new CaptureScriptProtocolViolationError(message);
}
