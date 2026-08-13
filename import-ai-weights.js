'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const requested = process.argv[2] || 'trained-weights-19x19-win6.json';
const weightFile = path.resolve(root, requested);

if (!fs.existsSync(weightFile)) {
  throw new Error(`找不到 ${requested}，请先运行 train-ai.js`);
}

const payload = JSON.parse(fs.readFileSync(weightFile, 'utf8'));
const model = payload.model;
if (!model || !Array.isArray(model.policy) || !Array.isArray(model.hiddenW)) {
  throw new Error(`${requested} 不包含有效的神经网络模型`);
}

let type;
if (Number(payload.size) === 13 && Number(payload.win) === 5) type = 'GOMOKU';
if (Number(payload.size) === 19 && Number(payload.win) === 6) type = 'CONNECT6';
if (!type) {
  throw new Error('只支持 13路五子棋（win=5）或 19路六子棋（win=6）的权重');
}

const start = `/*TRAINED_${type}_START*/`;
const end = `/*TRAINED_${type}_END*/`;

for (const name of ['six_go.html', 'index.html']) {
  const htmlFile = path.join(root, name);
  if (!fs.existsSync(htmlFile)) continue;
  let source = fs.readFileSync(htmlFile, 'utf8');
  const a = source.indexOf(start);
  const b = source.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${name} 中缺少 ${type} 模型嵌入标记`);
  source = source.slice(0, a + start.length) + JSON.stringify(model) + source.slice(b);
  fs.writeFileSync(htmlFile, source, 'utf8');
}

const label = type === 'GOMOKU' ? '13路五子棋' : '19路六子棋';
console.log(`${label}权重已嵌入 six_go.html 和 index.html；另一棋种的权重保持不变。`);
