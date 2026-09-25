# Deploy Calida Analyst lên Railway

## 1. Đưa source lên GitHub

Không commit `.env`, `secrets/`, `.venv/` hoặc `server/node_modules/`.

## 2. Tạo Railway service

- New Project -> Deploy from GitHub repo.
- Chọn repository chứa project này.
- Railway sẽ tự nhận `Dockerfile` ở thư mục gốc.
- Settings -> Networking -> Generate Domain.

## 3. Gắn persistent volume và backup

Gắn một Railway Volume vào service với Mount Path:

`/app/data`

Volume này giữ `data/input/*.xlsx`, `data/calida.db`, `data/dashboard.json`, `data/inbox/` và logs qua các lần redeploy. Dashboard trên Volume luôn được ưu tiên hơn file mẫu nằm trong image, do đó dữ liệu vừa đồng bộ không quay về quá khứ sau deploy, restart hoặc làm mới trình duyệt.

- Chỉ chạy **một replica** vì ứng dụng ghi vào Volume và SQLite cục bộ.
- Bật backup theo lịch cho Volume trước khi chạy dữ liệu thật; nên dùng lịch hằng ngày và thêm lịch hằng tuần/tháng theo nhu cầu lưu giữ. Thử khôi phục một bản backup vào môi trường thử nghiệm trước khi đưa vào vận hành.
- Sau lần deploy đầu, Volume là nguồn dữ liệu chính. Push Excel mới lên Git sẽ không ghi đè Volume đang có.

## 4. Variables

Tối thiểu cho server:

- `GEMINI_API_KEY` (nếu dùng chat/extract)
- `GEMINI_MODEL=gemini-2.5-flash`
- `ACCESS_TOKEN=<một mật khẩu mạnh>` để tạo admin ban đầu, hoặc `CALIDA_USERS_JSON` nếu muốn khai báo nhiều tài khoản ban đầu
- `SESSION_SECRET=<chuỗi ngẫu nhiên dài, khác ACCESS_TOKEN>`
- `SESSION_TTL_HOURS=8`
- `SESSION_COOKIE_SECURE=auto`
- `VAPID_SUBJECT=mailto:email-cua-doi-van-hanh@domain.com`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` để bật thông báo PWA/Web Push
- `PIPELINE_TIME=16:30`
- `TZ=Asia/Ho_Chi_Minh`
- `REBUILD_ON_BOOT=false` — giữ mặc định này để web khởi động độc lập với Google Sheets/vnstock. Chỉ đặt `true` cho **một lần deploy có chủ đích** khi cần dựng lại từ dữ liệu trên Volume; đặt lại `false` ngay sau đó.

Nếu pipeline đọc Google Sheets:

- `PORTFOLIO_SHEET_ID`
- `FUNDS_SHEET_ID`
- `OPERATIONS_SHEET_ID` (Sheet Vận hành dữ liệu: Bản tin, Dòng tiền và SUMMARY)
- `REPORTS_SHEET_ID` (Sheet Báo cáo CTCK: báo cáo, khuyến nghị, ngành và rủi ro)
- `FLOWS_MODULE_ENABLED=false` để tạm dừng Dòng tiền. Khi mở lại, đổi thành `true` sau khi ba sheet FLOW đã hợp lệ rồi deploy lại.
- `GOOGLE_SA_JSON` = toàn bộ nội dung JSON của Google service account
- `GOOGLE_SA_FILE=/app/secrets/service-account.json`

Các biến khác lấy theo `.env.example`.

Không đặt `ACCESS_TOKEN`, `SESSION_SECRET`, `GOOGLE_SA_JSON` hoặc mật khẩu trong Git. Khi `ACCESS_TOKEN` hoặc `CALIDA_USERS_JSON` được cấu hình, mọi trang và API đều yêu cầu đăng nhập. `viewer`, `analyst`, `admin` là bộ quyền mặc định; admin có thể ghi đè theo từng user cho từng module: `overview`, `brief`, `portfolio`, `flows`, `funds`, `reports`, `actions`, `signals`, `admin`. Quyền `edit` của `reports` cho phép thêm/sửa/xóa báo cáo và dùng AI; quyền `edit` của `actions` cho phép cập nhật tiến độ Action Desk; quyền `edit` của `signals` cho phép cập nhật trạng thái Signal Center; quyền `edit` của `admin` cho phép quản lý user/pipeline. Module `admin` chỉ có thể được cấp cho tài khoản có role `admin`.

### Bật thông báo iPhone / PWA

1. Trong thư mục `server`, chạy một lần `npm run generate:vapid`, rồi lưu ba giá trị `subject`, `publicKey`, `privateKey` vào các Railway Variables `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
2. Không thay VAPID key sau khi đã có người đăng ký; nếu bắt buộc thay, người dùng phải bật lại thông báo trên thiết bị.
3. Sau khi deploy HTTPS, người dùng iPhone mở Calida bằng Safari, chọn **Chia sẻ → Thêm vào Màn hình chính**, mở lại từ biểu tượng Calida và bấm chuông **Thông báo** để cho phép nhận push.
4. Server lưu subscription trên Railway Volume tại `/app/data/push-subscriptions.json`. Không commit file này; backup Volume đã bao gồm dữ liệu đăng ký.

Thông báo chỉ được gửi đến tài khoản có quyền xem module tương ứng: Signal mới, Action cần xử lý và lỗi Pipeline (chỉ tài khoản có quyền Quản trị). Người dùng tự chọn loại thông báo hoặc tắt trên từng thiết bị.

Sau khi đăng nhập bằng admin, mở **Quản trị** ở thanh bên để tạo, sửa vai trò, đặt lại mật khẩu, xóa tài khoản và tick quyền **Xem/Chỉnh sửa** cho từng module. Hệ thống lưu mật khẩu ở dạng băm và ma trận quyền trong `/app/data/auth/users.json` trên Railway Volume; sau lần thay đổi đầu tiên, kho này là nguồn tài khoản chính thay cho `ACCESS_TOKEN`/`CALIDA_USERS_JSON`. Không commit thư mục `data/auth/` và cần có Volume backup trước khi vận hành. Khi phân quyền được bật, giao diện lấy dữ liệu qua `/api/dashboard`; đường dẫn thô `/data/dashboard.json` bị chặn để tránh lộ dữ liệu module chưa được cấp.

## 5. Lần deploy đầu

Script khởi động sẽ:

1. Seed dữ liệu mẫu hiện có vào `/app/data` nếu volume còn trống.
2. Tạo file service-account từ `GOOGLE_SA_JSON` nếu có.
3. Nếu Volume chưa có `dashboard.json`, tự chạy `python3 pipeline/run.py --build-only` một lần để tạo dashboard bền vững từ dữ liệu Volume. Nếu dựng lỗi, hệ thống dùng bản dự phòng để web vẫn khởi động.
4. Chỉ chạy `python3 pipeline/run.py --build-only` ở mọi lần boot khi `REBUILD_ON_BOOT=true`.
5. Chạy `node server/index.js` với dashboard hợp lệ gần nhất.

Sau đó mở domain Railway.

## 6. Vận hành hằng ngày

- `railway.json` đã khai báo readiness healthcheck `/api/ready`; `/api/health` là liveness check. Cả hai không yêu cầu đăng nhập. Railway chỉ dùng healthcheck khi deploy, do đó vẫn cần theo dõi **Metrics**, Deploy Logs hoặc một dịch vụ uptime bên ngoài cho giám sát liên tục.
- `/api/ready` trả `200` chỉ khi `web/data/dashboard.json` tồn tại và đọc được; trả `503` khi dashboard không sẵn sàng. `/api/status` (cần đăng nhập) cho biết freshness, thời điểm dữ liệu và trạng thái pipeline.
- Vnstock được cài theo cơ chế tùy chọn khi build. Nếu kho package tạm thời không có bản tương thích, Railway vẫn deploy; dashboard và các nguồn Google Sheets vẫn hoạt động, chỉ bước làm mới giá bị bỏ qua. Khi nguồn giá sẵn sàng, deploy lại để image cài Vnstock.
- Pipeline có thể lỗi khi lấy Google Sheets hoặc vnstock mà không làm web dừng: dashboard hợp lệ gần nhất vẫn phục vụ. Kiểm tra Deploy Logs và **Quản trị → Vận hành dữ liệu** sau mỗi lượt chạy.
- Admin có thể vào **Quản trị → Vận hành dữ liệu** để xem độ mới của từng nguồn, nhật ký thao tác và chạy pipeline. **Đồng bộ tất cả nguồn** lấy mới 4 Google Sheets và vnstock. Có thể đồng bộ riêng **Danh mục**, **Vận hành**, **Quỹ** hoặc **Báo cáo CTCK** khi chỉ một nguồn vừa được sửa. Danh mục, Vận hành và Quỹ thay thế bản dữ liệu cũ trên Volume bằng bản chụp Google Sheets; Báo cáo CTCK gộp theo mã để không làm mất báo cáo tạo trên web. **Dựng lại bảng điều hành** chỉ dùng Excel đã có trên Volume.
- Nhật ký thao tác nằm trong `/app/data/logs/audit.jsonl`, theo Volume backup. Nhật ký không ghi mật khẩu hoặc secrets.
- Báo cáo CTCK có thể đồng bộ một chiều từ Google Sheet vào `reports.xlsx`. Admin vẫn có thể sửa/xóa trong thư viện; thay đổi được lưu tạm trong inbox, áp dụng atomic vào `reports.xlsx`, rồi pipeline dựng lại dashboard. Không nên cùng sửa một `ID` báo cáo trên web và Google Sheet trong một lượt đồng bộ, vì thay đổi nhập sau sẽ ghi đè theo cùng khóa.
- Không bật `.github/workflows/pipeline.yml` cùng với Railway cho dữ liệu thật: workflow chỉ chạy nếu repository variable `ENABLE_STATIC_PIPELINE=true`, vì nó commit các workbook trong `data/input/` về Git. Chỉ bật cho phương án host tĩnh với dữ liệu không nhạy cảm.

## 7. Quy trình deploy, cảnh báo và khôi phục

### Trước mỗi deploy

1. Kiểm tra Volume vẫn được mount đúng `/app/data`, còn dung lượng trống và backup gần nhất thành công.
2. Kiểm tra `SESSION_SECRET`, tài khoản admin và các biến Google/Gemini vẫn có trong đúng Environment Railway.
3. Push thay đổi lên GitHub, mở Deploy Logs và chờ `/api/ready` trả `200`.
4. Đăng nhập bằng admin, kiểm tra **Quản trị → Vận hành dữ liệu**: pipeline không báo lỗi, freshness và chất lượng dữ liệu phù hợp.

### Khi deploy hoặc pipeline gặp lỗi

1. Nếu deploy không qua healthcheck, mở Deploy Logs. `dashboard.json` thiếu/hỏng là nguyên nhân readiness trả `503`; khôi phục file từ backup hoặc deploy lại bản GitHub trước đó.
2. Nếu chỉ pipeline lỗi, không cần redeploy vội: web vẫn dùng dashboard hợp lệ gần nhất. Sửa Google Sheet/biến môi trường, sau đó chạy **Dựng lại dashboard** hoặc **Đồng bộ toàn bộ nguồn** từ giao diện admin.
3. Chỉ bật `REBUILD_ON_BOOT=true` khi cần rebuild ngay lúc khởi động. Xem log kết quả, rồi đổi lại `false` và redeploy để tránh mỗi lần restart đều phụ thuộc nguồn ngoài.
4. Nếu dữ liệu trên Volume bị sai hoặc mất, dùng Railway **Backups → Restore** để khôi phục snapshot đã chọn. Railway sẽ gắn volume đã khôi phục và yêu cầu xác nhận deploy; sau đó kiểm tra `/api/ready`, đăng nhập admin và xác minh dữ liệu trước khi tiếp tục ghi mới.

### Mốc cảnh báo khuyến nghị

- Báo động ngay khi deploy thất bại, `/api/ready` trả khác `200`, hoặc pipeline có trạng thái `error`.
- Cảnh báo khi freshness của nguồn vượt ngưỡng nghiệp vụ của đội phân tích, dung lượng Volume tăng bất thường, hoặc backup hằng ngày không xuất hiện.
- Không ghi secrets vào Deploy Logs, Git hoặc file Excel. Khi nghi lộ `SESSION_SECRET`, `GOOGLE_SA_JSON` hay API key, xoay secret trên Railway và buộc người dùng đăng nhập lại.
