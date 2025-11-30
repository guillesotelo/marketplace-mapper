// extract.js
const fs = require('fs');
const zlib = require('zlib');

const inputFile = '../data/cities_db.json.gz';
const outputFile = '../data/cities_db_extracted.json';

console.log('Decompressing gzipped JSON...');
const compressed = fs.readFileSync(inputFile);
const jsonBuffer = zlib.gunzipSync(compressed);

fs.writeFileSync(outputFile, jsonBuffer.toString('utf-8'));
console.log('Decompression done.');
