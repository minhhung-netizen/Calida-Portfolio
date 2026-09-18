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
    const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: users[0].password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const me = await request("/api/auth/me", { headers: { cookie } });
    const session = await me.json();
    assert.equal(session.user.role, "admin");
    assert.ok(session.csrfToken, "CALIDA_USERS_JSON phải tạo được session ngay cả khi thiếu SESSION_SECRET");

    const common = { headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken } };
    let response = await request("/api/admin/users", { method: "POST", ...common, body: JSON.stringify({ user: { username: "prototype", password: "prototype-password-123", role: "constructor" } }) });
    assert.equal(response.status, 400, "role prototype không được chấp nhận");

    const viewerLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "viewer", password: users[1].password }) });
    const viewerCookie = viewerLogin.headers.get("set-cookie").split(";", 1)[0];
    response = await request("/api/admin/users", { headers: { cookie: viewerCookie } });
    assert.equal(response.status, 403, "viewer không có quyền quản trị");

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
