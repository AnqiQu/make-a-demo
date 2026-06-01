import { type FormEvent, useState } from "react";

type ChatInputProps = {
  onSubmitMessage: (message: string) => void;
};

export function ChatInput({ onSubmitMessage }: ChatInputProps) {
  const [draft, setDraft] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmitMessage(draft.trim());
  };

  return (
    <form onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="owlet-chat-input">
        Chat with Owlet
      </label>
      <input
        id="owlet-chat-input"
        className="min-h-14 w-full rounded-2xl border border-[#DCCFC1] bg-white/92 px-6 text-base font-medium text-brand-umber shadow-soft-control outline-none transition placeholder:text-slate-400 focus:border-[#F59E0B]/70 focus:ring-4 focus:ring-[#F59E0B]/15"
        placeholder="Or chat with us about it here"
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </form>
  );
}
