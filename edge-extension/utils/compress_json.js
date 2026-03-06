// compress.js
const fs = require('fs');
const zlib = require('zlib');

const inputFile = '../data/cities_full.json';
const outputFile = '../data/cities_db.json.gz';

console.log('Compressing json...');
const json = fs.readFileSync(inputFile, 'utf-8');
const compressed = zlib.gzipSync(json);

fs.writeFileSync(outputFile, compressed);
console.log('Compression done.');
