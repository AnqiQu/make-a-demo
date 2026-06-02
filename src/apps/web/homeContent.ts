export type HomeContent = {
  eyebrow: string;
  title: string;
  description: string;
};

export function createHomeContent(): HomeContent {
  return {
    eyebrow: "Blank slate",
    title: "MakeADemo",
    description:
      "A clean starting point for the linear demo-generation workflow.",
  };
}
