/**
 * SQL Schema Extractor for Google Sheets (Apps Script).
 */

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[\w.]+[`"\]]?)\s*\(([^]*?)\)\s*;/gi;
const TABLE_CONSTRAINT_PREFIXES = ['PRIMARY KEY', 'FOREIGN KEY', 'CONSTRAINT', 'UNIQUE', 'CHECK'];
const CONFIG_SHEET = 'config';
const SQL_INPUT_SHEET = 'sql_input';
const SCHEMA_OUTPUT_SHEET = 'schema_output';
const ACCOUNT_SHEET = 'account_output';
const METADATA_SHEET = 'metadata_tables';
const JSON_IMPORT_SHEET = 'json_import';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SQL Metadata Tools')
    .addItem('1) Tạo / cập nhật sheet config', 'setupConfigSheet')
    .addSeparator()
    .addItem('2) Lấy dữ liệu account', 'getAccountData')
    .addItem('3) Lấy schema -> tạo JSON metadata', 'getSchemaMetadataFromDatabase')
    .addItem('4) Cập nhật metadata từ JSON', 'updateMetadataFromJson')
    .addItem('5) Lưu metadata JSON vào file', 'saveMetadataJsonToDrive')
    .addToUi();
}

function setupConfigSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_SHEET) || ss.insertSheet(CONFIG_SHEET);

  const headers = [
    ['key', 'value', 'note'],
    ['host', '127.0.0.1', 'DB host'],
    ['port', '8123', 'MySQL=3306, Postgres=5432, ClickHouse HTTP=8123/8443'],
    ['databases', 'default', 'Danh sách DB, phân tách bằng dấu phẩy'],
    ['user', 'default', 'DB user'],
    ['pass', '', 'DB password'],
    ['driver', 'clickhouse', 'mysql | postgres | clickhouse'],
    ['protocol', 'http', 'http | https (cho clickhouse HTTP API)'],
    ['endpoint', '', 'Tuỳ chọn: URL ClickHouse đầy đủ, ví dụ https://host:8443'],
    ['account_query', '', 'Để trống để dùng default theo driver']
  ];

  sheet.clear();
  sheet.getRange(1, 1, headers.length, headers[0].length).setValues(headers);
  sheet.autoResizeColumns(1, 3);
}

function normalizeIdentifier(value) {
  return String(value || '').trim().replace(/^[`"\[]|[`"\]]$/g, '');
}

function splitTopLevelComma(body) {
  const parts = [];
  let current = '';
  let depth = 0;

  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')' && depth > 0) depth -= 1;
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseColumnDef(raw) {
  const cleaned = String(raw || '').trim().replace(/,$/, '');
  if (!cleaned) return null;

  const upper = cleaned.toUpperCase();
  if (TABLE_CONSTRAINT_PREFIXES.some((prefix) => upper.startsWith(prefix))) return null;

  const firstSpace = cleaned.search(/\s/);
  if (firstSpace <= 0) return null;

  const name = normalizeIdentifier(cleaned.slice(0, firstSpace));
  const remaining = cleaned.slice(firstSpace).trim();
  const tokens = remaining.split(/\s+/);
  const constraintStarters = new Set(['NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'AUTO_INCREMENT', 'GENERATED']);

  const typeTokens = [];
  let idx = 0;
  while (idx < tokens.length && !constraintStarters.has(tokens[idx].toUpperCase())) {
    typeTokens.push(tokens[idx]);
    idx += 1;
  }

  const constraintText = tokens.slice(idx).join(' ').trim();
  return {
    name,
    data_type: typeTokens.join(' ').trim() || 'UNKNOWN',
    constraints: constraintText ? [constraintText] : []
  };
}

function parseCreateTables(sqlText, sourceName) {
  const tables = [];
  const sql = String(sqlText || '');
  let match;

  while ((match = CREATE_TABLE_RE.exec(sql)) !== null) {
    const tableName = normalizeIdentifier(match[1]);
    const body = match[2];
    const columns = [];
    const tableConstraints = [];
    const relationships = [];

    splitTopLevelComma(body).forEach((item) => {
      const normalized = item.replace(/\s+/g, ' ').trim();
      const upper = normalized.toUpperCase();

      if (TABLE_CONSTRAINT_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
        tableConstraints.push(normalized);
        if (upper.includes('FOREIGN KEY')) relationships.push(normalized);
        return;
      }

      const column = parseColumnDef(item);
      if (column) columns.push(column);
    });

    tables.push({
      name: tableName,
      source_file: sourceName,
      columns,
      table_constraints: tableConstraints,
      relationships,
      sample_data_examples: [],
      business_logic_notes: []
    });
  }

  return tables;
}

function buildSchemaFromRows(rows) {
  const tables = [];
  let scannedFiles = 0;
  rows.forEach((row, idx) => {
    const sourceFile = row[0] || `row_${idx + 2}`;
    const sqlText = row[1] || '';
    if (!sqlText.trim()) return;
    scannedFiles += 1;
    tables.push(...parseCreateTables(sqlText, sourceFile));
  });
  return { scanned_files: scannedFiles, tables };
}

function parseDatabases(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function getConfigMap() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) throw new Error("Thiếu sheet 'config'. Hãy chạy setupConfigSheet() trước.");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("Sheet 'config' chưa có dữ liệu.");

  const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const map = {};
  rows.forEach(([k, v]) => {
    if (k) map[String(k).trim()] = String(v || '').trim();
  });
  return map;
}

function getDriver(config) {
  return String(config.driver || 'mysql').toLowerCase().trim();
}

function buildJdbcUrl(config, databaseName) {
  const host = config.host;
  if (!host) throw new Error("Config thiếu 'host'.");

  const driver = getDriver(config);
  if (driver === 'postgres') {
    return `jdbc:postgresql://${host}:${config.port || '5432'}/${databaseName}`;
  }
  if (driver === 'mysql') {
    return `jdbc:mysql://${host}:${config.port || '3306'}/${databaseName}`;
  }
  throw new Error('ClickHouse không dùng Jdbc service của Apps Script. Dùng HTTP API.');
}

function buildClickHouseHttpUrl(config, databaseName) {
  const endpoint = String(config.endpoint || '').trim();
  if (endpoint) {
    const clean = endpoint.replace(/\/$/, '');
    return `${clean}/?database=${encodeURIComponent(databaseName)}`;
  }

  const host = config.host;
  if (!host) throw new Error("Config thiếu 'host'.");
  const protocol = String(config.protocol || 'http').toLowerCase();
  const port = config.port || (protocol === 'https' ? '8443' : '8123');
  return `${protocol}://${host}:${port}/?database=${encodeURIComponent(databaseName)}`;
}

function validateClickHouseConfig(config) {
  const protocol = String(config.protocol || 'http').toLowerCase();
  const port = String(config.port || (protocol === 'https' ? '8443' : '8123'));

  if (port !== '8123' && port !== '8443') {
    throw new Error(
      `Port ClickHouse hiện tại là ${port}. Apps Script chỉ gọi được ClickHouse qua HTTP API (thường 8123/8443). ` +
      'Port 32015 thường là native TCP hoặc private gateway nên Google Apps Script không truy cập được. ' +
      'Hãy mở HTTP endpoint công khai hoặc điền config.endpoint (vd: https://<host>:8443).'
    );
  }
}

function getDefaultAccountQuery(driver) {
  if (driver === 'clickhouse') return 'SELECT currentUser() AS account';
  return 'SELECT CURRENT_USER() AS account';
}

function openJdbcConnection(config, databaseName) {
  const url = buildJdbcUrl(config, databaseName);
  return Jdbc.getConnection(url, config.user, config.pass);
}

function toA1JsonSheet(sheetName, payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  sheet.clear();
  sheet.getRange(1, 1).setValue(JSON.stringify(payload, null, 2));
  sheet.autoResizeColumn(1);
}

function readSingleValueQuery(conn, sql) {
  const stmt = conn.createStatement();
  const rs = stmt.executeQuery(sql);
  let value = '';
  if (rs.next()) value = String(rs.getString(1));
  rs.close();
  stmt.close();
  return value;
}

function clickhouseQueryRows(config, databaseName, sql) {
  validateClickHouseConfig(config);
  const url = buildClickHouseHttpUrl(config, databaseName);
  const query = `${sql}
FORMAT JSONEachRow`;

  const options = {
    method: 'post',
    payload: query,
    muteHttpExceptions: true,
    contentType: 'text/plain; charset=utf-8',
    headers: {}
  };

  if (config.user) {
    options.headers['X-ClickHouse-User'] = config.user;
  }
  if (config.pass) {
    options.headers['X-ClickHouse-Key'] = config.pass;
  }

  let resp;
  try {
    resp = UrlFetchApp.fetch(url, options);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.includes('Address unavailable')) {
      throw new Error(
        `Không truy cập được ClickHouse endpoint: ${url}. ` +
        'Nguyên nhân thường gặp: host/port chỉ mở nội bộ, firewall chặn Google Apps Script, hoặc đang dùng native TCP thay vì HTTP. ' +
        'Hãy dùng cổng 8123/8443 hoặc endpoint HTTPS public qua reverse proxy/VPN bridge.'
      );
    }
    throw err;
  }

  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error(`ClickHouse HTTP query lỗi (${code}) tại ${url}: ${text}`);
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getAccountData() {
  const config = getConfigMap();
  const dbs = parseDatabases(config.databases);
  if (!dbs.length) throw new Error("Config 'databases' rỗng.");

  const driver = getDriver(config);
  const db = dbs[0];
  const query = config.account_query || getDefaultAccountQuery(driver);
  let account = '';

  if (driver === 'clickhouse') {
    const rows = clickhouseQueryRows(config, db, query);
    account = rows.length ? String(Object.values(rows[0])[0] || '') : '';
  } else {
    const conn = openJdbcConnection(config, db);
    try {
      account = readSingleValueQuery(conn, query);
    } finally {
      conn.close();
    }
  }

  toA1JsonSheet(ACCOUNT_SHEET, {
    host: config.host,
    driver,
    database: db,
    account,
    fetched_at: new Date().toISOString()
  });
  SpreadsheetApp.getActive().toast('Đã lấy dữ liệu account thành công.');
}

function fetchColumnsForTableDefault(conn, schemaName, tableName) {
  const sql = `
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ?
    ORDER BY ordinal_position
  `;
  const stmt = conn.prepareStatement(sql);
  stmt.setString(1, schemaName);
  stmt.setString(2, tableName);
  const rs = stmt.executeQuery();

  const columns = [];
  while (rs.next()) {
    const constraints = [];
    if (String(rs.getString('is_nullable')).toUpperCase() === 'NO') constraints.push('NOT NULL');
    if (rs.getString('column_default') !== null) constraints.push(`DEFAULT ${rs.getString('column_default')}`);
    columns.push({ name: rs.getString('column_name'), data_type: rs.getString('data_type'), constraints });
  }

  rs.close();
  stmt.close();
  return columns;
}

function fetchConstraintsForTableDefault(conn, schemaName, tableName) {
  const sql = `
    SELECT tc.constraint_name, tc.constraint_type, kcu.column_name,
           ccu.table_name AS referenced_table_name, ccu.column_name AS referenced_column_name
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.table_schema = ? AND tc.table_name = ?
  `;

  const stmt = conn.prepareStatement(sql);
  stmt.setString(1, schemaName);
  stmt.setString(2, tableName);
  const rs = stmt.executeQuery();

  const tableConstraints = [];
  const relationships = [];
  while (rs.next()) {
    let line = `${rs.getString('constraint_type')} ${rs.getString('constraint_name')}`;
    if (rs.getString('column_name')) line += ` (${rs.getString('column_name')})`;
    if (rs.getString('referenced_table_name') && rs.getString('referenced_column_name')) {
      line += ` REFERENCES ${rs.getString('referenced_table_name')}(${rs.getString('referenced_column_name')})`;
    }
    tableConstraints.push(line);
    if (String(rs.getString('constraint_type')).toUpperCase() === 'FOREIGN KEY') relationships.push(line);
  }

  rs.close();
  stmt.close();
  return { tableConstraints, relationships };
}

function fetchTablesForDatabaseViaClickHouseHttp(config, databaseName) {
  const tableRows = clickhouseQueryRows(
    config,
    databaseName,
    `SELECT name AS table_name, engine_full FROM system.tables WHERE database = '${databaseName.replace(/'/g, "''")}' ORDER BY name`
  );

  const tables = [];
  tableRows.forEach((row) => {
    const tableName = row.table_name;
    const colRows = clickhouseQueryRows(
      config,
      databaseName,
      `SELECT name, type, default_kind, default_expression
       FROM system.columns
       WHERE database = '${databaseName.replace(/'/g, "''")}' AND table = '${String(tableName).replace(/'/g, "''")}'
       ORDER BY position`
    );

    const columns = colRows.map((c) => {
      const constraints = [];
      if (c.default_kind && c.default_expression) constraints.push(`DEFAULT ${c.default_expression}`);
      return {
        name: c.name,
        data_type: c.type,
        constraints
      };
    });

    const tableConstraints = [];
    if (row.engine_full) tableConstraints.push(`ENGINE ${row.engine_full}`);

    tables.push({
      name: tableName,
      source_file: `${databaseName}.clickhouse_http`,
      columns,
      table_constraints: tableConstraints,
      relationships: [],
      sample_data_examples: [],
      business_logic_notes: []
    });
  });

  return tables;
}

function fetchTablesForDatabaseViaJdbc(config, databaseName) {
  const conn = openJdbcConnection(config, databaseName);

  try {
    const tableSql = `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`;
    const stmt = conn.prepareStatement(tableSql);
    stmt.setString(1, databaseName);
    const rs = stmt.executeQuery();

    const tables = [];
    while (rs.next()) {
      const tableName = rs.getString('table_name');
      const columns = fetchColumnsForTableDefault(conn, databaseName, tableName);
      const constraintsData = fetchConstraintsForTableDefault(conn, databaseName, tableName);

      tables.push({
        name: tableName,
        source_file: `${databaseName}.jdbc`,
        columns,
        table_constraints: constraintsData.tableConstraints,
        relationships: constraintsData.relationships,
        sample_data_examples: [],
        business_logic_notes: []
      });
    }

    rs.close();
    stmt.close();
    return tables;
  } finally {
    conn.close();
  }
}

function fetchTablesForDatabase(config, databaseName) {
  const driver = getDriver(config);
  if (driver === 'clickhouse') {
    return fetchTablesForDatabaseViaClickHouseHttp(config, databaseName);
  }
  return fetchTablesForDatabaseViaJdbc(config, databaseName);
}

function flattenMetadataRows(schema) {
  const rows = [['table_name', 'column_name', 'data_type', 'constraints', 'relationships_count', 'source_file']];

  schema.tables.forEach((table) => {
    if (!table.columns.length) {
      rows.push([table.name, '', '', '', table.relationships.length, table.source_file]);
      return;
    }

    table.columns.forEach((col) => {
      rows.push([
        table.name,
        col.name,
        col.data_type,
        (col.constraints || []).join(' | '),
        table.relationships.length,
        table.source_file
      ]);
    });
  });
  return rows;
}

function writeMetadataTableSheet(schema) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(METADATA_SHEET) || ss.insertSheet(METADATA_SHEET);
  const rows = flattenMetadataRows(schema);
  sheet.clear();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.autoResizeColumns(1, rows[0].length);
}

function getSchemaMetadataFromDatabase() {
  const config = getConfigMap();
  const dbs = parseDatabases(config.databases);
  if (!dbs.length) throw new Error("Config 'databases' rỗng.");

  const allTables = [];
  dbs.forEach((db) => allTables.push(...fetchTablesForDatabase(config, db)));

  const payload = { scanned_files: dbs.length, tables: allTables };
  toA1JsonSheet(SCHEMA_OUTPUT_SHEET, payload);
  writeMetadataTableSheet(payload);
  SpreadsheetApp.getActive().toast(`Đã tạo metadata từ ${dbs.length} database.`);
}

function extractSchemaToSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const inputSheet = ss.getSheetByName(SQL_INPUT_SHEET);
  if (!inputSheet) throw new Error("Không tìm thấy sheet 'sql_input'. Hãy tạo sheet với cột A=source_file, B=sql_text.");

  const outputSheet = ss.getSheetByName(SCHEMA_OUTPUT_SHEET) || ss.insertSheet(SCHEMA_OUTPUT_SHEET);
  const lastRow = inputSheet.getLastRow();
  if (lastRow < 2) throw new Error("Sheet 'sql_input' chưa có dữ liệu. Cần ít nhất 1 dòng SQL (từ dòng 2).");

  const rows = inputSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const schema = buildSchemaFromRows(rows);
  outputSheet.clear();
  outputSheet.getRange(1, 1).setValue(JSON.stringify(schema, null, 2));
  outputSheet.autoResizeColumn(1);
  writeMetadataTableSheet(schema);
}

function readSchemaJsonFromOutputSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SCHEMA_OUTPUT_SHEET);
  if (!sheet) throw new Error("Không tìm thấy sheet 'schema_output'.");

  const text = String(sheet.getRange(1, 1).getValue() || '').trim();
  if (!text) throw new Error("sheet 'schema_output' ô A1 đang rỗng.");
  return JSON.parse(text);
}

function saveMetadataJsonToDrive() {
  const schema = readSchemaJsonFromOutputSheet();
  const fileName = `schema_metadata_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const file = DriveApp.createFile(fileName, JSON.stringify(schema, null, 2), MimeType.PLAIN_TEXT);
  SpreadsheetApp.getActive().toast(`Đã lưu JSON file: ${file.getName()}`);
}

function updateMetadataFromJson() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const importSheet = ss.getSheetByName(JSON_IMPORT_SHEET) || ss.insertSheet(JSON_IMPORT_SHEET);

  let text = String(importSheet.getRange(1, 1).getValue() || '').trim();
  if (!text) {
    text = String((ss.getSheetByName(SCHEMA_OUTPUT_SHEET) || ss.insertSheet(SCHEMA_OUTPUT_SHEET)).getRange(1, 1).getValue() || '').trim();
  }
  if (!text) throw new Error("Không có JSON để cập nhật. Hãy nhập JSON vào sheet 'json_import' ô A1 hoặc tạo ở 'schema_output'.");

  const schema = JSON.parse(text);
  writeMetadataTableSheet(schema);
  SpreadsheetApp.getActive().toast('Đã cập nhật metadata từ JSON.');
}

if (typeof module !== 'undefined') {
  module.exports = {
    splitTopLevelComma,
    parseColumnDef,
    parseCreateTables,
    buildSchemaFromRows,
    parseDatabases,
    getDriver,
    buildJdbcUrl,
    buildClickHouseHttpUrl,
    validateClickHouseConfig,
    getDefaultAccountQuery,
    flattenMetadataRows
  };
}
