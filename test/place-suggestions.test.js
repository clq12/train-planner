'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const places = require('../public/place-suggestions.js');

const codes = query => places.match(places.airports, query).map(place => place.code);

test('43机场保留唯一代码及规范显示名，IATA大小写与中文/拼音别名可查', () => {
  assert.equal(places.airports.length, 43);
  assert.equal(new Set(places.airports.map(place => place.code)).size, 43);
  for (const airport of places.airports) {
    assert.equal(codes(airport.code.toLowerCase())[0], airport.code);
    assert.equal(codes(airport.name)[0], airport.code);
    assert.equal(airport.value, `${airport.code} ${airport.name}`);
  }
  for (const [query, code] of [
    ['PEK', 'PEK'], ['pek', 'PEK'], ['bjsd', 'PEK'], ['sd', 'PEK'], ['首都', 'PEK'],
    ['beijingshoudu', 'PEK'], ['shoudu', 'PEK'], ['北京首都国际机场', 'PEK'],
    ['PKX', 'PKX'], ['SHA', 'SHA'], ['shhq', 'SHA'], ['虹桥', 'SHA'], ['shanghaihongqiao', 'SHA'],
    ['ＳＨＡ', 'SHA'], [' bei jing shou du ', 'PEK'],
  ]) assert.equal(codes(query)[0], code, query);
  assert.deepEqual(codes('HND'), []);
  assert.deepEqual(codes(''), []);
});

test('城市简称和城市码保留多个独立机场，匹配按代码/别名/前缀/包含排序', () => {
  for (const query of ['北京', 'BJ', 'bjs', 'beijing']) assert.deepEqual(codes(query), ['PEK', 'PKX'], query);
  for (const query of ['上海', 'shanghai']) assert.deepEqual(codes(query), ['SHA', 'PVG'], query);
  const catalogue = [
    { code: 'ZZZ', aliases: ['xaax'] }, { code: 'BBB', aliases: ['aaxy'] },
    { code: 'CCC', aliases: ['aax'] }, { code: 'AAX', aliases: [] },
  ];
  assert.deepEqual(places.match(catalogue, 'aax').map(place => place.code), ['AAX', 'CCC', 'BBB', 'ZZZ']);
  assert.equal(places.match(places.airports, 'a', 2).length, 2);
});

test('站点按四字段无大小写匹配，坏数据忽略，保存值与既有铁路候选站名相同', () => {
  const stations = places.stationsFrom({
    VNP: { name: '北京南', code: 'vnp', pinyin: 'beijingnan', pinyinShort: 'bjn' },
    AOH: { name: '上海虹桥', code: 'AOH', pinyin: 'shanghaihongqiao', pinyinShort: 'shhq' },
    invalid: { name: '坏记录', code: 'TOOLONG' }, empty: null,
  });
  assert.equal(stations.length, 2);
  for (const query of ['北京南', 'VnP', 'BEIJINGNAN', 'BjN']) {
    const result = places.match(stations, query);
    assert.equal(result[0].value, '北京南');
    assert.equal(result[0].label, '北京南 · VNP');
  }
  assert.deepEqual(places.stationsFrom(null), []);
  assert.deepEqual(places.stationsFrom([]), []);
});

test('退役的真实Express routes对GET/POST固定410且不读取凭据或调用供应商/12306', async () => {
  let upstreamCalls = 0;
  const context = vm.createContext({
    require: name => {
      if (name === 'node-fetch') return () => { upstreamCalls++; throw new Error('Unexpected upstream call'); };
      if (name === 'fs') return { readFileSync() { throw new Error('Unexpected file access'); } };
      assert.ok(['express', 'cors', 'compression', 'path'].includes(name), `Unexpected module: ${name}`);
      return require(name);
    },
    __dirname: path.join(__dirname, '..'), module: { exports: {} }, console,
    process: { env: new Proxy({ VERCEL: '1' }, { get(target, key) {
      assert.ok(!String(key).includes('DUFFEL'), 'No supplier credential lookup');
      return target[key];
    } }) },
    setTimeout, clearTimeout, URLSearchParams, Buffer,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), context);
  const server = context.module.exports.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const endpoint of ['status', 'search']) {
      for (const method of ['GET', 'POST']) {
        const result = await new Promise((resolve, reject) => {
          const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
            path: `/api/domestic-flights/${endpoint}`, method, headers: { 'Content-Type': 'application/json' } }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) }));
          });
          request.on('error', reject);
          request.end(method === 'POST' ? '{malformed' : undefined);
        });
        assert.equal(result.status, 410);
        assert.equal(result.headers['cache-control'], 'no-store');
        assert.equal(result.body.code, 'FEATURE_REMOVED');
      }
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
