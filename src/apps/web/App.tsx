import { createHomeContent } from "./homeContent";

export function App() {
  const content = createHomeContent();

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-16 text-neutral-50">
      <section className="mx-auto flex min-h-[70vh] max-w-3xl flex-col justify-center">
        <p className="text-sm font-semibold uppercase tracking-[0.28em] text-amber-300">
          {content.eyebrow}
        </p>
        <h1 className="mt-5 text-5xl font-semibold tracking-tight sm:text-7xl">
          {content.title}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-neutral-300">
          {content.description}
        </p>
      </section>
    </main>
  );
}
