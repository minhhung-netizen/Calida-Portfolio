import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const html = readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const serverSource = readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).find((script) => script.includes("function pgOverview"));
const fixture = JSON.parse(readFileSync(path.join(ROOT, "web", "data", "dashboard.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(ROOT, "web", "manifest.webmanifest"), "utf8"));
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

test("giao diện và thông báo API không hiển thị tên nhà cung cấp hạ tầng", () => {
  assert.doesNotMatch(html, /railway/i);
  assert.doesNotMatch(serverSource, /railway/i);
});

test("PWA and iOS home-screen icons use Calida brand assets", () => {
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/icons\/apple-touch-icon\.png\?v=20260924-3"/);
  assert.match(html, /rel="icon" type="image\/png" sizes="32x32" href="\/icons\/favicon-32\.png"/);
  assert.match(html, /apple-mobile-web-app-title" content="Calida"/);
  for (const asset of [
    "favicon.ico", "icons/favicon-16.png", "icons/favicon-32.png",
    "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-512-maskable.png",
  ]) assert.ok(existsSync(path.join(ROOT, "web", asset)), `asset is present: ${asset}`);
  assert.ok(manifest.icons.some((icon) => icon.src === "/icons/icon-512-maskable.png" && icon.purpose === "maskable"));
});

test("dashboard numbers use the shared 1,234.56 convention", () => {
  const ui = app();
  assert.equal(ui.run("nf(1234.56, 2)"), "1,234.56");
  assert.equal(ui.run("nf(-1234.5, 1)"), "-1,234.5");
  assert.match(ui.run("pgOverview()"), /1,822\.77/);
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

test("trang quỹ có bố cục riêng cho bảng Top quỹ trên điện thoại", () => {
  const ui = app();
  const result = ui.run("pgFunds()");
  assert.match(result, /class="funds-header"/);
  assert.match(result, /class="funds-title"/);
  assert.match(result, /class="funds-period"/);
  assert.match(result, /class="tbl-wrap fund-top-desktop"/);
  assert.match(result, /class="fund-top-mobile"/);
  assert.match(result, /Hiệu suất YTD/);
  assert.match(html, /@media \(max-width:600px\).*\.funds-header\{display:block\}.*\.funds-title\{width:100%\}/s);
  assert.match(html, /@media \(max-width:600px\).*\.fund-top-desktop\{display:none\}.*\.fund-top-mobile\{display:grid\}/s);
});

test("người dùng có thể chọn kỳ dữ liệu trong module Quỹ đầu tư", () => {
  const ui = app();
  ui.run(`
    const current=JSON.parse(JSON.stringify(DATA.funds));
    const previous={...JSON.parse(JSON.stringify(DATA.funds)),period:"07/2026",prevPeriod:null,nav:42000,updated:10};
    current.period="08/2026";
    DATA.funds={...current,periods:[current,previous]};
  `);
  const latest = ui.run("pgFunds()");
  assert.match(latest, /id="fundPeriod"/);
  assert.match(latest, /value="08\/2026" selected/);
  assert.match(latest, /value="07\/2026"/);
  ui.run('STATE.fundPeriod="07/2026"');
  const historical = ui.run("pgFunds()");
  assert.match(historical, /Dữ liệu quỹ kỳ: 07\/2026/);
  assert.match(historical, /42,000 tỷ/);
  assert.match(historical, /value="07\/2026" selected/);
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

test("Dòng tiền tạm dừng được ẩn khỏi điều hướng và có thông báo khôi phục", () => {
  const ui = app();
  ui.run('DATA.features={flowsEnabled:false}; STATE.page="flows"; render();');
  assert.doesNotMatch(ui.element("#nav").innerHTML, /Dòng tiền/);
  assert.match(ui.element("#page").innerHTML, /Dòng tiền tạm dừng/);
  assert.match(ui.element("#page").innerHTML, /Quay về Tổng quan/);
});

test("report sections and administration panels preserve their controls", () => {
  const ui = app();
  ui.run('STATE.repTab="Thư viện"');
  assert.match(ui.run("pgReports()"), /data-rsel=/);
  ui.run('STATE.repTab="Hỏi đáp"');
  assert.match(ui.run("pgReports()"), /id="chatIn"/);
  ui.run('STATE.adminTab="Vận hành"');
  assert.match(ui.run("pgAdmin()"), /id="runBuild"/);
  assert.match(ui.run("pgAdmin()"), /data-pipeline-mode="portfolio"/);
  assert.match(ui.run("pgAdmin()"), /Đồng bộ từng nguồn/);
  ui.run('STATE.adminTab="Người dùng"');
  assert.match(ui.run("pgAdmin()"), /id="addUser"/);
  ui.run('STATE.adminTab="Dữ liệu"; STATE.adminDatabase={modules:[{id:"brief",label:"Bản tin",rows:8,from:"2026-09-01",to:"2026-09-02",dates:[{date:"2026-09-01",rows:5},{date:"2026-09-02",rows:3}],tables:[{id:"news",label:"Tin tức",rows:8,from:"2026-09-01",to:"2026-09-02",dates:[{date:"2026-09-01",rows:5},{date:"2026-09-02",rows:3}]}]}],history:[]};');
  assert.match(ui.run("pgAdmin()"), /Quản trị database/);
  assert.match(ui.run("pgAdmin()"), /id="deleteDatabaseRows"/);
  assert.match(ui.run("pgAdmin()"), /5 dòng đã chọn/);
});

test("Khuyến nghị hành động giữ các điều khiển vận hành và cho phép tạo chủ động theo quyền", () => {
  const ui = app();
  ui.run('DATA.workspace={actions:{"manual:123e4567-e89b-12d3-a456-426614174000":{kind:"manual",ticker:"VNM",action:"MUA",sector:"Tiêu dùng",price:62.5,zone:"61 – 63",context:"1. Luận điểm thủ công. 2. Chờ xác nhận tín hiệu.",status:"pending",plannedQuantity:1000,completedQuantity:0,note:"Chờ xác nhận"}},signals:{}};');
  const result = ui.run("pgActions()");
  assert.match(result, /KL hành động/);
  assert.match(result, /data-edit-action=/);
  assert.match(result, /id="addAction"/);
  assert.match(result, /class="action-context"/);
  assert.match(result, /<ol class="prose numbered-prose">/);
  assert.match(result, /<li>Luận điểm thủ công\.<\/li>/);
  assert.match(result, /<li>Chờ xác nhận tín hiệu\.<\/li>/);
  assert.match(result, /Chủ động/);
  assert.match(result, /Tín hiệu mới/);
  assert.match(result, /Chưa khai báo/);
  assert.doesNotMatch(result, /20\.000|50\.000|100\.000/, "khối lượng mẫu không được đưa vào dữ liệu thật");
  const readOnly = app(["actions"], []);
  assert.doesNotMatch(readOnly.run("pgActions()"), /id="addAction"/);
});

test("existing data tabs keep rendering without changing the source data", () => {
  const ui = app();
  const before = ui.run("JSON.stringify(DATA)");
  for (const [state, tabs, page] of [
    ["ovTab", ["Hôm nay", "Tuần này"], "Overview"],
    ["pfTab", ["Tổng quan", "Danh mục hiện tại", "Lịch sử giao dịch"], "Portfolio"],
    ["pfDetailTab", ["Tổng quan", "Luận điểm", "Quan điểm CTCK"], "Portfolio"],
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

test("luận điểm được tách thành các mục đánh số khi nhập trên cùng một dòng", () => {
  const ui = app();
  const result = ui.run('numberedProse("1. Luận điểm thứ nhất. 2. Luận điểm thứ hai. 3. Luận điểm thứ ba.")');
  assert.match(result, /<ol class="prose numbered-prose">/);
  assert.match(result, /<li>Luận điểm thứ nhất\.<\/li>/);
  assert.match(result, /<li>Luận điểm thứ hai\.<\/li>/);
  assert.match(result, /<li>Luận điểm thứ ba\.<\/li>/);
  assert.doesNotMatch(result, /1\. Luận điểm thứ nhất/);
});

test("report titles and account names remain escaped", () => {
  const ui = app();
  ui.run('DATA.reports[0].title="<img src=x onerror=alert(1)>"; STATE.adminUsers=[{username:"<script>bad()</script>",role:"viewer",permissions}];');
  assert.doesNotMatch(ui.run("repDetail(DATA.reports[0])"), /<img src=x/);
  assert.match(ui.run("repDetail(DATA.reports[0])"), /&lt;img/);
  assert.doesNotMatch(ui.run("pgAdmin()"), /<script>bad/);
});
