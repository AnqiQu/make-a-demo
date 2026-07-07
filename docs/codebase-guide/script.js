const tree = document.querySelector("[data-tree]");

renderTree(window.MAKEADEMO_FILE_INVENTORY.tree, tree, "");

document
  .querySelector('[data-action="expand"]')
  .addEventListener("click", () => {
    for (const detail of document.querySelectorAll("details"))
      detail.open = true;
  });

document
  .querySelector('[data-action="collapse"]')
  .addEventListener("click", () => {
    for (const detail of document.querySelectorAll("details"))
      detail.open = false;
  });

function renderTree(node, parent, pathPrefix) {
  for (const [name, child] of Object.entries(node.dirs).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const path = pathPrefix ? `${pathPrefix}/${name}` : name;
    const detail = document.createElement("details");
    if (
      path === "src" ||
      path === "src/server" ||
      path === "src/server/pipeline"
    ) {
      detail.open = true;
    }

    const summary = document.createElement("summary");
    summary.innerHTML = `<code>${escapeHtml(path)}/</code> <span>${countFiles(child)} files</span>`;
    detail.append(summary);

    const body = document.createElement("div");
    body.className = "node-body";
    renderTree(child, body, path);
    renderFiles(child.files, body);
    detail.append(body);
    parent.append(detail);
  }

  renderFiles(node.files, parent);
}

function renderFiles(files, parent) {
  if (files.length === 0) return;
  const list = document.createElement("ul");
  list.className = "file-list";
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const item = document.createElement("li");
    item.innerHTML = `<code>${escapeHtml(file.name)}</code> - ${escapeHtml(file.description)}`;
    list.append(item);
  }
  parent.append(list);
}

function countFiles(node) {
  return (
    node.files.length +
    Object.values(node.dirs).reduce(
      (total, child) => total + countFiles(child),
      0,
    )
  );
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
