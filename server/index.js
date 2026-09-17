/**
 * Calida Analyst — server
 *  - Phục vụ giao diện tĩnh (web/)
 *  - /api/chat     hỏi đáp trên thư viện báo cáo (Gemini)
 *  - /api/extract  trích xuất báo cáo từ text/PDF (Gemini, JSON mode)
 *  - /api/reports  lưu báo cáo vào data/inbox → chạy lại pipeline build
 *  - Lịch chạy pipeline đầy đủ mỗi ngày (PIPELINE_TIME, giờ Việt Nam)
 */
import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- .env ----------
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
process.env.TZ = process.env.TZ || "Asia/Ho_Chi_Minh";

const PORT = Number(process.env.PORT || 8080);
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const PYTHON = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const PIPELINE_TIME = process.env.PIPELINE_TIME ?? "16:30"; // "" để tắt
const WEB_DIR = path.join(ROOT, "web");
const JSON_PATH = path.join(WEB_DIR, "data", "dashboard.json");
const INBOX = path.join(ROOT, "data", "inbox", "reports.jsonl");
const LOG_DIR = path.join(ROOT, "data", "logs");
fs.mkdirSync(path.dirname(INBOX), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "30mb" }));

// ---------- auth (tùy chọn) ----------
const auth = (req, res, next) => {
  if (!ACCESS_TOKEN) return next();
  const t = req.get("x-access-token") || "";
  const ok = t.length === ACCESS_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ACCESS_TOKEN));
  return ok ? next() : res.status(401).json({ error: "Sai hoặc thiếu mã truy cập" });
};

// ---------- pipeline runner (1 tiến trình tại một thời điểm) ----------
let running = null;
function runPipeline(args, reason) {
  if (running) return running;
  const logFile = path.join(LOG_DIR, `pipeline-${new Date().toISOString().slice(0, 10)}.log`);
  const log = fs.createWriteStream(logFile, { flags: "a" });
  log.write(`\n===== ${new Date().toLocaleString("vi-VN")} | ${reason} | ${args.join(" ")}\n`);
  running = new Promise((resolve, reject) => {
    const p = spawn(PYTHON, [path.join(ROOT, "pipeline", "run.py"), ...args], { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let tail = "";
    const onData = (d) => { log.write(d); tail = (tail + d).slice(-2000); };
    p.stdout.on("data", onData); p.stderr.on("data", onData);
    p.on("error", (e) => { log.end(); reject(new Error(`Không chạy được ${PYTHON}: ${e.message}`)); });
    p.on("close", (code) => { log.end(); code === 0 ? resolve(tail) : reject(new Error(`Pipeline lỗi (mã ${code}). Xem ${logFile}\n${tail.slice(-500)}`)); });
  }).finally(() => { running = null; });
  return running;
}

// ---------- Gemini ----------
async function gemini({ system, contents, json = false, temperature = 0.2 }) {
  if (!GEMINI_KEY) throw Object.assign(new Error("Chưa cấu hình GEMINI_API_KEY trên server"), { status: 503 });
  const url = `${process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com"}/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
  };
  let wait = 2000;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify(body) });
    if (r.ok) {
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      if (!text) throw new Error("Gemini không trả về nội dung (" + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "không rõ") + ")");
      return text;
    }
    const errText = await r.text();
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {        // quota / quá tải → chờ rồi thử lại
      await new Promise((s) => setTimeout(s, wait)); wait *= 2; continue;
    }
    throw Object.assign(new Error(`Gemini ${r.status}: ${errText.slice(0, 300)}`), { status: r.status === 429 ? 429 : 502 });
  }
}

const readData = () => JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const RISK_TOPICS = () => [...new Set(readData().reports.flatMap((r) => r.risks.map((k) => k.k)))];

// ---------- routes ----------
app.get("/api/health", (req, res) => {
  let asOf = null; try { asOf = readData().asOf; } catch {}
  res.json({ ok: true, ai: !!GEMINI_KEY, model: GEMINI_MODEL, asOf, pipelineRunning: !!running, auth: !!ACCESS_TOKEN });
});

app.post("/api/chat", auth, async (req, res) => {
  try {
    const msgs = (req.body.messages || []).filter((m) => m && m.content).slice(-12);
    if (!msgs.length || msgs.at(-1).role !== "user") return res.status(400).json({ error: "Thiếu câu hỏi" });
    const d = readData();
    const library = d.reports.map((r) => ({ id: r.id, broker: r.broker, date: r.date, type: r.type, title: r.title, stance: r.stance,
      vnTarget: r.vnTarget, horizon: r.horizon, overweight: r.ow, underweight: r.uw, stocks: r.stocks, risks: r.risks, summary: r.summary }));
    const system = `Bạn là trợ lý phân tích của phòng phân tích Calida (quỹ cổ phiếu Việt Nam). Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào số liệu.
QUY TẮC:
- Chỉ dùng dữ liệu trong THƯ VIỆN BÁO CÁO bên dưới. Không bịa số liệu, CTCK hay báo cáo.
- Mỗi nhận định phải ghi nguồn dạng (Tên CTCK, dd/mm).
- Nếu thư viện không có thông tin, nói rõ là chưa có.
- Khi các CTCK có quan điểm trái chiều, nêu cả hai phía.
- Với target, dùng khuyến nghị mới nhất của mỗi CTCK; nêu trung vị/biên khi tổng hợp.
- Không dùng tiêu đề markdown; dùng gạch đầu dòng ngắn khi liệt kê.
Ngày dữ liệu: ${d.asOf}. VN-Index: ${d.market?.index}. Mã trong danh mục Calida: ${d.portfolio.positions.map((p) => `${p.t} (giá ${p.price})`).join(", ")}.
THƯ VIỆN BÁO CÁO (JSON):
${JSON.stringify(library)}`;
    const contents = msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content).slice(0, 4000) }] }));
    res.json({ text: await gemini({ system, contents, temperature: 0.2 }) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post("/api/extract", auth, async (req, res) => {
  try {
    const { text, pdfBase64 } = req.body || {};
    if (!text && !pdfBase64) return res.status(400).json({ error: "Cần text hoặc pdfBase64" });
    const prompt = `Trích xuất thông tin từ báo cáo phân tích chứng khoán Việt Nam. Trả về đúng 1 object JSON theo schema:
{"broker":string,"date":"YYYY-MM-DD","type":"Chiến lược"|"Vĩ mô"|"Ngành"|"Doanh nghiệp","title":string,"stance":"Tích cực"|"Trung lập"|"Thận trọng"|"Tiêu cực","vnTarget":number|null,"horizon":string,"ow":[string],"uw":[string],"stocks":[{"t":string,"rec":"MUA"|"KHẢ QUAN"|"TRUNG LẬP"|"KÉM KHẢ QUAN"|"BÁN","target":number|null}],"risks":[{"k":string,"s":1|2|3}],"summary":string}
- ow/uw: ngành khuyến nghị tăng/giảm tỷ trọng, chuẩn hóa theo: Ngân hàng, Chứng khoán, Bất động sản, Xây dựng, Vật liệu xây dựng, Thép, Hóa chất, Dầu khí, Công nghệ thông tin, Bán lẻ, Thực phẩm & đồ uống, Điện, nước & xăng dầu khí đốt, Xuất khẩu, Hàng không, Tiện ích.
- risks.k: ưu tiên dùng đúng các chủ đề đã có: ${RISK_TOPICS().join("; ")}. s: 1 thấp, 2 trung bình, 3 cao.
- target giá cổ phiếu theo nghìn đồng (VD 142.000 đ → 142). vnTarget là điểm VN-Index.
- summary: tối đa 2 câu, tự viết lại, không chép nguyên văn.
- Trường không có thông tin: null hoặc mảng rỗng.`;
    const parts = pdfBase64
      ? [{ inline_data: { mime_type: "application/pdf", data: pdfBase64 } }, { text: prompt }]
      : [{ text: prompt + "\n\nBÁO CÁO:\n" + String(text).slice(0, 80000) }];
    const out = await gemini({ contents: [{ role: "user", parts }], json: true, temperature: 0 });
    const obj = JSON.parse(out.replace(/^```(json)?|```$/g, "").trim());
    res.json(Array.isArray(obj) ? obj[0] : obj);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

const TYPES = ["Chiến lược", "Vĩ mô", "Ngành", "Doanh nghiệp"];
const STANCES = ["Tích cực", "Trung lập", "Thận trọng", "Tiêu cực"];
app.post("/api/reports", auth, async (req, res) => {
  try {
    const r = req.body?.report || {};
    const errs = [];
    if (!r.broker) errs.push("thiếu CTCK");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || "")) errs.push("ngày phải dạng YYYY-MM-DD");
    if (!TYPES.includes(r.type)) errs.push("loại báo cáo không hợp lệ");
    if (!STANCES.includes(r.stance)) errs.push("quan điểm không hợp lệ");
    if (errs.length) return res.status(400).json({ error: errs.join("; ") });
    const clean = {
      id: "U" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"),
      broker: String(r.broker).trim(), date: r.date, type: r.type, title: String(r.title || "").slice(0, 300),
      stance: r.stance, vnTarget: Number(r.vnTarget) || null, horizon: String(r.horizon || ""), source: String(r.source || ""),
      summary: String(r.summary || "").slice(0, 2000),
      ow: (r.ow || []).map(String), uw: (r.uw || []).map(String),
      stocks: (r.stocks || []).filter((s) => /^[A-Z0-9]{3,4}$/.test(s.t)).map((s) => ({ t: s.t, rec: String(s.rec || ""), target: Number(s.target) || null })),
      risks: (r.risks || []).filter((k) => k.k).map((k) => ({ k: String(k.k), s: Math.min(3, Math.max(1, Number(k.s) || 2)) })),
      createdAt: new Date().toISOString(),
    };
    fs.appendFileSync(INBOX, JSON.stringify(clean) + "\n", "utf8");
    await runPipeline(["--build-only"], "lưu báo cáo " + clean.id);
    res.json({ ok: true, id: clean.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/pipeline/run", auth, async (req, res) => {
  const args = req.body?.buildOnly ? ["--build-only"] : [];
  runPipeline(args, "chạy tay qua API").catch(() => {});
  res.json({ ok: true, started: true });
});

// ---------- static ----------
app.use("/data", express.static(path.join(WEB_DIR, "data"), { etag: false, cacheControl: false, setHeaders: (r) => r.setHeader("Cache-Control", "no-store") }));
app.use(express.static(WEB_DIR));

// ---------- lịch chạy hằng ngày (thứ 2–6) ----------
function scheduleDaily() {
  if (!PIPELINE_TIME) return;
  const [h, m] = PIPELINE_TIME.split(":").map(Number);
  const now = new Date();
  const next = new Date(now); next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  while ([0, 6].includes(next.getDay())) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    try { await runPipeline([], "lịch hằng ngày"); console.log("Pipeline hằng ngày: xong"); }
    catch (e) { console.error(e.message); }
    scheduleDaily();
  }, next - now);
  console.log(`Pipeline kế tiếp: ${next.toLocaleString("vi-VN")}`);
}

app.listen(PORT, () => {
  console.log(`Calida Analyst chạy tại http://localhost:${PORT}`);
  if (!GEMINI_KEY) console.log("⚠ Chưa có GEMINI_API_KEY: hỏi đáp và trích xuất sẽ báo lỗi");
  if (!fs.existsSync(JSON_PATH)) console.log("⚠ Chưa có web/data/dashboard.json — chạy: python pipeline/run.py");
  scheduleDaily();
});
