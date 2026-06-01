import { type FormEvent, useState } from "react";

type GithubConnectCardProps = {
  repoUrl: string;
  onRepoUrlChange: (repoUrl: string) => void;
};

export function GithubConnectCard({
  repoUrl,
  onRepoUrlChange,
}: GithubConnectCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftRepoUrl, setDraftRepoUrl] = useState(repoUrl);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onRepoUrlChange(draftRepoUrl.trim());
    setIsEditing(false);
  };

  return (
    <article className="flex min-h-[225px] flex-col items-center justify-center rounded-[20px] border border-[#E7DDD2] bg-white/88 px-5 py-5 text-center shadow-soft-card">
      <div className="grid h-14 w-14 place-items-center rounded-full bg-[#FFF7ED] shadow-[inset_0_0_0_1px_rgba(185,130,91,0.12)]">
        <svg
          aria-hidden="true"
          className="h-8 w-8 text-[#111827]"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 2C6.48 2 2 6.59 2 12.26c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49 0-.24-.01-1.05-.01-1.91-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.85.09-.67.35-1.12.64-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.33 9.33 0 0 1 12 6.95c.85 0 1.71.12 2.51.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.07.36.32.68.95.68 1.92 0 1.39-.01 2.51-.01 2.85 0 .27.18.59.69.49A10.19 10.19 0 0 0 22 12.26C22 6.59 17.52 2 12 2Z" />
        </svg>
      </div>
      <h2 className="mt-4 font-heading text-xl font-semibold tracking-normal text-black">
        Connect your Github
      </h2>
      <p className="mt-2 max-w-[250px] text-sm leading-6 text-slate-500">
        Import repositories, code, and context to help Owlet understand your
        project.
      </p>

      {isEditing ? (
        <form className="mt-4 w-full" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="github-repo-url">
            GitHub repo URL
          </label>
          <input
            id="github-repo-url"
            className="h-11 w-full rounded-full border border-orange-200 bg-white px-4 text-sm text-brand-umber outline-none focus:border-[#F59E0B] focus:ring-4 focus:ring-[#F59E0B]/15"
            placeholder="https://github.com/company/repo"
            type="url"
            value={draftRepoUrl}
            onChange={(event) => setDraftRepoUrl(event.target.value)}
          />
          <button
            className="mt-3 h-11 w-full rounded-full bg-[#F59E0B] px-5 font-bold text-white transition hover:bg-[#ea8500] focus:outline-none focus:ring-4 focus:ring-[#F59E0B]/25"
            type="submit"
          >
            Save repo
          </button>
        </form>
      ) : (
        <>
          {repoUrl ? (
            <p className="mt-4 w-full truncate rounded-full border border-orange-100 bg-[#FFF7ED] px-4 py-2 text-sm font-semibold text-[#B9825B]">
              {repoUrl}
            </p>
          ) : null}
          <button
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-orange-200 bg-[#FFF7ED] px-6 text-sm font-bold text-[#fb7600] transition hover:border-[#F59E0B] hover:bg-orange-50 focus:outline-none focus:ring-4 focus:ring-[#F59E0B]/20"
            type="button"
            onClick={() => setIsEditing(true)}
          >
            Connect Github
            <svg
              aria-hidden="true"
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.4"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </>
      )}
    </article>
  );
}
