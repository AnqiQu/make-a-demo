type MicrophonePromptProps = {
  isListening: boolean;
  onToggle: () => void;
};

export function MicrophonePrompt({
  isListening,
  onToggle,
}: MicrophonePromptProps) {
  return (
    <div className="mt-4 flex flex-col items-center">
      <button
        aria-pressed={isListening}
        aria-label={isListening ? "Stop listening" : "Start listening"}
        className="group relative grid h-20 w-20 place-items-center rounded-full bg-[#FFF7ED] shadow-[inset_0_0_0_1px_rgba(245,158,11,0.12),0_14px_35px_rgba(185,130,91,0.14)] transition hover:scale-[1.03] focus:outline-none focus:ring-4 focus:ring-[#F59E0B]/25"
        type="button"
        onClick={onToggle}
      >
        <span
          className={`absolute h-[112px] w-[112px] rounded-full border border-dashed border-[#F59E0B]/45 ${
            isListening ? "animate-spin [animation-duration:3s]" : ""
          }`}
        />
        {isListening ? (
          <span className="absolute h-24 w-24 animate-ping rounded-full border border-[#F59E0B]/25" />
        ) : null}
        <span className="relative grid h-12 w-12 place-items-center rounded-full border border-[#F59E0B]/25 bg-white text-[#F59E0B] shadow-sm">
          <svg
            aria-hidden="true"
            className="h-7 w-7"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.4"
          >
            <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <path d="M12 19v3" />
            <path d="M8 22h8" />
          </svg>
        </span>
      </button>
      {isListening ? (
        <p className="mt-2 text-sm font-semibold text-[#F59E0B]">
          Listening...
        </p>
      ) : null}
    </div>
  );
}
