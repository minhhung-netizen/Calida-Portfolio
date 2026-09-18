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
- `ACCESS_TOKEN=<một mật khẩu mạnh>` nếu chỉ dùng một tài khoản admin, hoặc `CALIDA_USERS_JSON` nếu cần các vai trò `viewer`, `analyst`, `admin`
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

Không đặt `ACCESS_TOKEN`, `SESSION_SECRET`, `GOOGLE_SA_JSON` hoặc mật khẩu trong Git. Khi `ACCESS_TOKEN` hoặc `CALIDA_USERS_JSON` được cấu hình, mọi trang, API và `dashboard.json` đều yêu cầu đăng nhập. `viewer` chỉ xem dữ liệu; `analyst` dùng AI và thêm báo cáo; `admin` có thêm quyền chạy pipeline.

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
- Không bật `.github/workflows/pipeline.yml` cùng với Railway cho dữ liệu thật: workflow này commit các workbook trong `data/input/` về Git, còn Railway tiếp tục dùng Volume riêng. Chỉ dùng workflow này cho phương án host tĩnh với dữ liệu không nhạy cảm.
