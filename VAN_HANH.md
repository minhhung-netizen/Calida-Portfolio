# Vận hành Calida Analyst

## 1. Nguồn dữ liệu và module

| Google Sheet / nguồn | Dữ liệu | Module nhận dữ liệu |
| --- | --- | --- |
| Portfolio Automation | `DM cơ bản`, `DM lướt sóng`, `Transaction Log` | Danh mục, Tổng quan, Action Desk, Signal Center |
| Fmarket DB | `FUND SUMMARY`, `ASSET ALLOCATION`, `INDUSTRY`, `TOP HOLDINGS` | Quỹ đầu tư |
| Operations Data | `VIEW`, `NEWS`, `EVENTS`, các bảng `*_FLOW`, `SUMMARY` | Tổng quan, Bản tin, Dòng tiền, hiệu suất danh mục |
| vnstock | VN-Index và giá các mã trong danh mục | Tổng quan, Bản tin, Danh mục, Action Desk |
| Báo cáo CTCK | `BAO_CAO_CTCK`, `KHUYEN_NGHI_CP`, `QUAN_DIEM_NGANH`, `RUI_RO` | Báo cáo CTCK, Signal Center |

Action Desk và Signal Center không có Google Sheet riêng. Action được suy ra từ trạng thái `MUA`, `TĂNG TỶ TRỌNG`, `GIẢM TỶ TRỌNG` trong danh mục. Khối lượng, deadline, tiến độ, ghi chú và trạng thái Signal được người có quyền cập nhật trực tiếp trong web.

## 2. Chuẩn bị bốn Google Sheet

1. Tải bốn file mẫu trong `outputs/gsheet-templates/` lên Google Drive, gồm cả `Calida_Bao_Cao_CTCK_Mau.xlsx`.
2. Mở từng file bằng Google Sheets và không đổi tên sheet hoặc hàng tiêu đề.
3. Tạo một Google service account, bật Google Drive API, rồi tải file JSON khóa về máy.
4. Chia sẻ cả bốn Sheet cho email service account với quyền **Viewer**.
5. Lấy ID mỗi Sheet trong URL: phần giữa `/d/` và `/edit`.

Các file mẫu chứa sheet `_HUONG_DAN`. Có thể xóa sheet này sau khi đội vận hành đã nắm cấu trúc; pipeline không đọc sheet hướng dẫn.

## 3. Cấu hình Railway

1. Gắn Railway Volume tại `/app/data`; chạy đúng một replica.
2. Đặt các biến tối thiểu:
   - `ACCESS_TOKEN` hoặc `CALIDA_USERS_JSON` để tạo admin đầu tiên.
   - `SESSION_SECRET` dài, ngẫu nhiên và khác mật khẩu.
   - `TZ=Asia/Ho_Chi_Minh`, `PIPELINE_TIME=16:30`, `REBUILD_ON_BOOT=false`.
3. Đặt biến Google Sheets:
   - `GOOGLE_SA_JSON`: toàn bộ JSON service account.
   - `GOOGLE_SA_FILE=/app/secrets/service-account.json`.
   - `PORTFOLIO_SHEET_ID`, `FUNDS_SHEET_ID`, `OPERATIONS_SHEET_ID`, `REPORTS_SHEET_ID`.
4. Deploy và chờ endpoint `/api/ready` trả `200`.
5. Đăng nhập admin, vào **Quản trị → Vận hành dữ liệu**, chọn **Đồng bộ toàn bộ nguồn** lần đầu.

`GOOGLE_SA_JSON`, `SESSION_SECRET`, mật khẩu và API key chỉ đặt trong Railway Variables. Không đặt vào Git hay Google Sheet.

## 4. Quy trình cập nhật hằng ngày

1. Trước phiên: cập nhật `VIEW`, `NEWS`, `EVENTS` trong Operations Data.
2. Sau phiên: thêm các dòng `INVESTOR_FLOW`, `TICKER_FLOW`, `SECTOR_FLOW`; cập nhật `SUMMARY` nếu có số hiệu suất/phân bổ chính thức.
3. Cập nhật danh mục và lịch sử giao dịch trong Portfolio Automation.
4. Cập nhật số liệu quỹ theo kỳ công bố trong Fmarket DB.
5. Cập nhật Báo cáo CTCK trong bốn tab của Sheet Báo cáo CTCK. Dùng một `ID` duy nhất cho một báo cáo và lặp lại đúng ID đó tại các dòng khuyến nghị, ngành và rủi ro liên quan.
6. Vào web với quyền admin, chạy **Đồng bộ toàn bộ nguồn**. Dùng **Dựng lại dashboard** khi chỉ cần dựng lại từ dữ liệu đã có trên Volume.
7. Kiểm tra mốc độ mới, chất lượng dữ liệu và audit log ở **Quản trị → Vận hành dữ liệu**.
8. Mở Action Desk để khai báo khối lượng, deadline, số đã thực hiện và ghi chú; xem Signal Center để theo dõi hoặc bỏ qua signal.

Pipeline upsert dữ liệu theo khóa nên lịch sử dòng tiền, tin tức, sự kiện và quỹ được giữ lại. `POSITIONS` là ảnh chụp danh mục hiện tại nên được thay thế theo lần đồng bộ mới.

## 5. Kiểm tra trước khi đồng bộ

- Ngày dùng định dạng ngày hợp lệ; `period` của quỹ dùng `MM/YYYY`.
- Mã cổ phiếu viết hoa.
- Giá, tỷ trọng, NAV, dòng tiền là số; tỷ trọng nhập theo phần trăm, ví dụ `12.5` thay vì `0.125` khi `WEIGHTS_AS_FRACTION=auto`.
- `NEWS.tab`: `Thế giới`, `Trong nước` hoặc `Doanh nghiệp`.
- `EVENTS.impact`: `Cao`, `Trung bình` hoặc `Thấp`.
- `POSITIONS.status`: `MUA`, `NẮM GIỮ`, `TĂNG TỶ TRỌNG`, `GIẢM TỶ TRỌNG` hoặc `THEO DÕI`.
- Không đổi tên các cột đang được map trong `pipeline/config.py`. Nếu nguồn thật dùng tên khác, chỉnh `PORTFOLIO_MAP`, `FUNDS_MAP` hoặc `OPERATIONS_MAP` trước khi chạy.
- Báo cáo CTCK dùng chính xác tên bốn tab và hàng tiêu đề trong file mẫu. Các giá trị hợp lệ: Loại = `Chiến lược`, `Vĩ mô`, `Ngành`, `Doanh nghiệp`; Quan điểm = `Tích cực`, `Trung lập`, `Thận trọng`, `Tiêu cực`; Khuyến nghị = `MUA`, `KHẢ QUAN`, `TRUNG LẬP`, `KÉM KHẢ QUAN`, `BÁN`; View = `OW`/`UW`; Mức độ = `1`/`2`/`3`.

## 6. Khi có lỗi

- Pipeline nguồn lỗi: web tiếp tục dùng dashboard hợp lệ gần nhất. Kiểm tra log, quyền share của service account và tên sheet/cột.
- `/api/ready` trả lỗi: kiểm tra Railway Volume, `web/data/dashboard.json` và Deploy Logs; khôi phục từ backup nếu cần.
- Sai dữ liệu: sửa Sheet, chạy lại **Đồng bộ toàn bộ nguồn**, rồi kiểm tra freshness. Với dữ liệu Volume bị mất, dùng Railway Backups để restore.
- Nếu cùng một báo cáo được chỉnh trên web và trên Google Sheet: chọn một nguồn chính. Đồng bộ hiện là **một chiều Google Sheet → `reports.xlsx` → web**; các thao tác trên web chưa ghi ngược về Google Sheet.
- Đổi quyền người dùng: vào **Quản trị → Người dùng**. Chỉ cấp `edit` cho Action Desk/Signal Center cho người cần cập nhật trạng thái.
