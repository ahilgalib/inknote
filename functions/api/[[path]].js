// Inknote sync API (Cloudflare Pages Functions + D1).
//   GET  /api/config   POST /api/google (Sign in with Google)
//   POST /api/signup  /api/login  /api/logout      GET|PATCH|DELETE /api/me
//   GET  /api/changes?since=N                       POST /api/items
//   POST /api/blobs/missing   PUT|GET /api/blob/:key
const SESSION_DAYS = 400;
const PBKDF2_ITER = 100000;
const CHUNK = 900 * 1024;                 // D1 rows must stay under 2 MB
const MAX_BLOB = 60 * 1024 * 1024;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hashPass(pass, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITER }, key, 256));
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const validKey = (k) => /^[ab]_[A-Za-z0-9_\-]{4,120}$/.test(k);
const GOOGLE_ONLY = 'google';             // pass_hash of accounts created with Google (no password)
const userOut = (u) => ({ id: u.id, email: u.email, name: u.name, created: u.created, google: u.pass_hash === GOOGLE_ONLY || undefined });

// Verify a Google Identity Services ID token (JWT) with Google.
async function verifyGoogle(env, credential) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId || typeof credential !== 'string' || credential.length > 4096) return null;
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!res.ok) return null;
  const t = await res.json();
  const okIss = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
  if (!okIss || t.aud !== clientId || Number(t.exp) * 1000 < Date.now()) return null;
  if (t.email_verified !== true && t.email_verified !== 'true') return null;
  return { email: String(t.email || '').toLowerCase(), name: String(t.name || '').slice(0, 80) };
}

async function limited(env, key, max, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT n, reset FROM attempts WHERE k = ?').bind(key).first();
  if (!row || row.reset < now) { await env.DB.prepare('INSERT OR REPLACE INTO attempts (k, n, reset) VALUES (?, 1, ?)').bind(key, now + windowMs).run(); return false; }
  if (row.n >= max) return true;
  await env.DB.prepare('UPDATE attempts SET n = n + 1 WHERE k = ?').bind(key).run();
  return false;
}

async function startSession(env, userId) {
  const token = randHex(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * 864e5).run();
  return token;
}

function bearer(req) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  return m ? m[1] : null;
}

async function currentUser(env, req) {
  const token = bearer(req);
  if (!token) return null;
  return env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?')
    .bind(await sha256(token), Date.now()).first();
}

async function nextSeq(env, userId) {
  const r = await env.DB.prepare('UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq').bind(userId).first();
  return r.seq;
}

async function deleteBlob(env, userId, key) {
  await env.DB.prepare('DELETE FROM blobs WHERE user_id = ? AND key = ?').bind(userId, key).run();
}

export async function onRequest({ request: req, env, params }) {
  const path = '/' + [].concat(params.path || []).join('/');
  const method = req.method;
  try {
    // ---------- auth ----------
    if (path === '/config' && method === 'GET') return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
    if (path === '/google' && method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const ip = req.headers.get('cf-connecting-ip') || 'x';
      if (await limited(env, 'google:' + ip, 30, 3600e3)) return fail(429, 'Too many attempts, try again later');
      const g = await verifyGoogle(env, b.credential);
      if (!g || !validEmail(g.email)) return fail(401, 'Google sign-in failed — try again');
      let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(g.email).first();
      if (!user) {
        const id = randHex(12);
        await env.DB.prepare('INSERT INTO users (id, email, name, pass_hash, salt, created) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, g.email, g.name || g.email.split('@')[0], GOOGLE_ONLY, randHex(16), Date.now()).run();
        user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      }
      return json({ token: await startSession(env, user.id), user: userOut(user) });
    }
    if (path === '/signup' && method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const email = str(b.email, 200).toLowerCase(), name = str(b.name, 80), password = typeof b.password === 'string' ? b.password : '';
      if (!validEmail(email)) return fail(400, 'Enter a valid email address');
      if (password.length < 8) return fail(400, 'Password must be at least 8 characters');
      const ip = req.headers.get('cf-connecting-ip') || 'x';
      if (await limited(env, 'signup:' + ip, 10, 3600e3)) return fail(429, 'Too many sign-ups, try again later');
      if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) return fail(409, 'An account with this email already exists — sign in instead');
      const id = randHex(12), salt = randHex(16);
      await env.DB.prepare('INSERT INTO users (id, email, name, pass_hash, salt, created) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, email, name || email.split('@')[0], await hashPass(password, salt), salt, Date.now()).run();
      const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      return json({ token: await startSession(env, id), user: userOut(user) });
    }
    if (path === '/login' && method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const email = str(b.email, 200).toLowerCase(), password = typeof b.password === 'string' ? b.password : '';
      if (await limited(env, 'login:' + email, 10, 900e3)) return fail(429, 'Too many attempts — wait 15 minutes');
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      if (user && user.pass_hash === GOOGLE_ONLY) return fail(401, 'This account uses Google — tap “Continue with Google”');
      if (!user || !safeEq(await hashPass(password, user.salt), user.pass_hash)) return fail(401, 'Wrong email or password');
      return json({ token: await startSession(env, user.id), user: userOut(user) });
    }

    const user = await currentUser(env, req);
    if (!user) return fail(401, 'Please sign in');

    if (path === '/logout' && method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(bearer(req))).run();
      return json({ ok: true });
    }
    if (path === '/me') {
      if (method === 'GET') return json({ user: userOut(user) });
      if (method === 'PATCH') {
        const b = await req.json().catch(() => ({}));
        const name = str(b.name, 80);
        if (name) await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, user.id).run();
        return json({ user: userOut({ ...user, name: name || user.name }) });
      }
      if (method === 'DELETE') {
        const b = await req.json().catch(() => ({}));
        if (user.pass_hash === GOOGLE_ONLY) { if (b.password !== 'DELETE') return fail(403, 'Type DELETE to confirm'); }
        else if (!safeEq(await hashPass(String(b.password || ''), user.salt), user.pass_hash)) return fail(403, 'Wrong password');
        await env.DB.batch([
          env.DB.prepare('DELETE FROM blobs WHERE user_id = ?').bind(user.id),
          env.DB.prepare('DELETE FROM items WHERE user_id = ?').bind(user.id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
        ]);
        return json({ ok: true });
      }
    }

    // ---------- sync ----------
    if (path === '/changes' && method === 'GET') {
      const since = Number(new URL(req.url).searchParams.get('since')) || 0;
      const rows = await env.DB.prepare('SELECT kind, id, updated, deleted, seq, data, body_key FROM items WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT 200')
        .bind(user.id, since).all();
      const items = rows.results.map((r) => ({ kind: r.kind, id: r.id, updated: r.updated, deleted: r.deleted, data: r.data ? JSON.parse(r.data) : null, body_key: r.body_key }));
      const cursor = rows.results.length ? rows.results[rows.results.length - 1].seq : since;
      return json({ items, cursor, more: rows.results.length === 200 });
    }
    if (path === '/items' && method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const list = Array.isArray(b.items) ? b.items.slice(0, 100) : [];
      const accepted = [];
      for (const it of list) {
        if (!['note', 'subject', 'prefs'].includes(it.kind) || typeof it.id !== 'string' || it.id.length > 80) continue;
        const updated = Number(it.updated) || 0;
        const cur = await env.DB.prepare('SELECT updated, body_key FROM items WHERE user_id = ? AND kind = ? AND id = ?').bind(user.id, it.kind, it.id).first();
        if (cur && cur.updated > updated) continue; // server copy is newer
        // the client edited an older version than the server has (another device
        // wrote meanwhile): refuse, the client pulls, merges and pushes again
        if (cur && it.kind === 'note' && !it.deleted && it.base != null && Number(it.base) !== cur.updated && cur.updated !== updated) continue;
        const data = it.deleted ? null : JSON.stringify(it.data || {}).slice(0, 400000);
        const bodyKey = it.deleted ? null : (it.kind === 'note' && validKey(it.body_key || '') ? it.body_key : null);
        const seq = await nextSeq(env, user.id);
        await env.DB.prepare('INSERT OR REPLACE INTO items (user_id, kind, id, updated, deleted, seq, data, body_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(user.id, it.kind, it.id, updated, it.deleted ? 1 : 0, seq, data, bodyKey).run();
        if (cur && cur.body_key && cur.body_key !== bodyKey) await deleteBlob(env, user.id, cur.body_key);
        accepted.push(it.kind + ':' + it.id);
      }
      return json({ accepted });
    }
    if (path === '/blobs/missing' && method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const keys = (Array.isArray(b.keys) ? b.keys : []).filter(validKey).slice(0, 500);
      const missing = [];
      for (let i = 0; i < keys.length; i += 50) {
        const part = keys.slice(i, i + 50);
        const rows = await env.DB.prepare(`SELECT DISTINCT key FROM blobs WHERE user_id = ? AND part = 0 AND key IN (${part.map(() => '?').join(',')})`)
          .bind(user.id, ...part).all();
        const have = new Set(rows.results.map((r) => r.key));
        for (const k of part) if (!have.has(k)) missing.push(k);
      }
      return json({ missing });
    }
    const bm = path.match(/^\/blob\/(.+)$/);
    if (bm) {
      const key = decodeURIComponent(bm[1]);
      if (!validKey(key)) return fail(400, 'Bad key');
      if (method === 'PUT') {
        const buf = new Uint8Array(await req.arrayBuffer());
        if (!buf.length || buf.length > MAX_BLOB) return fail(413, 'File too large');
        const parts = Math.ceil(buf.length / CHUNK);
        await deleteBlob(env, user.id, key);
        const stmts = [];
        for (let p = 0; p < parts; p++) {
          stmts.push(env.DB.prepare('INSERT INTO blobs (user_id, key, part, parts, data) VALUES (?, ?, ?, ?, ?)')
            .bind(user.id, key, p, parts, buf.subarray(p * CHUNK, (p + 1) * CHUNK)));
        }
        for (let i = 0; i < stmts.length; i += 5) await env.DB.batch(stmts.slice(i, i + 5));
        return json({ ok: true, parts });
      }
      if (method === 'GET') {
        const first = await env.DB.prepare('SELECT parts FROM blobs WHERE user_id = ? AND key = ? AND part = 0').bind(user.id, key).first();
        if (!first) return fail(404, 'Not found');
        const chunks = [];
        for (let p = 0; p < first.parts; p++) {
          const row = await env.DB.prepare('SELECT data FROM blobs WHERE user_id = ? AND key = ? AND part = ?').bind(user.id, key, p).first();
          if (!row) return fail(404, 'Incomplete');
          chunks.push(new Uint8Array(row.data));
        }
        return new Response(new Blob(chunks), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
      }
    }
    return fail(404, 'Not found');
  } catch (e) {
    return fail(500, 'Server error: ' + (e && e.message ? e.message : e));
  }
}
