const assert = require('assert');
const {
  splitTopLevelComma,
  parseCreateTables,
  buildSchemaFromRows,
  parseDatabases,
  buildJdbcUrl,
  buildClickHouseHttpUrl,
  getDefaultAccountQuery,
  flattenMetadataRows
} = require('../schema_extractor.gs');

(function testSplitTopLevelComma() {
  const input = 'id INT, amount DECIMAL(10,2), CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id)';
  const parts = splitTopLevelComma(input);
  assert.strictEqual(parts.length, 3);
})();

(function testParseCreateTables() {
  const sql = `
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
  `;

  const tables = parseCreateTables(sql, 'sample.sql');
  assert.strictEqual(tables.length, 2);
  assert.strictEqual(tables[0].name, 'users');
  assert.ok(tables[1].relationships.some((r) => r.includes('FOREIGN KEY')));
})();

(function testBuildSchemaFromRows() {
  const rows = [
    ['a.sql', 'CREATE TABLE t1 (id INT PRIMARY KEY);'],
    ['b.sql', '']
  ];

  const schema = buildSchemaFromRows(rows);
  assert.strictEqual(schema.scanned_files, 1);
  assert.strictEqual(schema.tables.length, 1);
})();

(function testConfigHelpers() {
  assert.deepStrictEqual(parseDatabases('db1, db2 ,db3'), ['db1', 'db2', 'db3']);

  const mysqlUrl = buildJdbcUrl({ host: '127.0.0.1', port: '3306', driver: 'mysql' }, 'sales');
  assert.strictEqual(mysqlUrl, 'jdbc:mysql://127.0.0.1:3306/sales');

  const pgUrl = buildJdbcUrl({ host: 'db.local', port: '5432', driver: 'postgres' }, 'analytics');
  assert.strictEqual(pgUrl, 'jdbc:postgresql://db.local:5432/analytics');

  const chHttp = buildClickHouseHttpUrl({ host: 'ch.local', port: '8123', protocol: 'http' }, 'warehouse');
  assert.strictEqual(chHttp, 'http://ch.local:8123/?database=warehouse');

  assert.strictEqual(getDefaultAccountQuery('clickhouse'), 'SELECT currentUser() AS account');

  assert.throws(
    () => buildJdbcUrl({ host: 'ch.local', port: '8123', driver: 'clickhouse' }, 'warehouse'),
    /ClickHouse không dùng Jdbc/
  );
})();

(function testFlattenMetadataRows() {
  const schema = {
    tables: [
      {
        name: 'users',
        source_file: 'db.information_schema',
        relationships: ['FOREIGN KEY fk_users_role (role_id) REFERENCES roles(id)'],
        columns: [{ name: 'id', data_type: 'int', constraints: ['NOT NULL'] }]
      }
    ]
  };

  const rows = flattenMetadataRows(schema);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1][0], 'users');
  assert.strictEqual(rows[1][1], 'id');
})();

console.log('All tests passed.');
