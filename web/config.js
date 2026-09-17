// Cấu hình giao diện. Sửa file này khi deploy, không cần đụng index.html.
window.CALIDA_CONFIG = {
  DATA_URL: "data/dashboard.json", // đường dẫn file JSON do pipeline xuất
  API_BASE: "",                    // "" = cùng domain với server; hoặc "https://api.ten-mien.vn"
  REFRESH_MINUTES: 5               // tự tải lại dữ liệu khi pipeline chạy xong; 0 = tắt
};
