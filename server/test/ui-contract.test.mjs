import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const html = readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).find((script) => script.includes("function pgOverview"));
const fixture = JSON.parse(readFileSync(path.join(ROOT, "web", "data", "dashboard.json"), "utf8"));
const modules = ["overview", "brief", "portfolio", "flows", "funds", "reports", "actions", "signals", "admin"];

// Exercise the real render functions without fetching data or starting polling.
// This is a render-contract check, not a substitute for browser layout testing.
function app(allowed = modules, editable = modules) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: "", textContent: "", dataset: {}, style: {}, hidden: false,
      setAttribute() {}, removeAttribute() {}, addEventListener() {},
      querySelectorAll: () => [], querySelector: () => null,
      classList: { add() {}, remove() {}, toggle() {} },
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    window: { CALIDA_CONFIG: {}, addEventListener() {}, scrollTo() {} },
    document: { documentElement: { dataset: {} }, body: element("body"),
      querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    location: { hash: "", origin: "http://localhost", assign() {} },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    console, fixture: structuredClone(fixture),
    permissions: Object.fromEntries(modules.map((name) => [name, {
      view: allowed.includes(name), edit: allowed.includes(name) && editable.includes(name),
    }])),
  });
  assert.ok(source, "SPA inline script must be present");
  const bootStart = source.indexOf("(async function boot(){");
  assert.ok(bootStart > 0, "Locate boot before evaluating render functions");
  vm.runInContext(source.slice(0, bootStart), context);
  vm.runInContext('DATA=fixture; API_OK=true; CURRENT_USER={username:"test",role:"admin",permissions}; STATE.adminUsers=[]; STATE.adminOps={};', context);
  return { run: (code) => vm.runInContext(code, context), element };
}

test("SPA JavaScript parses", () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test("theme text tokens meet normal-text contrast on their surfaces", () => {
  const luminance = (hex) => {
    const channels = hex.match(/../g).map((part) => parseInt(part, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const themes = [...html.matchAll(/:root[^{}]*\{([^}]+)\}/g)].map((match) =>
    Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*#([a-f\d]{6})/gi)]
      .map((token) => [token[1], token[2]])));
  assert.ok(themes.length >= 3, "light, system-dark and explicit-dark tokens remain available");
  for (const [index, theme] of themes.entries()) {
    for (const [foreground, background] of [
      ["ink", "panel"], ["muted", "panel"], ["muted", "panel-2"],
      ["up", "up-soft"], ["down", "down-soft"], ["warn", "warn-soft"],
      ["brand", "brand-soft"], ["on-brand", "brand"],
    ]) {
      const a = luminance(theme[foreground]);
      const b = luminance(theme[background]);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(ratio >= 4.5, `theme ${index}: ${foreground}/${background} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("all nine modules render the existing dashboard fixture", () => {
  const ui = app();
  for (const name of ["Overview", "Brief", "Portfolio", "Flows", "Funds", "Reports", "Actions", "Signals", "Admin"]) {
    const result = ui.run(`pg${name}()`);
    assert.match(result, /<h1\b/, name);
    assert.doesNotMatch(result, /\b(?:NaN|undefined)\b/, name);
  }
});

test("restricted navigation and write actions remain permission-gated", () => {
  const ui = app(["reports"], []);
  ui.run("renderNav()");
  assert.match(ui.element("#nav").innerHTML, /data-go="reports"/);
  for (const name of modules.filter((name) => name !== "reports")) {
    assert.doesNotMatch(ui.element("#nav").innerHTML, new RegExp(`data-go="${name}"`));
  }
  assert.doesNotMatch(ui.run("pgReports()"), /id="addRep"/);
  assert.doesNotMatch(ui.run("repDetail(DATA.reports[0])"), /data-(?:edit|delete)-rep/);
  assert.match(ui.run("pgAdmin()"), /Không có quyền truy cập/);
  ui.run('go("portfolio")');
  assert.equal(ui.run("STATE.page"), "overview", "unauthorized navigation must be ignored");
});

test("empty collections render without crashing", () => {
  const ui = app();
  ui.run("DATA.reports=[]; DATA.news=[]; DATA.events=[]; DATA.portfolio.positions=[];");
  for (const name of ["Overview", "Brief", "Portfolio", "Reports", "Actions", "Signals", "Admin"]) {
    assert.doesNotThrow(() => ui.run(`pg${name}()`), name);
  }
});

test("an account with no modules sees a recovery message", () => {
  const ui = app([], []);
  ui.run("render()");
  assert.equal(ui.element("#nav").innerHTML, "");
  assert.match(ui.element("#page").innerHTML, /Chưa được cấp quyền/);
});

test("transaction history remains visible after the last position is closed", () => {
  const ui = app();
  ui.run('DATA.portfolio.positions=[]; DATA.portfolio.history=[{d:"20/09/2026",t:"FPT",a:"BÁN",p:"100",note:"Closed-position-history-sentinel"}]; STATE.pfTab="Lịch sử giao dịch";');
  assert.match(ui.run("pgPortfolio()"), /Closed-position-history-sentinel/);
});

test("report sections and administration panels preserve their controls", () => {
  const ui = app();
  ui.run('STATE.repTab="Thư viện"');
  assert.match(ui.run("pgReports()"), /data-rsel=/);
  ui.run('STATE.repTab="Hỏi đáp"');
  assert.match(ui.run("pgReports()"), /id="chatIn"/);
  ui.run('STATE.adminTab="Vận hành"');
  assert.match(ui.run("pgAdmin()"), /id="runBuild"/);
  ui.run('STATE.adminTab="Người dùng"');
  assert.match(ui.run("pgAdmin()"), /id="addUser"/);
});

test("Action Desk keeps operational controls and does not invent quantities", () => {
  const ui = app();
  const result = ui.run("pgActions()");
  assert.match(result, /KL action/);
  assert.match(result, /data-edit-action=/);
  assert.match(result, /Signal mới/);
  assert.match(result, /Chưa khai báo/);
  assert.doesNotMatch(result, /20\.000|50\.000|100\.000/, "khối lượng mẫu không được đưa vào dữ liệu thật");
});

test("existing data tabs keep rendering without changing the source data", () => {
  const ui = app();
  const before = ui.run("JSON.stringify(DATA)");
  for (const [state, tabs, page] of [
    ["ovTab", ["Hôm nay", "Tuần này"], "Overview"],
    ["pfTab", ["Tổng quan", "Danh mục hiện tại", "Lịch sử giao dịch"], "Portfolio"],
    ["pfDetailTab", ["Tổng quan", "Luận điểm", "View CTCK"], "Portfolio"],
    ["invTab", ["Hôm nay", "MTD", "YTD"], "Flows"],
    ["repPeriod", ["7 ngày", "30 ngày", "Tất cả"], "Reports"],
  ]) {
    for (const tab of tabs) {
      ui.run(`STATE[${JSON.stringify(state)}]=${JSON.stringify(tab)}`);
      assert.doesNotThrow(() => ui.run(`pg${page}()`), `${state}: ${tab}`);
    }
  }
  assert.equal(ui.run("JSON.stringify(DATA)"), before);
});

test("report titles and account names remain escaped", () => {
  const ui = app();
  ui.run('DATA.reports[0].title="<img src=x onerror=alert(1)>"; STATE.adminUsers=[{username:"<script>bad()</script>",role:"viewer",permissions}];');
  assert.doesNotMatch(ui.run("repDetail(DATA.reports[0])"), /<img src=x/);
  assert.match(ui.run("repDetail(DATA.reports[0])"), /&lt;img/);
  assert.doesNotMatch(ui.run("pgAdmin()"), /<script>bad/);
});
