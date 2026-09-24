import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = path.resolve(".");
const outputFile = path.join(outputDir, "Calida_Bao_Cao_CTCK_Mau.xlsx");
const font = { name: "Arial", size: 10, color: "#172B4D" };
const colors = {
  navy: "#123A73", blue: "#2563EB", paleBlue: "#EAF2FF", input: "#FFF8D6",
  border: "#D8E2F1", muted: "#64748B", green: "#DCFCE7", amber: "#FEF3C7", red: "#FEE2E2",
};
const numberFormat = "#,##0.00;[Red](#,##0.00);-";

const workbook = Workbook.create();

function title(sheet, text, endColumn) {
  sheet.getRange(`A1:${endColumn}1`).merge();
  sheet.getRange("A1").values = [[text]];
  sheet.getRange("A1").format = {
    fill: colors.navy,
    font: { ...font, size: 15, bold: true, color: "#FFFFFF" },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  sheet.getRange("A1").format.rowHeight = 30;
}

function note(sheet, text, endColumn) {
  sheet.getRange(`A2:${endColumn}2`).merge();
  sheet.getRange("A2").values = [[text]];
  sheet.getRange("A2").format = {
    fill: colors.paleBlue,
    font: { ...font, italic: true, color: colors.muted },
    verticalAlignment: "center",
  };
  sheet.getRange("A2").format.rowHeight = 26;
}

function table(sheet, headers, rows, widths, dateCols = [], numberCols = []) {
  const endCol = String.fromCharCode(64 + headers.length);
  sheet.getRange(`A4:${endCol}${4 + rows.length}`).values = [headers, ...rows];
  const full = sheet.getRange(`A4:${endCol}${4 + rows.length}`);
  full.format.font = font;
  full.format.verticalAlignment = "center";
  sheet.getRange(`A4:${endCol}4`).format = {
    fill: colors.blue,
    font: { ...font, bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: "#FFFFFF" },
  };
  sheet.getRange(`A5:${endCol}${4 + rows.length}`).format.borders = {
    insideHorizontal: { style: "thin", color: colors.border },
    bottom: { style: "thin", color: colors.border },
  };
  sheet.getRange(`A5:${endCol}104`).format.fill = colors.input;
  sheet.getRange(`A5:${endCol}${4 + rows.length}`).format.fill = "#FFFFFF";
  sheet.getRange(`A5:${endCol}${4 + rows.length}`).format.wrapText = false;
  sheet.getRange(`A4:${endCol}4`).format.rowHeight = 24;
  sheet.getRange(`A5:${endCol}${4 + rows.length}`).format.rowHeight = 22;
  widths.forEach((width, i) => { sheet.getRangeByIndexes(0, i, 1, 1).format.columnWidth = width; });
  dateCols.forEach((column) => sheet.getRange(`${column}5:${column}104`).setNumberFormat("yyyy-mm-dd"));
  numberCols.forEach((column) => sheet.getRange(`${column}5:${column}104`).setNumberFormat(numberFormat));
  sheet.freezePanes.freezeRows(4);
  sheet.showGridLines = false;
  return endCol;
}

const guide = workbook.worksheets.add("_HUONG_DAN");
guide.tabColor = "#64748B";
guide.showGridLines = false;
title(guide, "Calida Analyst · Mẫu Google Sheet Báo cáo CTCK", "F");
note(guide, "Dùng file này làm nguồn nhập liệu thay thế reports.xlsx. Sau khi upload lên Google Drive, mở bằng Google Sheets, đặt Locale là United States và giữ nguyên tên tab/hàng tiêu đề.", "F");
guide.getRange("A4:B10").values = [
  ["BƯỚC", "THAO TÁC"],
  ["1", "Tải file .xlsx này lên Google Drive → Mở bằng Google Sheets."],
  ["2", "Trong File → Settings, đặt Locale: United States để hiển thị 1,234.56; sau đó chia sẻ Sheet cho service account với quyền Viewer."],
  ["3", "Lấy ID trên URL Sheet và đặt vào biến Railway REPORTS_SHEET_ID."],
  ["4", "Nhập báo cáo ở BAO_CAO_CTCK; dùng cùng ID ở ba tab dữ liệu chi tiết."],
  ["5", "Vào Quản trị → Vận hành dữ liệu → Đồng bộ toàn bộ nguồn để cập nhật web."],
  ["LƯU Ý", "Đồng bộ là một chiều: Google Sheet → reports.xlsx → web. Không cùng sửa một ID ở web và Sheet trong một lượt đồng bộ."],
];
guide.getRange("A4:B4").format = { fill: colors.blue, font: { ...font, bold: true, color: "#FFFFFF" }, horizontalAlignment: "center" };
guide.getRange("A5:A10").format = { fill: colors.paleBlue, font: { ...font, bold: true } };
guide.getRange("A4:B10").format.borders = { preset: "all", style: "thin", color: colors.border };
guide.getRange("A4:B10").format.font = font;
guide.getRange("A4:B10").format.verticalAlignment = "center";
guide.getRange("A5:B10").format.wrapText = true;
guide.getRange("A10:B10").format = { fill: colors.amber, font: { ...font, bold: true, color: "#7C2D12" } };
guide.getRange("A:A").format.columnWidth = 14;
guide.getRange("B:B").format.columnWidth = 110;
guide.getRange("A4:B10").format.rowHeight = 26;
guide.getRange("A10:B10").format.rowHeight = 42;
guide.getRange("D4:E10").values = [
  ["DANH MỤC GIÁ TRỊ", "GIÁ TRỊ HỢP LỆ"],
  ["Loại", "Chiến lược · Vĩ mô · Ngành · Doanh nghiệp"],
  ["Quan điểm", "Tích cực · Trung lập · Thận trọng · Tiêu cực"],
  ["Khuyến nghị", "MUA · KHẢ QUAN · TRUNG LẬP · KÉM KHẢ QUAN · BÁN"],
  ["View ngành", "OW · UW"],
  ["Mức độ rủi ro", "1 = thấp · 2 = trung bình · 3 = cao"],
  ["Định dạng ID", "CTCK-YYYYMMDD-xx, ví dụ SSI-20260923-01"],
];
guide.getRange("D4:E4").format = { fill: colors.blue, font: { ...font, bold: true, color: "#FFFFFF" }, horizontalAlignment: "center" };
guide.getRange("D5:D10").format = { fill: colors.paleBlue, font: { ...font, bold: true } };
guide.getRange("D4:E10").format.font = font;
guide.getRange("D4:E10").format.borders = { preset: "all", style: "thin", color: colors.border };
guide.getRange("D:D").format.columnWidth = 24;
guide.getRange("E:E").format.columnWidth = 62;
guide.getRange("D4:E10").format.rowHeight = 24;
guide.freezePanes.freezeRows(2);

const reports = workbook.worksheets.add("BAO_CAO_CTCK");
reports.tabColor = colors.navy;
title(reports, "Báo cáo CTCK", "J");
note(reports, "Một dòng là một báo cáo. ID là khóa chính, không trùng. Các tab chi tiết phải lặp lại đúng ID này.", "J");
table(reports,
  ["ID", "CTCK", "Ngày", "Loại", "Tiêu đề", "Quan điểm", "Target VN-Index", "Tầm nhìn", "Tóm tắt", "Nguồn"],
  [
    ["SSI-20260923-01", "SSI Research", new Date("2026-09-23"), "Chiến lược", "Chiến lược tháng 9: Tích lũy chọn lọc", "Tích cực", 1950, "Cuối 2026", "Ưu tiên nhóm hưởng lợi từ tăng trưởng lợi nhuận và thanh khoản cải thiện.", "https://www.ssi.com.vn/"],
    ["VCI-20260922-01", "Vietcap", new Date("2026-09-22"), "Vĩ mô", "Cập nhật vĩ mô: lạm phát và tăng trưởng", "Trung lập", 1880, "6–12 tháng", "Theo dõi diễn biến lãi suất toàn cầu và tiến độ giải ngân đầu tư công.", "https://www.vietcap.com.vn/"],
  ],
  [24, 20, 14, 18, 44, 18, 19, 16, 72, 42], ["C"], ["G"]);
reports.getRange("D5:D104").dataValidation = { rule: { type: "list", values: ["Chiến lược", "Vĩ mô", "Ngành", "Doanh nghiệp"] } };
reports.getRange("F5:F104").dataValidation = { rule: { type: "list", values: ["Tích cực", "Trung lập", "Thận trọng", "Tiêu cực"] } };

const stocks = workbook.worksheets.add("KHUYEN_NGHI_CP");
stocks.tabColor = "#16A34A";
title(stocks, "Khuyến nghị cổ phiếu", "D");
note(stocks, "Mỗi dòng là một khuyến nghị. ID báo cáo phải tồn tại trong tab BAO_CAO_CTCK.", "D");
table(stocks,
  ["ID báo cáo", "Mã cổ phiếu", "Khuyến nghị", "Target"],
  [
    ["SSI-20260923-01", "MBB", "MUA", 31],
    ["SSI-20260923-01", "MWG", "MUA", 78],
    ["VCI-20260922-01", "FPT", "KHẢ QUAN", 132],
  ],
  [26, 18, 22, 16], [], ["D"]);
stocks.getRange("C5:C104").dataValidation = { rule: { type: "list", values: ["MUA", "KHẢ QUAN", "TRUNG LẬP", "KÉM KHẢ QUAN", "BÁN"] } };

const sectors = workbook.worksheets.add("QUAN_DIEM_NGANH");
sectors.tabColor = "#7C3AED";
title(sectors, "Quan điểm ngành", "C");
note(sectors, "View dùng OW (Overweight) hoặc UW (Underweight). Có thể thêm nhiều ngành cho cùng một ID báo cáo.", "C");
table(sectors,
  ["ID báo cáo", "Ngành", "View"],
  [
    ["SSI-20260923-01", "Ngân hàng", "OW"],
    ["SSI-20260923-01", "Bất động sản", "UW"],
    ["VCI-20260922-01", "Công nghệ thông tin", "OW"],
  ],
  [26, 32, 14]);
sectors.getRange("C5:C104").dataValidation = { rule: { type: "list", values: ["OW", "UW"] } };

const risks = workbook.worksheets.add("RUI_RO");
risks.tabColor = "#DC2626";
title(risks, "Rủi ro cần theo dõi", "C");
note(risks, "Mức độ: 1 thấp, 2 trung bình, 3 cao. Ghi rõ chủ đề/điều kiện có thể tác động đến quan điểm báo cáo.", "C");
table(risks,
  ["ID báo cáo", "Chủ đề rủi ro", "Mức độ"],
  [
    ["SSI-20260923-01", "Biến động lãi suất USD và tỷ giá", 2],
    ["SSI-20260923-01", "Thanh khoản thị trường suy giảm", 2],
    ["VCI-20260922-01", "Giải ngân đầu tư công thấp hơn kỳ vọng", 3],
  ],
  [26, 64, 14], [], ["C"]);
risks.getRange("C5:C104").dataValidation = { rule: { type: "list", values: [1, 2, 3] } };
risks.getRange("C5:C104").conditionalFormats.add("cellIs", { operator: "equal", formula: 3, format: { fill: colors.red, font: { bold: true, color: "#B91C1C" } } });
risks.getRange("C5:C104").conditionalFormats.add("cellIs", { operator: "equal", formula: 2, format: { fill: colors.amber, font: { bold: true, color: "#92400E" } } });
risks.getRange("C5:C104").conditionalFormats.add("cellIs", { operator: "equal", formula: 1, format: { fill: colors.green, font: { bold: true, color: "#166534" } } });

await workbook.recalculate();
const inspection = await workbook.inspect({ kind: "workbook,sheet,table", maxChars: 9000, tableMaxRows: 6, tableMaxCols: 10 });
await fs.writeFile(path.join(outputDir, "Calida_Bao_Cao_CTCK_inspect.json"), inspection.ndjson);
const preview = await workbook.render({ sheetName: "BAO_CAO_CTCK", autoCrop: "all", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, "Calida_Bao_Cao_CTCK_preview.png"), new Uint8Array(await preview.arrayBuffer()));
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
await fs.writeFile(path.join(outputDir, "Calida_Bao_Cao_CTCK_errors.json"), errors.ndjson);
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputFile);
console.log(JSON.stringify({ outputFile, inspection: inspection.ndjson, errors: errors.ndjson }));
