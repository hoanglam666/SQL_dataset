#!/usr/bin/env python3
"""SQL metadata extractor (Python).

- Parse CREATE TABLE từ SQL text/file
- Xuất JSON metadata
- Hỗ trợ đọc schema/account từ ClickHouse HTTP API (tuỳ chọn)
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\"\[]?[\w.]+[`\"\]]?)\s*\((.*?)\)\s*;",
    re.IGNORECASE | re.DOTALL,
)
TABLE_CONSTRAINT_PREFIXES = ("PRIMARY KEY", "FOREIGN KEY", "CONSTRAINT", "UNIQUE", "CHECK")


@dataclass
class Column:
    name: str
    data_type: str
    constraints: list[str]


@dataclass
class Table:
    name: str
    source_file: str
    columns: list[Column]
    table_constraints: list[str]
    relationships: list[str]
    sample_data_examples: list[dict[str, Any]]
    business_logic_notes: list[str]


@dataclass
class SchemaOutput:
    scanned_files: int
    tables: list[Table]


def normalize_identifier(value: str) -> str:
    return value.strip().strip('`"[]')


def split_top_level_comma(body: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    depth = 0

    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")" and depth > 0:
            depth -= 1

        if ch == "," and depth == 0:
            item = "".join(current).strip()
            if item:
                parts.append(item)
            current = []
            continue
        current.append(ch)

    item = "".join(current).strip()
    if item:
        parts.append(item)
    return parts


def parse_column_def(raw: str) -> Column | None:
    cleaned = raw.strip().rstrip(",")
    if not cleaned:
        return None

    upper = cleaned.upper()
    if upper.startswith(TABLE_CONSTRAINT_PREFIXES):
        return None

    first_space = re.search(r"\s", cleaned)
    if not first_space:
        return None

    name = normalize_identifier(cleaned[: first_space.start()])
    remaining = cleaned[first_space.start() :].strip()
    tokens = remaining.split()

    constraint_starters = {
        "NOT",
        "NULL",
        "DEFAULT",
        "PRIMARY",
        "UNIQUE",
        "REFERENCES",
        "CHECK",
        "AUTO_INCREMENT",
        "GENERATED",
    }

    type_tokens: list[str] = []
    idx = 0
    while idx < len(tokens) and tokens[idx].upper() not in constraint_starters:
        type_tokens.append(tokens[idx])
        idx += 1

    constraint_text = " ".join(tokens[idx:]).strip()
    return Column(
        name=name,
        data_type=" ".join(type_tokens).strip() or "UNKNOWN",
        constraints=[constraint_text] if constraint_text else [],
    )


def parse_create_tables(sql_text: str, source_name: str) -> list[Table]:
    tables: list[Table] = []

    for match in CREATE_TABLE_RE.finditer(sql_text):
        table_name = normalize_identifier(match.group(1))
        body = match.group(2)

        columns: list[Column] = []
        table_constraints: list[str] = []
        relationships: list[str] = []

        for item in split_top_level_comma(body):
            normalized = " ".join(item.split())
            upper = normalized.upper()

            if upper.startswith(TABLE_CONSTRAINT_PREFIXES):
                table_constraints.append(normalized)
                if "FOREIGN KEY" in upper:
                    relationships.append(normalized)
                continue

            col = parse_column_def(item)
            if col:
                columns.append(col)

        tables.append(
            Table(
                name=table_name,
                source_file=source_name,
                columns=columns,
                table_constraints=table_constraints,
                relationships=relationships,
                sample_data_examples=[],
                business_logic_notes=[],
            )
        )

    return tables


def build_schema_from_sql_dir(input_dir: Path) -> SchemaOutput:
    files = sorted(path for path in input_dir.rglob("*.sql") if path.is_file())
    tables: list[Table] = []

    for sql_file in files:
        sql_text = sql_file.read_text(encoding="utf-8", errors="ignore")
        tables.extend(parse_create_tables(sql_text, str(sql_file.relative_to(input_dir))))

    return SchemaOutput(scanned_files=len(files), tables=tables)


def clickhouse_query_rows(base_url: str, database: str, query: str, user: str, password: str) -> list[dict[str, Any]]:
    base = base_url.rstrip("/")
    url = f"{base}/?database={urllib.parse.quote(database)}"
    payload = f"{query}\nFORMAT JSONEachRow".encode("utf-8")

    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "text/plain; charset=utf-8")
    if user:
        req.add_header("X-ClickHouse-User", user)
    if password:
        req.add_header("X-ClickHouse-Key", password)

    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="ignore")

    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def build_schema_from_clickhouse(base_url: str, databases: list[str], user: str, password: str) -> SchemaOutput:
    all_tables: list[Table] = []

    for database in databases:
        db_escaped = database.replace("'", "''")
        table_rows = clickhouse_query_rows(
            base_url,
            database,
            f"SELECT name AS table_name, engine_full FROM system.tables WHERE database = '{db_escaped}' ORDER BY name",
            user,
            password,
        )

        for tr in table_rows:
            table_name = tr["table_name"]
            tb_escaped = str(table_name).replace("'", "''")
            col_rows = clickhouse_query_rows(
                base_url,
                database,
                (
                    "SELECT name, type, default_kind, default_expression "
                    "FROM system.columns "
                    f"WHERE database = '{db_escaped}' "
                    f"AND table = '{tb_escaped}' ORDER BY position"
                ),
                user,
                password,
            )

            columns = [
                Column(
                    name=c["name"],
                    data_type=c["type"],
                    constraints=[f"DEFAULT {c['default_expression']}"]
                    if c.get("default_kind") and c.get("default_expression")
                    else [],
                )
                for c in col_rows
            ]

            all_tables.append(
                Table(
                    name=str(table_name),
                    source_file=f"{database}.clickhouse_http",
                    columns=columns,
                    table_constraints=[f"ENGINE {tr['engine_full']}"] if tr.get("engine_full") else [],
                    relationships=[],
                    sample_data_examples=[],
                    business_logic_notes=[],
                )
            )

    return SchemaOutput(scanned_files=len(databases), tables=all_tables)


def save_schema(schema: SchemaOutput, output_file: Path) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(asdict(schema), ensure_ascii=False, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SQL metadata extractor (Python)")
    sub = parser.add_subparsers(dest="command", required=True)

    sql_dir = sub.add_parser("from-sql-dir", help="Quét thư mục SQL và xuất metadata JSON")
    sql_dir.add_argument("--input-dir", default="data")
    sql_dir.add_argument("--output", default="schema_output/detailed_schema.json")

    ch = sub.add_parser("from-clickhouse", help="Lấy metadata từ ClickHouse HTTP API")
    ch.add_argument("--host", required=True, help="Ví dụ: http://103.104.122.217:32015")
    ch.add_argument("--databases", required=True, help="Ví dụ: kfm_scm,kdb")
    ch.add_argument("--user", required=True)
    ch.add_argument("--pass", dest="password", required=True)
    ch.add_argument("--output", default="schema_output/detailed_schema.json")

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.command == "from-sql-dir":
        schema = build_schema_from_sql_dir(Path(args.input_dir))
        save_schema(schema, Path(args.output))
        print(f"Đã quét {schema.scanned_files} file SQL, tìm thấy {len(schema.tables)} bảng.")
        return

    if args.command == "from-clickhouse":
        databases = [item.strip() for item in args.databases.split(",") if item.strip()]
        if not databases:
            raise SystemExit("--databases không hợp lệ")
        schema = build_schema_from_clickhouse(args.host, databases, args.user, args.password)
        save_schema(schema, Path(args.output))
        print(f"Đã quét {schema.scanned_files} database, tìm thấy {len(schema.tables)} bảng.")


if __name__ == "__main__":
    main()
