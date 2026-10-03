// one-off patch helper: node tools/_apply.cjs <file> <json pairs file>
const fs = require('fs');
const [file, pairsFile] = process.argv.slice(2);
let s = fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const pairs = JSON.parse(fs.readFileSync(pairsFile, 'utf8'));
for (const [a, b] of pairs) {
  if (!s.includes(a)) { console.error('MISSING in ' + file + ': ' + a.slice(0, 90)); process.exit(1); }
  s = s.replace(a, () => b);
}
fs.writeFileSync(file, s);
console.log('patched', file, pairs.length);
