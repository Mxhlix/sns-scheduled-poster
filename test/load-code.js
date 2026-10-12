'use strict';
// Code.gs のソースをNodeの vm でロードし、トップレベル関数・変数を素のオブジェクトとして返す。
const fs = require('fs');
const vm = require('vm');
const { buildSandbox } = require('./mock-gas');

const CODE_PATH = require('path').join(__dirname, '..', 'src', 'Code.gs');

function loadCode(mockOpts) {
  const src = fs.readFileSync(CODE_PATH, 'utf8');
  const sandbox = buildSandbox(mockOpts);
  const context = vm.createContext(Object.assign({}, sandbox));
  vm.runInContext(src, context, { filename: 'Code.gs' });
  return { context, sandbox };
}

module.exports = { loadCode, CODE_PATH };
