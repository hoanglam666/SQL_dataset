# SQL Metadata Tools (Google Sheets Apps Script)

Tool này chạy bằng **Google Apps Script (`.gs`)** trong Google Sheets để:

- Lấy thông tin account từ database
- Lấy schema từ DB và sinh JSON metadata
- Cập nhật metadata từ JSON
- Lưu JSON metadata ra file `.json` trên Google Drive

## 1) Sheet config (khai báo kết nối DB)

Chạy hàm `setupConfigSheet()` hoặc mở file sheet để menu tự tạo. Sheet `config` có các key:

- `host`
- `port`
- `databases` (nhiều DB, cách nhau bởi dấu phẩy)
- `user`
- `pass`
- `driver` (`mysql`, `postgres`, `clickhouse`)
- `protocol` (`http` hoặc `https`, dùng cho ClickHouse)
- `endpoint` (tuỳ chọn, URL ClickHouse đầy đủ, ví dụ `https://proxy.company.com:8443`)
- `account_query` (để trống sẽ tự dùng default theo driver)

## 2) Cấu hình ClickHouse (khắc phục lỗi unsupported JDBC protocol)

Apps Script `Jdbc` **không hỗ trợ** `jdbc:clickhouse://...`, vì vậy tool này dùng **ClickHouse HTTP API** (`UrlFetchApp`) cho driver `clickhouse`.

Ví dụ config:

- `host`: `103.104.xxx.xxx`
- `port`: `8123` (hoặc `8443` nếu SSL)
- `databases`: `kfm_scm,kdb`
- `user`: `scm_iam`
- `pass`: `***`
- `driver`: `clickhouse`
- `protocol`: `http`


## 3) Xử lý lỗi `Address unavailable`

Nếu gặp lỗi như:

`Exception: Address unavailable: http://103.104.122.217:32015/?database=kfm_scm`

thì thường là do:

- Đang dùng cổng không phải HTTP API của ClickHouse (32015 thường là native TCP/private gateway)
- Host/port chỉ mở nội bộ và Google Apps Script không truy cập được
- Firewall/security group chặn IP egress của Google

Cách xử lý:

1. Dùng cổng HTTP ClickHouse: `8123` hoặc HTTPS `8443`.
2. Hoặc khai báo `endpoint` trỏ tới reverse proxy/public endpoint.
3. Đảm bảo firewall cho phép truy cập từ Google Apps Script.

## 4) Nút hàm / menu để chạy

Khi mở sheet, menu **SQL Metadata Tools** sẽ xuất hiện với các lệnh:

1. `Tạo / cập nhật sheet config`
2. `Lấy dữ liệu account`
3. `Lấy schema -> tạo JSON metadata`
4. `Cập nhật metadata từ JSON`
5. `Lưu metadata JSON vào file`

> Có thể gán các hàm này vào button (Insert → Drawing → Assign script).

## 5) Output sheets

- `account_output!A1`: JSON account lấy từ DB
- `schema_output!A1`: JSON metadata schema
- `metadata_tables`: bảng metadata dạng phẳng để filter/tra cứu
- `json_import!A1`: nơi dán JSON để chạy `updateMetadataFromJson()`

## 6) Lưu kết quả vào file JSON

Chạy `saveMetadataJsonToDrive()` để tạo file:

- Tên file: `schema_metadata_<timestamp>.json`
- Vị trí: Google Drive của tài khoản chạy script

## 7) Parse SQL thủ công từ sheet `sql_input`

Nếu không kết nối DB, bạn vẫn có thể nhập SQL vào `sql_input`:

- Cột A: `source_file`
- Cột B: `sql_text` (`CREATE TABLE ...;`)

và chạy `extractSchemaToSheet()` để sinh metadata JSON.

## Test local parser/helpers (Node.js)

```bash
node tests/test_schema_extractor_gs.js
```

> Test local chỉ kiểm tra hàm JS thuần. Các hàm `SpreadsheetApp`, `Jdbc`, `DriveApp`, `UrlFetchApp` cần chạy trong Apps Script runtime.
