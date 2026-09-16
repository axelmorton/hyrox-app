// Stores the whole training log as one private JSON file in Vercel Blob.
// Needs: a private Blob store connected to this project (adds BLOB_READ_WRITE_TOKEN) and APP_PASSCODE.
// Access rules (the equivalent of row level security for this app):
//   - Anyone can READ the log (it is public on purpose).
//   - Only requests with the correct passcode can ADD or DELETE entries.
//   - Every new entry is checked field by field; unknown fields are dropped.
import { get, put } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";

const PATH = "hyrox/log.json";
const COLS = ["sessions", "benchmarks", "ergs"];
const MAX_BODY = 8000; // bytes
const MAX_ITEMS = 5000; // per list

// Allowed fields per list: [type, limit]
const SCHEMA = {
  sessions: { date: ["date"], type: ["str", 30], km: ["num", 0, 200], minutes: ["num", 0, 1440], effort: ["num", 0, 5], soreness: ["num", 0, 5], note: ["str", 1000], athlete: ["str", 30], createdAt: ["str", 40] },
  benchmarks: { date: ["date"], item: ["str", 60], seconds: ["num", 0, 100000], note: ["str", 1000], athlete: ["str", 30], createdAt: ["str", 40] },
  ergs: { date: ["date"], machine: ["str", 20], distance: ["num", 1, 100000], seconds: ["num", 0, 100000], athlete: ["str", 30], createdAt: ["str", 40] },
};

function clean(col, item) {
  const out = {};
  for (const [key, rule] of Object.entries(SCHEMA[col])) {
    const v = item[key];
    if (v === undefined || v === null || v === "") { out[key] = v === "" ? "" : null; continue; }
    if (rule[0] === "str") {
      if (typeof v !== "string") return null;
      out[key] = v.slice(0, rule[1]);
    } else if (rule[0] === "num") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < rule[1] || n > rule[2]) return null;
      out[key] = n;
    } else if (rule[0] === "date") {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
      out[key] = v;
    }
  }
  return out;
}

function passOk(given, real) {
  // Compare hashes in constant time so the passcode can't be guessed from response timing.
  const a = createHash("sha256").update(String(given || "")).digest();
  const b = createHash("sha256").update(String(real)).digest();
  return timingSafeEqual(a, b);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function load() {
  const r = await get(PATH, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return { sessions: [], benchmarks: [], ergs: [] };
  const text = await new Response(r.stream).text();
  try {
    const d = JSON.parse(text);
    return { sessions: d.sessions || [], benchmarks: d.benchmarks || [], ergs: d.ergs || [] };
  } catch {
    return { sessions: [], benchmarks: [], ergs: [] };
  }
}

async function save(data) {
  await put(PATH, JSON.stringify(data), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const pass = process.env.APP_PASSCODE;
  if (!pass) return res.status(500).json({ error: "Set APP_PASSCODE in Vercel to protect your log" });

  try {
    // Viewing is public: anyone can read the log.
    if (req.method === "GET") return res.status(200).json(await load());
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

    // Adding or deleting needs the passcode. Wrong guesses are slowed down.
    if (!passOk(req.headers["x-app-pass"], pass)) {
      await wait(1500);
      return res.status(401).json({ error: "Wrong passcode" });
    }

    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY) return res.status(413).json({ error: "Entry too large" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (!COLS.includes(body.col)) return res.status(400).json({ error: "Unknown list" });

    const data = await load();
    if (body.op === "add" && body.item && typeof body.item === "object" && !Array.isArray(body.item)) {
      if (data[body.col].length >= MAX_ITEMS) return res.status(400).json({ error: "List is full" });
      const item = clean(body.col, body.item);
      if (!item) return res.status(400).json({ error: "Invalid entry" });
      item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      data[body.col].push(item);
    } else if (body.op === "delete" && typeof body.id === "string" && body.id.length <= 40) {
      data[body.col] = data[body.col].filter(x => x.id !== body.id);
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
    await save(data);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Storage error. Is a Blob store connected to this project?" });
  }
}
