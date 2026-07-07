const tree = document.querySelector("[data-tree]");

if (tree && window.MAKEADEMO_FILE_INVENTORY) {
  renderTree(window.MAKEADEMO_FILE_INVENTORY.tree, tree, "");
}

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

for (const card of document.querySelectorAll("[data-correct]")) {
  const correctAnswer = card.dataset.correct;
  const feedback = card.querySelector(".feedback");

  for (const button of card.querySelectorAll("[data-answer]")) {
    button.addEventListener("click", () => {
      const isCorrect = button.dataset.answer === correctAnswer;

      for (const option of card.querySelectorAll("[data-answer]")) {
        option.classList.remove("is-correct", "is-incorrect");
        option.removeAttribute("aria-pressed");
      }

      button.classList.add(isCorrect ? "is-correct" : "is-incorrect");
      button.setAttribute("aria-pressed", "true");
      feedback.className = `feedback ${isCorrect ? "correct" : "incorrect"}`;
      feedback.textContent = isCorrect
        ? getCorrectFeedback(card)
        : getIncorrectFeedback(card, correctAnswer);
    });
  }
}

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

function getCorrectFeedback(card) {
  const questionNumber = getQuestionNumber(card);
  const feedbackByQuestion = {
    1: "Correct — validation is the trust boundary between generated script and accepted script.",
    2: "Correct — uploads are separate; the submit route creates the queued project/demo request.",
    3: "Correct — dependency install is the controlled exception, and the runtime is resealed afterward.",
    4: "Correct — R2 stores the object and Neon links it to the demo request.",
    5: "Correct — this is a cautious source-observed caveat about missing full-pipeline hooks.",
  };

  return feedbackByQuestion[questionNumber] || "Correct.";
}

function getIncorrectFeedback(card, correctAnswer) {
  const correctButton = card.querySelector(`[data-answer="${correctAnswer}"]`);
  return `Not quite. The best answer is: ${correctButton.textContent.trim()}`;
}

function getQuestionNumber(card) {
  const heading = card.querySelector("h3");
  return Number.parseInt(heading.textContent, 10);
}
