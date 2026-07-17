const NAME_KEY = "calvo:name";
const CACHE_KEY = "calvo:cache";
const PENDING_KEY = "calvo:pending";

let serverAvailability = {}; // letzter bekannter Serverstand { "YYYY-MM-DD": ["Name", ...] }
let availability = {}; // Anzeige: Serverstand + eigene, noch nicht übertragene Änderungen
let desired = new Map(); // "YYYY-MM-DD" -> gewünschte eigene Teilnahme, noch nicht vom Server bestätigt
let monthsShown = 6;
let pendingDate = null;

let ws = null;
let wsConnected = true; // optimistisch, damit das Banner beim Laden nicht aufblitzt
let syncFailed = false;
let syncing = false;
let syncTimer = null;
let loadTimer = null;
let reconnectTimer = null;

const calendarEl = document.getElementById("calendar");
const bestListEl = document.getElementById("best-list");
const bestEmptyEl = document.getElementById("best-empty");
const modalEl = document.getElementById("modal");
const nameForm = document.getElementById("name-form");
const nameInput = document.getElementById("name-input");
const moreBtn = document.getElementById("more-months");
const userInfoEl = document.getElementById("user-info");
const userNameEl = document.getElementById("user-name");
const statusEl = document.getElementById("status");

const monthFmt = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" });
const bestDateFmt = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

let recentVotes = new Map(); // "YYYY-MM-DD" -> { names: [...], timer } für kurz eingeblendete Labels

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

function loadStored() {
  try {
    serverAvailability = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    serverAvailability = {};
  }
  try {
    const stored = JSON.parse(localStorage.getItem(PENDING_KEY)) || {};
    desired = new Map(Object.entries(stored).map(([date, want]) => [date, Boolean(want)]));
  } catch {
    desired = new Map();
  }
}

function saveStored() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(serverAvailability));
    localStorage.setItem(PENDING_KEY, JSON.stringify(Object.fromEntries(desired)));
  } catch {
    // z.B. Speicher voll – dann eben ohne Cache
  }
}

// Anzeige-Stand aus Serverstand + eigenen offenen Änderungen ableiten.
// Änderungen, die der Server inzwischen bestätigt hat, sind damit erledigt.
function recompute() {
  const name = getName();
  availability = {};
  for (const [date, names] of Object.entries(serverAvailability)) {
    availability[date] = [...names];
  }
  if (!name) {
    desired.clear();
    return;
  }
  for (const [date, want] of [...desired]) {
    const names = availability[date] || [];
    const has = names.includes(name);
    if (has === want) {
      desired.delete(date);
      continue;
    }
    if (want) {
      names.push(name);
      availability[date] = names;
    } else {
      const rest = names.filter((n) => n !== name);
      if (rest.length > 0) {
        availability[date] = rest;
      } else {
        delete availability[date];
      }
    }
  }
}

function refresh() {
  recompute();
  saveStored();
  render();
  updateStatus();
}

function updateStatus() {
  statusEl.classList.toggle("hidden", wsConnected && !syncFailed);
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

      const recent = recentVotes.get(key);
      if (recent) {
        cell.classList.add("flash");
        const label = document.createElement("span");
        label.className = "vote-label";
        label.textContent = recent.names.join(", ");
        cell.appendChild(label);
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
  flip(key);
}

// Sofort lokal umschalten, Übertragung an den Server läuft im Hintergrund.
function flip(date) {
  const name = getName();
  const names = availability[date] || [];
  desired.set(date, !names.includes(name));
  refresh();
  syncPending();
}

// Offene Änderungen mit dem Server abgleichen; bei Fehler später erneut versuchen.
async function syncPending() {
  if (syncing) return;
  syncing = true;
  clearTimeout(syncTimer);
  const name = getName();
  let failed = false;

  for (const [date, want] of [...desired]) {
    const serverNames = serverAvailability[date] || [];
    if (serverNames.includes(name) === want) continue; // erledigt recompute() beim refresh()
    try {
      const res = await fetch("/api/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, date }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { names } = await res.json();
      if (names.length > 0) {
        serverAvailability[date] = names;
      } else {
        delete serverAvailability[date];
      }
    } catch (err) {
      console.error("Übertragung fehlgeschlagen, versuche es später erneut:", err);
      failed = true;
      break;
    }
  }

  syncing = false;
  syncFailed = failed;
  refresh();
  if (failed || desired.size > 0) {
    syncTimer = setTimeout(syncPending, 3000);
  }
}

// Blendet am Tag kurz ein Label ein, wenn sich jemand anderes neu eingetragen hat.
function notifyNewVotes(date, names) {
  const before = serverAvailability[date] || [];
  const myName = getName();
  const added = names.filter((n) => n !== myName && !before.includes(n));
  if (added.length === 0) return;

  const entry = recentVotes.get(date);
  if (entry) clearTimeout(entry.timer);
  recentVotes.set(date, {
    names: entry ? [...new Set([...entry.names, ...added])] : added,
    timer: setTimeout(() => {
      recentVotes.delete(date);
      render();
    }, 5100), // etwas länger als die 5s der CSS-Animation
  });
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
  if (date) flip(date);
});

moreBtn.addEventListener("click", () => {
  monthsShown += 3;
  render();
});

async function load() {
  clearTimeout(loadTimer);
  try {
    const res = await fetch("/api/availability");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    serverAvailability = await res.json();
    refresh();
    syncPending();
  } catch (err) {
    console.error("Laden fehlgeschlagen, versuche es später erneut:", err);
    loadTimer = setTimeout(load, 3000);
  }
}

function connect() {
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  clearTimeout(reconnectTimer);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("open", () => {
    wsConnected = true;
    updateStatus();
    load(); // beim (Re-)Connect Stand neu laden
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "update") {
      notifyNewVotes(msg.date, msg.names);
      if (msg.names.length > 0) {
        serverAvailability[msg.date] = msg.names;
      } else {
        delete serverAvailability[msg.date];
      }
      refresh();
    }
  });
  ws.addEventListener("close", () => {
    wsConnected = false;
    updateStatus();
    reconnectTimer = setTimeout(connect, 2000);
  });
}

// Mobile Browser kappen Verbindungen im Hintergrund – beim Zurückkehren sofort
// neu verbinden und offene Änderungen übertragen, statt auf Timer zu warten.
function wake() {
  connect();
  if (ws && ws.readyState === WebSocket.OPEN) load();
  syncPending();
}

window.addEventListener("online", wake);
window.addEventListener("focus", wake);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) wake();
});

loadStored();
refresh();
load();
connect();
