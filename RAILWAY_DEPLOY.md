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

Volume này giữ `data/input/*.xlsx`, `data/calida.db`, `data/inbox/` và logs qua các lần redeploy.

- Chỉ chạy **một replica** vì ứng dụng ghi vào Volume và SQLite cục bộ.
- Bật backup cho Volume trước khi chạy dữ liệu thật. Thử tải một bản backup và kiểm tra có đủ `data/input/` trước khi đưa vào vận hành.
- Sau lần deploy đầu, Volume là nguồn dữ liệu chính. Push Excel mới lên Git sẽ không ghi đè Volume đang có.

## 4. Variables

Tối thiểu cho server:

- `GEMINI_API_KEY` (nếu dùng chat/extract)
- `GEMINI_MODEL=gemini-2.5-flash`
- `ACCESS_TOKEN=<một mật khẩu mạnh>` để tạo admin ban đầu, hoặc `CALIDA_USERS_JSON` nếu muốn khai báo nhiều tài khoản ban đầu
- `SESSION_SECRET=<chuỗi ngẫu nhiên dài, khác ACCESS_TOKEN>`
- `SESSION_TTL_HOURS=8`
- `SESSION_COOKIE_SECURE=auto`
- `PIPELINE_TIME=16:30`
- `TZ=Asia/Ho_Chi_Minh`

Nếu pipeline đọc Google Sheets:

- `PORTFOLIO_SHEET_ID`
- `FUNDS_SHEET_ID`
- `GOOGLE_SA_JSON` = toàn bộ nội dung JSON của Google service account
- `GOOGLE_SA_FILE=/app/secrets/service-account.json`

Các biến khác lấy theo `.env.example`.

Không đặt `ACCESS_TOKEN`, `SESSION_SECRET`, `GOOGLE_SA_JSON` hoặc mật khẩu trong Git. Khi `ACCESS_TOKEN` hoặc `CALIDA_USERS_JSON` được cấu hình, mọi trang, API và `dashboard.json` đều yêu cầu đăng nhập. `viewer` chỉ xem dữ liệu; `analyst` dùng AI và thêm báo cáo; `admin` có thêm quyền chạy pipeline và quản lý tài khoản.

Sau khi đăng nhập bằng admin, mở **Quản trị** ở thanh bên để tạo, sửa vai trò, đặt lại mật khẩu hoặc xóa tài khoản. Hệ thống lưu mật khẩu ở dạng băm trong `/app/data/auth/users.json` trên Railway Volume; sau lần thay đổi đầu tiên, kho này là nguồn tài khoản chính thay cho `ACCESS_TOKEN`/`CALIDA_USERS_JSON`. Không commit thư mục `data/auth/` và cần có Volume backup trước khi vận hành.

## 5. Lần deploy đầu

Script khởi động sẽ:

1. Seed dữ liệu mẫu hiện có vào `/app/data` nếu volume còn trống.
2. Tạo file service-account từ `GOOGLE_SA_JSON` nếu có.
3. Chạy `python3 pipeline/run.py --build-only` để dựng DB/JSON.
4. Chạy `node server/index.js`.

Sau đó mở domain Railway.

## 6. Vận hành hằng ngày

- `railway.json` đã khai báo healthcheck `/api/health` và restart khi tiến trình lỗi.
- Một lần pipeline thất bại khi lấy Google Sheets hoặc vnstock sẽ trả mã lỗi, nhưng dashboard vẫn được dựng từ dữ liệu có sẵn. Kiểm tra log Railway và `/api/status` sau mỗi lượt chạy.
- Admin có thể vào **Quản trị → Vận hành dữ liệu** để xem độ mới của từng nguồn, nhật ký thao tác và chạy pipeline. Chỉ dùng **Đồng bộ toàn bộ nguồn** khi cần lấy mới Google Sheets/vnstock; **Dựng lại dashboard** chỉ dùng Excel đã có trên Volume.
- Nhật ký thao tác nằm trong `/app/data/logs/audit.jsonl`, theo Volume backup. Nhật ký không ghi mật khẩu hoặc secrets.
- Admin có thể sửa/xóa báo cáo trong thư viện. Thay đổi được lưu tạm trong inbox, áp dụng atomic vào `reports.xlsx`, rồi pipeline dựng lại dashboard.
- Không bật `.github/workflows/pipeline.yml` cùng với Railway cho dữ liệu thật: workflow chỉ chạy nếu repository variable `ENABLE_STATIC_PIPELINE=true`, vì nó commit các workbook trong `data/input/` về Git. Chỉ bật cho phương án host tĩnh với dữ liệu không nhạy cảm.
