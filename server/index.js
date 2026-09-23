/**
 * Calida Analyst — server
 *  - Phục vụ giao diện và dashboard đã đăng nhập
 *  - API Gemini, nhập báo cáo và chạy pipeline
 *  - Lịch pipeline mỗi ngày làm việc theo giờ Việt Nam
 */
import express from "express";
import helmet from "helmet";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import webpush from "web-push";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- environment ----------
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
process.env.TZ = process.env.TZ || "Asia/Ho_Chi_Minh";

const PORT = Number(process.env.PORT || 8080);
const NODE_ENV = process.env.NODE_ENV || "development";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const PYTHON = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const PIPELINE_TIME = process.env.PIPELINE_TIME ?? "16:30";
const PIPELINE_TIMEOUT_MS = Number(process.env.PIPELINE_TIMEOUT_MS || 20 * 60 * 1000);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60 * 1000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const SESSION_TTL_HOURS = Math.min(24 * 7, Math.max(1, Number(process.env.SESSION_TTL_HOURS || 8)));
const COOKIE_NAME = "calida_session";
const WEB_DIR = path.join(ROOT, "web");
const JSON_PATH = path.join(WEB_DIR, "data", "dashboard.json");
// Có thể tách state khi kiểm thử; trên Railway mặc định vẫn là /app/data.
const STATE_DIR = path.resolve(process.env.CALIDA_DATA_DIR || path.join(ROOT, "data"));
const REPORT_JOBS = path.join(STATE_DIR, "inbox", "report_jobs.jsonl");
const LOG_DIR = path.join(STATE_DIR, "logs");
const AUDIT_LOG = path.join(LOG_DIR, "audit.jsonl");
const USER_STORE_DIR = path.join(STATE_DIR, "auth");
const USER_STORE = path.join(USER_STORE_DIR, "users.json");
const WORKSPACE_STORE = path.join(STATE_DIR, "workspace-state.json");
const PUSH_STORE = path.join(STATE_DIR, "push-subscriptions.json");
const ROLE_RANK = Object.freeze({ viewer: 0, analyst: 1, admin: 2 });
const isRole = (role) => Object.hasOwn(ROLE_RANK, role);
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;
const MODULES = Object.freeze(["overview", "brief", "portfolio", "flows", "funds", "reports", "actions", "signals", "admin"]);
const MODULE_SET = new Set(MODULES);
const STARTED_AT = new Date().toISOString();
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "";
let PUSH_ENABLED = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    PUSH_ENABLED = true;
  } catch (error) {
    console.error(`VAPID không hợp lệ; Web Push đang tắt: ${error.message}`);
  }
}

fs.mkdirSync(path.dirname(REPORT_JOBS), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(USER_STORE_DIR, { recursive: true });

function audit(req, action, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    actor: req?.user?.u || "system",
    action,
    details,
  };
  try { fs.appendFileSync(AUDIT_LOG, `${JSON.stringify(entry)}\n`, "utf8"); }
  catch (error) { console.error(`Không ghi được audit log: ${error.message}`); }
}

function recentAudit(limit = 30) {
  try {
    return fs.readFileSync(AUDIT_LOG, "utf8").trim().split(/\r?\n/).slice(-limit).reverse()
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Endpoint readiness phải nhẹ, không phụ thuộc vào Google Sheets/vnstock. Railway
// dùng nó trong lúc deploy; lỗi một lần đồng bộ không được làm tiến trình web chết.
function dashboardReadiness() {
  try {
    const stat = fs.statSync(JSON_PATH);
    if (!stat.isFile() || stat.size === 0) throw new Error("dashboard.json rỗng");
    const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    if (!data || !Array.isArray(data.reports)) throw new Error("dashboard.json không đúng định dạng");
    return {
      ready: true,
      asOf: data.asOf || null,
      generatedAt: data.meta?.generatedAt || null,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return { ready: false };
  }
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function matchesPassword(password, storedHash) {
  const [scheme, salt, expected, ...rest] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || !salt || !expected || rest.length) return false;
  try {
    const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), 64);
    return sameSecret(actual.toString("base64url"), expected);
  } catch { return false; }
}

function validateNewUser(username, password, role) {
  if (!USERNAME_RE.test(username)) throw new Error("Tên đăng nhập chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang (3–64 ký tự)");
  if (typeof password !== "string" || password.length < 12 || password.length > 200) throw new Error("Mật khẩu phải có từ 12 đến 200 ký tự");
  if (!isRole(role)) throw new Error("Vai trò phải là viewer, analyst hoặc admin");
}

function defaultPermissions(role) {
  const allView = Object.fromEntries(MODULES.map((module) => [module, { view: module !== "admin", edit: false }]));
  if (role === "analyst") ["reports", "actions", "signals"].forEach((module) => { allView[module].edit = true; });
  if (role === "admin") return Object.fromEntries(MODULES.map((module) => [module, { view: true, edit: true }]));
  return allView;
}

function readWorkspaceState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACE_STORE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid workspace state");
    return { actions: parsed.actions && typeof parsed.actions === "object" ? parsed.actions : {}, signals: parsed.signals && typeof parsed.signals === "object" ? parsed.signals : {} };
  } catch (error) {
    if (error.code === "ENOENT") return { actions: {}, signals: {} };
    console.error(`Không đọc được workspace state: ${error.message}`);
    return { actions: {}, signals: {} };
  }
}

function writeWorkspaceState(state) {
  const safe = { actions: state.actions || {}, signals: state.signals || {} };
  const temp = `${WORKSPACE_STORE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(safe, null, 2), "utf8");
  fs.renameSync(temp, WORKSPACE_STORE);
  return safe;
}

const PUSH_PREFERENCES = Object.freeze(["signals", "actions", "pipeline"]);
const defaultPushPreferences = () => ({ signals: true, actions: true, pipeline: true });

function cleanPushPreferences(value) {
  const preferences = defaultPushPreferences();
  if (!value || typeof value !== "object" || Array.isArray(value)) return preferences;
  for (const key of PUSH_PREFERENCES) if (typeof value[key] === "boolean") preferences[key] = value[key];
  return preferences;
}

function cleanPushSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gói đăng ký thông báo không hợp lệ");
  const endpoint = String(value.endpoint || "").trim();
  const p256dh = String(value.keys?.p256dh || "").trim();
  const auth = String(value.keys?.auth || "").trim();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") throw new Error("endpoint phải dùng HTTPS");
  } catch { throw new Error("Endpoint thông báo không hợp lệ"); }
  if (!p256dh || !auth || p256dh.length > 1024 || auth.length > 1024) throw new Error("Khóa đăng ký thông báo không hợp lệ");
  return { endpoint, expirationTime: Number.isFinite(value.expirationTime) ? value.expirationTime : null, keys: { p256dh, auth } };
}

function readPushStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PUSH_STORE, "utf8"));
    if (!parsed || !Array.isArray(parsed.subscriptions)) throw new Error("invalid push store");
    return parsed.subscriptions.filter((entry) => {
      try { cleanPushSubscription(entry.subscription); return USERNAME_RE.test(entry.username || ""); }
      catch { return false; }
    }).map((entry) => ({
      username: entry.username,
      subscription: cleanPushSubscription(entry.subscription),
      preferences: cleanPushPreferences(entry.preferences),
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
    }));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.error(`Không đọc được kho đăng ký thông báo: ${error.message}`);
    return [];
  }
}

function writePushStore(subscriptions) {
  const temp = `${PUSH_STORE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, subscriptions }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, PUSH_STORE);
}

function savePushSubscription(username, rawSubscription, rawPreferences) {
  const subscription = cleanPushSubscription(rawSubscription);
  const current = readPushStore();
  const now = new Date().toISOString();
  const previous = current.find((entry) => entry.username === username && entry.subscription.endpoint === subscription.endpoint);
  const next = current.filter((entry) => entry.subscription.endpoint !== subscription.endpoint);
  next.push({ username, subscription, preferences: cleanPushPreferences(rawPreferences), createdAt: previous?.createdAt || now, updatedAt: now });
  writePushStore(next);
  return { subscription, preferences: cleanPushPreferences(rawPreferences) };
}

function removePushSubscription(username, endpoint) {
  const current = readPushStore();
  const next = current.filter((entry) => entry.username !== username || (endpoint && entry.subscription.endpoint !== endpoint));
  if (next.length !== current.length) writePushStore(next);
  return current.length - next.length;
}

async function dispatchPush({ preference, module, title, body, url = "/", tag = "calida" }) {
  if (!PUSH_ENABLED) return { delivered: 0, skipped: true };
  const candidates = readPushStore().filter((entry) => {
    const user = findUser(entry.username);
    return user && entry.preferences[preference] && hasModulePermission(user, module, "view");
  });
  const expired = new Set();
  let delivered = 0;
  for (const entry of candidates) {
    try {
      await webpush.sendNotification(entry.subscription, JSON.stringify({ title, body, url, tag }), { TTL: 300, urgency: "high" });
      delivered += 1;
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) expired.add(entry.subscription.endpoint);
      else console.error(`Không gửi được push tới ${entry.username}: ${error.message}`);
    }
  }
  if (expired.size) writePushStore(readPushStore().filter((entry) => !expired.has(entry.subscription.endpoint)));
  return { delivered, skipped: false };
}

function queuePush(payload) {
  void dispatchPush(payload).catch((error) => console.error(`Push notification lỗi: ${error.message}`));
}

function publicWorkspaceState(user) {
  const state = readWorkspaceState();
  return {
    actions: hasModulePermission(user, "actions") ? state.actions : {},
    signals: hasModulePermission(user, "signals") ? state.signals : {},
  };
}

function normalizePermissionOverrides(raw, role) {
  if (raw == null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Quyền theo module không hợp lệ");
  const normalized = {};
  for (const [module, value] of Object.entries(raw)) {
    if (!MODULE_SET.has(module) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Module phân quyền không hợp lệ");
    const permission = {};
    for (const action of ["view", "edit"]) {
      if (Object.hasOwn(value, action)) {
        if (typeof value[action] !== "boolean") throw new Error("Quyền module phải là true hoặc false");
        permission[action] = value[action];
      }
    }
    if (!Object.keys(permission).length || Object.keys(value).some((key) => key !== "view" && key !== "edit")) throw new Error("Quyền module không hợp lệ");
    if (permission.view === false && permission.edit === true) throw new Error("Không thể cấp quyền chỉnh sửa khi đã tắt quyền xem module");
    if (module === "admin" && role !== "admin" && (permission.view || permission.edit)) throw new Error("Chỉ tài khoản có vai trò admin mới được cấp quyền quản trị");
    normalized[module] = permission;
  }
  return normalized;
}

function effectivePermissions(user) {
  const permissions = defaultPermissions(user?.role || "viewer");
  const overrides = user?.permissions || {};
  for (const module of MODULES) {
    const override = overrides[module];
    if (!override) continue;
    if (typeof override.view === "boolean") permissions[module].view = override.view;
    if (typeof override.edit === "boolean") permissions[module].edit = override.edit;
    if (!permissions[module].view) permissions[module].edit = false;
  }
  if (user?.role !== "admin") permissions.admin = { view: false, edit: false };
  return permissions;
}

function hasModulePermission(user, module, action = "view") {
  return Boolean(MODULE_SET.has(module) && ["view", "edit"].includes(action) && effectivePermissions(user)[module]?.[action]);
}

function asStoredUser(user, createdAt = new Date().toISOString()) {
  const username = String(user?.username || "").trim();
  const password = String(user?.password || "");
  const role = String(user?.role || "").toLowerCase();
  if (!USERNAME_RE.test(username) || !password || password.length > 200 || !isRole(role)) {
    throw new Error("CALIDA_USERS_JSON cần username hợp lệ, password và role viewer/analyst/admin");
  }
  return {
    username,
    role,
    permissions: normalizePermissionOverrides(user?.permissions, role),
    passwordHash: passwordHash(password),
    sessionVersion: crypto.randomBytes(16).toString("base64url"),
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function validateStoredUsers(users) {
  if (!Array.isArray(users) || !users.length) throw new Error("Danh sách người dùng phải có ít nhất một tài khoản");
  const seen = new Set();
  for (const user of users) {
    const [scheme, salt, hash, ...rest] = String(user?.passwordHash || "").split("$");
    if (!USERNAME_RE.test(user?.username || "") || !isRole(user?.role) || scheme !== "scrypt" || !salt || !hash || rest.length || !user?.sessionVersion || seen.has(user.username)) {
      throw new Error("Kho người dùng không hợp lệ; hãy khôi phục users.json từ bản backup Railway Volume");
    }
    normalizePermissionOverrides(user.permissions, user.role);
    seen.add(user.username);
  }
  if (!users.some((user) => user.role === "admin")) throw new Error("Kho người dùng phải có ít nhất một admin");
  return users;
}

function readUserStore() {
  if (!fs.existsSync(USER_STORE)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(USER_STORE, "utf8")); }
  catch { throw new Error("Không đọc được data/auth/users.json"); }
  return validateStoredUsers(parsed?.users);
}

function loadBootstrapUsers() {
  const raw = process.env.CALIDA_USERS_JSON;
  let parsed;
  if (!raw) parsed = ACCESS_TOKEN ? [{ username: "admin", password: ACCESS_TOKEN, role: "admin" }] : [];
  else {
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("CALIDA_USERS_JSON phải là một JSON array hợp lệ"); }
  }
  if (!Array.isArray(parsed)) throw new Error("CALIDA_USERS_JSON phải là một JSON array hợp lệ");
  if (!parsed.length) return [];
  const seen = new Set();
  return parsed.map((user) => {
    const stored = asStoredUser(user);
    if (seen.has(stored.username)) throw new Error("CALIDA_USERS_JSON chứa username trùng lặp");
    seen.add(stored.username);
    return stored;
  });
}

function loadUsers() { return readUserStore() || loadBootstrapUsers(); }

function writeUserStore(users) {
  validateStoredUsers(users);
  const temp = `${USER_STORE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, USER_STORE);
}

let USERS = loadUsers();
const authEnabled = () => USERS.length > 0;
const SESSION_SECRET = process.env.SESSION_SECRET || (ACCESS_TOKEN
  ? crypto.createHash("sha256").update(`calida-session:${ACCESS_TOKEN}`).digest("hex")
  : authEnabled() ? crypto.randomBytes(32).toString("base64url") : "");
if (authEnabled() && !process.env.SESSION_SECRET) console.warn("SESSION_SECRET chưa được đặt; phiên sẽ bị đăng xuất khi service khởi động lại. Hãy đặt SESSION_SECRET riêng trên Railway.");

function parseCookies(header = "") {
  return header.split(";").reduce((all, pair) => {
    const index = pair.indexOf("=");
    if (index < 1) return all;
    const key = pair.slice(0, index).trim();
    try { all[key] = decodeURIComponent(pair.slice(index + 1)); }
    catch { /* Ignore malformed cookies. */ }
    return all;
  }, {});
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function issueSession(user) {
  const payload = {
    u: user.username,
    r: user.role,
    v: user.sessionVersion,
    e: Math.floor(Date.now() / 1000) + SESSION_TTL_HOURS * 3600,
    c: crypto.randomBytes(24).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function readSession(req) {
  if (!authEnabled()) return { u: "local", r: "admin", e: Number.MAX_SAFE_INTEGER, c: "local" };
  const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!value || !SESSION_SECRET) return null;
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length || !sameSecret(sign(encoded), signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const user = USERS.find((entry) => entry.username === payload?.u);
    if (!payload || typeof payload.u !== "string" || !isRole(payload.r) || typeof payload.c !== "string" || !Number.isFinite(payload.e) || payload.e <= Date.now() / 1000 || !user || user.role !== payload.r || user.sessionVersion !== payload.v) return null;
    return payload;
  } catch { return null; }
}

function shouldSecureCookie(req) {
  const configured = String(process.env.SESSION_COOKIE_SECURE || "auto").toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return NODE_ENV === "production" || req.secure;
}

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    secure: shouldSecureCookie(req),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_HOURS * 3600 * 1000,
  };
}

function requestIsSameOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    // Railway terminates TLS before forwarding traffic to Node. Comparing
    // req.protocol here can therefore reject a legitimate HTTPS browser
    // request that reaches this process as HTTP. The Origin host still gives
    // us the cross-site request protection needed by the CSRF guard.
    return url.host.toLowerCase() === String(req.get("host") || "").toLowerCase();
  } catch { return false; }
}

function requireSameOrigin(req, res, next) {
  if (!requestIsSameOrigin(req)) return res.status(403).json({ error: "Nguồn yêu cầu không hợp lệ" });
  return next();
}

function requireCsrf(req, res, next) {
  if (!requestIsSameOrigin(req) || !sameSecret(req.get("x-csrf-token"), req.user?.c)) {
    return res.status(403).json({ error: "Phiên làm việc không hợp lệ. Hãy tải lại trang và thử lại." });
  }
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Cần đăng nhập" });
    if (!isRole(req.user.r) || !isRole(role) || ROLE_RANK[req.user.r] < ROLE_RANK[role]) return res.status(403).json({ error: "Bạn không có quyền thực hiện thao tác này" });
    return next();
  };
}

function requestUser(req) {
  if (req.user?.u === "local") return { username: "local", role: "admin", permissions: {} };
  return USERS.find((user) => user.username === req.user?.u) || null;
}

function requireModule(module, action = "view") {
  return (req, res, next) => {
    const user = requestUser(req);
    if (!user) return res.status(401).json({ error: "Cần đăng nhập" });
    if (!hasModulePermission(user, module, action)) return res.status(403).json({ error: `Bạn không có quyền ${action === "edit" ? "chỉnh sửa" : "xem"} module này` });
    return next();
  };
}

function rateLimit({ windowMs, max }) {
  const entries = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const current = entries.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    entry.count += 1;
    entries.set(key, entry);
    if (entry.count > max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: "Bạn thao tác quá nhanh. Vui lòng thử lại sau." });
    }
    return next();
  };
}

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const aiLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const extractLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });
const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const pipelineLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 4 });

const app = express();
app.set("trust proxy", 1); // Railway terminates HTTPS before the app.
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      upgradeInsecureRequests: NODE_ENV === "production" ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "same-origin" },
}));
app.use(express.json({ limit: `${Math.max(1, MAX_UPLOAD_MB + 8)}mb` }));

// PWA assets phải truy cập được trước đăng nhập để iOS/Android có thể cài và
// cập nhật service worker. Worker không cache dữ liệu hoặc HTML có phân quyền.
app.get("/manifest.webmanifest", (req, res) => res.type("application/manifest+json").sendFile(path.join(WEB_DIR, "manifest.webmanifest")));
app.get("/sw.js", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.set("Service-Worker-Allowed", "/");
  return res.type("application/javascript").sendFile(path.join(WEB_DIR, "sw.js"));
});
app.get("/icon.svg", (req, res) => res.type("image/svg+xml").sendFile(path.join(WEB_DIR, "icon.svg")));

function protectSite(req, res, next) {
  if (!authEnabled()) { req.user = readSession(req); return next(); }
  const session = readSession(req);
  if (session) { req.user = session; return next(); }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Cần đăng nhập" });
  return res.redirect(302, "/login");
}

// ---------- authentication ----------
app.get("/login", (req, res) => {
  if (!authEnabled() || readSession(req)) return res.redirect(302, "/");
  res.set("Cache-Control", "no-store");
  return res.sendFile(path.join(WEB_DIR, "login.html"));
});

app.post("/api/auth/login", requireSameOrigin, loginLimit, (req, res) => {
  if (!authEnabled()) return res.status(404).json({ error: "Đăng nhập chưa được cấu hình" });
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const candidates = username ? USERS.filter((user) => user.username === username) : (USERS.length === 1 ? USERS : []);
  const user = candidates.find((candidate) => matchesPassword(password, candidate.passwordHash));
  if (!user) return res.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu không đúng" });
  const session = issueSession(user);
  res.set("Cache-Control", "no-store");
  res.cookie(COOKIE_NAME, session, sessionCookieOptions(req));
  return res.json({ ok: true, user: { username: user.username, role: user.role } });
});

// Liveness: luôn trả 2xx khi Node còn phục vụ được request.
app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({ ok: true, service: "calida-analyst", startedAt: STARTED_AT, uptimeSeconds: Math.floor(process.uptime()) });
});

// Readiness: Railway dùng endpoint này trước khi chuyển traffic sang deploy mới.
app.get("/api/ready", (req, res) => {
  const dashboard = dashboardReadiness();
  res.set("Cache-Control", "no-store");
  return res.status(dashboard.ready ? 200 : 503).json({ ok: dashboard.ready, dashboard });
});

app.use(protectSite);

app.get("/api/auth/me", (req, res) => {
  res.set("Cache-Control", "no-store");
  const user = requestUser(req);
  return res.json({ user: { username: req.user.u, role: req.user.r, permissions: effectivePermissions(user) }, csrfToken: req.user.c, expiresAt: authEnabled() ? new Date(req.user.e * 1000).toISOString() : null });
});

app.post("/api/auth/logout", requireCsrf, (req, res) => {
  const { maxAge, ...clearOptions } = sessionCookieOptions(req); // clearCookie tự đặt expiry; không truyền maxAge.
  res.clearCookie(COOKIE_NAME, clearOptions);
  return res.json({ ok: true });
});

// ---------- Web Push subscriptions ----------
app.get("/api/notifications/config", (req, res) => {
  const subscriptions = readPushStore().filter((entry) => entry.username === req.user.u);
  res.set("Cache-Control", "no-store");
  return res.json({ available: PUSH_ENABLED, publicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null, subscribed: subscriptions.length > 0, preferences: subscriptions[0]?.preferences || defaultPushPreferences() });
});

app.post("/api/notifications/subscriptions", requireCsrf, writeLimit, (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "Web Push chưa được cấu hình trên máy chủ. Hãy đặt VAPID keys trên Railway." });
  try {
    const saved = savePushSubscription(req.user.u, req.body?.subscription, req.body?.preferences);
    audit(req, "push.subscribe", { endpoint: new URL(saved.subscription.endpoint).host, preferences: saved.preferences });
    return res.status(201).json({ ok: true, preferences: saved.preferences });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.delete("/api/notifications/subscriptions", requireCsrf, writeLimit, (req, res) => {
  const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
  const removed = removePushSubscription(req.user.u, endpoint);
  audit(req, "push.unsubscribe", { removed });
  return res.json({ ok: true, removed });
});

app.post("/api/notifications/test", requireCsrf, writeLimit, async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "Web Push chưa được cấu hình trên máy chủ. Hãy đặt VAPID keys trên Railway." });
  const ownSubscriptions = readPushStore().filter((entry) => entry.username === req.user.u);
  if (!ownSubscriptions.length) return res.status(404).json({ error: "Thiết bị này chưa đăng ký nhận thông báo" });
  const expired = new Set();
  let delivered = 0;
  for (const entry of ownSubscriptions) {
    try {
      await webpush.sendNotification(entry.subscription, JSON.stringify({ title: "Calida Analyst", body: "Thiết bị đã sẵn sàng nhận thông báo.", url: "/#overview", tag: "calida-test" }), { TTL: 60, urgency: "high" });
      delivered += 1;
    } catch (error) { if ([404, 410].includes(error.statusCode)) expired.add(entry.subscription.endpoint); else console.error(`Push test lỗi: ${error.message}`); }
  }
  if (expired.size) writePushStore(readPushStore().filter((entry) => !expired.has(entry.subscription.endpoint)));
  audit(req, "push.test", { delivered });
  return delivered ? res.json({ ok: true, delivered }) : res.status(502).json({ error: "Không gửi được thông báo; hãy bật lại quyền thông báo trên thiết bị." });
});

// ---------- administration: users and access roles ----------
const publicUser = (user) => ({ username: user.username, role: user.role, permissions: effectivePermissions(user), createdAt: user.createdAt, updatedAt: user.updatedAt });
const findUser = (username) => USERS.find((user) => user.username === username);
const moduleAdminCount = (users = USERS) => users.filter((user) => hasModulePermission(user, "admin", "edit")).length;

app.get("/api/admin/users", requireModule("admin", "edit"), (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({ users: USERS.map(publicUser) });
});

app.post("/api/admin/users", requireModule("admin", "edit"), requireCsrf, writeLimit, (req, res) => {
  try {
    const input = req.body?.user || {};
    const username = String(input.username || "").trim();
    const password = typeof input.password === "string" ? input.password : "";
    const role = String(input.role || "").toLowerCase();
    validateNewUser(username, password, role);
    if (findUser(username)) return res.status(409).json({ error: "Tên đăng nhập đã tồn tại" });
    const user = asStoredUser({ username, password, role });
    const nextUsers = [...USERS, user];
    writeUserStore(nextUsers);
    USERS = nextUsers;
    audit(req, "user.create", { username: user.username, role: user.role });
    return res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.patch("/api/admin/users/:username", requireModule("admin", "edit"), requireCsrf, writeLimit, (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    const current = findUser(username);
    if (!current) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
    const input = req.body?.user || {};
    const hasRole = Object.prototype.hasOwnProperty.call(input, "role");
    const hasPassword = typeof input.password === "string" && input.password.length > 0;
    const hasPermissions = Object.hasOwn(input, "permissions");
    if (!hasRole && !hasPassword && !hasPermissions) return res.status(400).json({ error: "Chưa có thay đổi nào để lưu" });
    const role = hasRole ? String(input.role || "").toLowerCase() : current.role;
    if (!isRole(role)) return res.status(400).json({ error: "Vai trò phải là viewer, analyst hoặc admin" });
    if (username === req.user.u && role !== current.role) return res.status(400).json({ error: "Không thể tự thay đổi vai trò của chính mình" });
    if (hasPassword) validateNewUser(username, input.password, role);
    // Khi hạ vai trò, bỏ override quản trị cũ để kho người dùng vẫn hợp lệ.
    const inheritedPermissions = role === "admin" ? current.permissions : Object.fromEntries(Object.entries(current.permissions || {}).filter(([module]) => module !== "admin"));
    const permissions = hasPermissions ? normalizePermissionOverrides(input.permissions, role) : normalizePermissionOverrides(inheritedPermissions, role);
    const updated = {
      ...current,
      role,
      permissions,
      passwordHash: hasPassword ? passwordHash(input.password) : current.passwordHash,
      sessionVersion: (hasPassword || role !== current.role || hasPermissions) ? crypto.randomBytes(16).toString("base64url") : current.sessionVersion,
      updatedAt: new Date().toISOString(),
    };
    const nextUsers = USERS.map((user) => user.username === username ? updated : user);
    if (!moduleAdminCount(nextUsers)) return res.status(400).json({ error: "Hệ thống phải luôn còn ít nhất một quản trị viên có quyền quản trị" });
    writeUserStore(nextUsers);
    USERS = nextUsers;
    audit(req, "user.update", { username, role: updated.role, passwordReset: hasPassword, permissionsChanged: hasPermissions });
    return res.json({ ok: true, user: publicUser(updated), reauthenticate: username === req.user.u && (hasPassword || hasPermissions) });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.delete("/api/admin/users/:username", requireModule("admin", "edit"), requireCsrf, writeLimit, (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    const current = findUser(username);
    if (!current) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
    if (username === req.user.u) return res.status(400).json({ error: "Không thể tự xóa tài khoản đang đăng nhập" });
    const nextUsers = USERS.filter((user) => user.username !== username);
    if (!moduleAdminCount(nextUsers)) return res.status(400).json({ error: "Hệ thống phải luôn còn ít nhất một quản trị viên có quyền quản trị" });
    writeUserStore(nextUsers);
    USERS = nextUsers;
    audit(req, "user.delete", { username, role: current.role });
    return res.json({ ok: true });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

// ---------- pipeline runner ----------
let running = null;
let activeProcess = null;
let pipelineQueue = Promise.resolve();
let queuedJobs = 0;
let scheduleTimer = null;
let pipelineState = { status: "idle", startedAt: null, finishedAt: null, reason: null, error: null };

function startPipeline(args, reason) {
  if (running) return running;
  const logFile = path.join(LOG_DIR, `pipeline-${new Date().toISOString().slice(0, 10)}.log`);
  const log = fs.createWriteStream(logFile, { flags: "a" });
  log.write(`\n===== ${new Date().toLocaleString("vi-VN")} | ${reason} | ${args.join(" ")}\n`);
  pipelineState = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, reason, error: null };

  const job = new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(ROOT, "pipeline", "run.py"), ...args], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    activeProcess = child;
    let tail = "";
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, PIPELINE_TIMEOUT_MS);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeProcess = null;
      log.end();
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk) => {
      const text = chunk.toString();
      log.write(text);
      process.stdout.write(`[pipeline] ${text}`);
      tail = (tail + text).slice(-2000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => finish(new Error(`Không chạy được ${PYTHON}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (timedOut) return finish(new Error(`Pipeline quá thời gian cho phép (${Math.round(PIPELINE_TIMEOUT_MS / 60000)} phút)`));
      if (code === 0) return finish(null, tail);
      return finish(new Error(`Pipeline lỗi (mã ${code ?? signal ?? "không rõ"}). Xem ${logFile}\n${tail.slice(-500)}`));
    });
  });
  running = job.then(
    (result) => {
      pipelineState = { ...pipelineState, status: "ok", finishedAt: new Date().toISOString() };
      audit(null, "pipeline.complete", { reason, status: "ok" });
      return result;
    },
    (error) => {
      pipelineState = { ...pipelineState, status: "error", finishedAt: new Date().toISOString(), error: error.message };
      audit(null, "pipeline.complete", { reason, status: "error", error: error.message.slice(0, 300) });
      queuePush({ preference: "pipeline", module: "admin", title: "Calida · Pipeline lỗi", body: `Không hoàn tất: ${reason}. Mở Quản trị để xem nhật ký.`, url: "/#admin", tag: "calida-pipeline-error" });
      throw error;
    },
  ).finally(() => { running = null; });
  return running;
}

function enqueuePipeline(args, reason) {
  queuedJobs += 1;
  const job = pipelineQueue.catch(() => {}).then(() => startPipeline(args, reason));
  // Queue phải luôn trở về trạng thái resolved: request gọi job vẫn nhận lỗi,
  // còn hàng đợi tiếp tục chạy tác vụ sau và Node không có rejection bị bỏ quên.
  pipelineQueue = job.then(
    () => { queuedJobs -= 1; },
    () => { queuedJobs -= 1; },
  );
  return job;
}

// ---------- Gemini ----------
async function gemini({ system, contents, json = false, temperature = 0.2 }) {
  if (!GEMINI_KEY) throw Object.assign(new Error("Chưa cấu hình GEMINI_API_KEY trên server"), { status: 503 });
  const url = `${process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com"}/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = { systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents, generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) } };
  let wait = 2000;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) });
    } catch (error) {
      const message = error.name === "TimeoutError" ? "Gemini phản hồi quá lâu" : "Không kết nối được Gemini";
      throw Object.assign(new Error(message), { status: 504 });
    }
    if (response.ok) {
      const result = await response.json();
      const text = (result.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
      if (!text) throw new Error(`Gemini không trả về nội dung (${result.candidates?.[0]?.finishReason || result.promptFeedback?.blockReason || "không rõ"})`);
      return text;
    }
    const errorText = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait *= 2;
      continue;
    }
    throw Object.assign(new Error(`Gemini ${response.status}: ${errorText.slice(0, 300)}`), { status: response.status === 429 ? 429 : 502 });
  }
  throw new Error("Gemini không phản hồi");
}

const readData = () => JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const RISK_TOPICS = () => [...new Set(readData().reports.flatMap((report) => report.risks.map((risk) => risk.k)))];
const asList = (value) => Array.isArray(value) ? value : [];

function dashboardForUser(data, user) {
  const permissions = effectivePermissions(user);
  // Tổng quan là dashboard điều hành nên được phép dùng số liệu tổng hợp. Các
  // tài khoản chỉ được cấp module riêng chỉ nhận đúng dữ liệu module đó.
  if (permissions.overview.view) return { ...data, workspace: publicWorkspaceState(user) };
  const result = {
    asOf: data.asOf,
    meta: data.meta,
    market: { index: data.market?.index ?? null },
    news: [], events: [], reports: [], funds: null,
    flows: { asOf: null, investors: { "Hôm nay": {}, MTD: {}, YTD: {} }, history: { dates: [] }, tickers: [], sectors: [] },
    portfolio: { ytd: null, alloc: {}, positions: [], today: [], history: [] }, workspace: publicWorkspaceState(user),
  };
  if (permissions.brief.view) Object.assign(result, { market: data.market, news: data.news, events: data.events });
  if (permissions.portfolio.view) result.portfolio = data.portfolio;
  if (permissions.flows.view) result.flows = data.flows;
  if (permissions.funds.view) result.funds = data.funds;
  if (permissions.reports.view) result.reports = data.reports;
  // Hai module mới chỉ trình bày action/signal có căn cứ từ danh mục và báo cáo.
  // Cấp riêng một trong hai module vẫn nhận đúng nguồn dữ liệu cần thiết của nó.
  if (permissions.actions.view) result.portfolio = data.portfolio;
  if (permissions.signals.view) {
    result.portfolio = data.portfolio;
    result.reports = data.reports;
  }
  return result;
}

// ---------- application API ----------
app.get("/api/dashboard", (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    return res.json(dashboardForUser(readData(), requestUser(req)));
  } catch (error) { return res.status(503).json({ error: `Không tải được dashboard: ${error.message}` }); }
});

// ---------- action desk + signal center state ----------
const WORKSPACE_STATUS = Object.freeze({
  actions: new Set(["pending", "waiting", "completed", "cancelled"]),
  signals: new Set(["new", "watch", "dismissed"]),
});
const WORKSPACE_ID = /^(?:portfolio|signal):[A-Z0-9._-]{1,16}$/;

function updateWorkspaceStatus(req, collection) {
  const id = String(req.params.id || "");
  const status = String(req.body?.status || "");
  if (!WORKSPACE_ID.test(id) || !WORKSPACE_STATUS[collection].has(status)) return { error: "Trạng thái workspace không hợp lệ" };
  const state = readWorkspaceState();
  const previous = state[collection][id]?.status;
  state[collection][id] = { status, updatedAt: new Date().toISOString(), updatedBy: req.user.u };
  writeWorkspaceState(state);
  audit(req, `${collection.slice(0, -1)}.status`, { id, status });
  if (collection === "signals" && status === "new" && previous !== "new") {
    queuePush({ preference: "signals", module: "signals", title: "Calida · Signal mới", body: `Có signal mới cho ${id.split(":")[1]}.`, url: "/#signals", tag: `calida-${id}` });
  }
  return { state: state[collection][id] };
}

function actionQuantity(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw new Error("Khối lượng phải là số nguyên từ 0 đến 1.000.000.000");
  return value;
}

function updateActionDetails(req) {
  const id = String(req.params.id || "");
  const body = req.body || {};
  if (!WORKSPACE_ID.test(id) || !id.startsWith("portfolio:")) return { error: "Action không hợp lệ" };
  if (body.status !== undefined && !WORKSPACE_STATUS.actions.has(String(body.status))) return { error: "Trạng thái action không hợp lệ" };
  let plannedQuantity;
  let completedQuantity;
  try {
    plannedQuantity = actionQuantity(body.plannedQuantity);
    completedQuantity = actionQuantity(body.completedQuantity);
  } catch (error) { return { error: error.message }; }
  if (plannedQuantity !== null && completedQuantity !== null && completedQuantity > plannedQuantity) return { error: "Khối lượng đã thực hiện không thể lớn hơn khối lượng action" };
  const deadline = body.deadline == null || body.deadline === "" ? null : String(body.deadline);
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return { error: "Deadline phải theo định dạng YYYY-MM-DD" };
  const note = body.note == null ? "" : String(body.note).trim();
  if (note.length > 300) return { error: "Ghi chú không được quá 300 ký tự" };
  const state = readWorkspaceState();
  const previous = state.actions[id] || {};
  state.actions[id] = {
    ...previous,
    status: String(body.status || previous.status || "pending"),
    plannedQuantity,
    completedQuantity,
    deadline,
    note,
    updatedAt: new Date().toISOString(),
    updatedBy: req.user.u,
  };
  writeWorkspaceState(state);
  audit(req, "action.update", { id, status: state.actions[id].status, plannedQuantity, completedQuantity, deadline });
  if (state.actions[id].status === "pending" && previous.status !== "pending") {
    queuePush({ preference: "actions", module: "actions", title: "Calida · Action cần xử lý", body: `${id.split(":")[1]} đang chờ xử lý${deadline ? ` trước ${deadline}` : ""}.`, url: "/#actions", tag: `calida-${id}` });
  }
  return { state: state.actions[id] };
}

app.patch("/api/actions/:id", requireModule("actions", "edit"), requireCsrf, writeLimit, (req, res) => {
  const result = updateActionDetails(req);
  return result.error ? res.status(400).json(result) : res.json({ ok: true, ...result });
});

app.patch("/api/actions/:id/status", requireModule("actions", "edit"), requireCsrf, writeLimit, (req, res) => {
  const result = updateWorkspaceStatus(req, "actions");
  return result.error ? res.status(400).json(result) : res.json({ ok: true, ...result });
});

app.patch("/api/signals/:id/status", requireModule("signals", "edit"), requireCsrf, writeLimit, (req, res) => {
  const result = updateWorkspaceStatus(req, "signals");
  return result.error ? res.status(400).json(result) : res.json({ ok: true, ...result });
});

app.get("/api/status", (req, res) => {
  let asOf = null;
  let freshness = [];
  try {
    const data = readData();
    asOf = data.asOf;
    freshness = data.meta?.freshness || [];
  } catch { /* Status remains available during a failed build. */ }
  return res.json({ asOf, freshness, dashboard: dashboardReadiness(), pipeline: { ...pipelineState, queuedJobs }, aiEnabled: Boolean(GEMINI_KEY) });
});

app.get("/api/admin/operations", requireModule("admin", "edit"), (req, res) => {
  let freshness = [];
  let quality = { status: "unknown", issues: [] };
  try {
    const data = readData();
    freshness = data.meta?.freshness || [];
    quality = data.meta?.quality || quality;
  } catch { /* Report the pipeline state even without dashboard data. */ }
  return res.json({ pipeline: { ...pipelineState, queuedJobs }, freshness, quality, audit: recentAudit() });
});

app.post("/api/chat", requireModule("reports", "edit"), requireCsrf, aiLimit, async (req, res) => {
  try {
    const messages = asList(req.body?.messages).filter((message) => message && typeof message.content === "string" && message.content.trim()).slice(-12);
    if (!messages.length || messages.at(-1).role !== "user") return res.status(400).json({ error: "Thiếu câu hỏi" });
    const data = readData();
    const library = data.reports.map((report) => ({ id: report.id, broker: report.broker, date: report.date, type: report.type, title: report.title, stance: report.stance, vnTarget: report.vnTarget, horizon: report.horizon, overweight: report.ow, underweight: report.uw, stocks: report.stocks, risks: report.risks, summary: report.summary }));
    const system = `Bạn là trợ lý phân tích của phòng phân tích Calida (quỹ cổ phiếu Việt Nam). Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào số liệu.
QUY TẮC:
- Chỉ dùng dữ liệu trong THƯ VIỆN BÁO CÁO bên dưới. Không bịa số liệu, CTCK hay báo cáo.
- Mỗi nhận định phải ghi nguồn dạng (Tên CTCK, dd/mm).
- Nếu thư viện không có thông tin, nói rõ là chưa có.
- Khi các CTCK có quan điểm trái chiều, nêu cả hai phía.
- Với target, dùng khuyến nghị mới nhất của mỗi CTCK; nêu trung vị/biên khi tổng hợp.
- Không dùng tiêu đề markdown; dùng gạch đầu dòng ngắn khi liệt kê.
Ngày dữ liệu: ${data.asOf}. VN-Index: ${data.market?.index}. Mã trong danh mục Calida: ${data.portfolio.positions.map((position) => `${position.t} (giá ${position.price})`).join(", ")}.
THƯ VIỆN BÁO CÁO (JSON):
${JSON.stringify(library)}`;
    const contents = messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content.slice(0, 4000) }] }));
    return res.json({ text: await gemini({ system, contents, temperature: 0.2 }) });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.post("/api/extract", requireModule("reports", "edit"), requireCsrf, extractLimit, async (req, res) => {
  try {
    const { text, pdfBase64 } = req.body || {};
    const maxBase64Length = Math.ceil(MAX_UPLOAD_MB * 1024 * 1024 * 4 / 3) + 8;
    if (text != null && typeof text !== "string") return res.status(400).json({ error: "Text báo cáo không hợp lệ" });
    if (pdfBase64 != null && typeof pdfBase64 !== "string") return res.status(400).json({ error: "PDF không hợp lệ" });
    if (!text && !pdfBase64) return res.status(400).json({ error: "Cần text hoặc pdfBase64" });
    if (pdfBase64 && (pdfBase64.length > maxBase64Length || !/^[A-Za-z0-9+/=\s]+$/.test(pdfBase64))) return res.status(413).json({ error: `PDF tối đa ${MAX_UPLOAD_MB} MB` });
    if (text && text.length > 80000) return res.status(413).json({ error: "Nội dung văn bản tối đa 80.000 ký tự" });
    const prompt = `Trích xuất thông tin từ báo cáo phân tích chứng khoán Việt Nam. Trả về đúng 1 object JSON theo schema:
{"broker":string,"date":"YYYY-MM-DD","type":"Chiến lược"|"Vĩ mô"|"Ngành"|"Doanh nghiệp","title":string,"stance":"Tích cực"|"Trung lập"|"Thận trọng"|"Tiêu cực","vnTarget":number|null,"horizon":string,"ow":[string],"uw":[string],"stocks":[{"t":string,"rec":"MUA"|"KHẢ QUAN"|"TRUNG LẬP"|"KÉM KHẢ QUAN"|"BÁN","target":number|null}],"risks":[{"k":string,"s":1|2|3}],"summary":string}
- ow/uw: ngành khuyến nghị tăng/giảm tỷ trọng, chuẩn hóa theo: Ngân hàng, Chứng khoán, Bất động sản, Xây dựng, Vật liệu xây dựng, Thép, Hóa chất, Dầu khí, Công nghệ thông tin, Bán lẻ, Thực phẩm & đồ uống, Điện, nước & xăng dầu khí đốt, Xuất khẩu, Hàng không, Tiện ích.
- risks.k: ưu tiên dùng đúng các chủ đề đã có: ${RISK_TOPICS().join("; ")}. s: 1 thấp, 2 trung bình, 3 cao.
- target giá cổ phiếu theo nghìn đồng (VD 142.000 đ → 142). vnTarget là điểm VN-Index.
- summary: tối đa 2 câu, tự viết lại, không chép nguyên văn.
- Trường không có thông tin: null hoặc mảng rỗng.`;
    const parts = pdfBase64 ? [{ inline_data: { mime_type: "application/pdf", data: pdfBase64 } }, { text: prompt }] : [{ text: `${prompt}\n\nBÁO CÁO:\n${text}` }];
    const output = await gemini({ contents: [{ role: "user", parts }], json: true, temperature: 0 });
    const object = JSON.parse(output.replace(/^```(json)?|```$/g, "").trim());
    return res.json(Array.isArray(object) ? object[0] : object);
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

const TYPES = ["Chiến lược", "Vĩ mô", "Ngành", "Doanh nghiệp"];
const STANCES = ["Tích cực", "Trung lập", "Thận trọng", "Tiêu cực"];
function cleanReport(report, id) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw Object.assign(new Error("Báo cáo không hợp lệ"), { status: 400 });
  const errors = [];
  if (typeof report.broker !== "string" || !report.broker.trim()) errors.push("thiếu CTCK");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date || "")) errors.push("ngày phải dạng YYYY-MM-DD");
  if (!TYPES.includes(report.type)) errors.push("loại báo cáo không hợp lệ");
  if (!STANCES.includes(report.stance)) errors.push("quan điểm không hợp lệ");
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400 });
  return {
    id,
    broker: report.broker.trim().slice(0, 120), date: report.date, type: report.type, title: String(report.title || "").slice(0, 300),
    stance: report.stance, vnTarget: Number(report.vnTarget) || null, horizon: String(report.horizon || "").slice(0, 120), source: String(report.source || "").slice(0, 500), summary: String(report.summary || "").slice(0, 2000),
    ow: asList(report.ow).map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30), uw: asList(report.uw).map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30),
    stocks: asList(report.stocks).filter((stock) => stock && typeof stock === "object" && /^[A-Z0-9]{3,4}$/.test(String(stock.t || ""))).slice(0, 100).map((stock) => ({ t: String(stock.t).toUpperCase(), rec: String(stock.rec || "").slice(0, 30), target: Number(stock.target) || null })),
    risks: asList(report.risks).filter((risk) => risk && typeof risk === "object" && String(risk.k || "").trim()).slice(0, 50).map((risk) => ({ k: String(risk.k).trim().slice(0, 200), s: Math.min(3, Math.max(1, Number(risk.s) || 2)) })),
  };
}

function currentReport(id) {
  try { return readData().reports.find((report) => report.id === id); }
  catch { return null; }
}

app.post("/api/reports", requireModule("reports", "edit"), requireCsrf, writeLimit, async (req, res) => {
  try {
    const clean = cleanReport(req.body?.report, `U${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`);
    fs.appendFileSync(REPORT_JOBS, `${JSON.stringify({ action: "upsert", id: clean.id, report: clean })}\n`, "utf8");
    audit(req, "report.create", { reportId: clean.id, broker: clean.broker, date: clean.date });
    await enqueuePipeline(["--build-only"], `lưu báo cáo ${clean.id}`);
    return res.json({ ok: true, id: clean.id });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.patch("/api/reports/:id", requireModule("reports", "edit"), requireCsrf, writeLimit, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !currentReport(id)) return res.status(404).json({ error: "Không tìm thấy báo cáo" });
    const clean = cleanReport(req.body?.report, id);
    fs.appendFileSync(REPORT_JOBS, `${JSON.stringify({ action: "upsert", id, report: clean })}\n`, "utf8");
    audit(req, "report.update", { reportId: id, broker: clean.broker, date: clean.date });
    await enqueuePipeline(["--build-only"], `cập nhật báo cáo ${id}`);
    return res.json({ ok: true, id });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.delete("/api/reports/:id", requireModule("reports", "edit"), requireCsrf, writeLimit, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const existing = /^[A-Za-z0-9_-]{1,80}$/.test(id) ? currentReport(id) : null;
    if (!existing) return res.status(404).json({ error: "Không tìm thấy báo cáo" });
    fs.appendFileSync(REPORT_JOBS, `${JSON.stringify({ action: "delete", id })}\n`, "utf8");
    audit(req, "report.delete", { reportId: id, broker: existing.broker, date: existing.date });
    await enqueuePipeline(["--build-only"], `xóa báo cáo ${id}`);
    return res.json({ ok: true, id });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.post("/api/pipeline/run", requireModule("admin", "edit"), requireCsrf, pipelineLimit, (req, res) => {
  const args = req.body?.buildOnly === true ? ["--build-only"] : [];
  const wasQueued = queuedJobs > 0 || Boolean(running);
  audit(req, "pipeline.queue", { mode: args.length ? "build-only" : "full", wasQueued });
  enqueuePipeline(args, "chạy tay qua API").catch((error) => console.error(error.message));
  return res.status(202).json({ ok: true, queued: wasQueued });
});

// ---------- static site ----------
app.get("/data/dashboard.json", (req, res) => {
  if (authEnabled()) return res.status(403).json({ error: "Dữ liệu dashboard được phân quyền qua /api/dashboard" });
  res.set("Cache-Control", "no-store");
  return res.sendFile(JSON_PATH);
});
app.use("/data", express.static(path.join(WEB_DIR, "data"), { etag: false, cacheControl: false, setHeaders: (response) => response.setHeader("Cache-Control", "no-store") }));
app.use(express.static(WEB_DIR));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Không tìm thấy API" });
  return res.status(404).send("Không tìm thấy trang");
});

app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  if (error?.type === "entity.too.large") return res.status(413).json({ error: `Dữ liệu gửi lên tối đa ${MAX_UPLOAD_MB} MB` });
  if (error instanceof SyntaxError && "body" in error) return res.status(400).json({ error: "JSON không hợp lệ" });
  console.error(error);
  return res.status(500).json({ error: "Lỗi máy chủ" });
});

// ---------- weekday scheduler ----------
function scheduleDaily() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  if (!PIPELINE_TIME) return;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(PIPELINE_TIME);
  if (!match) { console.error("PIPELINE_TIME không hợp lệ; lịch pipeline đã tắt. Dùng định dạng HH:MM, ví dụ 16:30."); return; }
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  while ([0, 6].includes(next.getDay())) next.setDate(next.getDate() + 1);
  scheduleTimer = setTimeout(async () => {
    try { await enqueuePipeline([], "lịch hằng ngày"); console.log("Pipeline hằng ngày: xong"); }
    catch (error) { console.error(`Pipeline hằng ngày lỗi: ${error.message}`); }
    scheduleDaily();
  }, next - now);
  console.log(`Pipeline kế tiếp: ${next.toLocaleString("vi-VN")}`);
}

const server = app.listen(PORT, () => {
  console.log(`Calida Analyst chạy tại cổng ${PORT}`);
  if (!authEnabled()) console.warn("⚠ Chưa có ACCESS_TOKEN hoặc CALIDA_USERS_JSON: web đang mở công khai.");
  if (!GEMINI_KEY) console.log("⚠ Chưa có GEMINI_API_KEY: hỏi đáp và trích xuất sẽ báo lỗi");
  if (!fs.existsSync(JSON_PATH)) console.log("⚠ Chưa có web/data/dashboard.json — chạy: python pipeline/run.py");
  scheduleDaily();
});

function shutdown(signal) {
  console.log(`Nhận ${signal}; đang đóng server an toàn...`);
  if (scheduleTimer) clearTimeout(scheduleTimer);
  if (activeProcess) activeProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
