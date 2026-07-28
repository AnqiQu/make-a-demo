const MILES_PER_KILOMETER = 0.621371;

const distanceValue = document.querySelector("#distance-value");
const distanceUnit = document.querySelector("#distance-unit");
const distanceResult = document.querySelector("#distance-result");

function renderDistance() {
  const value = Number(distanceValue.value);
  if (!Number.isFinite(value) || value < 0) {
    distanceResult.textContent = "Enter a distance to convert.";
    return;
  }
  if (distanceUnit.value === "miles") {
    const kilometers = (value / MILES_PER_KILOMETER).toFixed(2);
    distanceResult.textContent = `${value} miles is ${kilometers} kilometers`;
  } else {
    const miles = (value * MILES_PER_KILOMETER).toFixed(2);
    distanceResult.textContent = `${value} kilometers is ${miles} miles`;
  }
}

distanceValue.addEventListener("input", renderDistance);
distanceUnit.addEventListener("change", renderDistance);

const packingForm = document.querySelector("#packing-form");
const packingItem = document.querySelector("#packing-item");
const packingList = document.querySelector("#packing-list");
const packingProgress = document.querySelector("#packing-progress");

const items = [
  { name: "Trail map", packed: true },
  { name: "First aid kit", packed: false },
  { name: "Headlamp", packed: false },
];

function renderPacking() {
  packingList.replaceChildren(
    ...items.map((item) => {
      const entry = document.createElement("li");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.packed;
      checkbox.id = `packed-${item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      checkbox.addEventListener("change", () => {
        item.packed = checkbox.checked;
        renderPacking();
      });

      const label = document.createElement("label");
      label.htmlFor = checkbox.id;
      label.textContent = item.name;

      entry.append(checkbox, label);
      return entry;
    }),
  );

  const packedCount = items.filter((item) => item.packed).length;
  packingProgress.textContent = `${packedCount} of ${items.length} packed`;
}

packingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = packingItem.value.trim();
  if (name.length === 0) {
    return;
  }
  items.push({ name, packed: false });
  packingItem.value = "";
  renderPacking();
});

renderDistance();
renderPacking();
