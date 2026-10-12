'use strict';
// GAS(Google Apps Script)グローバルAPIの最小モック。Code.gs をNode上で動かして検証するためのハーネス。

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows || 1; this.numCols = numCols || 1;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const rowArr = this.sheet.data[this.row - 1 + i] || [];
      const vals = [];
      for (let j = 0; j < this.numCols; j++) {
        const v = rowArr[this.col - 1 + j];
        vals.push(v === undefined ? '' : v);
      }
      out.push(vals);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    for (let i = 0; i < this.numRows; i++) {
      const rowIdx = this.row - 1 + i;
      while (this.sheet.data.length <= rowIdx) this.sheet.data.push([]);
      const rowArr = this.sheet.data[rowIdx];
      for (let j = 0; j < this.numCols; j++) {
        const colIdx = this.col - 1 + j;
        while (rowArr.length <= colIdx) rowArr.push('');
        rowArr[colIdx] = values[i][j];
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  getRange(row, col, numRows, numCols) { return new Range(this, row, col, numRows, numCols); }
  getLastRow() { return this.data.length; }
  getLastColumn() { let m = 0; this.data.forEach(r => { if (r.length > m) m = r.length; }); return m; }
  appendRow(values) { this.data.push(values.slice()); }
  setFrozenRows() { return this; }
  getName() { return this.name; }
}

class Spreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) { const s = new Sheet(name); this.sheets[name] = s; return s; }
}

function buildSandbox(opts) {
  opts = opts || {};
  const ss = new Spreadsheet();
  const calls = { urlFetch: [], mail: [], slack: [], log: [] };
  let uuidCounter = 0;

  const SpreadsheetApp = { getActiveSpreadsheet: () => ss };
  const Utilities = {
    getUuid: () => 'uuid-' + (++uuidCounter),
    MacAlgorithm: { HMAC_SHA_1: 'HMAC_SHA_1' },
    computeHmacSignature: () => [1, 2, 3],
    base64Encode: () => 'sig',
    formatDate: (d, tz, fmt) => {
      // テスト用の簡易フォーマッタ（yyyy-MM-dd HH:mm:ss 相当のみ対応）
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  };
  const propsStore = Object.assign({}, opts.scriptProperties || {});
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (propsStore[k] !== undefined ? propsStore[k] : null),
      setProperty: (k, v) => { propsStore[k] = v; }
    })
  };
  const ScriptApp = {
    getProjectTriggers: () => [],
    newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }),
    deleteTrigger: () => {}
  };
  const MailApp = { sendEmail: (...args) => calls.mail.push(args) };
  const UrlFetchApp = {
    fetch: (url, options) => {
      calls.urlFetch.push({ url, options });
      const mocked = (opts.urlFetchResponses || []).shift();
      return mocked || { getResponseCode: () => 200, getContentText: () => '{}' };
    }
  };
  const Logger = { log: (...args) => calls.log.push(args) };

  return { ss, Sheet, SpreadsheetApp, Utilities, PropertiesService, ScriptApp, MailApp, UrlFetchApp, Logger, calls };
}

module.exports = { buildSandbox, Sheet, Spreadsheet };
