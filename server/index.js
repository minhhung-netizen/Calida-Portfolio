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
const PRICE_REFRESH_MINUTES = Number(process.env.PRICE_REFRESH_MINUTES ?? 10);
const PRICE_REFRESH_WINDOWS = process.env.PRICE_REFRESH_WINDOWS || "09:00-11:30,13:00-15:10";
const PRICE_PRIMARY_PROVIDER = String(process.env.PRICE_PRIMARY_PROVIDER || "auto").trim().toLowerCase();
const DNSE_CONFIGURED = Boolean(String(process.env.DNSE_API_KEY || "").trim() && String(process.env.DNSE_API_SECRET || "").trim());
const FLOWS_MODULE_ENABLED = String(process.env.FLOWS_MODULE_ENABLED || "false").trim().toLowerCase() === "true";
const PIPELINE_TIMEOUT_MS = Number(process.env.PIPELINE_TIMEOUT_MS || 20 * 60 * 1000);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60 * 1000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const SESSION_TTL_HOURS = Math.min(24 * 7, Math.max(1, Number(process.env.SESSION_TTL_HOURS || 8)));
const COOKIE_NAME = "calida_session";
const WEB_DIR = path.join(ROOT, "web");
// Có thể tách state khi kiểm thử; trên môi trường triển khai mặc định vẫn là /app/data.
const STATE_DIR = path.resolve(process.env.CALIDA_DATA_DIR || path.join(ROOT, "data"));
const JSON_PATH = path.join(STATE_DIR, "dashboard.json");
const BUNDLED_JSON_PATH = path.join(WEB_DIR, "data", "dashboard.json");
const REPORT_JOBS = path.join(STATE_DIR, "inbox", "report_jobs.jsonl");
const LOG_DIR = path.join(STATE_DIR, "logs");
const AUDIT_LOG = path.join(LOG_DIR, "audit.jsonl");
const USER_STORE_DIR = path.join(STATE_DIR, "auth");
const USER_STORE = path.join(USER_STORE_DIR, "users.json");
const WORKSPACE_STORE = path.join(STATE_DIR, "workspace-state.json");
const PUSH_STORE = path.join(STATE_DIR, "push-subscriptions.json");
const PRICE_ALERT_STORE = path.join(STATE_DIR, "price-alerts.json");
const ROLE_RANK = Object.freeze({ viewer: 0, analyst: 1, admin: 2 });
const isRole = (role) => Object.hasOwn(ROLE_RANK, role);
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;
const MODULES = Object.freeze(["overview", "brief", "portfolio", "flows", "funds", "reports", "actions", "signals", "alerts", "admin"]);
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

// Endpoint readiness phải nhẹ, không phụ thuộc vào Google Sheets/vnstock. Nền tảng
// triển khai dùng nó khi phát hành; lỗi một lần đồng bộ không được làm tiến trình web chết.
function dashboardReadiness() {
  try {
    const { path: dashboardPath, data } = readDashboard();
    const stat = fs.statSync(dashboardPath);
    if (!stat.isFile() || stat.size === 0) throw new Error("dashboard.json rỗng");
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

function readDashboard() {
  // Ưu tiên Volume để dữ liệu vừa đồng bộ sống qua deploy. Bản kèm image chỉ
  // là fallback cho cài đặt mới hoặc môi trường kiểm thử trước lần dựng đầu.
  let lastError;
  for (const dashboardPath of [JSON_PATH, BUNDLED_JSON_PATH]) {
    try {
      const stat = fs.statSync(dashboardPath);
      if (!stat.isFile() || stat.size === 0) continue;
      const data = JSON.parse(fs.readFileSync(dashboardPath, "utf8"));
      if (!data || !Array.isArray(data.reports)) throw new Error("dashboard.json không đúng định dạng");
      return { path: dashboardPath, data };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error("Không tìm thấy dashboard.json");
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
  // Cảnh báo giá là dữ liệu cá nhân: mọi người dùng được tự quản lý cảnh báo của mình.
  allView.alerts.edit = true;
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

const PUSH_PREFERENCES = Object.freeze(["signals", "actions", "priceAlerts", "pipeline"]);
const defaultPushPreferences = () => ({ signals: true, actions: true, priceAlerts: true, pipeline: true });

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

async function dispatchPush({ preference, module, title, body, url = "/", tag = "calida", targetUsername = null }) {
  if (!PUSH_ENABLED) return { delivered: 0, skipped: true };
  const candidates = readPushStore().filter((entry) => {
    const user = findUser(entry.username);
    return user && (!targetUsername || entry.username === targetUsername) && entry.preferences[preference] && hasModulePermission(user, module, "view");
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

const PRICE_ALERT_ID = /^price:[a-f0-9-]{36}$/;
const PRICE_ALERT_TICKER = /^[A-Z0-9._-]{1,12}$/;
const PRICE_ALERT_CONDITIONS = new Set(["above", "below", "range"]);
const PRICE_ALERT_RANGE_ACTIONS = new Set(["buy", "sell"]);
const PRICE_ALERT_FREQUENCIES = new Set(["once", "daily", "crossing"]);
const PRICE_ALERT_SCHEDULES = new Set(["immediate", "at_time"]);
const PRICE_ALERT_SOURCE_TYPES = new Set(["personal", "action"]);
const PRICE_ALERT_ACTION_ID = /^(?:portfolio:[A-Z0-9._-]{1,16}|manual:[a-f0-9-]{36})$/;
const PRICE_ALERT_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_PRICE_ALERT_NOTIFY_TIME = "08:00";

function normalizePriceAlert(alert) {
  const notifyTime = PRICE_ALERT_TIME.test(alert?.notifyTime || "") ? alert.notifyTime : null;
  const scheduleMode = PRICE_ALERT_SCHEDULES.has(alert?.scheduleMode) ? alert.scheduleMode : "immediate";
  return {
    ...alert,
    sourceType: PRICE_ALERT_SOURCE_TYPES.has(alert?.sourceType) ? alert.sourceType : "personal",
    actionId: alert?.sourceType === "action" && PRICE_ALERT_ACTION_ID.test(alert?.actionId || "") ? alert.actionId : null,
    createdBy: USERNAME_RE.test(alert?.createdBy || "") ? alert.createdBy : alert.username,
    targetPriceHigh: Number.isFinite(alert?.targetPriceHigh) ? alert.targetPriceHigh : null,
    rangeAction: alert?.condition === "range" && PRICE_ALERT_RANGE_ACTIONS.has(alert?.rangeAction) ? alert.rangeAction : (alert?.condition === "range" ? "buy" : null),
    frequency: PRICE_ALERT_FREQUENCIES.has(alert?.frequency) ? alert.frequency : "once",
    scheduleMode: scheduleMode === "at_time" && !notifyTime ? "immediate" : scheduleMode,
    notifyTime,
    expiresAt: alert?.expiresAt || null,
    expiredAt: alert?.expiredAt || null,
    triggerCount: Number.isInteger(alert?.triggerCount) && alert.triggerCount >= 0 ? alert.triggerCount : (alert?.triggeredAt ? 1 : 0),
    lastTriggeredPriceDate: alert?.lastTriggeredPriceDate || null,
  };
}

function cleanPriceAlertInput(value, previous = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cảnh báo giá không hợp lệ");
  const ticker = String(value.ticker ?? previous.ticker ?? "").trim().toUpperCase();
  const condition = String(value.condition ?? previous.condition ?? "");
  const targetPrice = Number(value.targetPrice ?? previous.targetPrice);
  const targetPriceHighValue = value.targetPriceHigh !== undefined ? value.targetPriceHigh : previous.targetPriceHigh;
  const targetPriceHigh = condition === "range" ? Number(targetPriceHighValue) : null;
  const rangeAction = condition === "range" ? String(value.rangeAction ?? previous.rangeAction ?? "buy") : null;
  const note = String(value.note ?? previous.note ?? "").trim();
  const frequency = String(value.frequency ?? previous.frequency ?? "once");
  const scheduleMode = String(value.scheduleMode ?? previous.scheduleMode ?? "immediate");
  const sourceType = String(value.sourceType ?? previous.sourceType ?? "personal");
  const actionId = sourceType === "action" ? String(value.actionId ?? previous.actionId ?? "").trim() : null;
  const notifyTimeValue = value.notifyTime !== undefined ? value.notifyTime : (previous.notifyTime ?? DEFAULT_PRICE_ALERT_NOTIFY_TIME);
  const notifyTime = scheduleMode === "at_time" ? String(notifyTimeValue || "").trim() : null;
  const expiresValue = value.expiresAt !== undefined ? value.expiresAt : previous.expiresAt;
  let expiresAt = null;
  if (!PRICE_ALERT_TICKER.test(ticker)) throw new Error("Mã chứng khoán gồm 1–12 ký tự chữ, số, dấu chấm, gạch dưới hoặc gạch ngang");
  if (!PRICE_ALERT_CONDITIONS.has(condition)) throw new Error("Điều kiện cảnh báo không hợp lệ");
  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || targetPrice > 1_000_000_000) throw new Error("Giá cảnh báo phải là số lớn hơn 0");
  if (condition === "range" && (!Number.isFinite(targetPriceHigh) || targetPriceHigh <= targetPrice || targetPriceHigh > 1_000_000_000)) throw new Error("Giá cao phải lớn hơn giá thấp");
  if (condition === "range" && !PRICE_ALERT_RANGE_ACTIONS.has(rangeAction)) throw new Error("Loại vùng giá phải là mua hoặc bán");
  if (note.length > 300) throw new Error("Ghi chú không được quá 300 ký tự");
  if (!PRICE_ALERT_FREQUENCIES.has(frequency)) throw new Error("Tần suất cảnh báo không hợp lệ");
  if (!PRICE_ALERT_SCHEDULES.has(scheduleMode)) throw new Error("Thời điểm cảnh báo không hợp lệ");
  if (!PRICE_ALERT_SOURCE_TYPES.has(sourceType)) throw new Error("Nguồn thiết lập cảnh báo không hợp lệ");
  if (sourceType === "action" && !PRICE_ALERT_ACTION_ID.test(actionId)) throw new Error("Hãy chọn một khuyến nghị hành động hợp lệ");
  if (scheduleMode === "at_time" && !PRICE_ALERT_TIME.test(notifyTime)) throw new Error("Giờ cảnh báo phải theo định dạng HH:MM");
  if (expiresValue) {
    const deadline = new Date(expiresValue);
    if (!Number.isFinite(deadline.getTime())) throw new Error("Hạn cảnh báo không hợp lệ");
    expiresAt = deadline.toISOString();
  }
  return { ticker, condition, targetPrice: Math.round(targetPrice * 100) / 100, targetPriceHigh: targetPriceHigh == null ? null : Math.round(targetPriceHigh * 100) / 100, rangeAction, note, frequency, scheduleMode, notifyTime, expiresAt, sourceType, actionId };
}

function isPriceAlertAdmin(req) {
  return hasModulePermission(requestUser(req), "admin", "edit");
}

function canManagePriceAlert(req, alert) {
  return alert?.username === req.user.u || isPriceAlertAdmin(req);
}

function priceAlertRecipients(req, rawRecipients) {
  if (!isPriceAlertAdmin(req)) {
    if (rawRecipients !== undefined && (!Array.isArray(rawRecipients) || rawRecipients.some((username) => username !== req.user.u))) {
      const error = new Error("Bạn chỉ có thể tạo cảnh báo cho chính mình");
      error.status = 403;
      throw error;
    }
    return [req.user.u];
  }
  const recipients = Array.isArray(rawRecipients)
    ? [...new Set(rawRecipients.map((username) => String(username || "").trim()).filter(Boolean))]
    : [req.user.u];
  if (!recipients.length) throw new Error("Hãy chọn ít nhất một người nhận cảnh báo");
  if (recipients.length > 100) throw new Error("Mỗi lần chỉ được chọn tối đa 100 người nhận");
  for (const username of recipients) {
    const user = USERS.find((item) => item.username === username) || (username === "local" && req.user.u === "local" ? requestUser(req) : null);
    if (!user || !hasModulePermission(user, "alerts", "view")) throw new Error(`Tài khoản ${username} không tồn tại hoặc không có quyền xem cảnh báo`);
  }
  return recipients;
}

function readPriceAlertStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PRICE_ALERT_STORE, "utf8"));
    if (!parsed || !Array.isArray(parsed.alerts)) throw new Error("invalid price alert store");
    return parsed.alerts.filter((item) => PRICE_ALERT_ID.test(item?.id || "") && USERNAME_RE.test(item?.username || "") && PRICE_ALERT_CONDITIONS.has(item?.condition) && PRICE_ALERT_TICKER.test(item?.ticker || "") && Number.isFinite(item?.targetPrice) && (item.condition !== "range" || (Number.isFinite(item?.targetPriceHigh) && item.targetPriceHigh > item.targetPrice))).map(normalizePriceAlert);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.error(`Không đọc được kho cảnh báo giá: ${error.message}`);
    return [];
  }
}

function writePriceAlertStore(alerts) {
  const temp = `${PRICE_ALERT_STORE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, alerts }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, PRICE_ALERT_STORE);
}

function currentPriceMap() {
  const data = readData();
  const dedicatedPrices = Array.isArray(data.prices) && data.prices.length;
  const rows = dedicatedPrices
    ? data.prices.map((item) => ({ ...item, previousPrice: Number.isFinite(item.previousPrice) ? item.previousPrice : (Number.isFinite(item.price) && Number.isFinite(item.chg) ? item.price - item.chg : null) }))
    : (data.portfolio?.positions || []).map((item) => ({ t: item.t, price: item.price, date: item.priceDate }));
  return new Map(rows.filter((item) => item?.t).map((item) => [String(item.t).toUpperCase(), item]));
}

function publicPriceAlert(alert, prices) {
  const quote = prices.get(alert.ticker) || {};
  return { ...normalizePriceAlert(alert), expired: Boolean(alert.expiresAt && new Date(alert.expiresAt) <= new Date()), currentPrice: Number.isFinite(quote.price) ? quote.price : null, priceChange: Number.isFinite(quote.chg) ? quote.chg : null, priceDate: quote.date || null };
}

function priceAlertScheduleDue(alert, nowDate) {
  if (alert.scheduleMode !== "at_time") return true;
  const currentMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  const [hour, minute] = alert.notifyTime.split(":").map(Number);
  return currentMinutes >= hour * 60 + minute;
}

async function evaluatePriceAlerts(targetUsername = null) {
  const alerts = readPriceAlertStore();
  let prices;
  try { prices = currentPriceMap(); }
  catch { prices = new Map(); }
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const triggered = [];
  let changed = false;
  for (const alert of alerts) {
    if (targetUsername && alert.username !== targetUsername) continue;
    if (alert.enabled && alert.expiresAt && new Date(alert.expiresAt) <= nowDate) {
      alert.enabled = false;
      alert.expiredAt = alert.expiredAt || now;
      alert.updatedAt = now;
      changed = true;
      continue;
    }
    const quote = prices.get(alert.ticker);
    if (!quote || !Number.isFinite(quote.price)) continue;
    const quoteDate = String(quote.date || now.slice(0, 10));
    const lastObservedPrice = Number.isFinite(alert.lastPrice) ? alert.lastPrice : null;
    if (alert.lastPrice !== quote.price || alert.lastPriceDate !== quoteDate) {
      alert.lastPrice = quote.price;
      alert.lastPriceDate = quoteDate;
      alert.lastCheckedAt = now;
      changed = true;
    }
    const conditionMatched = alert.condition === "above"
      ? quote.price >= alert.targetPrice
      : alert.condition === "range"
        ? quote.price >= alert.targetPrice && quote.price <= alert.targetPriceHigh
        : quote.price <= alert.targetPrice;
    // Ưu tiên lần quan sát 10 phút trước để xác định đúng chiều đi vào vùng.
    // Cảnh báo mới chưa có quan sát thì dùng giá đóng cửa phiên trước làm mốc.
    const previousPrice = lastObservedPrice ?? (Number.isFinite(quote.previousPrice) ? quote.previousPrice : null);
    const directionMatched = alert.condition !== "range" || (previousPrice != null && (
      alert.rangeAction === "buy"
        ? previousPrice > alert.targetPriceHigh
        : previousPrice < alert.targetPrice
    ));
    if (!conditionMatched) {
      if (alert.wasMatched !== false) { alert.wasMatched = false; changed = true; }
      continue;
    }
    if (!alert.enabled || !priceAlertScheduleDue(alert, nowDate)) continue;
    const shouldTrigger = directionMatched && (alert.frequency === "daily"
      ? alert.lastTriggeredPriceDate !== quoteDate
      : alert.wasMatched !== true);
    if (alert.wasMatched !== true) { alert.wasMatched = true; changed = true; }
    if (!shouldTrigger) continue;
    if (alert.frequency === "once") alert.enabled = false;
    alert.triggeredAt = now;
    alert.triggeredPrice = quote.price;
    alert.lastTriggeredPriceDate = quoteDate;
    alert.triggerCount = (alert.triggerCount || 0) + 1;
    alert.expiredAt = null;
    alert.updatedAt = now;
    changed = true;
    triggered.push(alert);
  }
  if (changed) writePriceAlertStore(alerts);
  for (const alert of triggered) {
    const threshold = alert.condition === "range"
      ? `${alert.rangeAction === "buy" ? "đã đi xuống vào vùng mua" : "đã đi lên vào vùng bán"} ${alert.targetPrice.toLocaleString("en-US")} – ${alert.targetPriceHigh.toLocaleString("en-US")}`
      : `${alert.condition === "above" ? "đã tăng đến" : "đã giảm đến"} ${alert.targetPrice.toLocaleString("en-US")}`;
    await dispatchPush({ preference: "priceAlerts", module: "alerts", targetUsername: alert.username, title: `Calida · ${alert.ticker} chạm giá`, body: `${alert.ticker} ${threshold} (hiện tại ${alert.triggeredPrice.toLocaleString("en-US")}).`, url: "/#alerts", tag: `calida-${alert.id}` });
  }
  return { alerts, prices, triggered };
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Quyền theo phân hệ không hợp lệ");
  const normalized = {};
  for (const [module, value] of Object.entries(raw)) {
    if (!MODULE_SET.has(module) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Phân hệ phân quyền không hợp lệ");
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
      throw new Error("Kho người dùng không hợp lệ; hãy khôi phục users.json từ bản sao lưu vùng dữ liệu");
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
if (authEnabled() && !process.env.SESSION_SECRET) console.warn("SESSION_SECRET chưa được đặt; phiên sẽ bị đăng xuất khi dịch vụ khởi động lại. Hãy đặt SESSION_SECRET riêng trong biến môi trường máy chủ.");

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
    // Nền tảng hosting kết thúc TLS trước khi chuyển tiếp lưu lượng đến Node.
    // Vì vậy không so sánh req.protocol: yêu cầu HTTPS hợp lệ có thể đến tiến trình
    // dưới dạng HTTP. Origin host vẫn cung cấp lớp bảo vệ liên trang cho CSRF guard.
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
app.set("trust proxy", 1); // Nền tảng hosting kết thúc HTTPS trước ứng dụng.
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
const publicIconOptions = {
  index: false,
  setHeaders: (response) => response.setHeader("Cache-Control", "public, max-age=300"),
};
app.use("/icons", express.static(path.join(WEB_DIR, "icons"), publicIconOptions));
app.get("/favicon.ico", (req, res) => res.type("image/x-icon").sendFile(path.join(WEB_DIR, "favicon.ico")));
app.get(["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/apple-touch-icon-180x180.png"], (req, res) =>
  res.type("image/png").sendFile(path.join(WEB_DIR, "icons", "apple-touch-icon.png")));

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

// Readiness: nền tảng triển khai dùng endpoint này trước khi chuyển lưu lượng sang bản mới.
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
  if (!PUSH_ENABLED) return res.status(503).json({ error: "Web Push chưa được cấu hình trên máy chủ. Hãy đặt VAPID keys trong biến môi trường." });
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
  if (!PUSH_ENABLED) return res.status(503).json({ error: "Web Push chưa được cấu hình trên máy chủ. Hãy đặt VAPID keys trong biến môi trường." });
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

// ---------- price alerts ----------
app.get("/api/price-alerts", requireModule("alerts", "view"), async (req, res) => {
  try {
    const admin = isPriceAlertAdmin(req);
    const result = await evaluatePriceAlerts(admin ? null : req.user.u);
    const alerts = admin ? result.alerts : result.alerts.filter((item) => item.username === req.user.u);
    const recipients = admin
      ? USERS.filter((user) => hasModulePermission(user, "alerts", "view")).map((user) => ({ username: user.username, role: user.role }))
      : [{ username: req.user.u, role: requestUser(req)?.role || "viewer" }];
    if (admin && req.user.u === "local" && !recipients.length) recipients.push({ username: "local", role: "admin" });
    res.set("Cache-Control", "no-store");
    return res.json({ alerts: alerts.map((item) => publicPriceAlert(item, result.prices)), recipients, canAssignRecipients: admin, priceRefresh: priceRefreshInfo() });
  } catch (error) { return res.status(500).json({ error: `Không tải được cảnh báo giá: ${error.message}` }); }
});

app.post("/api/price-alerts", requireModule("alerts", "edit"), requireCsrf, writeLimit, async (req, res) => {
  try {
    const details = cleanPriceAlertInput(req.body?.alert);
    const recipients = priceAlertRecipients(req, req.body?.recipients);
    const now = new Date().toISOString();
    const enabled = typeof req.body?.alert?.enabled === "boolean" ? req.body.alert.enabled : true;
    if (enabled && details.expiresAt && new Date(details.expiresAt) <= new Date()) throw new Error("Hạn cảnh báo phải nằm trong tương lai");
    const batchId = recipients.length > 1 ? `batch:${crypto.randomUUID()}` : null;
    const created = recipients.map((username) => ({ id: `price:${crypto.randomUUID()}`, username, createdBy: req.user.u, batchId, ...details, enabled, wasMatched: false, triggeredAt: null, triggeredPrice: null, triggerCount: 0, lastTriggeredPriceDate: null, expiredAt: null, lastPrice: null, lastPriceDate: null, lastCheckedAt: null, createdAt: now, updatedAt: now }));
    writePriceAlertStore([...readPriceAlertStore(), ...created]);
    audit(req, "price-alert.create", { ids: created.map((alert) => alert.id), recipients, sourceType: details.sourceType, actionId: details.actionId, ticker: details.ticker, condition: details.condition, targetPrice: details.targetPrice, targetPriceHigh: details.targetPriceHigh, rangeAction: details.rangeAction });
    const result = await evaluatePriceAlerts(isPriceAlertAdmin(req) ? null : req.user.u);
    const saved = created.map((alert) => result.alerts.find((item) => item.id === alert.id) || alert).map((alert) => publicPriceAlert(alert, result.prices));
    return res.status(201).json({ ok: true, alert: saved[0], alerts: saved });
  } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
});

app.patch("/api/price-alerts/:id", requireModule("alerts", "edit"), requireCsrf, writeLimit, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!PRICE_ALERT_ID.test(id)) return res.status(404).json({ error: "Không tìm thấy cảnh báo giá" });
    const alerts = readPriceAlertStore();
    const index = alerts.findIndex((item) => item.id === id && canManagePriceAlert(req, item));
    if (index < 0) return res.status(404).json({ error: "Không tìm thấy cảnh báo giá" });
    const previous = alerts[index];
    const details = cleanPriceAlertInput(req.body?.alert || {}, previous);
    const enabled = typeof req.body?.alert?.enabled === "boolean" ? req.body.alert.enabled : previous.enabled;
    if (enabled && details.expiresAt && new Date(details.expiresAt) <= new Date()) throw new Error("Hạn cảnh báo phải nằm trong tương lai");
    const triggerRuleChanged = details.ticker !== previous.ticker || details.condition !== previous.condition || details.targetPrice !== previous.targetPrice || details.targetPriceHigh !== previous.targetPriceHigh || details.rangeAction !== previous.rangeAction || details.frequency !== previous.frequency || details.scheduleMode !== previous.scheduleMode || details.notifyTime !== previous.notifyTime;
    const reset = enabled && (!previous.enabled || triggerRuleChanged);
    alerts[index] = { ...previous, ...details, enabled, wasMatched: triggerRuleChanged ? false : previous.wasMatched, triggeredAt: reset ? null : previous.triggeredAt, triggeredPrice: reset ? null : previous.triggeredPrice, expiredAt: enabled ? null : previous.expiredAt, updatedAt: new Date().toISOString() };
    writePriceAlertStore(alerts);
    audit(req, "price-alert.update", { id, ticker: details.ticker, condition: details.condition, targetPrice: details.targetPrice, targetPriceHigh: details.targetPriceHigh, rangeAction: details.rangeAction, enabled });
    const result = await evaluatePriceAlerts(isPriceAlertAdmin(req) ? null : req.user.u);
    const saved = result.alerts.find((item) => item.id === id) || alerts[index];
    return res.json({ ok: true, alert: publicPriceAlert(saved, result.prices) });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.delete("/api/price-alerts/:id", requireModule("alerts", "edit"), requireCsrf, writeLimit, (req, res) => {
  const id = String(req.params.id || "");
  const alerts = readPriceAlertStore();
  const existing = alerts.find((item) => item.id === id && canManagePriceAlert(req, item));
  if (!PRICE_ALERT_ID.test(id) || !existing) return res.status(404).json({ error: "Không tìm thấy cảnh báo giá" });
  writePriceAlertStore(alerts.filter((item) => item.id !== id));
  audit(req, "price-alert.delete", { id, ticker: existing.ticker, username: existing.username });
  return res.json({ ok: true, id });
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
    const alerts = readPriceAlertStore();
    if (alerts.some((alert) => alert.username === username)) writePriceAlertStore(alerts.filter((alert) => alert.username !== username));
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
let priceRefreshTimer = null;
let priceAlertTimer = null;
let nextPriceRefreshAt = null;
let priceRefreshState = { lastAttemptAt: null, lastSuccessAt: null, lastSkippedAt: null, lastError: null };
let pipelineState = { status: "idle", startedAt: null, finishedAt: null, reason: null, error: null };

function priceRefreshInfo(includeError = false) {
  const primaryProvider = PRICE_PRIMARY_PROVIDER === "vnstock" ? "Vnstock" : PRICE_PRIMARY_PROVIDER === "dnse" ? (DNSE_CONFIGURED ? "DNSE" : "Vnstock") : (DNSE_CONFIGURED ? "DNSE" : "Vnstock");
  return {
    minutes: PRICE_REFRESH_MINUTES,
    windows: PRICE_REFRESH_WINDOWS,
    primaryProvider,
    fallbackProvider: primaryProvider === "DNSE" ? "Vnstock" : (DNSE_CONFIGURED ? "DNSE" : null),
    dnseConfigured: DNSE_CONFIGURED,
    nextAt: nextPriceRefreshAt,
    ...priceRefreshState,
    lastError: priceRefreshState.lastError ? (includeError ? priceRefreshState.lastError : "Không cập nhật được giá") : null,
  };
}

function trackPriceRefresh(job) {
  priceRefreshState = { ...priceRefreshState, lastAttemptAt: new Date().toISOString(), lastError: null };
  return job.then(
    (result) => {
      priceRefreshState = { ...priceRefreshState, lastSuccessAt: new Date().toISOString(), lastError: null };
      return result;
    },
    (error) => {
      priceRefreshState = { ...priceRefreshState, lastError: error.message };
      throw error;
    },
  );
}

function startPipeline(args, reason, options = {}) {
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
      if (timedOut) return finish(new Error(`Quy trình dữ liệu quá thời gian cho phép (${Math.round(PIPELINE_TIMEOUT_MS / 60000)} phút)`));
      if (code === 0) return finish(null, tail);
      return finish(new Error(`Quy trình dữ liệu lỗi (mã ${code ?? signal ?? "không rõ"}). Xem ${logFile}\n${tail.slice(-500)}`));
    });
  });
  running = job.then(
    async (result) => {
      pipelineState = { ...pipelineState, status: "ok", finishedAt: new Date().toISOString() };
      if (!options.quiet) audit(null, "pipeline.complete", { reason, status: "ok" });
      try { await evaluatePriceAlerts(); }
      catch (error) { console.error(`Không kiểm tra được cảnh báo giá: ${error.message}`); }
      return result;
    },
    (error) => {
      pipelineState = { ...pipelineState, status: "error", finishedAt: new Date().toISOString(), error: error.message };
      if (!options.quiet) {
        audit(null, "pipeline.complete", { reason, status: "error", error: error.message.slice(0, 300) });
        queuePush({ preference: "pipeline", module: "admin", title: "Calida · Quy trình dữ liệu lỗi", body: `Không hoàn tất: ${reason}. Mở Quản trị để xem nhật ký.`, url: "/#admin", tag: "calida-pipeline-error" });
      }
      throw error;
    },
  ).finally(() => { running = null; });
  return running;
}

function enqueuePipeline(args, reason, options = {}) {
  queuedJobs += 1;
  const job = pipelineQueue.catch(() => {}).then(() => startPipeline(args, reason, options));
  // Queue phải luôn trở về trạng thái resolved: request gọi job vẫn nhận lỗi,
  // còn hàng đợi tiếp tục chạy tác vụ sau và Node không có rejection bị bỏ quên.
  pipelineQueue = job.then(
    () => { queuedJobs -= 1; },
    () => { queuedJobs -= 1; },
  );
  return job;
}

function runPythonJson(script, args = [], timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(ROOT, "pipeline", script), ...args], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Đọc thống kê dữ liệu quá thời gian cho phép"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", (error) => finish(new Error(`Không chạy được ${PYTHON}: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error(stderr.trim() || `Tiện ích dữ liệu dừng với mã ${code}`));
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        return finish(null, JSON.parse(line || "{}"));
      } catch { return finish(new Error("Không đọc được kết quả thống kê dữ liệu")); }
    });
  });
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

const readData = () => readDashboard().data;
const RISK_TOPICS = () => [...new Set(readData().reports.flatMap((report) => report.risks.map((risk) => risk.k)))];
const asList = (value) => Array.isArray(value) ? value : [];

function dashboardForUser(data, user) {
  const permissions = effectivePermissions(user);
  const pausedFlows = { asOf: null, investors: { "Hôm nay": {}, MTD: {}, YTD: {} }, history: { dates: [] }, tickers: [], sectors: [] };
  const features = { ...data.features, flowsEnabled: FLOWS_MODULE_ENABLED };
  // Tổng quan là dashboard điều hành nên được phép dùng số liệu tổng hợp. Các
  // tài khoản chỉ được cấp module riêng chỉ nhận đúng dữ liệu module đó.
  if (permissions.overview.view) return { ...data, features, flows: FLOWS_MODULE_ENABLED ? data.flows : pausedFlows, workspace: publicWorkspaceState(user) };
  const result = {
    asOf: data.asOf, features,
    meta: data.meta,
    market: { index: data.market?.index ?? null },
    news: [], events: [], reports: [], funds: null, prices: [],
    flows: pausedFlows,
    portfolio: { ytd: null, alloc: {}, positions: [], today: [], history: [] }, workspace: publicWorkspaceState(user),
  };
  if (permissions.brief.view) Object.assign(result, { market: data.market, news: data.news, events: data.events });
  if (permissions.portfolio.view) result.portfolio = data.portfolio;
  if (FLOWS_MODULE_ENABLED && permissions.flows.view) result.flows = data.flows;
  if (permissions.funds.view) result.funds = data.funds;
  if (permissions.reports.view) result.reports = data.reports;
  if (permissions.alerts.view) result.prices = data.prices || [];
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
const WORKSPACE_ID = /^(?:(?:portfolio|signal):[A-Z0-9._-]{1,16}|manual:[a-f0-9-]{36})$/;
const MANUAL_ACTIONS = new Set(["MUA", "BÁN", "TĂNG TỶ TRỌNG", "GIẢM TỶ TRỌNG", "THEO DÕI"]);

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
    queuePush({ preference: "signals", module: "signals", title: "Calida · Tín hiệu mới", body: `Có tín hiệu mới cho ${id.split(":")[1]}.`, url: "/#signals", tag: `calida-${id}` });
  }
  return { state: state[collection][id] };
}

function actionQuantity(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw new Error("Khối lượng phải là số nguyên từ 0 đến 1.000.000.000");
  return value;
}

function manualActionInput(body, previous = {}) {
  const ticker = String(body.ticker ?? previous.ticker ?? "").trim().toUpperCase();
  const action = String(body.action ?? previous.action ?? "").trim().toUpperCase();
  const context = String(body.context ?? previous.context ?? "").trim();
  const sector = String(body.sector ?? previous.sector ?? "Chủ động khai báo").trim();
  const zone = String(body.zone ?? previous.zone ?? "—").trim();
  const priceValue = body.price ?? previous.price ?? null;
  const price = priceValue === "" || priceValue === null ? null : Number(priceValue);
  if (!/^[A-Z0-9._-]{1,16}$/.test(ticker)) throw new Error("Mã chứng khoán chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang (tối đa 16 ký tự)");
  if (!MANUAL_ACTIONS.has(action)) throw new Error("Hành động khuyến nghị không hợp lệ");
  if (!context || context.length > 300) throw new Error("Ngữ cảnh khuyến nghị cần từ 1 đến 300 ký tự");
  if (!sector || sector.length > 80) throw new Error("Ngành cần từ 1 đến 80 ký tự");
  if (!zone || zone.length > 80) throw new Error("Vùng giá cần từ 1 đến 80 ký tự");
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 10_000_000)) throw new Error("Giá tham chiếu không hợp lệ");
  return { ticker, action, context, sector, zone, price };
}

function createManualAction(req) {
  const body = req.body || {};
  let details, plannedQuantity, completedQuantity;
  try {
    details = manualActionInput(body);
    plannedQuantity = actionQuantity(body.plannedQuantity);
    completedQuantity = actionQuantity(body.completedQuantity);
  } catch (error) { return { error: error.message }; }
  if (plannedQuantity !== null && completedQuantity !== null && completedQuantity > plannedQuantity) return { error: "Khối lượng đã thực hiện không thể lớn hơn khối lượng hành động" };
  const deadline = body.deadline == null || body.deadline === "" ? null : String(body.deadline);
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return { error: "Hạn xử lý phải theo định dạng YYYY-MM-DD" };
  const note = body.note == null ? "" : String(body.note).trim();
  if (note.length > 300) return { error: "Ghi chú không được quá 300 ký tự" };
  const id = `manual:${crypto.randomUUID()}`;
  const state = readWorkspaceState();
  state.actions[id] = { kind: "manual", ...details, status: String(body.status || "pending"), plannedQuantity, completedQuantity, deadline, note, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: req.user.u };
  if (!WORKSPACE_STATUS.actions.has(state.actions[id].status)) return { error: "Trạng thái hành động không hợp lệ" };
  writeWorkspaceState(state);
  audit(req, "action.create", { id, ticker: details.ticker, action: details.action, status: state.actions[id].status });
  if (state.actions[id].status === "pending") queuePush({ preference: "actions", module: "actions", title: "Calida · Khuyến nghị mới", body: `${details.ticker}: ${details.action}${deadline ? ` trước ${deadline}` : ""}.`, url: "/#actions", tag: `calida-${id}` });
  return { action: { id, ...state.actions[id] } };
}

function updateActionDetails(req) {
  const id = String(req.params.id || "");
  const body = req.body || {};
  const isManual = id.startsWith("manual:");
  if (!WORKSPACE_ID.test(id) || (!id.startsWith("portfolio:") && !isManual)) return { error: "Hành động không hợp lệ" };
  if (body.status !== undefined && !WORKSPACE_STATUS.actions.has(String(body.status))) return { error: "Trạng thái hành động không hợp lệ" };
  let plannedQuantity;
  let completedQuantity;
  try {
    plannedQuantity = actionQuantity(body.plannedQuantity);
    completedQuantity = actionQuantity(body.completedQuantity);
  } catch (error) { return { error: error.message }; }
  if (plannedQuantity !== null && completedQuantity !== null && completedQuantity > plannedQuantity) return { error: "Khối lượng đã thực hiện không thể lớn hơn khối lượng hành động" };
  const deadline = body.deadline == null || body.deadline === "" ? null : String(body.deadline);
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return { error: "Hạn xử lý phải theo định dạng YYYY-MM-DD" };
  const note = body.note == null ? "" : String(body.note).trim();
  if (note.length > 300) return { error: "Ghi chú không được quá 300 ký tự" };
  const state = readWorkspaceState();
  const previous = state.actions[id] || {};
  if (isManual && previous.kind !== "manual") return { error: "Không tìm thấy khuyến nghị thủ công" };
  let details = {};
  if (isManual) {
    try { details = manualActionInput(body, previous); }
    catch (error) { return { error: error.message }; }
  }
  state.actions[id] = {
    ...previous,
    ...details,
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
    queuePush({ preference: "actions", module: "actions", title: "Calida · Hành động cần xử lý", body: `${id.split(":")[1]} đang chờ xử lý${deadline ? ` trước ${deadline}` : ""}.`, url: "/#actions", tag: `calida-${id}` });
  }
  return { state: state.actions[id] };
}

function deleteManualAction(req) {
  const id = String(req.params.id || "");
  if (!WORKSPACE_ID.test(id) || !id.startsWith("manual:")) return { error: "Chỉ có thể xóa khuyến nghị tạo thủ công" };
  const state = readWorkspaceState();
  if (state.actions[id]?.kind !== "manual") return { error: "Không tìm thấy khuyến nghị thủ công" };
  delete state.actions[id];
  writeWorkspaceState(state);
  audit(req, "action.delete", { id });
  return { id };
}

app.post("/api/actions", requireModule("actions", "edit"), requireCsrf, writeLimit, (req, res) => {
  const result = createManualAction(req);
  return result.error ? res.status(400).json(result) : res.status(201).json({ ok: true, ...result });
});

app.patch("/api/actions/:id", requireModule("actions", "edit"), requireCsrf, writeLimit, (req, res) => {
  const result = updateActionDetails(req);
  return result.error ? res.status(400).json(result) : res.json({ ok: true, ...result });
});

app.delete("/api/actions/:id", requireModule("actions", "edit"), requireCsrf, writeLimit, (req, res) => {
  const result = deleteManualAction(req);
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
  return res.json({ asOf, freshness, dashboard: dashboardReadiness(), pipeline: { ...pipelineState, queuedJobs }, priceRefresh: priceRefreshInfo(), aiEnabled: Boolean(GEMINI_KEY) });
});

app.get("/api/admin/operations", requireModule("admin", "edit"), (req, res) => {
  let freshness = [];
  let quality = { status: "unknown", issues: [] };
  try {
    const data = readData();
    freshness = data.meta?.freshness || [];
    quality = data.meta?.quality || quality;
  } catch { /* Report the pipeline state even without dashboard data. */ }
  return res.json({ pipeline: { ...pipelineState, queuedJobs }, priceRefresh: priceRefreshInfo(true), modules: { flowsEnabled: FLOWS_MODULE_ENABLED }, freshness, quality, audit: recentAudit() });
});

const DATA_ADMIN_MODULES = Object.freeze({ brief: "Bản tin", portfolio: "Danh mục", flows: "Dòng tiền", funds: "Quỹ đầu tư", reports: "Báo cáo CTCK" });
const DATA_ADMIN_TABLES = Object.freeze({
  brief: ["all", "view", "news", "events"],
  portfolio: ["all", "positions", "prices", "transactions", "summary"],
  flows: ["all", "investor_flow", "ticker_flow", "sector_flow"],
  funds: ["all", "fund_summary", "asset_allocation", "industry", "top_holdings"],
  reports: ["all", "reports", "report_stocks", "report_sectors", "report_risks"],
});

app.get("/api/admin/database", requireModule("admin", "edit"), async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    return res.json(await runPythonJson("data_admin.py", ["summary"]));
  } catch (error) { return res.status(503).json({ error: `Không đọc được dữ liệu nguồn: ${error.message}` }); }
});

app.delete("/api/admin/database", requireModule("admin", "edit"), requireCsrf, pipelineLimit, async (req, res) => {
  const module = String(req.body?.module || "");
  const table = String(req.body?.table || "all");
  const from = String(req.body?.from || "");
  const to = String(req.body?.to || "");
  if (!Object.hasOwn(DATA_ADMIN_MODULES, module)) return res.status(400).json({ error: "Module quản trị dữ liệu không hợp lệ" });
  if (!DATA_ADMIN_TABLES[module].includes(table)) return res.status(400).json({ error: "Nhóm dữ liệu không thuộc module đã chọn" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return res.status(400).json({ error: "Khoảng ngày xoá không hợp lệ" });
  }
  if (req.body?.confirmation !== "XOA DU LIEU") return res.status(400).json({ error: "Thiếu xác nhận xoá dữ liệu" });
  try {
    const label = DATA_ADMIN_MODULES[module];
    await enqueuePipeline(["--purge-module", module, "--purge-table", table, "--from-date", from, "--to-date", to, "--actor", req.user.u], `xoá dữ liệu ${label} từ ${from} đến ${to}`);
    audit(req, "database.delete", { module, table, label, from, to });
    return res.json({ ok: true, module, table, label, from, to });
  } catch (error) { return res.status(500).json({ error: error.message }); }
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

const PIPELINE_RUN_MODES = Object.freeze({
  build: { args: ["--build-only"], label: "dựng lại bảng điều hành" },
  prices: { args: ["--prices-only"], label: "cập nhật giá trong phiên" },
  all: { args: [], label: "đồng bộ tất cả nguồn" },
  portfolio: { args: ["--source", "portfolio", "--no-prices"], label: "đồng bộ Danh mục" },
  operations: { args: ["--source", "operations", "--no-prices"], label: "đồng bộ Vận hành" },
  funds: { args: ["--source", "funds", "--no-prices"], label: "đồng bộ Quỹ" },
  reports: { args: ["--source", "reports", "--no-prices"], label: "đồng bộ Báo cáo CTCK" },
});

app.post("/api/pipeline/run", requireModule("admin", "edit"), requireCsrf, pipelineLimit, (req, res) => {
  const requestedMode = req.body?.mode ?? (req.body?.buildOnly === true ? "build" : "all");
  if (typeof requestedMode !== "string" || !Object.hasOwn(PIPELINE_RUN_MODES, requestedMode)) {
    return res.status(400).json({ error: "Chế độ đồng bộ không hợp lệ" });
  }
  const mode = PIPELINE_RUN_MODES[requestedMode];
  const args = mode.args;
  const wasQueued = queuedJobs > 0 || Boolean(running);
  audit(req, "pipeline.queue", { mode: requestedMode, label: mode.label, wasQueued });
  const job = enqueuePipeline(args, `chạy tay: ${mode.label}`);
  (requestedMode === "prices" ? trackPriceRefresh(job) : job).catch((error) => console.error(error.message));
  return res.status(202).json({ ok: true, queued: wasQueued, mode: requestedMode });
});

// ---------- static site ----------
// Giao diện PWA thay đổi thường xuyên; Safari/iOS không được giữ lại index.html
// cũ sau khi máy chủ phát hành bản mới, nếu không các CSS responsive mới sẽ không áp dụng.
app.get(["/", "/index.html"], (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.sendFile(path.join(WEB_DIR, "index.html"));
});
app.get("/data/dashboard.json", (req, res) => {
  if (authEnabled()) return res.status(403).json({ error: "Dữ liệu dashboard được phân quyền qua /api/dashboard" });
  res.set("Cache-Control", "no-store");
  try { return res.sendFile(readDashboard().path); }
  catch (error) { return res.status(503).json({ error: `Không tải được dashboard: ${error.message}` }); }
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

function parsedPriceRefreshWindows() {
  if (!Number.isInteger(PRICE_REFRESH_MINUTES) || PRICE_REFRESH_MINUTES <= 0) return [];
  return PRICE_REFRESH_WINDOWS.split(",").map((part) => {
    const match = /^\s*([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)\s*$/.exec(part);
    if (!match) return null;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    return start <= end ? { start, end } : null;
  }).filter(Boolean).sort((left, right) => left.start - right.start);
}

function nextPriceRefreshTime(now = new Date()) {
  const windows = parsedPriceRefreshWindows();
  if (!windows.length) return null;
  const intervalMs = PRICE_REFRESH_MINUTES * 60_000;
  const afterNow = now.getTime() + 1000;
  let next = null;
  for (let offset = 0; offset < 8; offset += 1) {
    const day = new Date(now);
    day.setDate(now.getDate() + offset);
    day.setHours(0, 0, 0, 0);
    if ([0, 6].includes(day.getDay())) continue;
    for (const window of windows) {
      const start = day.getTime() + window.start * 60_000;
      const end = day.getTime() + window.end * 60_000;
      const steps = Math.max(0, Math.ceil((afterNow - start) / intervalMs));
      const candidate = start + steps * intervalMs;
      if (candidate < afterNow || candidate > end) continue;
      if (!next || candidate < next.getTime()) next = new Date(candidate);
    }
    if (next) break;
  }
  return next;
}

function schedulePriceRefresh() {
  if (priceRefreshTimer) clearTimeout(priceRefreshTimer);
  const now = new Date();
  const next = nextPriceRefreshTime(now);
  if (!next) {
    nextPriceRefreshAt = null;
    if (PRICE_REFRESH_MINUTES > 0) console.error("PRICE_REFRESH_WINDOWS không hợp lệ; lịch cập nhật giá đã tắt.");
    return;
  }
  nextPriceRefreshAt = next.toISOString();
  priceRefreshTimer = setTimeout(() => {
    priceRefreshTimer = null;
    if (running || queuedJobs > 0) {
      priceRefreshState = { ...priceRefreshState, lastSkippedAt: new Date().toISOString() };
      console.log("Bỏ qua lượt cập nhật giá định kỳ vì quy trình dữ liệu khác đang chạy hoặc chờ.");
    } else {
      trackPriceRefresh(enqueuePipeline(["--prices-only"], `cập nhật giá định kỳ ${PRICE_REFRESH_MINUTES} phút`, { quiet: true }))
        .catch((error) => console.error(`Cập nhật giá định kỳ lỗi: ${error.message}`));
    }
    schedulePriceRefresh();
  }, Math.max(1000, next - now));
  priceRefreshTimer.unref?.();
  console.log(`Cập nhật giá kế tiếp: ${next.toLocaleString("vi-VN")}`);
}

function schedulePriceAlertChecks() {
  if (priceAlertTimer) clearInterval(priceAlertTimer);
  priceAlertTimer = setInterval(() => {
    void evaluatePriceAlerts().catch((error) => console.error(`Không kiểm tra được lịch cảnh báo giá: ${error.message}`));
  }, 60_000);
  priceAlertTimer.unref?.();
}

const server = app.listen(PORT, () => {
  console.log(`Calida Analyst chạy tại cổng ${PORT}`);
  if (!authEnabled()) console.warn("⚠ Chưa có ACCESS_TOKEN hoặc CALIDA_USERS_JSON: web đang mở công khai.");
  if (!GEMINI_KEY) console.log("⚠ Chưa có GEMINI_API_KEY: hỏi đáp và trích xuất sẽ báo lỗi");
  if (!fs.existsSync(JSON_PATH)) console.log("⚠ Chưa có dashboard trên Volume; đang dùng bản dự phòng cho tới khi pipeline dựng dữ liệu.");
  scheduleDaily();
  schedulePriceRefresh();
  schedulePriceAlertChecks();
});

function shutdown(signal) {
  console.log(`Nhận ${signal}; đang đóng server an toàn...`);
  if (scheduleTimer) clearTimeout(scheduleTimer);
  if (priceRefreshTimer) clearTimeout(priceRefreshTimer);
  if (priceAlertTimer) clearInterval(priceAlertTimer);
  if (activeProcess) activeProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
