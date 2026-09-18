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
const INBOX = path.join(ROOT, "data", "inbox", "reports.jsonl");
const LOG_DIR = path.join(ROOT, "data", "logs");
const ROLE_RANK = { viewer: 0, analyst: 1, admin: 2 };

fs.mkdirSync(path.dirname(INBOX), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function loadUsers() {
  const raw = process.env.CALIDA_USERS_JSON;
  if (!raw) return ACCESS_TOKEN ? [{ username: "admin", password: ACCESS_TOKEN, role: "admin" }] : [];
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("CALIDA_USERS_JSON phải là một JSON array hợp lệ"); }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("CALIDA_USERS_JSON phải chứa ít nhất một người dùng");
  const users = parsed.map((user) => ({
    username: String(user?.username || "").trim(),
    password: String(user?.password || ""),
    role: String(user?.role || "").toLowerCase(),
  }));
  const seen = new Set();
  for (const user of users) {
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(user.username) || !user.password || !(user.role in ROLE_RANK) || seen.has(user.username)) {
      throw new Error("Mỗi người dùng trong CALIDA_USERS_JSON cần username duy nhất, password và role viewer/analyst/admin");
    }
    seen.add(user.username);
  }
  return users;
}

const USERS = loadUsers();
const AUTH_ENABLED = USERS.length > 0;
const SESSION_SECRET = process.env.SESSION_SECRET || (ACCESS_TOKEN
  ? crypto.createHash("sha256").update(`calida-session:${ACCESS_TOKEN}`).digest("hex")
  : "");
if (AUTH_ENABLED && !process.env.SESSION_SECRET) console.warn("SESSION_SECRET chưa được đặt; phiên sẽ dùng secret dẫn xuất từ ACCESS_TOKEN. Hãy đặt SESSION_SECRET riêng trên Railway.");

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
    e: Math.floor(Date.now() / 1000) + SESSION_TTL_HOURS * 3600,
    c: crypto.randomBytes(24).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function readSession(req) {
  if (!AUTH_ENABLED) return { u: "local", r: "admin", e: Number.MAX_SAFE_INTEGER, c: "local" };
  const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!value || !SESSION_SECRET) return null;
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length || !sameSecret(sign(encoded), signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload || typeof payload.u !== "string" || !(payload.r in ROLE_RANK) || typeof payload.c !== "string" || !Number.isFinite(payload.e) || payload.e <= Date.now() / 1000) return null;
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
    return url.host === req.get("host") && url.protocol === req.protocol;
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
    if (ROLE_RANK[req.user.r] < ROLE_RANK[role]) return res.status(403).json({ error: "Bạn không có quyền thực hiện thao tác này" });
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
      fontSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: NODE_ENV === "production" ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "same-origin" },
}));
app.use(express.json({ limit: `${Math.max(1, MAX_UPLOAD_MB + 8)}mb` }));

function protectSite(req, res, next) {
  if (!AUTH_ENABLED) { req.user = readSession(req); return next(); }
  const session = readSession(req);
  if (session) { req.user = session; return next(); }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Cần đăng nhập" });
  return res.redirect(302, "/login");
}

// ---------- authentication ----------
app.get("/login", (req, res) => {
  if (!AUTH_ENABLED || readSession(req)) return res.redirect(302, "/");
  res.set("Cache-Control", "no-store");
  return res.sendFile(path.join(WEB_DIR, "login.html"));
});

app.post("/api/auth/login", requireSameOrigin, loginLimit, (req, res) => {
  if (!AUTH_ENABLED) return res.status(404).json({ error: "Đăng nhập chưa được cấu hình" });
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const candidates = username ? USERS.filter((user) => user.username === username) : (USERS.length === 1 ? USERS : []);
  const user = candidates.find((candidate) => sameSecret(password, candidate.password));
  if (!user) return res.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu không đúng" });
  const session = issueSession(user);
  res.set("Cache-Control", "no-store");
  res.cookie(COOKIE_NAME, session, sessionCookieOptions(req));
  return res.json({ ok: true, user: { username: user.username, role: user.role } });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use(protectSite);

app.get("/api/auth/me", (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({ user: { username: req.user.u, role: req.user.r }, csrfToken: req.user.c, expiresAt: new Date(req.user.e * 1000).toISOString() });
});

app.post("/api/auth/logout", requireCsrf, (req, res) => {
  res.clearCookie(COOKIE_NAME, sessionCookieOptions(req));
  return res.json({ ok: true });
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
    (result) => { pipelineState = { ...pipelineState, status: "ok", finishedAt: new Date().toISOString() }; return result; },
    (error) => { pipelineState = { ...pipelineState, status: "error", finishedAt: new Date().toISOString(), error: error.message }; throw error; },
  ).finally(() => { running = null; });
  return running;
}

function enqueuePipeline(args, reason) {
  queuedJobs += 1;
  const job = pipelineQueue.catch(() => {}).then(() => startPipeline(args, reason));
  pipelineQueue = job.finally(() => { queuedJobs -= 1; });
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

// ---------- application API ----------
app.get("/api/status", (req, res) => {
  let asOf = null;
  try { asOf = readData().asOf; } catch { /* Status remains available during a failed build. */ }
  return res.json({ asOf, pipeline: { ...pipelineState, queuedJobs }, aiEnabled: Boolean(GEMINI_KEY) });
});

app.post("/api/chat", requireRole("analyst"), requireCsrf, aiLimit, async (req, res) => {
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

app.post("/api/extract", requireRole("analyst"), requireCsrf, extractLimit, async (req, res) => {
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
app.post("/api/reports", requireRole("analyst"), requireCsrf, writeLimit, async (req, res) => {
  try {
    const report = req.body?.report;
    if (!report || typeof report !== "object" || Array.isArray(report)) return res.status(400).json({ error: "Báo cáo không hợp lệ" });
    const errors = [];
    if (typeof report.broker !== "string" || !report.broker.trim()) errors.push("thiếu CTCK");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date || "")) errors.push("ngày phải dạng YYYY-MM-DD");
    if (!TYPES.includes(report.type)) errors.push("loại báo cáo không hợp lệ");
    if (!STANCES.includes(report.stance)) errors.push("quan điểm không hợp lệ");
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });
    const clean = {
      id: `U${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`,
      broker: report.broker.trim().slice(0, 120), date: report.date, type: report.type, title: String(report.title || "").slice(0, 300),
      stance: report.stance, vnTarget: Number(report.vnTarget) || null, horizon: String(report.horizon || "").slice(0, 120), source: String(report.source || "").slice(0, 500), summary: String(report.summary || "").slice(0, 2000),
      ow: asList(report.ow).map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30), uw: asList(report.uw).map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30),
      stocks: asList(report.stocks).filter((stock) => stock && typeof stock === "object" && /^[A-Z0-9]{3,4}$/.test(String(stock.t || ""))).slice(0, 100).map((stock) => ({ t: String(stock.t).toUpperCase(), rec: String(stock.rec || "").slice(0, 30), target: Number(stock.target) || null })),
      risks: asList(report.risks).filter((risk) => risk && typeof risk === "object" && String(risk.k || "").trim()).slice(0, 50).map((risk) => ({ k: String(risk.k).trim().slice(0, 200), s: Math.min(3, Math.max(1, Number(risk.s) || 2)) })),
      createdAt: new Date().toISOString(),
    };
    fs.appendFileSync(INBOX, `${JSON.stringify(clean)}\n`, "utf8");
    await enqueuePipeline(["--build-only"], `lưu báo cáo ${clean.id}`);
    return res.json({ ok: true, id: clean.id });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

app.post("/api/pipeline/run", requireRole("admin"), requireCsrf, pipelineLimit, (req, res) => {
  const args = req.body?.buildOnly === true ? ["--build-only"] : [];
  const wasQueued = queuedJobs > 0 || Boolean(running);
  enqueuePipeline(args, "chạy tay qua API").catch((error) => console.error(error.message));
  return res.status(202).json({ ok: true, queued: wasQueued });
});

// ---------- static site ----------
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
  if (!AUTH_ENABLED) console.warn("⚠ Chưa có ACCESS_TOKEN hoặc CALIDA_USERS_JSON: web đang mở công khai.");
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
