export const columns = ["todo", "doing", "done"];

export const columnTitles = {
  todo: "To do",
  doing: "In progress",
  done: "Done",
};

export function formatTaskLabel(name, assignee) {
  const trimmed = name.trim();
  return assignee ? `${trimmed} — ${assignee}` : trimmed;
}

export function nextColumn(column) {
  const index = columns.indexOf(column);
  if (index === -1 || index === columns.length - 1) {
    return column;
  }
  return columns[index + 1];
}
