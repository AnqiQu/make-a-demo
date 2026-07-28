import {
  columnTitles,
  columns,
  formatTaskLabel,
  nextColumn,
} from "@crewboard/shared";
import "./style.css";

let nextId = 5;
const tasks = [
  { id: 1, name: "Patch the roof", assignee: "Sam", column: "todo" },
  { id: 2, name: "Order new gloves", assignee: "", column: "todo" },
  { id: 3, name: "Repaint the van", assignee: "Rio", column: "doing" },
  { id: 4, name: "Fix loading dock light", assignee: "Alex", column: "done" },
];

const form = document.querySelector("#new-task-form");
const nameInput = document.querySelector("#task-name");
const assigneeSelect = document.querySelector("#task-assignee");
const board = document.querySelector("#board");

function render() {
  board.replaceChildren(
    ...columns.map((column) => {
      const columnTasks = tasks.filter((task) => task.column === column);

      const section = document.createElement("section");
      section.className = `column column-${column}`;
      section.setAttribute("aria-label", columnTitles[column]);

      const heading = document.createElement("h2");
      heading.textContent = `${columnTitles[column]} (${columnTasks.length})`;

      const list = document.createElement("ul");
      list.append(
        ...columnTasks.map((task) => {
          const item = document.createElement("li");

          const label = document.createElement("span");
          label.textContent = formatTaskLabel(task.name, task.assignee);

          item.append(label);

          if (column !== "done") {
            const advance = document.createElement("button");
            advance.type = "button";
            advance.textContent =
              column === "todo" ? "Start" : "Finish";
            advance.setAttribute(
              "aria-label",
              `Move ${task.name} to ${columnTitles[nextColumn(column)]}`,
            );
            advance.addEventListener("click", () => {
              task.column = nextColumn(task.column);
              render();
            });
            item.append(advance);
          }

          return item;
        }),
      );

      section.append(heading, list);
      return section;
    }),
  );
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (name.length === 0) {
    return;
  }
  tasks.push({
    id: nextId,
    name,
    assignee: assigneeSelect.value,
    column: "todo",
  });
  nextId += 1;
  nameInput.value = "";
  assigneeSelect.value = "";
  render();
});

render();
