const NAME_KEY = "calvo:name";

let availability = {}; // { "YYYY-MM-DD": ["Name", ...] }
let monthsShown = 6;
let pendingDate = null;

const calendarEl = document.getElementById("calendar");
const bestListEl = document.getElementById("best-list");
const bestEmptyEl = document.getElementById("best-empty");
const modalEl = document.getElementById("modal");
const nameForm = document.getElementById("name-form");
const nameInput = document.getElementById("name-input");
const moreBtn = document.getElementById("more-months");
const userInfoEl = document.getElementById("user-info");
const userNameEl = document.getElementById("user-name");

const monthFmt = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" });
const bestDateFmt = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function getName() {
  return localStorage.getItem(NAME_KEY) || "";
}

function dateKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayKey() {
  const t = new Date();
  return dateKey(t.getFullYear(), t.getMonth(), t.getDate());
}

function render() {
  renderUser();
  renderCalendar();
  renderBest();
}

function renderUser() {
  const name = getName();
  userInfoEl.classList.toggle("hidden", !name);
  userNameEl.textContent = name;
}

function renderCalendar() {
  calendarEl.innerHTML = "";
  const now = new Date();
  const tKey = todayKey();
  const myName = getName();

  for (let i = 0; i < monthsShown; i++) {
    const first = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const year = first.getFullYear();
    const month = first.getMonth();

    const monthEl = document.createElement("div");
    monthEl.className = "month";

    const heading = document.createElement("h3");
    heading.textContent = monthFmt.format(first);
    monthEl.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "grid";

    for (const wd of WEEKDAYS) {
      const el = document.createElement("div");
      el.className = "weekday";
      el.textContent = wd;
      grid.appendChild(el);
    }

    // Montag als erster Wochentag: So(0) -> 6, Mo(1) -> 0, ...
    const offset = (first.getDay() + 6) % 7;
    for (let j = 0; j < offset; j++) {
      grid.appendChild(document.createElement("div"));
    }

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const key = dateKey(year, month, day);
      const names = availability[key] || [];

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "day";
      if (key === tKey) cell.classList.add("today");
      if (key < tKey) {
        cell.classList.add("past");
        cell.disabled = true;
      }
      if (myName && names.includes(myName)) cell.classList.add("mine");
      if (names.length > 0) cell.classList.add("has-votes");

      const num = document.createElement("span");
      num.className = "num";
      num.textContent = day;
      cell.appendChild(num);

      if (names.length > 0) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = names.length;
        cell.appendChild(badge);
        cell.title = names.join(", ");
      }

      cell.addEventListener("click", () => onDayClick(key));
      grid.appendChild(cell);
    }

    monthEl.appendChild(grid);
    calendarEl.appendChild(monthEl);
  }
}

function renderBest() {
  const entries = Object.entries(availability)
    .filter(([, names]) => names.length > 0)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  bestListEl.innerHTML = "";
  bestEmptyEl.classList.toggle("hidden", entries.length > 0);

  const topCount = entries.length > 0 ? entries[0][1].length : 0;
  for (const [key, names] of entries) {
    const li = document.createElement("li");
    if (names.length === topCount) li.classList.add("top");

    const dateSpan = document.createElement("span");
    dateSpan.className = "best-date";
    dateSpan.textContent = bestDateFmt.format(parseKey(key));

    const countSpan = document.createElement("span");
    countSpan.className = "best-count";
    countSpan.textContent = `${names.length} ${names.length === 1 ? "Person" : "Personen"}`;

    const namesSpan = document.createElement("span");
    namesSpan.className = "best-names";
    namesSpan.textContent = names.join(", ");

    li.append(dateSpan, countSpan, namesSpan);
    bestListEl.appendChild(li);
  }
}

function onDayClick(key) {
  if (!getName()) {
    pendingDate = key;
    openModal();
    return;
  }
  toggle(key);
}

async function toggle(date) {
  try {
    const res = await fetch("/api/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: getName(), date }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { names } = await res.json();
    if (names.length > 0) {
      availability[date] = names;
    } else {
      delete availability[date];
    }
    render();
  } catch (err) {
    console.error("Toggle fehlgeschlagen:", err);
  }
}

function openModal() {
  nameInput.value = getName();
  modalEl.classList.remove("hidden");
  nameInput.focus();
}

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  localStorage.setItem(NAME_KEY, name);
  modalEl.classList.add("hidden");
  const date = pendingDate;
  pendingDate = null;
  render();
  if (date) toggle(date);
});

moreBtn.addEventListener("click", () => {
  monthsShown += 3;
  render();
});

async function load() {
  const res = await fetch("/api/availability");
  availability = await res.json();
  render();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("open", load); // beim (Re-)Connect Stand neu laden
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "update") {
      if (msg.names.length > 0) {
        availability[msg.date] = msg.names;
      } else {
        delete availability[msg.date];
      }
      render();
    }
  });
  ws.addEventListener("close", () => setTimeout(connect, 2000));
}

render();
connect();
