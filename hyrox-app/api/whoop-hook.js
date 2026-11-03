// WHOOP webhook receiver.
//
// Register this URL in the WHOOP Developer Dashboard under Webhooks:
//   https://hyrox-app-nine.vercel.app/api/whoop-hook
//
// WHOOP sends a NOTIFICATION, not the data: user_id, id, type, trace_id. The record
// itself still has to be fetched from the API.
//
// Deliberate design: this endpoint does NOT refresh the access token. A WHOOP refresh
// invalidates the previous refresh token and concurrent refreshes fail, so if this ran a
// refresh while the app was running one, Axel would be silently signed out. api/whoop.js
// stays the only code path that refreshes. Here:
//   - access token still comfortably valid  -> fetch the record and update the cache
//   - access token expired or close to it   -> just mark the cache stale
// Either way the next time the app opens it shows a correct, current figure.
import { get, put } from "@vercel/blob";
import { createHmac, timingSafeEqual } from "node:crypto";

export const config = { api: { bodyParser: false } }; // HMAC needs the exact raw bytes

const FILE = "hyrox/whoop.json";
const API_BASES = ["https://api.prod.whoop.com/developer/v2", "https://api.prod.whoop.com/developer/v1"];
const SKEW_MS = 10 * 60 * 1000;   // reject anything older than ten minutes (replay guard)
const SAFE_MS = 5 * 60 * 1000;    // only fetch if the token has this long left to live
const SEEN_MAX = 40;              // trace_ids kept for duplicate detection

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

// timestamp + raw body, HMAC-SHA256 with the client secret, base64.
function verify(raw, ts, sig, secret) {
  if (!raw || !ts || !sig || !secret) return false;
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age > SKEW_MS || age < -SKEW_MS) return false;
  const mine = createHmac("sha256", secret).update(String(ts) + raw).digest("base64");
  const a = Buffer.from(mine), b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function load() {
  try {
    const r = await get(FILE, { access: "private", useCache: false });
    if (!r || r.statusCode !== 200) return {};
    return JSON.parse(await new Response(r.stream).text()) || {};
  } catch { return {}; }
}

async function save(d) {
  await put(FILE, JSON.stringify(d), {
    access: "private", allowOverwrite: true, addRandomSuffix: false,
    contentType: "application/json", cacheControlMaxAge: 0,
  });
}

function shape(rec) {
  if (!rec) return null;
  const s = rec.score || {};
  return {
    date: (rec.created_at || "").slice(0, 10),
    state: rec.score_state || null,
    calibrating: !!s.user_calibrating,
    score: typeof s.recovery_score === "number" ? Math.round(s.recovery_score) : null,
    hrv: typeof s.hrv_rmssd_milli === "number" ? Math.round(s.hrv_rmssd_milli * 10) / 10 : null,
    rhr: typeof s.resting_heart_rate === "number" ? Math.round(s.resting_heart_rate) : null,
    updated: rec.updated_at || rec.created_at || null,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.WHOOP_CLIENT_SECRET;
  if (!secret) return res.status(500).json({ error: "WHOOP_CLIENT_SECRET not set" });

  let raw;
  try { raw = await rawBody(req); } catch { return res.status(400).json({ error: "No body" }); }

  if (!verify(raw, req.headers["x-whoop-signature-timestamp"], req.headers["x-whoop-signature"], secret)) {
    return res.status(401).json({ error: "Bad signature" });
  }

  let ev = {};
  try { ev = JSON.parse(raw) || {}; } catch { return res.status(200).json({ ok: true }); }
  const type = String(ev.type || "");

  // Acknowledge anything we do not act on. A non-2XX makes WHOOP retry five times
  // over an hour for an event we were never going to use.
  if (!type.startsWith("recovery.")) return res.status(200).json({ ok: true, ignored: type });

  try {
    const d = await load();

    // WHOOP warns deliveries can be duplicated. trace_id is how you spot that.
    const seen = d.seen || [];
    if (ev.trace_id && seen.includes(ev.trace_id)) return res.status(200).json({ ok: true, duplicate: true });
    if (ev.trace_id) d.seen = [ev.trace_id, ...seen].slice(0, SEEN_MAX);

    d.lastEvent = { type, at: new Date().toISOString() };

    if (!d.tokens || !d.tokens.refresh) { await save(d); return res.status(200).json({ ok: true, linked: false }); }

    const fresh = d.tokens.access && Date.now() < d.tokens.expires - SAFE_MS;
    if (type === "recovery.deleted" || !fresh) {
      // Mark stale and let the app fetch on next open, with its own token handling.
      delete d.cache;
      await save(d);
      return res.status(200).json({ ok: true, invalidated: true });
    }

    let json = null;
    for (const base of API_BASES) {
      const r = await fetch(base + "/recovery?limit=7", { headers: { authorization: `Bearer ${d.tokens.access}` } });
      if (r.ok) { json = await r.json(); break; }
      if (r.status === 401) break; // token is not usable; fall through to invalidating
    }
    if (!json) { delete d.cache; await save(d); return res.status(200).json({ ok: true, invalidated: true }); }

    const recs = (json.records || []).map(shape).filter(r => r && r.date);
    recs.sort((a, b) => (a.date < b.date ? 1 : -1));
    d.cache = { at: Date.now(), data: { latest: recs[0] || null, recent: recs.slice(0, 7) } };
    await save(d);
    return res.status(200).json({ ok: true, updated: true });
  } catch (e) {
    // 200 on purpose: the event is not worth five retries, and the 30 minute cache in
    // api/whoop.js is the backstop that makes a missed webhook harmless.
    return res.status(200).json({ ok: true, error: String(e.message || e).slice(0, 120) });
  }
}
