# SQL Metadata Tools (Python)

Đã chuyển toàn bộ code sang **Python**.

## Chức năng

- Parse `CREATE TABLE` từ file SQL
- Xuất metadata JSON
- Lấy metadata từ ClickHouse qua HTTP API

## Cài đặt

Python 3.10+.

## 1) Quét SQL file -> JSON

```bash
python3 schema_extractor.py from-sql-dir \
  --input-dir data \
  --output schema_output/detailed_schema.json
```

## 2) Lấy schema từ ClickHouse -> JSON

Dùng đúng config bạn đưa:

```bash
python3 schema_extractor.py from-clickhouse \
  --host "http://103.104.122.217:32015" \
  --databases "kfm_scm" \
  --user "scm_lam" \
  --pass "xukco1-roghaB-fuqfum" \
  --output schema_output/detailed_schema.json
```

> Nếu mạng cần VPN, hãy chạy lệnh Python ở máy đã kết nối VPN/WireGuard.

## Test

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
```
