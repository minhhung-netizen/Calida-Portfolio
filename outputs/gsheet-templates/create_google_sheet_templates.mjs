import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = path.resolve(".");
const blue = "#1F5EEA";
const pale = "#E3EDFF";
const line = "#D9E2EF";
const columnLetter = (index) => String.fromCharCode(65 + index);
const numberFormat = "#,##0.00;[Red](#,##0.00);-";
const percentPointFormat = "0.0;[Red](0.0);-";

function styleTable(sheet, headers, rows) {
  const end = columnLetter(headers.length - 1);
  sheet.getRange(`A1:${end}1`).values = [headers];
  if (rows.length) sheet.getRange(`A2:${end}${rows.length + 1}`).values = rows;
  const used = sheet.getRange(`A1:${end}${Math.max(rows.length + 1, 2)}`);
  used.format.font = { name: "Aptos", size: 11, color: "#132044" };
  used.format.verticalAlignment = "center";
  used.format.wrapText = true;
  used.format.borders = { preset: "all", style: "thin", color: line };
  sheet.getRange(`A1:${end}1`).format = {
    fill: blue,
    font: { name: "Aptos", size: 11, bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
  sheet.getRange(`A1:${end}${Math.max(rows.length + 1, 2)}`).format.autofitColumns();
  sheet.getRange(`A1:${end}1`).format.rowHeight = 28;
  sheet.freezePanes.freezeRows(1);
  sheet.showGridLines = false;
}

function addGuide(workbook, rows) {
  const sheet = workbook.worksheets.add("_HUONG_DAN");
  styleTable(sheet, ["Sheet", "Dùng để", "Quy tắc cập nhật"], [
    ["Thiết lập chung", "Google Sheets", "Sau khi tải file lên: File → Settings → Locale → United States để dùng 1,234.56."],
    ...rows,
  ]);
  sheet.getRange("A1:C1").format.fill = blue;
  sheet.getRange("A2:C2").format.fill = pale;
  sheet.getRange("A:C").format.columnWidth = 28;
  return sheet;
}

async function exportWorkbook(name, workbook, sheetNames) {
  await workbook.recalculate();
  const overview = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 4000 });
  console.log(`${name}: ${overview.ndjson}`);
  for (let index = 0; index < sheetNames.length; index += 1) {
    const sheet = workbook.worksheets.getItem(sheetNames[index]);
    const used = sheet.getUsedRange(true);
    const address = used?.address || "A1:C2";
    const check = await workbook.inspect({ kind: "table", sheetId: sheet.name, range: address, tableMaxRows: 4, tableMaxCols: 8, maxChars: 2500 });
    console.log(`${name}/${sheet.name}: ${check.ndjson}`);
    const preview = await workbook.render({ sheetName: sheet.name, autoCrop: "all", scale: 1, format: "png" });
    await fs.writeFile(path.join(outputDir, `${name.replace(/\.xlsx$/, "")}-${index + 1}.png`), new Uint8Array(await preview.arrayBuffer()));
  }
  const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!", options: { useRegex: true, maxResults: 50 }, summary: `${name} formula errors` });
  if (errors.ndjson.includes("#REF!") || errors.ndjson.includes("#DIV/0!") || errors.ndjson.includes("#VALUE!")) throw new Error(`${name} has formula errors`);
  const file = await SpreadsheetFile.exportXlsx(workbook);
  await file.save(path.join(outputDir, name));
}

function createPortfolioWorkbook() {
  const workbook = Workbook.create();
  addGuide(workbook, [
    ["DM cơ bản", "Danh mục đầu tư cơ bản", "Giữ đúng tiêu đề cột. Dùng số 1,234.56; tỷ trọng nhập theo %, giá theo nghìn đồng."],
    ["DM lướt sóng", "Danh mục giao dịch ngắn hạn", "Dùng cùng cấu trúc DM cơ bản. Pipeline gắn book là Lướt sóng."],
    ["Transaction Log", "Lịch sử giao dịch", "Mỗi giao dịch là một dòng. Không đổi tên cột."],
  ]);
  const headers = ["Mã CK", "Tên công ty", "Ngành", "Trạng thái", "Vùng mua thấp", "Vùng mua cao", "Target", "Vùng vi phạm", "Giá vốn", "Ngày khuyến nghị", "Tỷ trọng", "Luận điểm"];
  const basic = workbook.worksheets.add("DM cơ bản");
  styleTable(basic, headers, [
    ["FPT", "CTCP FPT", "CNTT", "NẮM GIỮ", 118, 124, 140, 95, 112, new Date("2025-07-20"), 22, "Tích lũy thêm khi giá về vùng mua."],
    ["MBB", "NH TMCP Quân Đội", "Ngân hàng", "MUA", 25, 26.2, 30, 24.9, null, new Date("2026-09-02"), 0, "Tăng trưởng tín dụng và CASA cải thiện."],
    ["HPG", "CTCP Tập đoàn Hòa Phát", "Thép", "TĂNG TỶ TRỌNG", null, null, 32, 24, 27.25, new Date("2026-05-15"), 15, "Dung Quất 2 là động lực trung hạn."],
  ]);
  basic.getRange("J2:J10").setNumberFormat("yyyy-mm-dd");
  basic.getRange("E2:I10").setNumberFormat(numberFormat);
  basic.getRange("K2:K10").setNumberFormat(percentPointFormat);
  basic.getRange("E:I").format.columnWidth = 14;
  const trading = workbook.worksheets.add("DM lướt sóng");
  styleTable(trading, headers, [
    ["VCI", "CTCP Chứng khoán Vietcap", "Chứng khoán", "NẮM GIỮ", 38, 42, 50, 41.5, 42.1, new Date("2026-06-01"), 10, "Hưởng lợi từ thanh khoản và nâng hạng."],
    ["KBC", "TCT Phát triển Đô thị Kinh Bắc", "BĐS", "THEO DÕI", 28, 30, 36, 26, null, new Date("2026-08-28"), 0, "Chờ tiến độ bàn giao khu công nghiệp."],
  ]);
  trading.getRange("J2:J10").setNumberFormat("yyyy-mm-dd");
  trading.getRange("E2:I10").setNumberFormat(numberFormat);
  trading.getRange("K2:K10").setNumberFormat(percentPointFormat);
  trading.getRange("E:I").format.columnWidth = 14;
  const transactions = workbook.worksheets.add("Transaction Log");
  styleTable(transactions, ["Ngày", "Mã CK", "Hành động", "Giá", "Ghi chú"], [
    [new Date("2026-09-05"), "CTD", "Khuyến nghị mua", "64 – 68", "Mở vị thế mới"],
    [new Date("2026-08-28"), "ACB", "Giảm tỷ trọng 50%", "25.10", "Lần 1 trong chu kỳ"],
  ]);
  transactions.getRange("A2:A10").setNumberFormat("yyyy-mm-dd");
  return workbook;
}

function createFundsWorkbook() {
  const workbook = Workbook.create();
  addGuide(workbook, [
    ["FUND SUMMARY", "Thông tin quỹ theo kỳ", "period dùng MM/YYYY; nav_bn là tỷ đồng; ytd_pct là %. Dùng số 1,234.56."],
    ["ASSET ALLOCATION", "Phân bổ tài sản", "asset_type: Cổ phiếu, Tiền mặt, Trái phiếu hoặc Khác."],
    ["INDUSTRY", "Tỷ trọng ngành", "weight_pct theo %, một dòng cho mỗi quỹ-ngành-kỳ."],
    ["TOP HOLDINGS", "Top cổ phiếu nắm giữ", "ticker viết hoa; weight_pct theo %."],
  ]);
  const summary = workbook.worksheets.add("FUND SUMMARY");
  styleTable(summary, ["period", "fund_code", "fund_name", "nav_bn", "ytd_pct"], [
    ["08/2026", "VFM", "Quỹ VFM", 8305, 6.6], ["08/2026", "VCBF", "Quỹ VCBF", 7264, 9.5],
  ]);
  summary.getRange("D2:D10").setNumberFormat(numberFormat);
  summary.getRange("E2:E10").setNumberFormat(percentPointFormat);
  summary.getRange("D:D").format.columnWidth = 15;
  summary.getRange("E:E").format.columnWidth = 12;
  const allocation = workbook.worksheets.add("ASSET ALLOCATION");
  styleTable(allocation, ["period", "fund_code", "asset_type", "weight_pct"], [
    ["08/2026", "VFM", "Cổ phiếu", 88.4], ["08/2026", "VFM", "Tiền mặt", 10.1], ["08/2026", "VFM", "Khác", 1.5],
  ]);
  allocation.getRange("D2:D10").setNumberFormat(percentPointFormat);
  allocation.getRange("D:D").format.columnWidth = 12;
  const industry = workbook.worksheets.add("INDUSTRY");
  styleTable(industry, ["period", "fund_code", "industry", "weight_pct"], [
    ["08/2026", "VFM", "Ngân hàng", 10.5], ["08/2026", "VFM", "Công nghệ thông tin", 9.3], ["08/2026", "VCBF", "Thép", 6.6],
  ]);
  industry.getRange("D2:D10").setNumberFormat(percentPointFormat);
  industry.getRange("D:D").format.columnWidth = 12;
  const holdings = workbook.worksheets.add("TOP HOLDINGS");
  styleTable(holdings, ["period", "fund_code", "ticker", "weight_pct"], [
    ["08/2026", "VFM", "FPT", 4.3], ["08/2026", "VFM", "HPG", 4.1], ["08/2026", "VCBF", "MBB", 3.8],
  ]);
  holdings.getRange("D2:D10").setNumberFormat(percentPointFormat);
  holdings.getRange("D:D").format.columnWidth = 12;
  return workbook;
}

function createOperationsWorkbook() {
  const workbook = Workbook.create();
  addGuide(workbook, [
    ["VIEW", "Nhận định thị trường", "Mỗi ngày một dòng. Dùng số 1,234.56. Danh sách ngành/rủi ro ngăn cách dấu phẩy; week_actions ngăn cách |."],
    ["NEWS", "Tin tức cho Bản tin", "tab chỉ dùng: Thế giới, Trong nước hoặc Doanh nghiệp."],
    ["EVENTS", "Lịch sự kiện", "impact chỉ dùng: Cao, Trung bình hoặc Thấp."],
    ["INVESTOR_FLOW", "Dòng tiền theo nhóm NĐT", "net_value là tỷ đồng; mua ròng dương, bán ròng âm."],
    ["TICKER_FLOW", "Dòng tiền theo mã", "ticker viết hoa; main_investor là nhóm nhà đầu tư chi phối."],
    ["SECTOR_FLOW", "Dòng tiền theo ngành", "chg_pct và weight_pct nhập theo %."],
    ["SUMMARY", "Hiệu suất và phân bổ danh mục", "Tùy chọn; stock_pct + cash_pct + other_pct nên bằng 100%."],
  ]);
  const view = workbook.worksheets.add("VIEW");
  styleTable(view, ["date", "sentiment", "support_lo", "support_hi", "resist_lo", "resist_hi", "expected_lo", "expected_hi", "today_text", "week_text", "focus_sectors", "risks", "strategy_short", "strategy_long", "week_actions"], [[
    new Date("2026-09-23"), "Tích cực thận trọng", 1800, 1810, 1850, 1870, 1810, 1870, "Ưu tiên giải ngân từng phần tại vùng hỗ trợ.", "Thị trường dao động, giữ kỷ luật tỷ trọng.", "Ngân hàng, Dầu khí, Xây dựng", "Fed, Đáo hạn phái sinh", "Không mua đuổi.", "Tích lũy doanh nghiệp nền tảng tốt.", "Theo dõi hỗ trợ | Không mua đuổi | Chốt lời từng phần",
  ]]);
  view.getRange("A2:A10").setNumberFormat("yyyy-mm-dd");
  view.getRange("C2:H10").setNumberFormat(numberFormat);
  view.getRange("C:H").format.columnWidth = 15;
  const news = workbook.worksheets.add("NEWS");
  styleTable(news, ["published_at", "tab", "title", "source", "url"], [[new Date("2026-09-23T09:00:00"), "Trong nước", "Ví dụ: Cập nhật thị trường đầu phiên", "Nguồn tin", "https://example.com"]]);
  news.getRange("A2:A10").setNumberFormat("yyyy-mm-dd hh:mm");
  const events = workbook.worksheets.add("EVENTS");
  styleTable(events, ["date", "time", "name", "country", "impact", "forecast", "previous"], [[new Date("2026-09-24"), "19:00", "Ví dụ: Công bố dữ liệu vĩ mô", "Mỹ", "Cao", "2.6%", "2.9%"]]);
  events.getRange("A2:A10").setNumberFormat("yyyy-mm-dd");
  const investor = workbook.worksheets.add("INVESTOR_FLOW");
  styleTable(investor, ["date", "investor", "net_value"], [[new Date("2026-09-23"), "Cá nhân", 620], [new Date("2026-09-23"), "Khối ngoại", -401]]);
  investor.getRange("A2:A10").setNumberFormat("yyyy-mm-dd");
  investor.getRange("C2:C10").setNumberFormat(numberFormat);
  investor.getRange("C:C").format.columnWidth = 15;
  const ticker = workbook.worksheets.add("TICKER_FLOW");
  styleTable(ticker, ["date", "ticker", "net_value", "main_investor", "note"], [[new Date("2026-09-23"), "FPT", 215, "Cá nhân", ""], [new Date("2026-09-23"), "VCB", -182, "Khối ngoại", "Bán ròng mạnh"]]);
  ticker.getRange("A2:A10").setNumberFormat("yyyy-mm-dd");
  ticker.getRange("C2:C10").setNumberFormat(numberFormat);
  ticker.getRange("C:C").format.columnWidth = 15;
  const sector = workbook.worksheets.add("SECTOR_FLOW");
  styleTable(sector, ["date", "sector", "net_value", "chg_pct", "weight_pct"], [[new Date("2026-09-23"), "Ngân hàng", 320, 12.5, 18.6], [new Date("2026-09-23"), "Bất động sản", -210, -6.3, 11.8]]);
  sector.getRange("A2:A10").setNumberFormat("yyyy-mm-dd");
  sector.getRange("C2:C10").setNumberFormat(numberFormat);
  sector.getRange("D2:E10").setNumberFormat(percentPointFormat);
  sector.getRange("C:C").format.columnWidth = 15;
  sector.getRange("D:E").format.columnWidth = 12;
  const summary = workbook.worksheets.add("SUMMARY");
  styleTable(summary, ["date", "ytd_pct", "stock_pct", "cash_pct", "other_pct"], [[new Date("2026-09-23"), 2.3, 85, 10, 5]]);
  summary.getRange("A2:A10").setNumberFormat("yyyy-mm-dd");
  summary.getRange("B2:E10").setNumberFormat(percentPointFormat);
  summary.getRange("B:E").format.columnWidth = 12;
  return workbook;
}

await fs.mkdir(outputDir, { recursive: true });
await exportWorkbook("Calida_Portfolio_Automation_Mau.xlsx", createPortfolioWorkbook(), ["_HUONG_DAN", "DM cơ bản", "DM lướt sóng", "Transaction Log"]);
await exportWorkbook("Calida_Fmarket_DB_Mau.xlsx", createFundsWorkbook(), ["_HUONG_DAN", "FUND SUMMARY", "ASSET ALLOCATION", "INDUSTRY", "TOP HOLDINGS"]);
await exportWorkbook("Calida_Operations_Data_Mau.xlsx", createOperationsWorkbook(), ["_HUONG_DAN", "VIEW", "NEWS", "EVENTS", "INVESTOR_FLOW", "TICKER_FLOW", "SECTOR_FLOW", "SUMMARY"]);
