export type SceneDescription = {
  id: string;
  humanReadableDescription: string;
  durationSeconds: number;
  events: string[];
  playwrightScript: string;
};

type ScriptSection = {
  id: string;
  title: string;
  scenes: SceneDescription[];
};

export type VideoScriptPackage = {
  scriptId: string;
  title: string;
  version: number;
  estimatedDurationSeconds: number;
  format: string;
  sections: ScriptSection[];
};

export function parseVideoScriptPackage(value: unknown): VideoScriptPackage {
  const packageRecord = assertRecord(value, "script package");

  const scriptPackage: VideoScriptPackage = {
    estimatedDurationSeconds: readPositiveNumber(
      packageRecord,
      "estimatedDurationSeconds",
    ),
    format: readNonEmptyString(packageRecord, "format"),
    scriptId: readNonEmptyString(packageRecord, "scriptId"),
    sections: readSections(packageRecord),
    title: readNonEmptyString(packageRecord, "title"),
    version: readPositiveNumber(packageRecord, "version"),
  };

  return scriptPackage;
}

function readSections(packageRecord: Record<string, unknown>) {
  const sections = packageRecord.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("sections must be a non-empty array");
  }

  return sections.map((section, sectionIndex): ScriptSection => {
    const sectionPath = `sections[${sectionIndex}]`;
    const sectionRecord = assertRecord(section, sectionPath);

    const scenes = sectionRecord.scenes;
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error(`${sectionPath}.scenes must be a non-empty array`);
    }

    return {
      id: readNonEmptyString(sectionRecord, "id", sectionPath),
      scenes: scenes.map((scene, sceneIndex) =>
        readScene(scene, `${sectionPath}.scenes[${sceneIndex}]`),
      ),
      title: readNonEmptyString(sectionRecord, "title", sectionPath),
    };
  });
}

function readScene(value: unknown, path: string): SceneDescription {
  const sceneRecord = assertRecord(value, path);
  const events = sceneRecord.events;

  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(`${path}.events must be a non-empty array`);
  }

  return {
    durationSeconds: readPositiveNumber(sceneRecord, "durationSeconds", path),
    events: events.map((event, eventIndex) => {
      if (typeof event !== "string" || event.trim().length === 0) {
        throw new Error(
          `${path}.events[${eventIndex}] must be a non-empty string`,
        );
      }
      return event;
    }),
    humanReadableDescription: readNonEmptyString(
      sceneRecord,
      "humanReadableDescription",
      path,
    ),
    id: readNonEmptyString(sceneRecord, "id", path),
    playwrightScript: readNonEmptyString(sceneRecord, "playwrightScript", path),
  };
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
