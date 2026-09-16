// Stores the whole training log as one private JSON file in Vercel Blob.
// Needs: a private Blob store connected to this project (adds BLOB_READ_WRITE_TOKEN) and APP_PASSCODE (needed to add or delete; viewing is public).
import { get, put } from "@vercel/blob";

const PATH = "hyrox/log.json";
const COLS = ["sessions", "benchmarks", "ergs"];

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
  const pass = process.env.APP_PASSCODE;
  if (!pass) return res.status(500).json({ error: "Set APP_PASSCODE in Vercel to protect your log" });

  try {
    // Viewing is public: anyone can read the log.
    if (req.method === "GET") return res.status(200).json(await load());
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

    // Adding or deleting still needs the passcode.
    if (req.headers["x-app-pass"] !== pass) return res.status(401).json({ error: "Wrong passcode" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (!COLS.includes(body.col)) return res.status(400).json({ error: "Unknown list" });

    const data = await load();
    if (body.op === "add" && body.item && typeof body.item === "object") {
      const item = { ...body.item, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7) };
      data[body.col].push(item);
    } else if (body.op === "delete" && body.id) {
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
