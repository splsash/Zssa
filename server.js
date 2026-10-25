/* فِرْقَةُ SSA — خادم بدون مكتبات خارجية (Node 18+)
   التخزين: Upstash Redis إذا ضُبطت متغيراته، وإلا ملف محلي (مؤقت). */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT        = process.env.PORT || 3000;
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, "data");
const ACCESS_CODE = process.env.ACCESS_CODE || "19.13.008.2";
const ADMIN_USER  = (process.env.ADMIN_USER || "ssa_admin").toLowerCase();
const ADMIN_PASS  = process.env.ADMIN_PASS || "SSA@Admin#2026";
const UP_URL      = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN    = process.env.UPSTASH_REDIS_REST_TOKEN;
const REMOTE      = !!(UP_URL && UP_TOKEN);
const DB_FILE     = path.join(DATA_DIR, "db.json");
const FX_KEYS     = ["echo", "radio", "garble", "bass", "loud"];
const LOCKED_KEYS = ["radio", "garble", "bass", "loud"];

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

/* ---------------- التخزين ---------------- */
async function upstash(cmd) {
  const r = await fetch(UP_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + UP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || ("HTTP " + r.status));
  return j.result;
}
let db = { users: {}, sessions: {} };
let dirty = false, writing = false, lastSaveOk = true, lastSaveAt = 0;

function writeLocal() {
  try {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error("تعذّر حفظ الملف المحلي:", e.message); }
}
async function flush() {
  if (!REMOTE || writing) return;
  writing = true;
  try {
    while (dirty) { dirty = false; await upstash(["SET", "ssa_db", JSON.stringify(db)]); lastSaveOk = true; lastSaveAt = Date.now(); }
  } catch (e) {
    console.error("فشل الحفظ في Upstash:", e.message);
    lastSaveOk = false; dirty = true;
    setTimeout(() => { writing = false; flush(); }, 3000);
    return;
  }
  writing = false;
}
function save() {
  const cut = Date.now() - 30 * 24 * 3600 * 1000;
  for (const t in db.sessions) if (db.sessions[t].created < cut) delete db.sessions[t];
  writeLocal(); dirty = true; flush();
}
async function loadDB() {
  let local = null;
  try { local = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}
  if (!REMOTE) return local || { users: {}, sessions: {} };
  for (let i = 0; i < 5; i++) {
    try {
      const v = await upstash(["GET", "ssa_db"]);
      if (v) return JSON.parse(v);
      return local || { users: {}, sessions: {} };
    } catch (e) {
      console.error("تعذّر قراءة Upstash، محاولة", i + 1, "—", e.message);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  console.error("لم أستطع الاتصال بقاعدة البيانات — إيقاف الخادم حتى لا تُمسح البيانات.");
  process.exit(1);
}

/* ---------------- أدوات ---------------- */
const hashPass = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";
const digits = s => String(s || "").replace(/[٠-٩]/g, d => AR.indexOf(d)).replace(/[۰-۹]/g, d => FA.indexOf(d));

function newId() {
  const used = new Set(Object.values(db.users).map(u => u.id));
  let id; do { id = String(Math.floor(10000 + Math.random() * 90000)); } while (used.has(id));
  return id;
}
function ensure(u) {
  if (!u.fxOpen) u.fxOpen = { radio: false, garble: false, bass: false, loud: false };
  if (!u.id) u.id = newId();
  return u;
}
const openMap = u => { ensure(u); const o = { echo: true }; LOCKED_KEYS.forEach(k => o[k] = !!u.fxOpen[k]); return o; };
function banState(u) {
  if (!u.ban) return null;
  if (u.ban.permanent) return { permanent: true };
  if (u.ban.until > Date.now()) return { until: u.ban.until };
  return null;
}
const view = u => ({
  role: "user", username: u.username, id: u.id, open: openMap(u),
  ban: banState(u), fx: u.fx || {}, volume: u.volume ?? 100
});
const adminView = u => ({
  username: u.username, id: u.id, open: openMap(u),
  ban: banState(u), created: u.created || null
});

const fails = new Map();
const limited = ip => { const f = fails.get(ip); return f && f.n >= 10 && Date.now() < f.t; };
const fail = ip => { const f = fails.get(ip) || { n: 0, t: 0 }; f.n++; f.t = Date.now() + 10 * 60 * 1000; fails.set(ip, f); };
const okIp = ip => fails.delete(ip);

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise(resolve => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 20000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (e) { resolve({}); } });
  });
}
function auth(req) {
  const t = (req.headers.authorization || "").replace("Bearer ", "");
  const s = db.sessions[t];
  if (!s) return null;
  if (s.role === "admin") return { token: t, role: "admin" };
  const u = db.users[s.key];
  return u ? { token: t, role: "user", key: s.key, user: ensure(u) } : null;
}
function newSession(role, key) {
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions[token] = { role, key, created: Date.now() };
  return token;
}
const adminMe = () => ({
  role: "admin", username: ADMIN_USER,
  count: Object.keys(db.users).length,
  banned: Object.values(db.users).filter(u => banState(u)).length,
  storage: REMOTE ? (lastSaveOk ? "دائم (Upstash)" : "خطأ في الحفظ") : "مؤقت (ملف محلي)",
  storageRemote: REMOTE,
  lastSaveAt
});

/* ---------------- الواجهة البرمجية ---------------- */
async function api(req, res, url) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const route = url.pathname.replace("/api/", "");
  const b = req.method === "POST" ? await body(req) : {};

  if (route === "health") return send(res, 200, { ok: true, storage: REMOTE ? "upstash" : "local", ts: Date.now() });

  if (route === "code") {
    if (limited(ip)) return send(res, 429, { error: "محاولات كثيرة، انتظر قليلاً" });
    if (String(b.code || "").trim() !== ACCESS_CODE) { fail(ip); return send(res, 403, { error: "الرمز غير صحيح" }); }
    okIp(ip); return send(res, 200, { ok: true });
  }

  if (route === "register" || route === "login") {
    if (limited(ip)) return send(res, 429, { error: "محاولات كثيرة، انتظر قليلاً" });
    if (String(b.code || "").trim() !== ACCESS_CODE) return send(res, 403, { error: "code", message: "الرمز غير صحيح" });
    const name = String(b.username || "").trim(), pass = String(b.password || "");
    const key = name.toLowerCase();

    if (route === "register") {
      if (!/^[\u0600-\u06FFa-zA-Z0-9_\- ]{3,20}$/.test(name))
        return send(res, 400, { error: "اسم المستخدم 3–20 حرفاً (عربي/إنجليزي/أرقام/شرطة سفلية فقط)" });
      if (pass.length < 4 || pass.length > 100) return send(res, 400, { error: "كلمة المرور 4 أحرف على الأقل" });
      if (key === ADMIN_USER || db.users[key]) return send(res, 409, { error: "اسم المستخدم مستخدم من قبل" });
      const salt = crypto.randomBytes(16).toString("hex");
      db.users[key] = {
        username: name, salt, pass: hashPass(pass, salt), id: newId(),
        fxOpen: { radio: false, garble: false, bass: false, loud: false },
        ban: null, fx: {}, volume: 100, created: Date.now()
      };
      const token = newSession("user", key); save();
      return send(res, 200, { token, me: view(db.users[key]) });
    }
    if (key === ADMIN_USER) {
      if (!same(pass, ADMIN_PASS)) { fail(ip); return send(res, 401, { error: "بيانات الدخول غير صحيحة" }); }
      okIp(ip);
      const token = newSession("admin", ADMIN_USER); save();
      return send(res, 200, { token, me: adminMe() });
    }
    const u = db.users[key];
    if (!u || !same(hashPass(pass, u.salt), u.pass)) { fail(ip); return send(res, 401, { error: "بيانات الدخول غير صحيحة" }); }
    okIp(ip); ensure(u);
    const token = newSession("user", key); save();
    return send(res, 200, { token, me: view(u) });
  }

  const a = auth(req);
  if (!a) return send(res, 401, { error: "انتهت الجلسة" });

  if (route === "me") return send(res, 200, { me: a.role === "admin" ? adminMe() : view(a.user) });
  if (route === "logout") { delete db.sessions[a.token]; save(); return send(res, 200, { ok: true }); }

  if (route === "settings") {
    if (a.role !== "user") return send(res, 403, { error: "غير مسموح" });
    if (banState(a.user)) return send(res, 403, { error: "الحساب محظور" });
    if (b.fx && typeof b.fx === "object") {
      const open = openMap(a.user); a.user.fx = {};
      FX_KEYS.forEach(k => { if (b.fx[k] === true && open[k]) a.user.fx[k] = true; });
    }
    if (typeof b.volume === "number" && isFinite(b.volume))
      a.user.volume = Math.max(0, Math.min(1008, Math.round(b.volume)));
    save(); return send(res, 200, { ok: true });
  }

  /* ----- الإدارة ----- */
  if (route.startsWith("admin/")) {
    if (a.role !== "admin") return send(res, 403, { error: "للإدارة فقط" });
    const findById = id => Object.values(db.users).find(u => u.id === digits(id).trim());

    if (route === "admin/users") {
      const list = Object.values(db.users)
        .map(u => ({ id: ensure(u).id, username: u.username, banned: !!banState(u) }))
        .sort((x, y) => x.username.localeCompare(y.username));
      return send(res, 200, { users: list });
    }
    if (route === "admin/find") {
      const q = digits(url.searchParams.get("q")).trim();
      if (!q) return send(res, 400, { error: "اكتب المعرّف أو اسم المستخدم" });
      let u = findById(q) || db.users[q.toLowerCase()];
      if (!u) u = Object.values(db.users).find(x => x.username.toLowerCase().includes(q.toLowerCase()));
      return u ? send(res, 200, { user: adminView(ensure(u)) }) : send(res, 404, { error: "لا يوجد مستخدم بهذا المعرّف أو الاسم" });
    }
    if (route === "admin/user") {
      const u = findById(url.searchParams.get("id"));
      return u ? send(res, 200, { user: adminView(ensure(u)) }) : send(res, 404, { error: "لا يوجد مستخدم بهذا المعرّف" });
    }
    if (route === "admin/delete") {
      const u = findById(b.id);
      if (!u) return send(res, 404, { error: "لا يوجد مستخدم بهذا المعرّف" });
      const key = u.username.toLowerCase();
      delete db.users[key];
      for (const t in db.sessions) if (db.sessions[t].key === key) delete db.sessions[t];
      save(); return send(res, 200, { ok: true });
    }

    const u = findById(b.id);
    if (!u) return send(res, 404, { error: "لا يوجد مستخدم بهذا المعرّف" });
    ensure(u);

    if (route === "admin/ban") {
      if (b.permanent) u.ban = { permanent: true };
      else {
        const t = Number(b.until);
        if (!t || t <= Date.now()) return send(res, 400, { error: "اختر وقتاً في المستقبل" });
        u.ban = { permanent: false, until: t };
      }
    } else if (route === "admin/unban") u.ban = null;
    else if (route === "admin/features") {
      LOCKED_KEYS.forEach(k => u.fxOpen[k] = !!b.on);
      if (!b.on) LOCKED_KEYS.forEach(k => { if (u.fx) delete u.fx[k]; });
    } else if (route === "admin/feature") {
      if (!LOCKED_KEYS.includes(b.key)) return send(res, 400, { error: "ميزة غير صالحة" });
      u.fxOpen[b.key] = !!b.on;
      if (!b.on && u.fx) delete u.fx[b.key];
    } else return send(res, 404, { error: "غير موجود" });

    save(); return send(res, 200, { user: adminView(u) });
  }
  send(res, 404, { error: "غير موجود" });
}

/* ---------------- الملفات الثابتة ---------------- */
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#3a1b63"/><stop offset="1" stop-color="#07060b"/></radialGradient><radialGradient id="c"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="#c4153f"/><stop offset="1" stop-color="#c4153f" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="256" r="170" fill="none" stroke="#c4153f" stroke-width="4" opacity=".8"/><circle cx="256" cy="256" r="60" fill="url(#c)"/><text x="256" y="440" font-family="serif" font-size="84" font-weight="700" text-anchor="middle" fill="#e9e2d6">SSA</text></svg>';
const MANIFEST = JSON.stringify({
  name: "فِرْقَةُ SSA", short_name: "SSA", lang: "ar", dir: "rtl",
  start_url: "/", scope: "/", display: "standalone", orientation: "portrait",
  background_color: "#07060b", theme_color: "#07060b",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }]
});
const SW = 'self.addEventListener("install",e=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));';
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"]
};
const INLINE = {
  "/icon.svg": [ICON, "image/svg+xml"],
  "/manifest.webmanifest": [MANIFEST, "application/manifest+json"],
  "/sw.js": [SW, "text/javascript; charset=utf-8"]
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const f = FILES[url.pathname];
    if (f) {
      res.writeHead(200, { "Content-Type": f[1], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      return fs.createReadStream(path.join(__dirname, f[0])).pipe(res);
    }
    const i = INLINE[url.pathname];
    if (i) { res.writeHead(200, { "Content-Type": i[1], "Cache-Control": "no-cache" }); return res.end(i[0]); }
    res.writeHead(404); res.end("404");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "خطأ في الخادم" });
  }
});

loadDB().then(d => {
  db = Object.assign({ users: {}, sessions: {} }, d);
  Object.values(db.users).forEach(ensure);
  server.listen(PORT, () => console.log("SSA يعمل — التخزين: " + (REMOTE ? "Upstash (دائم)" : "ملف محلي (مؤقت)") + " — المنفذ " + PORT));
});
