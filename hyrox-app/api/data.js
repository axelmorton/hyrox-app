// Stores the whole training log as one private JSON file in Vercel Blob.
// Needs: a private Blob store connected to this project (adds BLOB_READ_WRITE_TOKEN),
// APP_PASSCODE (Axel, can edit everything) and NOE_PASSCODE (Noé, can edit only Noé's entries).
// Access rules (the equivalent of row level security for this app):
//   - Anyone can READ the log (it is public on purpose).
//   - Adding, editing or deleting needs a valid passcode.
//   - Each passcode belongs to one athlete. Noé can only change Noé's entries; Axel is admin.
//   - Every entry is checked field by field; unknown fields are dropped.
import { get, put } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";

const PATH = "hyrox/log.json";
const COLS = ["sessions", "benchmarks", "ergs", "doubles"];
const ATHLETES = ["Axel", "Noé"];
const MAX_BODY = 8000; // bytes
const MAX_ITEMS = 5000; // per list

const SCHEMA = {
  sessions: { date: ["date"], type: ["str", 30], km: ["num", 0, 200], minutes: ["num", 0, 1440], effort: ["num", 0, 5], soreness: ["num", 0, 5], note: ["str", 1000], athlete: ["who"], createdAt: ["str", 40], cid: ["str", 40] },
  benchmarks: { date: ["date"], item: ["str", 60], seconds: ["num", 0, 100000], note: ["str", 1000], splits: ["splits"], athlete: ["who"], createdAt: ["str", 40], cid: ["str", 40] },
  ergs: { date: ["date"], machine: ["str", 20], distance: ["num", 1, 100000], seconds: ["num", 0, 100000], athlete: ["who"], createdAt: ["str", 40], cid: ["str", 40] },
  doubles: { station: ["str", 40], lead: ["enum", ["Axel", "Noé", "Split"]], note: ["str", 300], updatedBy: ["str", 30], createdAt: ["str", 40], cid: ["str", 40] },
};

// Returns only the fields that were sent, cleaned. null = invalid entry.
function clean(col, item) {
  const out = {};
  for (const [key, rule] of Object.entries(SCHEMA[col])) {
    if (!(key in item)) continue;
    const v = item[key];
    if (v === null || v === "") { out[key] = v; continue; }
    const t = rule[0];
    if (t === "str") {
      if (typeof v !== "string") return null;
      out[key] = v.slice(0, rule[1]);
    } else if (t === "num") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < rule[1] || n > rule[2]) return null;
      out[key] = n;
    } else if (t === "date") {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
      out[key] = v;
    } else if (t === "who") {
      if (!ATHLETES.includes(v)) return null;
      out[key] = v;
    } else if (t === "enum") {
      if (!rule[1].includes(v)) return null;
      out[key] = v;
    } else if (t === "splits") {
      if (!Array.isArray(v) || v.length > 16) return null;
      const arr = v.map(Number);
      if (arr.some(n => !Number.isFinite(n) || n < 0 || n > 100000)) return null;
      out[key] = arr;
    }
  }
  return out;
}

const hash = s => createHash("sha256").update(String(s || "")).digest();

// Checks the passcode against every account (no early exit) in constant time.
function whoIs(given) {
  const accounts = [
    { name: "Axel", admin: true, pass: process.env.APP_PASSCODE },
    { name: "Noé", admin: false, pass: process.env.NOE_PASSCODE },
  ];
  const g = hash(given);
  let match = null;
  for (const a of accounts) {
    const ok = !!a.pass && !!given && timingSafeEqual(g, hash(a.pass));
    if (ok && !match) match = a;
  }
  return match;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const canTouch = (user, athlete) => user.admin || (athlete || "Axel") === user.name;

async function load() {
  const empty = { sessions: [], benchmarks: [], ergs: [], doubles: [] };
  const r = await get(PATH, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return empty;
  const text = await new Response(r.stream).text();
  try {
    const d = JSON.parse(text);
    return { sessions: d.sessions || [], benchmarks: d.benchmarks || [], ergs: d.ergs || [], doubles: d.doubles || [] };
  } catch {
    return empty;
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
  if (!process.env.APP_PASSCODE) return res.status(500).json({ error: "Set APP_PASSCODE in Vercel to protect your log" });

  try {
    // Viewing is public: anyone can read the log.
    if (req.method === "GET") return res.status(200).json(await load());
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });
    if (process.env.NOE_PASSCODE && process.env.NOE_PASSCODE === process.env.APP_PASSCODE) return res.status(500).json({ error: "APP_PASSCODE and NOE_PASSCODE must be different" });

    const user = whoIs(req.headers["x-app-pass"]);
    if (!user) {
      await wait(1500);
      return res.status(401).json({ error: "Wrong passcode" });
    }

    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY) return res.status(413).json({ error: "Entry too large" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    if (body.op === "whoami") return res.status(200).json({ user: user.name, admin: user.admin });
    if (!COLS.includes(body.col)) return res.status(400).json({ error: "Unknown list" });

    const data = await load();
    const list = data[body.col];
    const denied = () => res.status(403).json({ error: `Signed in as ${user.name}. You can only change ${user.name}'s entries.` });
    const isObj = v => v && typeof v === "object" && !Array.isArray(v);

    if (body.op === "add" && isObj(body.item)) {
      const item = clean(body.col, body.item);
      if (!item) return res.status(400).json({ error: "Invalid entry" });
      if (body.col === "doubles") {
        if (!item.station || !item.lead) return res.status(400).json({ error: "Invalid entry" });
        item.updatedBy = user.name;
        data.doubles = list.filter(x => x.station !== item.station); // one plan per station
      } else {
        if (!item.athlete) item.athlete = user.name;
        if (!canTouch(user, item.athlete)) return denied();
        if (item.cid && list.some(x => x.cid === item.cid)) return res.status(200).json(data); // already synced
      }
      if (data[body.col].length >= MAX_ITEMS) return res.status(400).json({ error: "List is full" });
      item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      data[body.col].push(item);
    } else if (body.op === "update" && typeof body.id === "string" && isObj(body.item) && body.col !== "doubles") {
      const i = list.findIndex(x => x.id === body.id);
      if (i < 0) return res.status(404).json({ error: "Entry not found. It may have been deleted." });
      const changes = clean(body.col, body.item);
      if (!changes) return res.status(400).json({ error: "Invalid entry" });
      delete changes.cid; delete changes.createdAt;
      if (!canTouch(user, list[i].athlete) || !canTouch(user, changes.athlete || list[i].athlete)) return denied();
      list[i] = { ...list[i], ...changes, id: list[i].id };
    } else if (body.op === "delete" && typeof body.id === "string" && body.id.length <= 40) {
      const target = list.find(x => x.id === body.id);
      if (!target) return res.status(200).json(data);
      if (body.col !== "doubles" && !canTouch(user, target.athlete)) return denied();
      data[body.col] = list.filter(x => x.id !== body.id);
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
    await save(data);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Storage error. Is a Blob store connected to this project?" });
  }
}
