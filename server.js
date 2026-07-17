import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "availability.json");
const PORT = process.env.PORT || 3000;

// { "YYYY-MM-DD": ["Name", ...], ... }
let availability = {};
try {
  availability = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch {
  availability = {};
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(availability, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/availability", (req, res) => {
  res.json(availability);
});

app.post("/api/toggle", (req, res) => {
  const { name, date } = req.body ?? {};
  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return res
      .status(400)
      .json({ error: "name und date (JJJJ-MM-TT) sind erforderlich." });
  }

  const person = name.trim();
  const names = availability[date] ?? [];
  const idx = names.indexOf(person);
  if (idx === -1) {
    names.push(person);
  } else {
    names.splice(idx, 1);
  }
  if (names.length > 0) {
    availability[date] = names;
  } else {
    delete availability[date];
  }
  persist();
  broadcast({ type: "update", date, names });
  res.json({ date, names });
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Ungültiger JSON-Body." });
  }
  next(err);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Calvo läuft auf http://localhost:${PORT}`);
});
