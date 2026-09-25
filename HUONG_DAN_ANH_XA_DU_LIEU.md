# Hướng dẫn ánh xạ dữ liệu theo từng module

Tài liệu này trả lời ba câu hỏi khi vận hành Calida Analyst:

1. Một nội dung trên giao diện lấy từ file và sheet nào?
2. Cần nhập hoặc sửa trường nào trong Google Sheets?
3. Sau khi đồng bộ, dữ liệu đi qua bảng database và khóa JSON nào trước khi hiển thị?

## 1. Sơ đồ dữ liệu tổng thể

```text
Google Sheets / nguồn giá / dữ liệu nhập trên web
                    │
                    ▼
       data/input/*.xlsx (dữ liệu chuẩn hóa)
                    │
                    ▼
             data/calida.db
                    │
                    ▼
          data/dashboard.json + API
                    │
                    ▼
              Các module web
```

Các file trong `data/input/`, `data/calida.db` và `data/dashboard.json` là dữ liệu vận hành do hệ thống tạo hoặc cập nhật. Không chỉnh trực tiếp `calida.db` hay `dashboard.json`.

## 2. Bốn Google Sheets nguồn

| Nguồn | Biến cấu hình | File chuẩn hóa | Sheet nguồn |
|---|---|---|---|
| Danh mục | `PORTFOLIO_SHEET_ID` | `portfolio.xlsx` | `DM cơ bản`, `DM lướt sóng`, `Transaction Log` |
| Vận hành | `OPERATIONS_SHEET_ID` | `market.xlsx`, `portfolio.xlsx`, `flows.xlsx` | `VIEW`, `NEWS`, `EVENTS`, `SUMMARY`, và ba sheet dòng tiền |
| Quỹ | `FUNDS_SHEET_ID` | `funds.xlsx` | `FUND SUMMARY`, `ASSET ALLOCATION`, `INDUSTRY`, `TOP HOLDINGS` |
| Báo cáo CTCK | `REPORTS_SHEET_ID` | `reports.xlsx` | `BAO_CAO_CTCK`, `KHUYEN_NGHI_CP`, `QUAN_DIEM_NGANH`, `RUI_RO` |

Ngoài bốn nguồn trên, `market.xlsx/VNINDEX` và `portfolio.xlsx/PRICES` được cập nhật từ nguồn giá. Khuyến nghị thủ công, trạng thái tín hiệu, cảnh báo giá và người dùng được lưu qua API của web, không nằm trong Google Sheets.

## 3. Bảng tra nhanh theo module

| Module trên web | Nguồn chính | File / sheet chuẩn hóa | Bảng database | Khóa JSON/API |
|---|---|---|---|---|
| Tổng quan | Giá, Vận hành, Danh mục, Quỹ, Báo cáo | Nhiều sheet | Nhiều bảng | `market`, `portfolio`, `funds`, `reports`, `news`, `flows` |
| Bản tin | Vận hành + giá | `market.xlsx/VNINDEX, VIEW, NEWS, EVENTS` | `vnindex`, `view`, `news`, `events` | `market`, `news`, `events` |
| Danh mục | Danh mục + Vận hành + giá + Báo cáo | `portfolio.xlsx/POSITIONS, PRICES, TRANSACTIONS, SUMMARY`; `reports.xlsx/*` | `positions`, `prices`, `transactions`, `summary`, `report_*` | `portfolio`, `prices`, `reports` |
| Dòng tiền | Vận hành | `flows.xlsx/INVESTOR_FLOW, TICKER_FLOW, SECTOR_FLOW` | `investor_flow`, `ticker_flow`, `sector_flow` | `flows` |
| Quỹ đầu tư | Quỹ | `funds.xlsx/*` | `fund_summary`, `asset_allocation`, `industry`, `top_holdings` | `funds` |
| Báo cáo CTCK | Báo cáo CTCK + nhập trên web | `reports.xlsx/*` | `reports`, `report_stocks`, `report_sectors`, `report_risks` | `reports`; `/api/reports` |
| Khuyến nghị hành động | Danh mục + khai báo trên web | `portfolio.xlsx/POSITIONS`; kho trạng thái web | `positions`; `workspace-state.json` | `portfolio.today`; `/api/actions` |
| Trung tâm tín hiệu | Danh mục + Báo cáo CTCK | `portfolio.xlsx/POSITIONS, PRICES`; `reports.xlsx/*`; kho trạng thái web | `positions`, `prices`, `report_*` | `portfolio`, `reports`; `/api/signals` |
| Cảnh báo giá | Người dùng nhập trên web + giá | `portfolio.xlsx/PRICES`; kho cảnh báo web | `prices`; `price-alerts.json` | `prices`; `/api/price-alerts` |
| Quản trị | Người dùng, vận hành, database | Toàn bộ file dữ liệu + kho trạng thái | Toàn bộ bảng | `/api/admin/*`, `/api/operations` |

## 4. Module Tổng quan

Tổng quan không có một sheet riêng. Các thẻ được ghép từ nhiều nguồn:

| Thành phần giao diện | Nguồn dữ liệu | Cách tính / chọn dữ liệu |
|---|---|---|
| VN-Index, tăng giảm, biểu đồ nhỏ | `market.xlsx/VNINDEX` | Lấy hai phiên gần nhất; biểu đồ dùng tối đa 20 giá đóng cửa |
| Nhận định hôm nay/tuần | Vận hành `VIEW` | Lấy dòng có `date` mới nhất không sau ngày dữ liệu hệ thống |
| Hỗ trợ, kháng cự, vùng kỳ vọng | Vận hành `VIEW` | Ghép cặp `*_lo` và `*_hi` |
| Khối ngoại | Vận hành `INVESTOR_FLOW` | Tổng `net_value` của nhóm `Khối ngoại` tại phiên gần nhất |
| Hiệu suất danh mục YTD | Vận hành `SUMMARY.ytd_pct` | Lấy dòng `SUMMARY` gần nhất |
| Đồng thuận CTCK | Báo cáo `BAO_CAO_CTCK` | Trung vị `Target VN-Index` của báo cáo trong 30 ngày |
| Hành động theo danh mục | Danh mục `DM cơ bản`, `DM lướt sóng` | Các trạng thái `MUA`, `TĂNG TỶ TRỌNG`, `GIẢM TỶ TRỌNG` |
| Tin cần biết | Vận hành `NEWS` | Bốn tin mới nhất |
| Chỉ số quỹ | Bốn sheet Quỹ | Dữ liệu kỳ quỹ mới nhất |

## 5. Module Bản tin

### 5.1 Sheet `VIEW` của Google Sheet Vận hành

| Cột nguồn | Trường chuẩn | Hiển thị / ý nghĩa |
|---|---|---|
| `date` | `date` | Ngày nhận định; mỗi ngày một dòng |
| `sentiment` | `sentiment` | Tâm lý thị trường |
| `support_lo`, `support_hi` | cùng tên | Cận dưới/cận trên vùng hỗ trợ |
| `resist_lo`, `resist_hi` | cùng tên | Cận dưới/cận trên vùng kháng cự |
| `expected_lo`, `expected_hi` | cùng tên | Vùng kỳ vọng tuần |
| `today_text` | cùng tên | Nội dung nhận định hôm nay |
| `week_text` | cùng tên | Nội dung nhận định tuần |
| `focus_sectors` | cùng tên | Danh sách ngành, phân tách bằng dấu phẩy |
| `risks` | cùng tên | Danh sách rủi ro, phân tách bằng dấu phẩy |
| `strategy_short` | cùng tên | Chiến lược ngắn hạn |
| `strategy_long` | cùng tên | Chiến lược dài hạn |
| `week_actions` | cùng tên | Các việc cần theo dõi, phân tách bằng dấu `|` |

Đường đi: `Vận hành/VIEW` → `market.xlsx/VIEW` → bảng `view` → `dashboard.market`.

### 5.2 Sheet `NEWS`

| Cột | Ý nghĩa |
|---|---|
| `published_at` | Ngày giờ đăng; cùng `title` tạo khóa duy nhất |
| `tab` | `Thế giới`, `Trong nước` hoặc `Doanh nghiệp` |
| `title` | Tiêu đề tin |
| `source` | Nguồn tin |
| `url` | Liên kết bài viết |

Đường đi: `Vận hành/NEWS` → `market.xlsx/NEWS` → bảng `news` → `dashboard.news`.

### 5.3 Sheet `EVENTS`

| Cột | Ý nghĩa |
|---|---|
| `date`, `time` | Ngày và giờ sự kiện |
| `name` | Tên sự kiện |
| `country` | Quốc gia/thị trường |
| `impact` | `Cao`, `Trung bình` hoặc `Thấp` |
| `forecast` | Dự báo |
| `previous` | Giá trị kỳ trước |

Đường đi: `Vận hành/EVENTS` → `market.xlsx/EVENTS` → bảng `events` → `dashboard.events`.

### 5.4 Dữ liệu VN-Index

`market.xlsx/VNINDEX` có các trường `date`, `open`, `high`, `low`, `close`, `volume`. Đây là sheet tự động; người vận hành không cần nhập tay.

## 6. Module Danh mục

### 6.1 Hai sheet `DM cơ bản` và `DM lướt sóng`

Cả hai sheet cùng đổ vào `portfolio.xlsx/POSITIONS`. Hệ thống tự gắn `book = Cơ bản` hoặc `book = Lướt sóng`.

| Cột Google Sheet | Trường chuẩn | Vị trí sử dụng |
|---|---|---|
| `Mã CK` | `ticker` | Mã cổ phiếu; viết hoa khi chuẩn hóa |
| `Tên công ty` | `name` | Tên doanh nghiệp |
| `Ngành` | `sector` | Chi tiết mã và thẻ **Ngành trong danh mục** |
| `Trạng thái` | `status` | MUA/NẮM GIỮ/TĂNG TỶ TRỌNG/GIẢM TỶ TRỌNG/THEO DÕI |
| `Vùng mua thấp` | `buy_lo` | Cận dưới vùng mua |
| `Vùng mua cao` | `buy_hi` | Cận trên vùng mua |
| `Target` | `target` | Giá mục tiêu |
| `Vùng vi phạm` | `stop` | Giá cắt lỗ / vùng vi phạm |
| `Giá vốn` | `cost` | Tính hiệu suất từng mã |
| `Ngày khuyến nghị` | `rec_date` | Ngày khuyến nghị |
| `Tỷ trọng` | `weight_pct` | Tỷ trọng mã theo % NAV |
| `Luận điểm` | `thesis` | Tab Luận điểm và ngữ cảnh Khuyến nghị hành động |

Khóa duy nhất trong database là `ticker + book`. Một mã có thể xuất hiện ở cả hai danh mục.

**Ngành trong danh mục** chỉ cộng các dòng có `weight_pct > 0`, sau đó chuẩn hóa tổng các ngành thành 100%. Nếu thẻ trống, kiểm tra cả `Ngành` và `Tỷ trọng`.

### 6.2 Sheet `Transaction Log`

| Cột Google Sheet | Trường chuẩn | Ý nghĩa |
|---|---|---|
| `Ngày` | `date` | Ngày giao dịch |
| `Mã CK` | `ticker` | Mã cổ phiếu |
| `Hành động` | `action` | Mua/bán/điều chỉnh |
| `Giá` | `price` | Giá thực hiện |
| `Ghi chú` | `note` | Nội dung bổ sung |

Đường đi: `Transaction Log` → `portfolio.xlsx/TRANSACTIONS` → `transactions` → `dashboard.portfolio.history`.

### 6.3 Giá cổ phiếu `PRICES`

| Trường | Ý nghĩa |
|---|---|
| `date`, `ticker` | Khóa theo ngày và mã |
| `open`, `high`, `low`, `close` | Giá mở/cao/thấp/đóng hoặc giá gần nhất trong phiên |
| `volume` | Khối lượng |

Giá được lấy tự động từ nguồn giá chính và nguồn dự phòng. `close` tạo **Giá hiện tại**; chênh lệch với bản ghi trước tạo mức tăng/giảm; `low` dùng kiểm tra cổ phiếu đã chạm vùng mua.

### 6.4 Sheet `SUMMARY` của Google Sheet Vận hành

| Cột | Hiển thị |
|---|---|
| `date` | Ngày chốt số liệu |
| `ytd_pct` | Hiệu suất danh mục từ đầu năm |
| `stock_pct` | Phân bổ Cổ phiếu |
| `cash_pct` | Phân bổ Tiền mặt |
| `other_pct` | Phân bổ Khác |

Đường đi: `Vận hành/SUMMARY` → `portfolio.xlsx/SUMMARY` → bảng `summary` → `dashboard.portfolio.ytd` và `dashboard.portfolio.alloc`.

Nếu `SUMMARY` không có dòng phù hợp, hệ thống lấy tổng `weight_pct` làm tỷ trọng cổ phiếu, phần còn lại làm tiền mặt và để trống YTD.

### 6.5 Quan điểm CTCK trong chi tiết cổ phiếu

Tab **Quan điểm CTCK** không lấy từ file Danh mục. Nó lấy các dòng trong `KHUYEN_NGHI_CP` có `Mã cổ phiếu` trùng mã đang xem, rồi chọn khuyến nghị mới nhất của từng CTCK theo ngày báo cáo.

## 7. Module Dòng tiền

Module này có thể tắt độc lập. Khi tắt, ba sheet sau không chặn các module khác đồng bộ.

### 7.1 `INVESTOR_FLOW`

| Cột | Ý nghĩa |
|---|---|
| `date` | Ngày giao dịch |
| `investor` | `Cá nhân`, `Tổ chức`, `Tự doanh` hoặc `Khối ngoại` |
| `net_value` | Giá trị mua/bán ròng theo tỷ đồng; mua ròng dương, bán ròng âm |

Hệ thống tính Hôm nay, MTD, YTD và lịch sử 5 phiên từ các dòng này.

### 7.2 `TICKER_FLOW`

`date`, `ticker`, `net_value`, `main_investor`, `note` tạo bảng dòng tiền theo mã tại phiên gần nhất.

### 7.3 `SECTOR_FLOW`

`date`, `sector`, `net_value`, `chg_pct`, `weight_pct` tạo bảng dòng tiền, thay đổi giao dịch và tỷ trọng giao dịch theo ngành.

Đường đi chung: Google Sheet Vận hành → `flows.xlsx` → ba bảng `*_flow` → `dashboard.flows`.

## 8. Module Quỹ đầu tư

Mọi sheet quỹ dùng `period` theo định dạng `MM/YYYY`. Người dùng có thể chọn một kỳ bất kỳ đã có trong dữ liệu; hệ thống mặc định kỳ mới nhất.

### 8.1 `FUND SUMMARY`

| Cột | Ý nghĩa |
|---|---|
| `period` | Kỳ báo cáo |
| `fund_code` | Mã quỹ |
| `fund_name` | Tên quỹ |
| `nav_bn` | NAV, đơn vị tỷ đồng sau chuẩn hóa |
| `ytd_pct` | Hiệu suất từ đầu năm của quỹ |

### 8.2 `ASSET ALLOCATION`

`period`, `fund_code`, `asset_type`, `weight_pct` tạo tỷ trọng tài sản từng quỹ. `asset_type` nên dùng `Cổ phiếu`, `Tiền mặt`, `Trái phiếu` hoặc `Khác`.

Các chỉ số **Tỷ trọng cổ phiếu** và **Tiền mặt** của toàn thị trường quỹ là bình quân gia quyền theo NAV, không phải trung bình cộng.

### 8.3 `INDUSTRY`

`period`, `fund_code`, `industry`, `weight_pct` tạo phân bổ ngành. Giao diện tổng hợp từng ngành theo NAV của quỹ.

### 8.4 `TOP HOLDINGS`

`period`, `fund_code`, `ticker`, `weight_pct` tạo danh sách cổ phiếu nắm giữ lớn. Giao diện tổng hợp và lấy tối đa 10 mã lớn nhất.

Đường đi: Google Sheet Quỹ → `funds.xlsx` → bốn bảng quỹ → `dashboard.funds.periods[]`. Mỗi phần tử trong `periods` là một ảnh chụp hoàn chỉnh của một kỳ.

## 9. Module Báo cáo CTCK

### 9.1 `BAO_CAO_CTCK`

| Cột Google Sheet | Trường chuẩn | Ý nghĩa |
|---|---|---|
| `ID` | `id` | Mã duy nhất của báo cáo; dùng nối ba sheet con |
| `CTCK` | `broker` | Công ty chứng khoán |
| `Ngày` | `date` | Ngày báo cáo |
| `Loại` | `type` | Chiến lược/Vĩ mô/Ngành/Doanh nghiệp |
| `Tiêu đề` | `title` | Tên báo cáo |
| `Quan điểm` | `stance` | Tích cực/Trung lập/Thận trọng/Tiêu cực |
| `Target VN-Index` | `vn_target` | Mục tiêu chỉ số |
| `Tầm nhìn` | `horizon` | Khoảng thời gian của nhận định |
| `Tóm tắt` | `summary` | Nội dung tóm tắt |
| `Nguồn` | `source` | Link hoặc tên nguồn |

### 9.2 `KHUYEN_NGHI_CP`

| Cột | Ý nghĩa |
|---|---|
| `ID báo cáo` | Phải trùng `ID` trong `BAO_CAO_CTCK` |
| `Mã cổ phiếu` | Mã được khuyến nghị |
| `Khuyến nghị` | MUA/KHẢ QUAN/TRUNG LẬP/KÉM KHẢ QUAN/BÁN |
| `Target` | Giá mục tiêu, đơn vị nghìn đồng |

### 9.3 `QUAN_DIEM_NGANH`

`ID báo cáo`, `Ngành`, `View`. `View = OW` nghĩa là tăng tỷ trọng; `UW` nghĩa là giảm tỷ trọng.

### 9.4 `RUI_RO`

`ID báo cáo`, `Chủ đề rủi ro`, `Mức độ`. Mức độ dùng `1` thấp, `2` trung bình, `3` cao.

Đường đi: Google Sheet Báo cáo → `reports.xlsx` → bốn bảng `report*` → `dashboard.reports[]`.

Báo cáo tạo hoặc sửa trực tiếp trên web đi qua `/api/reports` và hàng đợi `data/inbox/report-jobs.jsonl`, sau đó được gộp vào cùng cấu trúc. Đồng bộ Báo cáo dùng khóa ID để không làm mất báo cáo đã tạo trên web.

## 10. Module Khuyến nghị hành động

Module này có hai nguồn:

### 10.1 Theo Danh mục

- Mã, hành động, vùng giá, giá hiện tại, ngành và luận điểm lấy từ `POSITIONS` + `PRICES`.
- Chỉ các trạng thái `MUA`, `TĂNG TỶ TRỌNG`, `GIẢM TỶ TRỌNG` được đưa vào danh sách hành động tự động.
- `Luận điểm` trở thành **Ngữ cảnh**.
- Trạng thái mặc định là **Chờ điều kiện giá** khi giá thấp hơn cận dưới vùng mua; trường hợp khác là **Cần xử lý**.

### 10.2 Khuyến nghị khai báo chủ động

Khuyến nghị do người dùng thêm trên web không ghi vào Google Sheets. Nó được lưu trong `data/state/workspace-state.json`, nhóm `actions`, qua `/api/actions`.

Các trường gồm: mã, hành động, ngành, giá tham chiếu, vùng giá, ngữ cảnh, trạng thái, khối lượng dự kiến, khối lượng đã thực hiện, hạn xử lý và ghi chú.

Trạng thái của cả hành động tự động lẫn thủ công cũng lưu tại `workspace-state.json` để không bị mất khi dựng lại dashboard.

## 11. Module Trung tâm tín hiệu

Tín hiệu được tính trên web từ hai nhóm dữ liệu:

- Danh mục: giá, vùng mua, target, vùng vi phạm và trạng thái.
- Báo cáo CTCK: khuyến nghị mới nhất của từng CTCK cho từng mã.

Quy tắc danh mục:

| Tín hiệu | Điều kiện |
|---|---|
| Cần xử lý | `price <= stop` |
| Sát vùng vi phạm | `price <= stop × 1.03` |
| Về vùng mua | `low` nằm trong `[buy_lo, buy_hi]` và trạng thái là MUA/THEO DÕI |
| Đạt target | `price >= target` |

Nếu không có cảnh báo rủi ro, hệ thống dùng tỷ lệ CTCK đánh giá MUA/KHẢ QUAN để gợi ý. Trạng thái Mới/Theo dõi/Đã bỏ qua được lưu trong `data/state/workspace-state.json`, nhóm `signals`.

## 12. Module Cảnh báo giá

Cấu hình cảnh báo do người dùng tạo trên web và lưu tại `data/state/price-alerts.json`; không nằm trong Google Sheets.

| Trường cảnh báo | Nguồn / ý nghĩa |
|---|---|
| Mã | Người dùng nhập; hệ thống bổ sung mã vào lượt cập nhật giá |
| Điều kiện | Giá bằng/vượt/lùi xuống hoặc nằm trong vùng |
| Giá thấp, giá cao | Một mức giá hoặc hai cận vùng |
| Hướng vùng | Vùng mua đi xuống, vùng bán đi lên, hoặc mặc định nằm trong vùng |
| Nguồn cảnh báo | Cá nhân hoặc liên kết Khuyến nghị hành động |
| Người nhận | Chủ cảnh báo; quản trị viên có thể chọn nhiều người |
| Tần suất | Một lần, mỗi ngày có giá mới hoặc mỗi lần quay lại ngưỡng |
| Thời điểm/giờ sớm nhất | Giới hạn thời gian được gửi |
| Hạn cảnh báo | Ngày hết hiệu lực |
| Ghi chú | Lưu để xem trong chi tiết cảnh báo trên web; thông báo đẩy hiện chỉ gửi mã, điều kiện và giá kích hoạt |

Giá hiện tại và mức tăng/giảm lấy từ `portfolio.xlsx/PRICES` → bảng `prices` → `dashboard.prices`. API chính là `/api/price-alerts`.

## 13. Module Quản trị

### 13.1 Người dùng và phân quyền

- Tài khoản được lưu tại `data/state/auth/users.json`.
- Quyền xem/chỉnh sửa áp dụng riêng cho 10 module.
- Nhật ký thao tác lưu tại `data/logs/audit.jsonl`.

### 13.2 Vận hành dữ liệu

Trang vận hành đọc trạng thái quy trình, độ mới, cảnh báo chất lượng và nhật ký qua API. Các nút đồng bộ tương ứng:

| Nút | Nguồn được đọc |
|---|---|
| Danh mục | `PORTFOLIO_SHEET_ID` + giá |
| Vận hành | `OPERATIONS_SHEET_ID`; bỏ qua dòng tiền khi module đang tắt |
| Quỹ | `FUNDS_SHEET_ID` |
| Báo cáo CTCK | `REPORTS_SHEET_ID` |
| Đồng bộ tất cả | Tất cả nguồn đang bật + giá + dựng database + xuất dashboard |

### 13.3 Quản trị database theo module/ngày

| Nhóm quản trị | Các bảng |
|---|---|
| Bản tin | `VIEW`, `NEWS`, `EVENTS` |
| Danh mục | `POSITIONS`, `PRICES`, `TRANSACTIONS`, `SUMMARY` |
| Dòng tiền | `INVESTOR_FLOW`, `TICKER_FLOW`, `SECTOR_FLOW` |
| Quỹ đầu tư | `FUND_SUMMARY`, `ASSET_ALLOCATION`, `INDUSTRY`, `TOP_HOLDINGS` |
| Báo cáo CTCK | `REPORTS`, `REPORT_STOCKS`, `REPORT_SECTORS`, `REPORT_RISKS` |

Khi xóa theo ngày, hệ thống vừa xóa khỏi file chuẩn hóa vừa ghi khóa đã xóa vào `data/data-deletions.json`. Dấu xóa tiếp tục được áp dụng khi đồng bộ lại, nên bản ghi cũ không tự quay lại.

## 14. Quy tắc dữ liệu bắt buộc

- Số dùng dấu phẩy phân tách hàng nghìn và dấu chấm cho phần thập phân, ví dụ `1,234.56`.
- Ngày nên dùng `YYYY-MM-DD`; kỳ quỹ dùng `MM/YYYY`.
- Không chèn thêm tiêu đề khác phía trên bảng quá 15 dòng.
- Không đổi tên sheet hoặc tiêu đề cột nếu chưa cập nhật ánh xạ trong `pipeline/config.py`.
- `weight_pct`, `ytd_pct`, `chg_pct` phải là số, không nhập mô tả bằng chữ trong cùng ô.
- Khóa của mỗi bảng phải duy nhất. Ví dụ: báo cáo theo `ID`, danh mục theo `Mã CK + loại danh mục`, quỹ theo `period + fund_code`.
- Các sheet con Báo cáo phải dùng `ID báo cáo` đã tồn tại trong `BAO_CAO_CTCK`.
- Mỗi quỹ trong một kỳ nên có tổng `ASSET ALLOCATION` xấp xỉ 100%.
- Để nội dung đánh số `1.`, `2.`, `3.` tự xuống dòng, nhập mỗi đầu mục trên một dòng riêng trong ô Google Sheets.

## 15. Cách xác định nơi cần sửa

| Hiện tượng | Nơi kiểm tra đầu tiên |
|---|---|
| Ngành trong danh mục trống | `DM cơ bản`/`DM lướt sóng`: cột `Ngành`, `Tỷ trọng` |
| Phân bổ tài sản danh mục sai | Vận hành `SUMMARY`: `stock_pct`, `cash_pct`, `other_pct` |
| Giá hoặc % tăng giảm cũ | `portfolio.xlsx/PRICES` và trạng thái lượt cập nhật giá |
| Luận điểm cổ phiếu sai | Sheet danh mục: cột `Luận điểm` |
| Quan điểm CTCK của mã sai | `KHUYEN_NGHI_CP` và ngày của `BAO_CAO_CTCK` |
| Phân bổ tài sản quỹ sai | Quỹ `ASSET ALLOCATION` đúng kỳ và đúng `fund_code` |
| Ngành quỹ sai | Quỹ `INDUSTRY` |
| Top cổ phiếu quỹ sai | Quỹ `TOP HOLDINGS` |
| OW/UW sai | `QUAN_DIEM_NGANH`: cột `View` |
| Tin quá nhiều | Quản trị → Dữ liệu → Bản tin → Tin tức → chọn khoảng ngày để xóa |
| Hành động thủ công mất/sai | `data/state/workspace-state.json` và `/api/actions` |
| Cảnh báo giá mất/sai | `data/state/price-alerts.json` và `/api/price-alerts` |

## 16. Quy trình kiểm tra sau khi sửa dữ liệu

1. Sửa đúng Google Sheet nguồn theo bảng ánh xạ trên.
2. Trong Quản trị → Vận hành dữ liệu, chọn đúng nút đồng bộ nguồn; chỉ dùng Đồng bộ tất cả khi nhiều nguồn cùng thay đổi.
3. Chờ trạng thái hoàn tất và kiểm tra ngày dữ liệu của module.
4. Mở module, chọn đúng tab hoặc kỳ báo cáo.
5. Nếu dữ liệu không đúng, kiểm tra file chuẩn hóa tương ứng trong `data/input/`, sau đó kiểm tra bảng database và `data/dashboard.json`.
6. Không sửa `dashboard.json` để chữa tạm vì file này sẽ được tạo lại ở lượt tiếp theo.

Nguồn chuẩn kỹ thuật của tài liệu này là `pipeline/schema.py`, `pipeline/config.py`, `pipeline/export_json.py`, `pipeline/data_admin.py`, `server/index.js` và `web/index.html`.
