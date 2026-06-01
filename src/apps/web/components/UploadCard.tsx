import { type ChangeEvent, type DragEvent, useRef, useState } from "react";

type UploadCardProps = {
  uploadedFiles: string[];
  onFilesChange: (files: string[]) => void;
};

const acceptedExtensions = ".pdf,.pptx,.docx,.txt,.md,.zip";

export function UploadCard({ uploadedFiles, onFilesChange }: UploadCardProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const addFiles = (fileList: FileList) => {
    const existingFileNames = new Set(uploadedFiles);
    const nextFileNames = Array.from(fileList)
      .map((file) => file.name)
      .filter((fileName) => !existingFileNames.has(fileName));

    onFilesChange([...uploadedFiles, ...nextFileNames]);
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addFiles(event.target.files);
      event.target.value = "";
    }
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDragging(false);

    if (event.dataTransfer.files.length > 0) {
      addFiles(event.dataTransfer.files);
    }
  };

  return (
    <article className="rounded-[20px] border border-[#E7DDD2] bg-white/80 p-3 shadow-soft-card">
      <button
        className={`flex min-h-[205px] w-full flex-col items-center justify-center rounded-[16px] border border-dashed px-5 py-5 text-center transition ${
          isDragging
            ? "border-[#F59E0B] bg-orange-50"
            : "border-orange-300 bg-[#FFF7ED]/45 hover:border-[#F59E0B]"
        }`}
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept={acceptedExtensions}
          multiple
          onChange={handleFileInput}
        />
        <span className="grid h-16 w-16 place-items-center rounded-full bg-[#ffead5] text-[#F59E0B] shadow-sm">
          <svg
            aria-hidden="true"
            className="h-9 w-9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.4"
          >
            <path d="M12 20V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </span>
        <h2 className="mt-4 font-heading text-xl font-semibold tracking-normal text-black">
          Drop anything relevant here
        </h2>
        <p className="mt-2 text-sm text-slate-500">
          pitch decks, design guidelines, manifestos
        </p>
        <span className="mt-4 inline-flex min-h-10 items-center gap-3 rounded-full border border-[#E7DDD2] bg-white px-4 text-xs font-bold uppercase tracking-normal text-slate-600 shadow-soft-control">
          <svg
            aria-hidden="true"
            className="h-5 w-5 text-slate-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <path d="M9 15h6" />
            <path d="M9 18h4" />
          </svg>
          PDF, PPTX, DOCX, TXT, MD, ZIP
        </span>
      </button>

      {uploadedFiles.length > 0 ? (
        <ul className="mt-3 grid gap-2 px-2 pb-1 text-left text-sm text-slate-600">
          {uploadedFiles.map((fileName) => (
            <li
              className="truncate rounded-full bg-white px-4 py-2 shadow-sm"
              key={fileName}
            >
              {fileName}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
