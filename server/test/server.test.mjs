import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server dừng sớm (mã ${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server không khởi động kịp");
}

function report() {
  return {
    broker: "Test Securities", date: "2026-09-18", type: "Chiến lược", title: "Báo cáo kiểm thử",
    stance: "Trung lập", vnTarget: 1300, horizon: "3 tháng", source: "test", summary: "Dữ liệu kiểm thử.",
    ow: [], uw: [], stocks: [], risks: [],
  };
}

test("đăng nhập, phân quyền và pipeline lỗi vẫn giữ server hoạt động", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "calida-server-test-"));
  const port = await freePort();
  const users = [
    { username: "admin", password: "correct-horse-battery", role: "admin" },
    { username: "viewer", password: "viewer-password-123", role: "viewer" },
  ];
  const child = spawn(process.execPath, ["index.js"], {
    cwd: path.join(ROOT, "server"),
    env: { ...process.env, PORT: String(port), PIPELINE_TIME: "", SESSION_COOKIE_SECURE: "false",
      CALIDA_DATA_DIR: stateDir, CALIDA_USERS_JSON: JSON.stringify(users), PYTHON_BIN: "calida-test-python-not-found" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (route, options = {}) => fetch(base + route, options);

  try {
    await waitFor(`${base}/api/health`, child);
    const health = await request("/api/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "calida-analyst");
    const manifest = await request("/manifest.webmanifest");
    assert.equal(manifest.status, 200, "PWA manifest phải truy cập được trước khi đăng nhập");
    assert.equal((await manifest.json()).display, "standalone");
    for (const route of ["/icons/apple-touch-icon.png", "/apple-touch-icon.png", "/favicon.ico"]) {
      const icon = await request(route, { redirect: "manual" });
      assert.equal(icon.status, 200, `${route} phải truy cập được trước khi đăng nhập`);
      assert.match(icon.headers.get("content-type") || "", /^image\//, `${route} phải trả về ảnh, không phải trang đăng nhập`);
    }
    const worker = await request("/sw.js");
    assert.equal(worker.status, 200, "service worker phải truy cập được trước khi đăng nhập");
    assert.match(await worker.text(), /showNotification/);
    const ready = await request("/api/ready");
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).dashboard.ready, true);
    const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: users[0].password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const me = await request("/api/auth/me", { headers: { cookie } });
    const session = await me.json();
    assert.equal(session.user.role, "admin");
    assert.ok(session.csrfToken, "CALIDA_USERS_JSON phải tạo được session ngay cả khi thiếu SESSION_SECRET");
    const pushConfig = await request("/api/notifications/config", { headers: { cookie } });
    assert.equal(pushConfig.status, 200);
    assert.equal((await pushConfig.json()).available, false, "không có VAPID key thì không được nhận subscription");
    const pushSubscribe = await request("/api/notifications/subscriptions", { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify({ subscription: { endpoint: "https://push.example.test/device", keys: { p256dh: "key", auth: "auth" } } }) });
    assert.equal(pushSubscribe.status, 503, "chưa cấu hình VAPID phải trả hướng dẫn thay vì lưu subscription vô hiệu");
    const appPage = await request("/", { headers: { cookie } });
    assert.equal(appPage.status, 200);
    const csp = appPage.headers.get("content-security-policy") || "";
    assert.match(csp, /https:\/\/fonts\.googleapis\.com/, "CSP phải cho phép stylesheet font đã dùng trong giao diện");
    assert.match(csp, /https:\/\/fonts\.gstatic\.com/, "CSP phải cho phép file font đã dùng trong giao diện");

    const common = { headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken } };
    let response = await request("/api/pipeline/run", { method: "POST", ...common, body: JSON.stringify({ mode: "khong-hop-le" }) });
    assert.equal(response.status, 400, "chỉ chấp nhận các chế độ đồng bộ đã định nghĩa");
    response = await request("/api/admin/users", { method: "POST", ...common, body: JSON.stringify({ user: { username: "prototype", password: "prototype-password-123", role: "constructor" } }) });
    assert.equal(response.status, 400, "role prototype không được chấp nhận");

    const viewerLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "viewer", password: users[1].password }) });
    const viewerCookie = viewerLogin.headers.get("set-cookie").split(";", 1)[0];
    const viewerSession = await (await request("/api/auth/me", { headers: { cookie: viewerCookie } })).json();
    response = await request("/api/admin/users", { headers: { cookie: viewerCookie } });
    assert.equal(response.status, 403, "viewer không có quyền quản trị");
    response = await request("/api/reports", { method: "POST", headers: { cookie: viewerCookie, "content-type": "application/json", "x-csrf-token": viewerSession.csrfToken }, body: JSON.stringify({ report: report() }) });
    assert.equal(response.status, 403, "viewer mặc định không có quyền chỉnh sửa báo cáo");
    response = await request("/api/actions/portfolio%3AFPT/status", { method: "PATCH", headers: { cookie: viewerCookie, "content-type": "application/json", "x-csrf-token": viewerSession.csrfToken }, body: JSON.stringify({ status: "completed" }) });
    assert.equal(response.status, 403, "viewer mặc định không có quyền cập nhật Action Desk");

    response = await request("/api/actions/portfolio%3AFPT/status", { method: "PATCH", ...common, body: JSON.stringify({ status: "completed" }) });
    assert.equal(response.status, 200, "admin phải cập nhật được trạng thái action");
    assert.equal((await response.json()).state.status, "completed");
    response = await request("/api/actions/portfolio%3AFPT", { method: "PATCH", ...common, body: JSON.stringify({ status: "completed", plannedQuantity: 20000, completedQuantity: 5000, deadline: "2026-09-24", note: "Đã khớp lệnh một phần" }) });
    assert.equal(response.status, 200, "admin phải khai báo được tiến độ action");
    assert.deepEqual((await response.json()).state.plannedQuantity, 20000);
    response = await request("/api/actions/portfolio%3AFPT", { method: "PATCH", ...common, body: JSON.stringify({ plannedQuantity: 100, completedQuantity: 101 }) });
    assert.equal(response.status, 400, "không được khai báo khối lượng hoàn thành vượt kế hoạch");
    response = await request("/api/actions", { method: "POST", ...common, body: JSON.stringify({ ticker: "VNM", action: "MUA", sector: "Tiêu dùng", price: 62.5, zone: "61 – 63", context: "Khuyến nghị chủ động để kiểm thử.", plannedQuantity: 1000, completedQuantity: 0, deadline: "2026-09-30", note: "Chờ xác nhận", status: "pending" }) });
    assert.equal(response.status, 201, "admin phải tạo được khuyến nghị hành động chủ động");
    const manualAction = await response.json();
    assert.match(manualAction.action.id, /^manual:/);
    assert.equal(manualAction.action.ticker, "VNM");
    response = await request(`/api/actions/${encodeURIComponent(manualAction.action.id)}`, { method: "PATCH", ...common, body: JSON.stringify({ ticker: "VNM", action: "TĂNG TỶ TRỌNG", sector: "Tiêu dùng", price: 62.5, zone: "60 – 63", context: "Đã điều chỉnh luận điểm.", plannedQuantity: 1000, completedQuantity: 200, deadline: "2026-09-30", note: "Đã giải ngân một phần", status: "waiting" }) });
    assert.equal(response.status, 200, "admin phải cập nhật được khuyến nghị chủ động");
    assert.equal((await response.json()).state.action, "TĂNG TỶ TRỌNG");
    response = await request(`/api/actions/${encodeURIComponent(manualAction.action.id)}`, { method: "DELETE", ...common });
    assert.equal(response.status, 200, "admin phải xóa được khuyến nghị chủ động");
    response = await request("/api/signals/signal%3AFPT/status", { method: "PATCH", ...common, body: JSON.stringify({ status: "watch" }) });
    assert.equal(response.status, 200, "admin phải cập nhật được trạng thái signal");
    response = await request("/api/actions/portfolio%3AFPT/status", { method: "PATCH", ...common, body: JSON.stringify({ status: "not-a-status" }) });
    assert.equal(response.status, 400, "trạng thái ngoài danh sách phải bị chặn");
    const adminDashboard = await (await request("/api/dashboard", { headers: { cookie } })).json();
    assert.equal(adminDashboard.workspace.actions["portfolio:FPT"].status, "completed");
    assert.equal(adminDashboard.workspace.actions["portfolio:FPT"].completedQuantity, 5000);
    assert.equal(adminDashboard.workspace.signals["signal:FPT"].status, "watch");
    assert.equal(adminDashboard.features.flowsEnabled, false, "Dòng tiền mặc định phải được tạm dừng");
    assert.deepEqual(adminDashboard.flows.tickers, [], "không trả dữ liệu Dòng tiền cũ khi module đang tạm dừng");

    const scopedPermissions = {
      overview: { view: false, edit: false }, brief: { view: false, edit: false }, portfolio: { view: false, edit: false },
      flows: { view: false, edit: false }, funds: { view: false, edit: false }, reports: { view: true, edit: true }, actions: { view: false, edit: false }, signals: { view: false, edit: false }, admin: { view: false, edit: false },
    };
    response = await request("/api/admin/users/viewer", { method: "PATCH", ...common, body: JSON.stringify({ user: { permissions: scopedPermissions } }) });
    assert.equal(response.status, 200, "admin phải cấp được quyền riêng theo module");

    const scopedLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "viewer", password: users[1].password }) });
    const scopedCookie = scopedLogin.headers.get("set-cookie").split(";", 1)[0];
    const scopedSession = await (await request("/api/auth/me", { headers: { cookie: scopedCookie } })).json();
    assert.equal(scopedSession.user.permissions.reports.edit, true);
    assert.equal(scopedSession.user.permissions.portfolio.view, false);
    response = await request("/api/dashboard", { headers: { cookie: scopedCookie } });
    const scopedDashboard = await response.json();
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(scopedDashboard.reports) && scopedDashboard.reports.length > 0, "module báo cáo được cấp phải có dữ liệu");
    assert.deepEqual(scopedDashboard.portfolio.positions, [], "không trả dữ liệu module danh mục chưa được cấp");
    assert.equal((await request("/data/dashboard.json", { headers: { cookie: scopedCookie } })).status, 403, "không được truy cập dashboard thô khi đã bật phân quyền");
    response = await request("/api/reports", { method: "POST", headers: { cookie: scopedCookie, "content-type": "application/json", "x-csrf-token": scopedSession.csrfToken }, body: JSON.stringify({ report: report() }) });
    assert.equal(response.status, 500, "quyền chỉnh sửa báo cáo riêng phải vượt qua lớp phân quyền trước khi pipeline giả lập lỗi");

    // Python giả lập lỗi. Hai lần liên tiếp phải đều trả lỗi HTTP, không được làm
    // Node dừng do unhandled promise rejection trong pipeline queue.
    for (let i = 0; i < 2; i += 1) {
      response = await request("/api/reports", { method: "POST", ...common, body: JSON.stringify({ report: report() }) });
      assert.equal(response.status, 500);
      assert.equal(child.exitCode, null);
    }
    assert.equal((await request("/api/health")).status, 200);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
