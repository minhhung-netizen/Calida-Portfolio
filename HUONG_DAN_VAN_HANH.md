# Hướng dẫn vận hành Calida Analyst

Tài liệu này dành cho quản trị viên vận hành Calida Analyst trên Railway. Mục tiêu là cập nhật dữ liệu an toàn, nhận biết lỗi nhanh và khôi phục được dữ liệu khi cần.

## 1. Mô hình vận hành

```text
Google Sheets ──► Railway Volume (/app/data) ──► SQLite ──► Dashboard
                         ▲                         │
                         └── Báo cáo tạo trên web ──┘
```

- Railway Volume tại `/app/data` là nơi lưu dữ liệu vận hành thực tế: Excel đầu vào, SQLite, `dashboard.json`, inbox báo cáo, nhật ký và tài khoản.
- GitHub chỉ lưu mã nguồn và dữ liệu mẫu. Đẩy Excel lên GitHub không tự ghi đè dữ liệu trên Volume; dashboard vừa đồng bộ cũng được giữ trên Volume nên không quay về dữ liệu mẫu sau deploy hoặc `Ctrl + F5`.
- Mỗi lượt chạy dựng lại SQLite và dashboard từ dữ liệu hiện có. Nếu lượt chạy lỗi, dashboard hợp lệ gần nhất vẫn được phục vụ.

## 2. Chuẩn bị một lần

### Railway

1. Gắn Volume vào service tại `/app/data`.
2. Chỉ chạy một replica vì hệ thống sử dụng SQLite và ghi vào Volume cục bộ.
3. Bật backup Volume hằng ngày trước khi vận hành dữ liệu thật.
4. Đặt `TZ=Asia/Ho_Chi_Minh`.
5. Đặt `REBUILD_ON_BOOT=false` để Railway không tự gọi nguồn ngoài mỗi lần khởi động.

### Biến môi trường quan trọng

| Biến | Mục đích |
|---|---|
| `ACCESS_TOKEN` hoặc `CALIDA_USERS_JSON` | Khởi tạo tài khoản quản trị |
| `SESSION_SECRET` | Bảo vệ phiên đăng nhập |
| `GOOGLE_SA_JSON` | Nội dung JSON của Google service account |
| `GOOGLE_SA_FILE=/app/secrets/service-account.json` | Đường dẫn file service account được tạo lúc khởi động |
| `PORTFOLIO_SHEET_ID` | Google Sheet Danh mục |
| `OPERATIONS_SHEET_ID` | Google Sheet Vận hành |
| `FUNDS_SHEET_ID` | Google Sheet Quỹ |
| `REPORTS_SHEET_ID` | Google Sheet Báo cáo CTCK |
| `PIPELINE_TIME=16:30` | Lịch chạy ngày làm việc, giờ Việt Nam |
| `PRICE_REFRESH_MINUTES=10` | Chu kỳ cập nhật riêng VN-Index và giá cổ phiếu; đặt `0` để tắt |
| `PRICE_REFRESH_WINDOWS=09:00-11:30,13:00-15:10` | Khung chạy giá từ thứ Hai đến thứ Sáu, theo `TZ` |
| `PRICE_REQUESTS_PER_MINUTE=50` | Gọi tuần tự; hệ thống luôn chặn tối đa 55 để thấp hơn giới hạn 60/phút |
| `PRICE_REFRESH_LOOKBACK_DAYS=10` | Số ngày tải trong lượt giá định kỳ; đủ giữ giá hiện tại và giá phiên trước |
| `FLOWS_MODULE_ENABLED=false` | Tạm dừng Dòng tiền; nên giữ giá trị hiện tại |
| `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Bật thông báo web/PWA nếu sử dụng |

Không đặt mật khẩu, JSON service account, API key hoặc VAPID private key vào GitHub hay Google Sheets.

### Google Sheets

Service account phải được chia sẻ quyền **Viewer** trên cả bốn Google Sheets. Google Drive API phải được bật trong Google Cloud Project của service account.

Các tiêu đề sheet và cột phải giữ đúng mẫu. Dữ liệu số nhập theo chuẩn:

```text
Hàng nghìn: 1,234.56
Số âm: -125.5
Phần trăm: 2.5 hoặc -0.8
```

Không nhập số dạng `2/5`, `26/3` vì Google Sheets có thể hiểu là ngày tháng. Đặt cột số về định dạng **Number**, không phải Date.

## 3. Luồng đồng bộ dữ liệu

Đăng nhập bằng tài khoản có quyền **Quản trị → Chỉnh sửa**, mở **Quản trị → Vận hành dữ liệu**.

| Thao tác | Khi dùng | Phạm vi |
|---|---|---|
| Dựng lại bảng điều hành | Chỉ thay đổi dữ liệu đã có trên Volume, hoặc cần thử dựng lại | Không gọi Google Sheets/vnstock |
| Đồng bộ tất cả nguồn | Quy trình vận hành hằng ngày | 4 Google Sheets, giá vnstock, dựng dashboard |
| Danh mục | Chỉ vừa cập nhật danh mục/giao dịch | Thay thế dữ liệu Danh mục cũ bằng bản chụp Sheet mới |
| Vận hành | Chỉ vừa cập nhật nhận định, tin tức, sự kiện hoặc summary | Thay thế phần Vận hành đang hoạt động |
| Quỹ | Chỉ vừa cập nhật Fmarket DB | Thay thế dữ liệu Quỹ cũ bằng bản chụp Sheet mới |
| Báo cáo CTCK | Chỉ vừa cập nhật thư viện báo cáo | Gộp theo mã báo cáo |

Danh mục, Vận hành và Quỹ dùng **bản chụp nguồn**. Nghĩa là dòng cũ không còn trong Google Sheets sẽ bị loại khỏi phần dữ liệu tương ứng trên Railway. Cơ chế này xử lý dứt điểm lỗi do dòng dữ liệu cũ còn sót trên Volume.

Riêng dữ liệu Quỹ, cần giữ các dòng của mọi kỳ `MM/YYYY` trong cả 4 sheet `FUND SUMMARY`, `ASSET ALLOCATION`, `INDUSTRY` và `TOP HOLDINGS`. Khi có tháng mới, thêm dữ liệu kỳ mới thay vì xoá kỳ cũ. Sau khi đồng bộ, module Quỹ mặc định mở kỳ mới nhất và người dùng có quyền xem module có thể chọn lại bất kỳ kỳ nào còn trong Google Sheets. Nếu xoá một kỳ khỏi Google Sheets, kỳ đó cũng sẽ biến mất khỏi bộ chọn sau lần đồng bộ Quỹ tiếp theo.

Báo cáo CTCK dùng **gộp theo mã** để không làm mất báo cáo được tạo trực tiếp trên web. Không nên sửa cùng một mã báo cáo trên Google Sheets và web trong cùng một lượt đồng bộ; thay đổi được nhập sau sẽ có hiệu lực.

### Cảnh báo giá cá nhân

Người dùng mở **Cảnh báo giá → Thêm cảnh báo**, tự nhập mã chứng khoán rồi chọn một trong ba điều kiện: **Giá tăng đến hoặc vượt**, **Giá giảm đến hoặc thấp hơn**, hoặc **Giá nằm trong vùng**. Với vùng giá, nhập giá thấp, giá cao và loại vùng:

- **Vùng mua:** chỉ kích hoạt khi giá trước đó nằm trên giá cao và giá mới đi xuống vào vùng. Giá đi từ dưới lên sẽ không kích hoạt.
- **Vùng bán:** chỉ kích hoạt khi giá trước đó nằm dưới giá thấp và giá mới đi lên vào vùng. Giá đi từ trên xuống sẽ không kích hoạt.

Hai đầu vùng đều được tính là nằm trong vùng. Nếu chưa có giá trước đó để xác định hướng, hệ thống tiếp tục chờ thay vì gửi cảnh báo không chắc chắn. Cảnh báo này độc lập với Danh mục, Khuyến nghị hành động và Trung tâm tín hiệu; mỗi tài khoản chỉ thấy dữ liệu của chính mình.

Mỗi cảnh báo có thể đặt:

- **Tần suất:** một lần rồi tự tắt; mỗi ngày có dữ liệu giá mới; hoặc mỗi lần giá rời rồi quay lại ngưỡng.
- **Thời điểm gửi:** ngay khi đủ điều kiện hoặc từ một giờ cụ thể trong ngày. Giờ được chọn là giờ gửi sớm nhất; nếu dữ liệu giá cập nhật sau giờ đó, hệ thống gửi khi lần kiểm tra kế tiếp xác nhận đủ điều kiện.
- **Hạn cảnh báo:** không bắt buộc. Quá thời điểm này cảnh báo tự chuyển sang hết hạn và không gửi thêm.

Cảnh báo được kiểm tra sau mỗi lần nguồn giá cập nhật và theo lịch kiểm tra mỗi phút. Giá có quy trình độc lập mặc định chạy 10 phút/lần trong các khung `09:00–11:30` và `13:00–15:10`, từ thứ Hai đến thứ Sáu. Mỗi mã được gọi tuần tự với tốc độ mặc định 50 request/phút; nếu một quy trình dữ liệu khác đang chạy hoặc chờ, lượt giá đó được bỏ qua để không chạy chồng hay dồn hàng đợi. Tần suất theo ngày chỉ gửi lại khi có ngày dữ liệu giá mới, tránh lặp lại từ dữ liệu cũ. Với chế độ một lần, sau khi kích hoạt người dùng chọn **Bật lại** để theo dõi tiếp. Nếu mã chưa tồn tại trong danh mục, hệ thống sẽ bổ sung mã đó vào lượt lấy giá tiếp theo; trước khi có dữ liệu, thẻ cảnh báo hiển thị trạng thái chờ. File `price-alerts.json` nằm trong vùng dữ liệu vận hành và cần được đưa vào kế hoạch sao lưu.

### Xoá dữ liệu cũ theo module và ngày

Tài khoản có quyền **Quản trị → Chỉnh sửa** mở **Quản trị → Dữ liệu**:

1. Chọn module: Bản tin, Danh mục, Dòng tiền, Quỹ đầu tư hoặc Báo cáo CTCK.
2. Chọn **Nhóm dữ liệu** bên trong module. Ví dụ chọn **Tin tức** để không xoá nhầm Nhận định hoặc Sự kiện cùng ngày. Chỉ dùng **Tất cả nhóm dữ liệu** khi thực sự muốn dọn toàn bộ module trong khoảng thời gian đó.
3. Chọn ngày bắt đầu và kết thúc từ đúng các mốc dữ liệu đang có. Muốn xoá một ngày thì chọn cùng ngày ở cả hai ô.
4. Kiểm tra số dòng xem trước và các bảng nguồn bị ảnh hưởng.
5. Bấm **Xóa dữ liệu đã chọn**, đọc nội dung xác nhận rồi đồng ý.
6. Chờ hệ thống ghi nguồn vận hành, dựng lại SQLite và `dashboard.json`; sau đó kiểm tra module liên quan.

Tổng quan, Khuyến nghị hành động và Trung tâm tín hiệu là dữ liệu tổng hợp nên không có nút xoá độc lập; chúng tự thay đổi theo các module nguồn. Với Quỹ, ngày hiển thị là ngày đầu tháng đại diện cho kỳ `MM/YYYY`. Với Báo cáo CTCK, xoá một báo cáo sẽ xoá kèm khuyến nghị cổ phiếu, quan điểm ngành và rủi ro có cùng ID.

Mỗi bản ghi đã xoá được lưu dấu theo khóa trong `/app/data/data-deletions.json`. Vì vậy cùng bản ghi không tự xuất hiện lại khi đồng bộ Google Sheets. Đây là dữ liệu vận hành trên Railway Volume: phải nằm trong kế hoạch backup và không được xoá thủ công. Nếu cần khôi phục dữ liệu đã xoá, khôi phục Volume từ backup hoặc yêu cầu kỹ thuật gỡ đúng dấu xoá; giao diện hiện không có chức năng hoàn tác.

## 4. Dòng tiền đang tạm dừng

Ở trạng thái hiện tại, `FLOWS_MODULE_ENABLED=false`.

- Module Dòng tiền không hiển thị trong điều hướng.
- Lượt đồng bộ Vận hành và Đồng bộ tất cả không đọc `INVESTOR_FLOW`, `TICKER_FLOW`, `SECTOR_FLOW`.
- Pipeline không kiểm tra và không đưa dữ liệu Dòng tiền cũ vào dashboard. Vì vậy lỗi FLOW không thể chặn Quỹ, Danh mục, Bản tin hoặc Báo cáo CTCK.
- File `flows.xlsx` vẫn được giữ trên Volume để phục hồi khi mở lại.

### Mở lại Dòng tiền

1. Chuẩn hóa ba sheet `INVESTOR_FLOW`, `TICKER_FLOW`, `SECTOR_FLOW`.
2. Kiểm tra mọi `net_value`, `chg_pct`, `weight_pct` là số; không để trống trường bắt buộc.
3. Đổi Railway Variable thành `FLOWS_MODULE_ENABLED=true`.
4. Deploy lại service.
5. Chạy **Vận hành** để lấy bản chụp FLOW mới.
6. Kiểm tra Chất lượng dữ liệu trong trang Quản trị trước khi dùng Đồng bộ tất cả.

## 5. Kiểm tra sau mỗi lần đồng bộ

1. Chờ trạng thái pipeline chuyển thành `ok`.
2. Kiểm tra mục **Chất lượng dữ liệu**. Không được có lỗi đỏ.
3. Kiểm tra **Độ mới dữ liệu theo nguồn** phù hợp ngày cập nhật mong muốn.
4. Mở các module bị ảnh hưởng để xác nhận số lượng và ngày dữ liệu.
5. Nếu có lỗi, đọc thông báo kèm tên file, sheet, cột và dòng nguồn trước khi chạy lại.

Ví dụ lỗi `flows.xlsx/SECTOR_FLOW: weight_pct phải là số` nghĩa là phải sửa cột `weight_pct` trong Sheet `SECTOR_FLOW`, không phải sửa dashboard.

## 6. Xử lý sự cố thường gặp

### Pipeline lỗi dữ liệu

- Sửa đúng ô và định dạng mà log nêu.
- Nếu lỗi thuộc Danh mục, Vận hành hoặc Quỹ, chạy lại đồng bộ riêng nguồn đó để thay toàn bộ dòng cũ.
- Không dùng Dựng lại bảng điều hành để lấy thay đổi vừa sửa trên Google Sheets; thao tác này không gọi nguồn ngoài.

### Drive export lỗi 403

- Kiểm tra Google Drive API đã bật đúng Google Cloud Project.
- Kiểm tra service account có quyền Viewer trên sheet.
- Sau khi bật API lần đầu, chờ vài phút rồi đồng bộ lại.

### vnstock giới hạn request

- Chờ hết khoảng thời gian giới hạn rồi chạy lại.
- Giữ `PRICE_REQUESTS_PER_MINUTE=50`; không tăng lên 60. Hệ thống vẫn chặn tối đa 55 ngay cả khi cấu hình cao hơn.
- Quy trình giá định kỳ chỉ tải `PRICE_REFRESH_LOOKBACK_DAYS=10`, gọi từng mã lần lượt và không chạy chồng với pipeline khác.
- Có thể đồng bộ riêng Danh mục, Vận hành, Quỹ hoặc Báo cáo CTCK; các thao tác này không gọi nguồn giá.
- Không liên tục bấm Đồng bộ tất cả khi nguồn giá đang bị giới hạn.

### Dashboard vẫn hiển thị dữ liệu cũ

- Kiểm tra pipeline có trạng thái `ok` hay không.
- Tải lại trang sau khi pipeline hoàn tất.
- Kiểm tra đúng Railway Volume đang được mount tại `/app/data`.
- Nếu log báo dòng vượt quá số dòng của Sheet hiện tại, chạy đồng bộ riêng nguồn đó. Cơ chế bản chụp sẽ xóa dòng cũ còn tồn trên Volume.

## 7. Sao lưu và khôi phục

Trước một thay đổi dữ liệu lớn, xác nhận backup Volume gần nhất đã thành công.

Khi cần khôi phục:

1. Chọn bản backup trong Railway Backups.
2. Khôi phục vào service theo hướng dẫn Railway và xác nhận deploy.
3. Kiểm tra `/api/ready` trả trạng thái hoạt động.
4. Đăng nhập, kiểm tra Dashboard và trạng thái pipeline.
5. Chỉ chạy đồng bộ mới sau khi xác minh dữ liệu đã khôi phục đúng.

## 8. Quy trình vận hành khuyến nghị

### Hằng ngày

1. Cập nhật Google Sheets.
2. Giá tự cập nhật mỗi 10 phút trong khung cấu hình; Google Sheets vẫn dùng đồng bộ riêng nguồn hoặc lịch đầy đủ `PIPELINE_TIME`.
3. Kiểm tra trạng thái và chất lượng dữ liệu.
4. Xem thông báo lỗi pipeline trên PWA nếu đã bật thông báo.

### Hằng tuần

1. Kiểm tra backup Volume.
2. Kiểm tra các tài khoản có quyền Quản trị và quyền chỉnh sửa.
3. Rà soát freshness của từng nguồn.

### Trước khi deploy mã nguồn

1. Xác nhận Volume vẫn mount `/app/data`.
2. Kiểm tra Railway Variables không bị mất.
3. Push GitHub, theo dõi Deploy Logs và `/api/ready`.
4. Đăng nhập kiểm tra Quản trị → Vận hành dữ liệu.
5. Mở **Quản trị → Dữ liệu** và xác nhận thống kê module vẫn đọc được từ Volume.

## 9. Mở rộng và tài liệu liên quan

- [RAILWAY_DEPLOY.md](RAILWAY_DEPLOY.md): chi tiết hạ tầng Railway, thông báo PWA và khôi phục.
- [README.md](README.md): kiến trúc dự án, schema và lệnh chạy cục bộ.
- Mỗi file Excel mẫu có sheet `_HUONG_DAN` mô tả trường dữ liệu cần nhập.
