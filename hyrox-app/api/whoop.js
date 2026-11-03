// WHOOP recovery for the HYROX tracker.
//
// Env vars (Vercel project settings, NEVER in the repo — this repo is public):
//   WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET
//   WHOOP_SCOPES   optional override, e.g. "read:recovery offline" if the WHOOP app
//                  was created with fewer scopes ticked than DEFAULT_SCOPES asks for.
//
// Tokens and the cached recovery live in their OWN Blob file, not in hyrox/log.json.
// That is deliberate: data.js does load-modify-save with no locking, so sharing a file
// would let a training write and a token refresh clobber each other.
//
// Unlike data.js, nothing here is public. WHOOP data is health data, so every op
// requires the admin passcode. The privacy policy at /privacy.html promises this.
import { get, put } from "@vercel/blob";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

const FILE = "hyrox/whoop.json";
const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
// v2 is current (July 2025). Fall back to v1 if a path 404s, so a base-path change
// does not silently break the card.
const API_BASES = ["https://api.prod.whoop.com/developer/v2", "https://api.prod.whoop.com/developer/v1"];
const DEFAULT_SCOPES = "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline";
const CACHE_MS = 30 * 60 * 1000;  // recovery updates about once a day; no reason to poll harder
const STATE_MS = 10 * 60 * 1000;  // an authorisation link is good for ten minutes

const env = k => (process.env[k] || "").trim();
const scopes = () => env("WHOOP_SCOPES") || DEFAULT_SCOPES;
const hash = s => createHash("sha256").update(String(s || "")).digest();

// Admin only. Noé has his own login for training data but no business seeing Axel's HRV.
function isAdmin(given) {
  const pass = process.env.APP_PASSCODE;
  return !!pass && !!given && timingSafeEqual(hash(given), hash(pass));
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

function redirectUri(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}/api/whoop`;
}

// WHOOP's token endpoint registers clients with a specific authentication method.
// client_secret_basic (credentials in an HTTP Basic header) is the common default and
// what the endpoint layout suggests; client_secret_post (credentials in the form body)
// is the other. Sending the wrong one returns 401 "Client authentication failed", which
// looks identical to a wrong secret. So try Basic, then fall back to the body.
async function postForm(params) {
  const id = env("WHOOP_CLIENT_ID"), secret = env("WHOOP_CLIENT_SECRET");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const attempts = [
    { name: "basic", headers: { authorization: `Basic ${basic}` }, body: params },
    { name: "post", headers: {}, body: { ...params, client_id: id, client_secret: secret } },
  ];
  let last = "";
  for (const a of attempts) {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...a.headers },
      body: new URLSearchParams(a.body).toString(),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (r.ok) return json;
    last = `${a.name} auth -> ${r.status}: ${(json && (json.error_description || json.error)) || text.slice(0, 160)}`;
    // Only an authentication failure is worth retrying with the other method. A bad or
    // already-used code fails the same way whichever method is used.
    const err = json && json.error;
    if (r.status !== 401 && err !== "invalid_client") break;
  }
  throw new Error(`WHOOP token request failed. Last attempt: ${last}`);
}

function store(d, t) {
  d.tokens = {
    access: t.access_token,
    refresh: t.refresh_token || (d.tokens && d.tokens.refresh) || null,
    expires: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000, // refresh a minute early
  };
  return d;
}

// Returns a valid access token, refreshing if needed. Refreshing invalidates the old
// refresh token, and WHOOP rejects concurrent refreshes, so this must stay single-caller.
// The 30 minute cache on recovery is what keeps that true in practice.
async function token(d) {
  if (!d.tokens || !d.tokens.refresh) return null;
  if (d.tokens.access && Date.now() < d.tokens.expires) return d.tokens.access;
  const t = await postForm({
    grant_type: "refresh_token",
    refresh_token: d.tokens.refresh,
    scope: "offline",
  });
  store(d, t);
  await save(d);
  return d.tokens.access;
}

async function apiGet(path, access) {
  let last = null;
  for (const base of API_BASES) {
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${access}` } });
    if (r.status === 404) { last = r; continue; }
    if (r.status === 401) throw new Error("unauthorised");
    if (r.status === 429) throw new Error("WHOOP rate limit hit. Try again in a minute.");
    if (!r.ok) { last = r; continue; }
    return await r.json();
  }
  throw new Error(`WHOOP API error${last ? ` (${last.status})` : ""}`);
}

// One tidy recovery record, or null while WHOOP is still scoring the night.
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
  res.setHeader("X-Content-Type-Options", "nosniff");

  const id = env("WHOOP_CLIENT_ID"), secret = env("WHOOP_CLIENT_SECRET");
  if (!id || !secret) return res.status(500).json({ error: "Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in Vercel, then redeploy." });

  try {
    // --- OAuth callback. A browser redirect, so it is a GET and carries no passcode.
    // The one-time state proves this flow was started by someone holding the passcode.
    if (req.method === "GET") {
      const url = new URL(req.url, `https://${req.headers["x-forwarded-host"] || req.headers.host}`);
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      const denied = url.searchParams.get("error");
      if (denied) return res.redirect(302, "/?whoop=denied#train");
      if (!code || !state) return res.status(400).json({ error: "Nothing to do here." });

      const d = await load();
      if (!d.state || d.state.v !== state || Date.now() > d.state.exp) {
        return res.redirect(302, "/?whoop=badstate#train");
      }
      delete d.state;
      const t = await postForm({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(req),
      });
      store(d, t);
      d.linkedAt = new Date().toISOString();
      delete d.cache;
      await save(d);
      return res.redirect(302, "/?whoop=linked#train");
    }

    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });
    if (!isAdmin(req.headers["x-app-pass"])) {
      await new Promise(r => setTimeout(r, 1500));
      return res.status(401).json({ error: "WHOOP data needs Axel's passcode." });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const d = await load();

    if (body.op === "status") {
      return res.status(200).json({ linked: !!(d.tokens && d.tokens.refresh), linkedAt: d.linkedAt || null });
    }

    if (body.op === "link") {
      const v = randomBytes(4).toString("hex"); // WHOOP requires state to be 8 characters
      d.state = { v, exp: Date.now() + STATE_MS };
      await save(d);
      const q = new URLSearchParams({
        client_id: id, response_type: "code", redirect_uri: redirectUri(req),
        scope: scopes(), state: v,
      });
      return res.status(200).json({ url: `${AUTH_URL}?${q}` });
    }

    if (body.op === "unlink") {
      await save({});  // tokens and cached recovery both gone, as the privacy policy says
      return res.status(200).json({ linked: false });
    }

    if (body.op === "recovery") {
      if (!d.tokens || !d.tokens.refresh) return res.status(200).json({ linked: false });
      const fresh = body.force || !d.cache || Date.now() - d.cache.at > CACHE_MS;
      if (!fresh) return res.status(200).json({ linked: true, cached: true, ...d.cache.data });

      let access;
      try { access = await token(d); }
      catch (e) { return res.status(200).json({ linked: true, error: "WHOOP sign-in expired. Reconnect to fix it.", expired: true }); }

      let json;
      try { json = await apiGet("/recovery?limit=7", access); }
      catch (e) {
        if (String(e.message) === "unauthorised") return res.status(200).json({ linked: true, error: "WHOOP sign-in expired. Reconnect to fix it.", expired: true });
        // Serve stale rather than nothing: a day-old recovery score still beats a blank card.
        if (d.cache) return res.status(200).json({ linked: true, cached: true, stale: true, ...d.cache.data });
        return res.status(200).json({ linked: true, error: e.message });
      }

      const recs = (json.records || []).map(shape).filter(r => r && r.date);
      recs.sort((a, b) => (a.date < b.date ? 1 : -1));
      const data = { latest: recs[0] || null, recent: recs.slice(0, 7) };
      d.cache = { at: Date.now(), data };
      await save(d);
      return res.status(200).json({ linked: true, cached: false, ...data });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
