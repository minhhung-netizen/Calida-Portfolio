# Deploy Calida Analyst lên Railway

## 1. Đưa source lên GitHub

Không commit `.env`, `secrets/`, `.venv/` hoặc `server/node_modules/`.

## 2. Tạo Railway service

- New Project -> Deploy from GitHub repo.
- Chọn repository chứa project này.
- Railway sẽ tự nhận `Dockerfile` ở thư mục gốc.
- Settings -> Networking -> Generate Domain.

## 3. Gắn persistent volume

Gắn một Railway Volume vào service với Mount Path:

`/app/data`

Volume này giữ `data/input/*.xlsx`, `data/calida.db`, `data/inbox/` và logs qua các lần redeploy.

## 4. Variables

Tối thiểu cho server:

- `GEMINI_API_KEY` (nếu dùng chat/extract)
- `GEMINI_MODEL=gemini-2.5-flash`
- `ACCESS_TOKEN=<một chuỗi bí mật mạnh>`
- `PIPELINE_TIME=16:30`
- `TZ=Asia/Ho_Chi_Minh`

Nếu pipeline đọc Google Sheets:

- `PORTFOLIO_SHEET_ID`
- `FUNDS_SHEET_ID`
- `GOOGLE_SA_JSON` = toàn bộ nội dung JSON của Google service account
- `GOOGLE_SA_FILE=/app/secrets/service-account.json`

Các biến khác lấy theo `.env.example`.

## 5. Lần deploy đầu

Script khởi động sẽ:

1. Seed dữ liệu mẫu hiện có vào `/app/data` nếu volume còn trống.
2. Tạo file service-account từ `GOOGLE_SA_JSON` nếu có.
3. Chạy `python3 pipeline/run.py --build-only` để dựng DB/JSON.
4. Chạy `node server/index.js`.

Sau đó mở domain Railway.
