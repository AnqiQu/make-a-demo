import {
  type BrowserAction,
  compileBrowserActionPlan,
  readBrowserActions,
} from "./browser-action-plan";

type SceneBase = {
  id: string;
  humanReadableDescription?: string;
};

export type PlaywrightRecordingSceneDescription = SceneBase & {
  actions?: BrowserAction[];
  expectedVisibleOutcome: string;
  featureId?: string;
  type: "playwright-recording";
};

type FullScreenTextSceneDescription = SceneBase & {
  backgroundColor: string;
  durationSeconds: number;
  text: DemoScriptTextStyle;
  type: "full-screen-text";
};

type StaticImageSceneDescription = SceneBase & {
  alt: string;
  assetId: string;
  durationSeconds: number;
  type: "static-image";
};

type SceneDescription =
  | FullScreenTextSceneDescription
  | PlaywrightRecordingSceneDescription
  | StaticImageSceneDescription;

export type DemoScript = {
  demoPlaywrightScript?: string;
  format: "16:9";
  presentation: DemoScriptPresentation;
  scenes: SceneDescription[];
  scriptId: string;
  setupActions?: BrowserAction[];
  title: string;
  version: number;
};

type DemoScriptPresentation = {
  music: DemoScriptMusicIntent;
  textOverlays: DemoScriptTextOverlay[];
  transitions: DemoScriptTransition[];
};

type DemoScriptMusicIntent =
  | { enabled: false }
  | { enabled: true; trackId: ApprovedMusicTrackId };

type DemoScriptTextOverlay = {
  content: string;
  font: ApprovedFontFamily;
  position: "bottom-left" | "center" | "top-left";
  sceneId: string;
  size: "large" | "medium" | "small";
};

type DemoScriptTextStyle = {
  color: string;
  content: string;
  font: ApprovedFontFamily;
  position: "bottom-left" | "center" | "top-left";
  size: "large" | "medium" | "small";
};

type DemoScriptTransition =
  | {
      fromSceneId: string;
      style: "cut";
      toSceneId: string;
    }
  | {
      durationSeconds: number;
      fromSceneId: string;
      style: "fade";
      toSceneId: string;
    };

type ApprovedFontFamily = (typeof approvedFontFamilies)[number];
type ApprovedMusicTrackId = (typeof approvedMusicTrackIds)[number];

export const approvedFontFamilies = [
  "Bricolage Grotesque",
  "Fraunces",
  "IBM Plex Sans",
  "Inter",
  "JetBrains Mono",
  "Nunito",
  "Playfair Display",
  "Space Grotesk",
] as const;

export const approvedMusicTrackIds = [
  "clean",
  "focus",
  "pulse",
  "upbeat",
  "vision",
] as const;

export const demoScriptLimits = {
  maxActionsPerCollection: 50,
  maxFadeDurationSeconds: 3,
  maxScenes: 20,
  maxSyntheticSceneDurationSeconds: 30,
  maxTextOverlays: 40,
  maxTotalDurationSeconds: 180,
  maxTransitions: 19,
  minFadeDurationSeconds: 0.1,
  minSyntheticSceneDurationSeconds: 0.5,
} as const;

export function parseDemoScript(value: unknown): DemoScript {
  const scriptRecord = assertRecord(value, "Demo Script");
  assertOnlyKeys(
    scriptRecord,
    [
      "demoPlaywrightScript",
      "format",
      "presentation",
      "scenes",
      "scriptId",
      "setupActions",
      "title",
      "version",
    ],
    "Demo Script",
  );
  const scenes = readScenes(scriptRecord);
  const sceneIds = scenes.map((scene) => scene.id);
  const browserScenes = scenes.filter(
    (scene): scene is PlaywrightRecordingSceneDescription =>
      scene.type === "playwright-recording",
  );
  const setupActions =
    scriptRecord.setupActions === undefined
      ? undefined
      : readBoundedBrowserActions(scriptRecord.setupActions, "setupActions");
  if (setupActions !== undefined && browserScenes.length === 0) {
    throw new Error(
      "setupActions are only allowed when the Demo Script has a playwright-recording Scene",
    );
  }

  const demoScript: DemoScript = {
    format: readFormat(scriptRecord),
    presentation: readPresentation(scriptRecord, sceneIds),
    scenes,
    scriptId: readSafeIdentifier(scriptRecord, "scriptId", "Demo Script"),
    ...(setupActions === undefined ? {} : { setupActions }),
    title: readNonEmptyString(scriptRecord, "title"),
    version: readDemoScriptVersion(scriptRecord),
  };

  if (scriptRecord.demoPlaywrightScript !== undefined) {
    demoScript.demoPlaywrightScript = readNonEmptyString(
      scriptRecord,
      "demoPlaywrightScript",
    );
  } else {
    if (browserScenes.length > 0) {
      if (browserScenes.some((scene) => scene.actions === undefined)) {
        throw new Error(
          "playwright-recording Scenes require actions when demoPlaywrightScript is omitted",
        );
      }
      demoScript.demoPlaywrightScript = compileBrowserActionPlan({
        scenes: browserScenes.map((scene) => ({
          actions: scene.actions as BrowserAction[],
          id: scene.id,
        })),
        ...(setupActions === undefined ? {} : { setupActions }),
      });
    }
  }

  return demoScript;
}

function readDemoScriptVersion(record: Record<string, unknown>): number {
  const version = readPositiveNumber(record, "version");
  if (version !== 1) {
    throw new Error("version must be 1");
  }
  return version;
}

function readScenes(scriptRecord: Record<string, unknown>) {
  const scenes = scriptRecord.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("scenes must be a non-empty array");
  }
  if (scenes.length > demoScriptLimits.maxScenes) {
    throw new Error(
      `scenes must contain at most ${demoScriptLimits.maxScenes} items`,
    );
  }

  const seenSceneIds = new Set<string>();

  const parsedScenes = scenes.map((scene, sceneIndex): SceneDescription => {
    const path = `scenes[${sceneIndex}]`;
    const sceneRecord = assertRecord(scene, path);
    const id = readSafeIdentifier(sceneRecord, "id", path);
    if (id === "setup") {
      throw new Error(
        `${path}.id must not use reserved identifier ${JSON.stringify(id)}`,
      );
    }
    if (seenSceneIds.has(id)) {
      throw new Error(`${path}.id must be unique`);
    }
    seenSceneIds.add(id);

    const type = readSceneType(sceneRecord, path);
    if (type === "playwright-recording" && "durationSeconds" in sceneRecord) {
      throw new Error(`${path}.durationSeconds is not allowed`);
    }
    assertOnlyKeys(
      sceneRecord,
      type === "playwright-recording"
        ? [
            "actions",
            "description",
            "expectedVisibleOutcome",
            "featureId",
            "humanReadableDescription",
            "id",
            "type",
          ]
        : type === "full-screen-text"
          ? [
              "backgroundColor",
              "description",
              "durationSeconds",
              "humanReadableDescription",
              "id",
              "text",
              "type",
            ]
          : [
              "alt",
              "assetId",
              "description",
              "durationSeconds",
              "humanReadableDescription",
              "id",
              "type",
            ],
      path,
    );
    const humanReadableDescription = readSceneDescription(sceneRecord, path);
    const base = {
      ...(humanReadableDescription === undefined
        ? {}
        : { humanReadableDescription }),
      id,
    };
    if (type === "playwright-recording") {
      return {
        ...base,
        ...(sceneRecord.actions === undefined
          ? {}
          : {
              actions: readBoundedBrowserActions(
                sceneRecord.actions,
                `${path}.actions`,
              ),
            }),
        expectedVisibleOutcome: readNonEmptyString(
          sceneRecord,
          "expectedVisibleOutcome",
          path,
        ),
        ...(sceneRecord.featureId === undefined
          ? {}
          : {
              featureId: readSafeIdentifier(sceneRecord, "featureId", path),
            }),
        type,
      };
    }

    if ("expectedVisibleOutcome" in sceneRecord) {
      throw new Error(
        `${path}.expectedVisibleOutcome is only allowed for playwright-recording Scenes`,
      );
    }

    if (type === "full-screen-text") {
      return {
        ...base,
        backgroundColor: readHexColor(sceneRecord, "backgroundColor", path),
        durationSeconds: readSyntheticSceneDuration(
          sceneRecord,
          "durationSeconds",
          path,
        ),
        text: readTextStyle(sceneRecord.text, `${path}.text`),
        type,
      };
    }

    return {
      ...base,
      alt: readNonEmptyString(sceneRecord, "alt", path),
      assetId: readSafeAssetId(sceneRecord, "assetId", path),
      durationSeconds: readSyntheticSceneDuration(
        sceneRecord,
        "durationSeconds",
        path,
      ),
      type,
    };
  });

  const totalSyntheticDurationSeconds = parsedScenes.reduce(
    (total, scene) =>
      scene.type === "playwright-recording"
        ? total
        : total + scene.durationSeconds,
    0,
  );
  if (
    totalSyntheticDurationSeconds > demoScriptLimits.maxTotalDurationSeconds
  ) {
    throw new Error(
      `synthetic Scenes must total at most ${demoScriptLimits.maxTotalDurationSeconds} seconds`,
    );
  }

  return parsedScenes;
}

function readBoundedBrowserActions(value: unknown, path: string) {
  if (
    Array.isArray(value) &&
    value.length > demoScriptLimits.maxActionsPerCollection
  ) {
    throw new Error(
      `${path} must contain at most ${demoScriptLimits.maxActionsPerCollection} items`,
    );
  }
  return readBrowserActions(value, path);
}

function readSceneType(
  sceneRecord: Record<string, unknown>,
  path: string,
): SceneDescription["type"] {
  if (sceneRecord.type === undefined) {
    return "playwright-recording";
  }

  return readEnum(
    sceneRecord,
    "type",
    ["full-screen-text", "playwright-recording", "static-image"],
    path,
  );
}

function readSyntheticSceneDuration(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  const durationSeconds = readPositiveNumber(record, key, parentPath);
  if (durationSeconds < demoScriptLimits.minSyntheticSceneDurationSeconds) {
    throw new Error(
      `${parentPath}.${key} must be at least ${demoScriptLimits.minSyntheticSceneDurationSeconds} seconds`,
    );
  }
  if (durationSeconds > demoScriptLimits.maxSyntheticSceneDurationSeconds) {
    throw new Error(
      `${parentPath}.${key} must be at most ${demoScriptLimits.maxSyntheticSceneDurationSeconds} seconds`,
    );
  }
  return durationSeconds;
}

function readTextStyle(value: unknown, path: string): DemoScriptTextStyle {
  const textRecord = assertRecord(value, path);
  assertOnlyKeys(
    textRecord,
    ["color", "content", "font", "position", "size"],
    path,
  );
  return {
    color: readHexColor(textRecord, "color", path),
    content: readNonEmptyString(textRecord, "content", path),
    font: readApprovedFontFamily(textRecord, "font", path),
    position: readEnum(
      textRecord,
      "position",
      ["bottom-left", "center", "top-left"],
      path,
    ),
    size: readEnum(textRecord, "size", ["large", "medium", "small"], path),
  };
}

function readHexColor(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  const value = readNonEmptyString(record, key, parentPath);
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${parentPath}.${key} must be a six-digit hex color`);
  }
  return value;
}

function readSafeAssetId(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  const value = readNonEmptyString(record, key, parentPath);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) {
    throw new Error(`${parentPath}.${key} must be a safe asset ID`);
  }
  return value;
}

function readSafeIdentifier(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  const value = readNonEmptyString(record, key, parentPath);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) {
    throw new Error(`${parentPath}.${key} must be a safe identifier`);
  }
  return value;
}

function readSceneDescription(
  sceneRecord: Record<string, unknown>,
  path: string,
): string | undefined {
  if (sceneRecord.humanReadableDescription !== undefined) {
    return readNonEmptyString(sceneRecord, "humanReadableDescription", path);
  }
  if (sceneRecord.description !== undefined) {
    return readNonEmptyString(sceneRecord, "description", path);
  }
  return undefined;
}

function readFormat(scriptRecord: Record<string, unknown>): "16:9" {
  const format = readNonEmptyString(scriptRecord, "format");
  if (format !== "16:9") {
    throw new Error("format must be 16:9");
  }
  return format;
}

function readPresentation(
  scriptRecord: Record<string, unknown>,
  sceneIds: string[],
): DemoScriptPresentation {
  const presentationRecord = assertRecord(
    scriptRecord.presentation,
    "presentation",
  );
  assertOnlyKeys(
    presentationRecord,
    ["music", "textOverlays", "transitions"],
    "presentation",
  );

  return {
    music: readMusicIntent(presentationRecord.music),
    textOverlays: readTextOverlays(
      presentationRecord.textOverlays,
      new Set(sceneIds),
    ),
    transitions: readTransitions(presentationRecord.transitions, sceneIds),
  };
}

function readMusicIntent(value: unknown): DemoScriptMusicIntent {
  if (value === undefined) {
    return { enabled: false };
  }
  const musicRecord = assertRecord(value, "presentation.music");
  const enabled = readBoolean(musicRecord, "enabled", "presentation.music");
  assertOnlyKeys(
    musicRecord,
    enabled ? ["enabled", "trackId"] : ["enabled"],
    "presentation.music",
  );

  if (!enabled) {
    return { enabled: false };
  }

  return {
    enabled: true,
    trackId: readApprovedMusicTrackId(
      musicRecord,
      "trackId",
      "presentation.music",
    ),
  };
}

function readTextOverlays(value: unknown, sceneIds: Set<string>) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("presentation.textOverlays must be an array");
  }
  if (value.length > demoScriptLimits.maxTextOverlays) {
    throw new Error(
      `presentation.textOverlays must contain at most ${demoScriptLimits.maxTextOverlays} items`,
    );
  }

  return value.map((overlay, overlayIndex): DemoScriptTextOverlay => {
    const path = `presentation.textOverlays[${overlayIndex}]`;
    const overlayRecord = assertRecord(overlay, path);
    assertOnlyKeys(
      overlayRecord,
      ["content", "font", "position", "sceneId", "size"],
      path,
    );
    const sceneId = readNonEmptyString(overlayRecord, "sceneId", path);
    assertKnownSceneId(sceneIds, sceneId, `${path}.sceneId`);

    return {
      content: readNonEmptyString(overlayRecord, "content", path),
      font: readApprovedFontFamily(overlayRecord, "font", path),
      position: readEnum(
        overlayRecord,
        "position",
        ["bottom-left", "center", "top-left"],
        path,
      ),
      sceneId,
      size: readEnum(overlayRecord, "size", ["large", "medium", "small"], path),
    };
  });
}

function readTransitions(value: unknown, sceneIds: string[]) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("presentation.transitions must be an array");
  }
  if (value.length > demoScriptLimits.maxTransitions) {
    throw new Error(
      `presentation.transitions must contain at most ${demoScriptLimits.maxTransitions} items`,
    );
  }
  const sceneIdSet = new Set(sceneIds);
  const seenEdges = new Set<string>();

  return value.map((transition, transitionIndex): DemoScriptTransition => {
    const path = `presentation.transitions[${transitionIndex}]`;
    const transitionRecord = assertRecord(transition, path);
    const fromSceneId = readNonEmptyString(
      transitionRecord,
      "fromSceneId",
      path,
    );
    const toSceneId = readNonEmptyString(transitionRecord, "toSceneId", path);
    assertKnownSceneId(sceneIdSet, fromSceneId, `${path}.fromSceneId`);
    assertKnownSceneId(sceneIdSet, toSceneId, `${path}.toSceneId`);
    if (sceneIds.indexOf(toSceneId) !== sceneIds.indexOf(fromSceneId) + 1) {
      throw new Error(`${path} must connect adjacent Scenes in script order`);
    }
    const edge = `${fromSceneId}\u0000${toSceneId}`;
    if (seenEdges.has(edge)) {
      throw new Error(`${path} duplicates transition edge`);
    }
    seenEdges.add(edge);
    const style = readEnum(transitionRecord, "style", ["cut", "fade"], path);
    assertOnlyKeys(
      transitionRecord,
      style === "fade"
        ? ["durationSeconds", "fromSceneId", "style", "toSceneId"]
        : ["fromSceneId", "style", "toSceneId"],
      path,
    );

    if (style === "cut") {
      if (transitionRecord.durationSeconds !== undefined) {
        throw new Error(`${path}.durationSeconds is not allowed for a cut`);
      }
      return { fromSceneId, style, toSceneId };
    }

    return {
      durationSeconds: readFadeDuration(
        transitionRecord,
        "durationSeconds",
        path,
      ),
      fromSceneId,
      style,
      toSceneId,
    };
  });
}

function readFadeDuration(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  const durationSeconds = readPositiveNumber(record, key, parentPath);
  if (durationSeconds < demoScriptLimits.minFadeDurationSeconds) {
    throw new Error(
      `${parentPath}.${key} must be at least ${demoScriptLimits.minFadeDurationSeconds} seconds`,
    );
  }
  if (durationSeconds > demoScriptLimits.maxFadeDurationSeconds) {
    throw new Error(
      `${parentPath}.${key} must be at most ${demoScriptLimits.maxFadeDurationSeconds} seconds`,
    );
  }
  return durationSeconds;
}

function assertKnownSceneId(
  sceneIds: Set<string>,
  sceneId: string,
  path: string,
): void {
  if (!sceneIds.has(sceneId)) {
    throw new Error(`${path} must reference a declared Scene`);
  }
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${path} contains unsupported property ${key}`);
    }
  }
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
) {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

function readPositiveNumber(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
) {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number`);
  }

  return value;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
) {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];

  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }

  return value;
}

function readApprovedFontFamily(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  return readEnum(record, key, approvedFontFamilies, parentPath);
}

function readApprovedMusicTrackId(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  return readEnum(record, key, approvedMusicTrackIds, parentPath);
}

function readEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowedValues: T,
  parentPath: string,
): T[number] {
  const path = `${parentPath}.${key}`;
  const value = record[key];

  if (
    typeof value !== "string" ||
    !allowedValues.includes(value as T[number])
  ) {
    throw new Error(`${path} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}
