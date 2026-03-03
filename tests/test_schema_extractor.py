import unittest

from schema_extractor import (
    build_schema_from_sql_dir,
    parse_column_def,
    parse_create_tables,
    split_top_level_comma,
)
from pathlib import Path
import tempfile


class SchemaExtractorTests(unittest.TestCase):
    def test_split_top_level_comma(self):
        s = "id INT, amount DECIMAL(10,2), CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id)"
        self.assertEqual(len(split_top_level_comma(s)), 3)

    def test_parse_tables(self):
        sql = """
        CREATE TABLE users (
          id INT PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE TABLE orders (
          id INT,
          user_id INT,
          amount DECIMAL(10,2),
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
        """
        tables = parse_create_tables(sql, "sample.sql")
        self.assertEqual(len(tables), 2)
        self.assertEqual(tables[0].name, "users")
        self.assertTrue(any("FOREIGN KEY" in x for x in tables[1].relationships))

    def test_parse_column(self):
        col = parse_column_def("email VARCHAR(255) NOT NULL")
        self.assertIsNotNone(col)
        self.assertEqual(col.name, "email")
        self.assertEqual(col.data_type, "VARCHAR(255)")
        self.assertEqual(col.constraints, ["NOT NULL"])

    def test_build_schema_from_sql_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.sql").write_text("CREATE TABLE t1 (id INT PRIMARY KEY);", encoding="utf-8")
            (root / "x.txt").write_text("ignored", encoding="utf-8")
            schema = build_schema_from_sql_dir(root)
            self.assertEqual(schema.scanned_files, 1)
            self.assertEqual(len(schema.tables), 1)


if __name__ == "__main__":
    unittest.main()
