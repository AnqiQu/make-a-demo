import "./style.css";

type Note = { id: number; text: string; pinned: boolean };

let nextId = 4;
const notes: Note[] = [
  { id: 1, text: "Check irrigation timer on the east plot", pinned: true },
  { id: 2, text: "Order two rolls of wire mesh", pinned: false },
  { id: 3, text: "Gate latch needs oil", pinned: false },
];

const form = document.querySelector<HTMLFormElement>("#new-note-form");
const textInput = document.querySelector<HTMLInputElement>("#note-text");
const searchInput = document.querySelector<HTMLInputElement>("#note-search");
const list = document.querySelector<HTMLUListElement>("#note-list");
const stats = document.querySelector<HTMLParagraphElement>("#note-stats");

if (!form || !textInput || !searchInput || !list || !stats) {
  throw new Error("Fieldnote markup is missing a required element.");
}

function render(): void {
  const query = searchInput.value.trim().toLowerCase();
  const visible = notes.filter((note) =>
    note.text.toLowerCase().includes(query),
  );
  const ordered = [
    ...visible.filter((note) => note.pinned),
    ...visible.filter((note) => !note.pinned),
  ];

  list.replaceChildren(
    ...ordered.map((note) => {
      const item = document.createElement("li");
      item.className = note.pinned ? "note pinned" : "note";

      const text = document.createElement("span");
      text.textContent = note.text;

      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.textContent = note.pinned ? "Unpin" : "Pin";
      pinButton.setAttribute(
        "aria-label",
        `${note.pinned ? "Unpin" : "Pin"} note: ${note.text}`,
      );
      pinButton.addEventListener("click", () => {
        note.pinned = !note.pinned;
        render();
      });

      item.append(text, pinButton);
      return item;
    }),
  );

  const pinnedCount = notes.filter((note) => note.pinned).length;
  stats.textContent = `${notes.length} note${notes.length === 1 ? "" : "s"}, ${pinnedCount} pinned`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (text.length === 0) {
    return;
  }
  notes.unshift({ id: nextId, text, pinned: false });
  nextId += 1;
  textInput.value = "";
  render();
});

searchInput.addEventListener("input", () => {
  render();
});

render();
