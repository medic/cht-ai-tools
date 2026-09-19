'use strict';
// Every write is atomic: write to <name>.tmp in the same directory, then rename (contracts/run-directory.md).
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const writeFileAtomic = async (file, data) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
};

const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

const writeGzipJsonAtomic = (file, value) => writeFileAtomic(file, zlib.gzipSync(Buffer.from(JSON.stringify(value))));

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

const readGzipJson = async (file) => JSON.parse(zlib.gunzipSync(await fs.readFile(file)).toString('utf8'));

const appendJsonl = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`);
};

const readJsonl = async (file) => {
  if (!fsSync.existsSync(file)) {
    return [];
  }
  const text = await fs.readFile(file, 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
};

const exists = (file) => fsSync.existsSync(file);

module.exports = {
  writeFileAtomic, writeJsonAtomic, writeGzipJsonAtomic, readJson, readGzipJson, appendJsonl, readJsonl, exists,
};
