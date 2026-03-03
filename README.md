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
- `account_query` (để trống sẽ tự dùng default theo driver)

### Cấu hình ClickHouse

Ví dụ config:

- `host`: `127.0.0.1`
- `port`: `8123` (hoặc `8443` nếu SSL)
- `databases`: `default,analytics`
- `user`: `default`
- `pass`: `<password>`
- `driver`: `clickhouse`

JDBC URL sẽ tự dựng dạng:

`jdbc:clickhouse://<host>:<port>/<database>`

## 2) Nút hàm / menu để chạy

Khi mở sheet, menu **SQL Metadata Tools** sẽ xuất hiện với các lệnh:

1. `Tạo / cập nhật sheet config`
2. `Lấy dữ liệu account`
3. `Lấy schema -> tạo JSON metadata`
4. `Cập nhật metadata từ JSON`
5. `Lưu metadata JSON vào file`

> Có thể gán các hàm này vào button (Insert → Drawing → Assign script).

## 3) Output sheets

- `account_output!A1`: JSON account lấy từ DB
- `schema_output!A1`: JSON metadata schema
- `metadata_tables`: bảng metadata dạng phẳng để filter/tra cứu
- `json_import!A1`: nơi dán JSON để chạy `updateMetadataFromJson()`

## 4) Lưu kết quả vào file JSON

Chạy `saveMetadataJsonToDrive()` để tạo file:

- Tên file: `schema_metadata_<timestamp>.json`
- Vị trí: Google Drive của tài khoản chạy script

## 5) Parse SQL thủ công từ sheet `sql_input`

Nếu không kết nối DB, bạn vẫn có thể nhập SQL vào `sql_input`:

- Cột A: `source_file`
- Cột B: `sql_text` (`CREATE TABLE ...;`)

và chạy `extractSchemaToSheet()` để sinh metadata JSON.

## Lưu ý ClickHouse

- Hàm lấy schema DB dùng `system.tables` và `system.columns`.
- `table_constraints` sẽ lưu thông tin `ENGINE ...` của bảng ClickHouse.
- `relationships` với ClickHouse mặc định để rỗng vì thường không dùng FK như OLTP DB.

## Test local parser/helpers (Node.js)

```bash
node tests/test_schema_extractor_gs.js
```

> Test local chỉ kiểm tra hàm JS thuần. Các hàm `SpreadsheetApp`, `Jdbc`, `DriveApp` cần chạy trong Apps Script runtime.
