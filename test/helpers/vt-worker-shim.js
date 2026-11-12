'use strict';
// Web Workerのグローバル(self/importScripts/postMessage/onmessage)を worker_threads の上に再現して、
// js/core/vt-worker.js をそのまま動かす。
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { makeFetch } = require('./vt-fixture');
globalThis.self = globalThis;
globalThis.fetch = makeFetch(workerData.fixture);
globalThis.importScripts = (rel) => vm.runInThisContext(fs.readFileSync(path.resolve(path.dirname(workerData.file), rel), 'utf8'), { filename: rel });
globalThis.postMessage = (m) => parentPort.postMessage(m);
vm.runInThisContext(fs.readFileSync(workerData.file, 'utf8'), { filename: workerData.file });
parentPort.on('message', (m) => globalThis.onmessage({ data: m }));
