# Calida Analyst System

Hướng dẫn vận hành hằng ngày: [HUONG_DAN_VAN_HANH.md](HUONG_DAN_VAN_HANH.md).

Hệ thống gồm 10 phân hệ: Tổng quan · Bản tin · Danh mục · Dòng tiền · Quỹ đầu tư · Báo cáo CTCK · Khuyến nghị hành động · Trung tâm tín hiệu · Cảnh báo giá · Quản trị.

```
 NGUỒN                          EXCEL (data/input/)        DATABASE              GIAO DIỆN
 ─────────────────────────      ───────────────────        ────────────          ─────────────────
 vnstock ───────────────────►   market.xlsx    ─┐
 Google Sheet Portfolio ────►   portfolio.xlsx  │
 Google Sheet Fmarket DB ───►   funds.xlsx      ├─► build_db ─► calida.db ─► export_json ─► web/data/dashboard.json ─► web/index.html
 Google Sheet Báo cáo CTCK ─►  reports.xlsx     │                                                   ▲
 Nhập tay / vendor ─────────►   flows.xlsx      │                                                   │
 Nút "Thêm báo cáo" ─► inbox ►  reports.xlsx   ─┘                                                   │
                                                                             server/index.js ───────┘  (/api/chat, /api/extract, /api/reports)
```

- **Excel và dashboard là dữ liệu vận hành**: Excel, SQLite và `dashboard.json` được lưu trên Railway Volume. Đồng bộ Danh mục, Vận hành và Quỹ dùng **bản chụp nguồn** để thay đúng các sheet do Google Sheets quản lý, nhờ đó dữ liệu cũ đã bị xóa sẽ không còn lưu lại trên Railway. Báo cáo CTCK vẫn gộp theo khóa để bảo toàn báo cáo tạo từ giao diện.
- **SQLite (`data/calida.db`)** được dựng lại toàn bộ từ Excel mỗi lần chạy, có kiểm tra cột, ngày và dòng trùng khóa.
- **`dashboard.json`** chứa sẵn mọi chỉ số tổng hợp (MTD/YTD, bình quân gia quyền NAV, Δ kỳ trước). Giao diện chỉ việc hiển thị.
- **Vnstock là nguồn giá tùy chọn**: Railway vẫn deploy và dựng dashboard từ dữ liệu đã có nếu kho cài đặt tạm thời không cung cấp được Vnstock. Khi đó chỉ bước làm mới giá bị bỏ qua; các đồng bộ Google Sheets vẫn dùng bình thường.
- **Giá có quy trình độc lập**: mặc định máy chủ cập nhật giá mỗi 10 phút trong các khung `09:00–11:30` và `13:00–15:10` từ thứ Hai đến thứ Sáu. Các mã được gọi tuần tự tối đa 50 request/phút, thấp hơn giới hạn 60 request/phút; lượt mới không chạy chồng hoặc tích hàng đợi khi quy trình khác đang bận.
- **Quản trị database theo module/ngày**: admin có thể xem trước số dòng và xoá dữ liệu Bản tin, Danh mục, Dòng tiền, Quỹ hoặc Báo cáo CTCK trong một khoảng ngày. Dấu xoá theo khóa được giữ trên Volume để dữ liệu cũ không quay lại sau lần đồng bộ Google Sheets tiếp theo.
- **Cảnh báo giá cá nhân**: mỗi người dùng tự tạo ngưỡng tăng đến, giảm đến hoặc một vùng giá và chỉ thấy dữ liệu của chính mình. Vùng mua chỉ nhận chiều giá đi xuống; vùng bán chỉ nhận chiều giá đi lên. Có thể chọn gửi một lần, mỗi ngày có giá mới hoặc mỗi lần giá quay lại ngưỡng; chọn giờ gửi sớm nhất và hạn tự hết hiệu lực. Mã ngoài danh mục được bổ sung vào nguồn lấy giá ở lần đồng bộ tiếp theo.

## Cài đặt (Windows)

1. Cài Python 3.10+ và Node.js 18+.
2. Copy `.env.example` → `.env`, rồi điền các biến (xem mục Cấu hình).
3. Chạy `run_pipeline.bat`. Lần đầu sẽ tự tạo `.venv` và cài thư viện.
4. Chạy `start_server.bat`, sau đó mở http://localhost:8080.

Muốn chạy thử ngay với dữ liệu mẫu (không cần API):
```
python pipeline/make_templates.py --sample --force
python pipeline/run.py --build-only
```

## Lệnh pipeline

| Lệnh | Việc làm |
|---|---|
| `python pipeline/run.py` | Chạy đầy đủ: Google Sheets → vnstock → inbox → DB → JSON |
| `python pipeline/run.py --build-only` | Chỉ dựng lại DB + JSON từ Excel hiện có |
| `python pipeline/run.py --prices-only` | Chỉ lấy giá → cập nhật bảng giá trong DB → xuất lại JSON; không gọi Google Sheets |
| `python pipeline/run.py --no-prices` | Bỏ bước vnstock |
| `python pipeline/run.py --source funds --no-prices` | Đồng bộ riêng một nguồn: `portfolio`, `operations`, `funds` hoặc `reports` |
| `python pipeline/make_templates.py` | Tạo template Excel trống. Mỗi file có sheet `_HUONG_DAN` mô tả cột |

Mỗi bước lấy dữ liệu chạy độc lập: một nguồn lỗi thì các bước sau vẫn chạy trên dữ liệu cũ. Chỉ khi bước build/export lỗi, pipeline mới thoát với mã 1.

### Tạm dừng Dòng tiền

Đặt `FLOWS_MODULE_ENABLED=false` để tạm dừng Dòng tiền. Pipeline sẽ không đồng bộ các sheet `INVESTOR_FLOW`, `TICKER_FLOW`, `SECTOR_FLOW`, không kiểm tra chúng và không đưa dữ liệu cũ vào dashboard. Các module khác vẫn đồng bộ bình thường. Khi nguồn FLOW đã chuẩn hóa, đặt biến thành `true` và deploy lại.

## Nguồn dữ liệu

| File / sheet | Nguồn | Tự động? |
|---|---|---|
| `market.xlsx / VNINDEX` | vnstock | ✅ |
| `market.xlsx / VIEW, NEWS, EVENTS` | Nhập tay, hoặc ghi từ Bản Tin Ngày | ✍️ |
| `flows.xlsx / *` | **Chưa có nguồn tự động.** Nhập từ bảng thống kê giao dịch theo nhóm NĐT | ✍️ |
| `portfolio.xlsx / POSITIONS, TRANSACTIONS` | Google Sheet Portfolio Automation | ✅ |
| `portfolio.xlsx / PRICES` | vnstock (các mã trong POSITIONS) | ✅ |
| `portfolio.xlsx / SUMMARY` | Nhập tay: hiệu suất YTD, phân bổ tài sản | ✍️ |
| `funds.xlsx / *` | Google Sheet Fmarket DB (pipeline Colab hiện có) | ✅ |
| `reports.xlsx / *` | Google Sheet Báo cáo CTCK (hoặc nút "Thêm báo cáo" trên giao diện) | ✅/✍️ |

## Cấu hình cần chỉnh

**1. Ánh xạ cột Google Sheet** – `pipeline/config.py` → `PORTFOLIO_MAP`, `FUNDS_MAP`, `OPERATIONS_MAP`, `REPORTS_MAP`.
Bên trái là tiêu đề cột trong sheet của bạn, bên phải là tên cột chuẩn. Tiêu đề trong file hiện chỉ là **giả định**. Nếu sai, lần chạy đầu sẽ báo lỗi kèm danh sách tiêu đề thực tế để bạn sửa.

**2. Service account** – tạo trong Google Cloud, bật Drive API, tải JSON về `secrets/service-account.json`. Sau đó share các sheet đang dùng (bao gồm Báo cáo CTCK) cho email của service account với quyền Viewer.

**3. Đơn vị và định dạng số** – `WEIGHTS_AS_FRACTION` (tỷ trọng lưu dạng 0.12 hay 12) và `NAV_DIVISOR` (NAV tính theo đồng hay tỷ). Toàn hệ thống dùng dấu phẩy phân tách hàng nghìn và dấu chấm thập phân: `1,234.56`.

**4. Gemini** – `GEMINI_API_KEY`, dùng cho hỏi đáp và trích xuất báo cáo (text hoặc PDF). Server tự thử lại khi gặp lỗi 429/5xx.

## Triển khai

**A. Một máy chủ (khuyến nghị)** – VPS hoặc máy Windows nội bộ chạy `node server/index.js`:
- Server phục vụ giao diện và API.
- Tự chạy pipeline lúc `PIPELINE_TIME` (T2–T6). Log nằm ở `data/logs/`.
- Tự cập nhật giá theo `PRICE_REFRESH_MINUTES` và `PRICE_REFRESH_WINDOWS`; mặc định 10 phút/lần trong giờ theo dõi.
- Khi lưu báo cáo, server ghi vào `data/inbox/`, rồi dựng lại DB ngay.
- Admin có thể sửa/xóa báo cáo trong thư viện; mỗi thay đổi được đưa vào inbox, áp dụng atomic vào `reports.xlsx` rồi mới dựng lại dashboard.
- Đặt `ACCESS_TOKEN` hoặc `CALIDA_USERS_JSON` khi mở ra internet; phiên đăng nhập dùng cookie `HttpOnly`. Admin có thể cấp riêng quyền **xem/chỉnh sửa** cho từng module của từng user; dashboard qua server chỉ trả dữ liệu của các module đã được cấp.
- Xem `RAILWAY_DEPLOY.md` trước khi deploy Railway, đặc biệt phần Volume, backup và nguồn dữ liệu chính.

**B. Chỉ host tĩnh** (GitHub Pages / Netlify / Vercel):
- Upload thư mục `web/`.
- Chỉ khi thực sự dùng host tĩnh, tạo repository variable `ENABLE_STATIC_PIPELINE=true`, rồi thêm các secret `GOOGLE_SA_JSON`, `PORTFOLIO_SHEET_ID`, `FUNDS_SHEET_ID`. Workflow này mặc định bị tắt để tránh commit dữ liệu Railway Volume về GitHub.
- Hỏi đáp và "Thêm báo cáo" sẽ tự ẩn vì không có server.

**C. Tách giao diện và API** – host `web/` ở một nơi, server ở nơi khác:
- Đặt `API_BASE` trong `web/config.js`.
- Bật CORS trên server cho domain giao diện.

⚠ Nếu server chạy trên nền tảng có ổ đĩa tạm (Render, Railway…), cần gắn **persistent disk** cho thư mục `data/`. Nếu không, báo cáo đã lưu sẽ mất khi redeploy.

## Quy tắc tính toán chính

- **Cảnh báo danh mục** (tính trong giao diện):
  - Cần xử lý: giá ≤ vùng vi phạm.
  - Sát vùng vi phạm: giá ≤ vùng vi phạm × 1,03.
  - Về vùng mua: Low nằm trong vùng mua.
  - Đạt target: giá ≥ target.
- **Hành động trong ngày**: các mã có trạng thái MUA / TĂNG TỶ TRỌNG / GIẢM TỶ TRỌNG.
- **Quỹ**:
  - Mặc định hiển thị kỳ mới nhất; người dùng có quyền xem module có thể chọn lại các kỳ `MM/YYYY` còn được lưu trong nguồn Quỹ.
  - Tỷ trọng ngành và cổ phiếu là bình quân gia quyền theo NAV, chỉ tính các quỹ có dữ liệu trong kỳ đang chọn.
  - Mọi chỉ số Δ chỉ so sánh những quỹ có đủ cả 2 kỳ.
  - Top cổ phiếu dựa trên top holdings công bố, nên tỷ trọng thực tế có thể cao hơn.
- **Dòng tiền**:
  - Ngày dữ liệu = ngày mới nhất trong INVESTOR_FLOW / VNINDEX / VIEW.
  - MTD và YTD là tổng cộng dồn theo tháng và năm của ngày đó.
- **Báo cáo CTCK**:
  - Mỗi CTCK lấy báo cáo mới nhất để xác định quan điểm và target VN-Index.
  - Đồng thuận cổ phiếu lấy khuyến nghị mới nhất của mỗi CTCK cho từng mã.

## Cấu trúc thư mục

```
pipeline/   schema.py (định nghĩa cột) · config.py · fetch_*.py · import_inbox.py · build_db.py · export_json.py · run.py · make_templates.py
data/       input/*.xlsx · inbox/ · calida.db · logs/
web/        index.html · config.js · data/dashboard.json
server/     index.js · package.json
```
