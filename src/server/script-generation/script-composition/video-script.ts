type SceneDescription = {
  browserActions: string[];
  id: string;
  summary: string;
};

type ScriptSection = {
  id: string;
  scenes: SceneDescription[];
  title: string;
};

export type VideoScript = {
  sections: ScriptSection[];
  title: string;
};
