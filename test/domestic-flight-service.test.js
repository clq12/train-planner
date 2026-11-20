'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const flights = require('../public/domestic-flight-service.js');
const core = require('../public/itinerary-core.js');
const now = Date.parse('2026-11-20T12:00:00+08:00');
const input = { origin: 'PEK', destination: 'SHA', departureDate: '2026-12-10' };
const query = flights.validateSearch(input, now);
const credential = 'unit-test-credential-not-real';
function airport(code, country = 'CN') { return { iata_code: code, iata_country_code: country, type: 'airport' }; }
function segment(origin = 'PEK', destination = 'SHA', departure = '2026-12-10T08:00:00', arrival = '2026-12-10T10:00:00', number = '1234') {
  return {
    origin: airport(origin), destination: airport(destination), departing_at: departure, arriving_at: arrival,
    marketing_carrier: { iata_code: 'CA', name: '中国国际航空' }, marketing_carrier_flight_number: number,
    operating_carrier: { iata_code: 'CA', name: '中国国际航空' }, origin_terminal: 'T3', destination_terminal: 'T2',
    passengers: [{ cabin_class: 'economy' }], stops: [],
  };
}
function offer() {
  return {
    id: 'off_test123', total_amount: '1234.50', total_currency: 'CNY', expires_at: '2026-11-20T05:00:00Z', live_mode: false,
    passengers: [{ type: 'adult', id: 'pas_test' }],
    slices: [{ origin: airport('PEK'), destination: airport('SHA'), segments: [segment()] }],
  };
}
function payload(offers = [offer()]) { return { data: { offers, live_mode: false, client_key: 'DO_NOT_RETURN_CLIENT_KEY' } }; }
function mockService(fetchImpl, token = credential) { return flights.createFlightService({ fetchImpl, getToken: () => token, now: () => now }); }
function response(status = 200, data = payload()) { return { ok: status === 200, status, json: async () => data }; }
function normalise(raw) { return flights.normaliseOffers(payload([raw]), query, now).offers; }

test('默认参数为单程、1成人、经济舱、最多1次中转和10个结果', () => {
  assert.deepEqual(query, { ...input, adults: 1, cabinClass: 'economy', maxConnections: 1, limit: 10 });
  assert.deepEqual(flights.requestBody(query), { data: {
    slices: [{ origin: 'PEK', destination: 'SHA', departure_date: '2026-12-10' }],
    passengers: [{ type: 'adult' }], cabin_class: 'economy', max_connections: 1,
  } });
  const other = flights.validateSearch({ ...input, origin: ' pek ', destination: 'pvg', adults: 2, maxConnections: 0, limit: 3 }, now);
  assert.equal(other.origin, 'PEK');
  assert.equal(other.destination, 'PVG');
  assert.equal(flights.requestBody(other).data.passengers.length, 2);
});

test('内地allowlist不含港澳台、城市码和任意国外机场，拒绝相同机场', () => {
  assert.ok(flights.airports.length >= 30);
  assert.ok(flights.airports.every(airport => airport.country === 'CN'));
  for (const origin of ['HKG', 'MFM', 'TPE', 'TSA', 'KHH', 'HND', 'LAX', 'BJS', 'XXX', '', null, {}, ['PEK']]) {
    assert.throws(() => flights.validateSearch({ ...input, origin }, now), /中国内地机场/);
  }
  assert.throws(() => flights.validateSearch({ ...input, destination: 'PEK' }, now));
});

test('拒绝非法日期、过去/过远日期、不支持舱位和非整型或越界参数', () => {
  for (const departureDate of ['2026-02-30', '2026-11-19', '2027-12-31', '2026-12-10T00:00', '2026-1-1']) {
    assert.throws(() => flights.validateSearch({ ...input, departureDate }, now));
  }
  for (const bad of [null, [], {}, { ...input, adults: 0 }, { ...input, adults: 7 }, { ...input, adults: '1' },
    { ...input, adults: 1.5 }, { ...input, adults: null }, { ...input, limit: null }, { ...input, maxConnections: null }, { ...input, cabinClass: 'business' }, { ...input, maxConnections: 2 },
    { ...input, maxConnections: -1 }, { ...input, maxConnections: false }, { ...input, limit: 0 },
    { ...input, limit: 11 }, { ...input, returnDate: '2026-12-11' }, { ...input, token: credential }]) {
    assert.throws(() => flights.validateSearch(bad, now));
  }
  assert.equal(flights.searchDates(now).min, '2026-11-20');
  assert.doesNotThrow(() => flights.validateSearch({ ...input, departureDate: flights.searchDates(now).max }, now));
});

test('请求固定Duffel HTTPS地址、Bearer header、版本及单程body，不把token放URL或body', async () => {
  let requested;
  const service = mockService(async (url, options) => { requested = { url, options }; return response(); });
  const result = await service.search(input);
  assert.equal(service.configured(), true);
  assert.equal(requested.url, 'https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=15000');
  assert.equal(requested.options.method, 'POST');
  assert.equal(requested.options.redirect, 'error');
  assert.equal(requested.options.headers.Authorization, `Bearer ${credential}`);
  assert.equal(requested.options.headers['Duffel-Version'], 'v2');
  assert.deepEqual(JSON.parse(requested.options.body), flights.requestBody(query));
  assert.ok(!requested.url.includes(credential));
  assert.ok(!requested.options.body.includes(credential));
  assert.ok(!JSON.stringify(result).includes(credential));
  assert.ok(!JSON.stringify(result).includes('DO_NOT_RETURN_CLIENT_KEY'));
  assert.ok(requested.options.signal);
});

test('无token时状态未配置，搜索不触发上游；非法输入也不触发上游', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(); };
  const missing = mockService(fetchImpl, '  ');
  assert.equal(missing.configured(), false);
  await assert.rejects(missing.search(input), error => flights.safeError(error).body.code === 'NOT_CONFIGURED');
  const service = mockService(fetchImpl);
  await assert.rejects(service.search({ ...input, origin: 'HKG' }));
  assert.equal(calls, 0);
});

test('归一化直飞报价保留币种、总价、机场、航司、航站楼、时区，并可保存恢复', () => {
  const result = normalise(offer())[0];
  assert.equal(result.totalAmount, '1234.50');
  assert.equal(result.totalCurrency, 'CNY');
  assert.equal(result.liveMode, false);
  assert.equal(result.segments[0].number, 'CA1234');
  assert.equal(result.segments[0].departure, '2026-12-10T08:00');
  assert.equal(result.segments[0].departureOffset, '+08:00');
  assert.equal(result.segments[0].from, 'PEK 北京首都机场');
  assert.equal(result.segments[0].flightDetails.departureTerminal, 'T3');
  assert.equal(result.connections.length, 0);
  const restored = core.loadState({ getItem: () => JSON.stringify({ legs: result.segments }) });
  assert.deepEqual(restored.legs, result.segments);
});

test('多航段中转支持跨日并给出真实中转地点和分钟数，换机场不会假装同站', () => {
  const raw = offer();
  raw.slices[0].segments = [
    segment('PEK', 'CAN', '2026-12-10T20:00:00', '2026-12-10T23:00:00'),
    segment('SZX', 'SHA', '2026-12-11T02:00:00', '2026-12-11T04:00:00', '5678'),
  ];
  const result = normalise(raw)[0];
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.connections, [{ from: 'CAN 广州白云机场', to: 'SZX 深圳宝安机场', gapMinutes: 180, airportChange: true }]);
  assert.equal(result.segments[1].departure, '2026-12-11T02:00');
  const nonstopQuery = { ...query, maxConnections: 0 };
  assert.equal(flights.normaliseOffers(payload([raw]), nonstopQuery, now).offers.length, 0);
});

test('同一航班经停机场及时间保留，港澳台或境外经停一律剔除', () => {
  const raw = offer();
  raw.slices[0].segments[0].stops = [{ airport: airport('NKG'), arriving_at: '2026-12-10T08:45:00', departing_at: '2026-12-10T09:00:00' }];
  const result = normalise(raw)[0];
  assert.deepEqual(result.segments[0].flightDetails.stops, [{ code: 'NKG', name: '南京禄口机场', arrival: '2026-12-10T08:45', departure: '2026-12-10T09:00' }]);
  for (const code of ['HKG', 'MFM', 'TPE', 'HND']) {
    raw.slices[0].segments[0].stops[0].airport = airport(code);
    assert.equal(normalise(raw).length, 0, code);
  }
});

test('逐段验证CN与allowlist，拒绝境外/未知机场、反向时间及响应与请求不一致', () => {
  const mutations = [
    raw => { raw.slices[0].segments[0].origin = airport('PEK', 'US'); },
    raw => { raw.slices[0].segments[0].destination = airport('HKG'); },
    raw => { raw.slices[0].segments[0].origin.type = 'city'; },
    raw => { raw.slices[0].destination = airport('PVG'); },
    raw => { raw.slices[0].segments[0].origin = airport('PKX'); },
    raw => { raw.slices[0].segments[0].departing_at = '2026-12-11T08:00:00'; },
    raw => { raw.slices[0].segments[0].departing_at = '2026-12-10T08:00:00+08:00'; },
    raw => { raw.slices[0].segments[0].arriving_at = '2026-12-10T07:00:00'; },
    raw => { raw.slices[0].segments[0].arriving_at = '2026-02-30T10:00:00'; },
    raw => { raw.slices.push(raw.slices[0]); },
    raw => { raw.slices[0].segments[0].passengers[0].cabin_class = 'business'; },
    raw => { raw.passengers.push({ type: 'adult' }); },
    raw => { raw.total_currency = '<CNY>'; },
    raw => { raw.total_amount = 'Infinity'; },
    raw => { raw.expires_at = '2026-11-20T03:00:00Z'; },
    raw => { raw.slices[0].segments[0].marketing_carrier_flight_number = '<script>'; },
  ];
  for (const mutate of mutations) {
    const raw = offer(); mutate(raw);
    assert.equal(normalise(raw).length, 0, mutate.toString());
  }
  const overlapping = offer();
  overlapping.slices[0].segments = [segment('PEK', 'NKG'), segment('NKG', 'SHA', '2026-12-10T09:00:00', '2026-12-10T11:00:00')];
  assert.equal(normalise(overlapping).length, 0);
});

test('结果限制、去重、空结果与坏响应行为明确', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ ...offer(), id: `off_test${i}` }));
  const result = flights.normaliseOffers(payload(many), { ...query, limit: 3 }, now);
  assert.equal(result.offers.length, 3);
  assert.equal(result.limited, true);
  assert.equal(flights.normaliseOffers(payload([offer(), offer()]), query, now).offers.length, 1);
  assert.deepEqual(flights.normaliseOffers(payload([]), query, now).offers, []);
  assert.throws(() => flights.normaliseOffers({ data: { offers: 'bad' } }, query, now));
});

test('授权、限流、超时、JSON和网络失败均为固定安全错误，绝不回显token或上游body', async () => {
  for (const [status, expectedCode] of [[401, 'UPSTREAM_AUTH'], [403, 'UPSTREAM_AUTH'], [429, 'UPSTREAM_LIMIT'], [500, 'UPSTREAM_UNAVAILABLE']]) {
    let bodyRead = false;
    const service = mockService(async () => ({ ok: false, status, json: async () => { bodyRead = true; return { error: credential }; } }));
    await assert.rejects(service.search(input), error => {
      const safe = flights.safeError(error);
      assert.equal(safe.body.code, expectedCode);
      assert.ok(!JSON.stringify(safe).includes(credential));
      return true;
    });
    assert.equal(bodyRead, false);
  }
  for (const failure of [new Error(credential), Object.assign(new Error(credential), { type: 'request-timeout' })]) {
    await assert.rejects(mockService(async () => { throw failure; }).search(input), error => {
      const safe = flights.safeError(error);
      assert.ok(!JSON.stringify(safe).includes(credential));
      assert.equal(safe.body.code, failure.type ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE');
      return true;
    });
  }
  await assert.rejects(mockService(async () => ({ ok: true, json: async () => { throw new Error(credential); } })).search(input), error => !JSON.stringify(flights.safeError(error)).includes(credential));
  assert.ok(!JSON.stringify(flights.safeError({ code: 'INVALID_INPUT', message: credential })).includes(credential));
  const echoed = offer(); echoed.slices[0].segments[0].marketing_carrier.name = credential;
  await assert.rejects(mockService(async () => response(200, payload([echoed]))).search(input), error => flights.safeError(error).body.code === 'INVALID_RESPONSE');
});

test('最多2个上游并发，第三个安全拒绝，结束后释放额度', async () => {
  const pending = [];
  const service = mockService(() => new Promise(resolve => pending.push(resolve)));
  const first = service.search(input);
  const second = service.search(input);
  await assert.rejects(service.search(input), error => flights.safeError(error).body.code === 'UPSTREAM_LIMIT');
  pending.shift()(response()); pending.shift()(response());
  await Promise.all([first, second]);
  const third = service.search(input);
  pending.shift()(response());
  await third;
});

function resStub() {
  return { httpStatus: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(code) { this.httpStatus = code; return this; }, json(body) { this.body = body; return this; } };
}

test('HTTP handlers只输出归一化数据及固定错误，缺配置和坏JSON均安全', async () => {
  let upstreamCalls = 0;
  const handlers = flights.createHandlers(mockService(async () => { upstreamCalls++; return response(); }, ''));
  const status = resStub(); handlers.status({}, status);
  assert.deepEqual(status.body, { status: 0, configured: false });
  assert.equal(status.headers['Cache-Control'], 'no-store');
  const result = resStub(); await handlers.search({ body: input }, result);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.code, 'NOT_CONFIGURED');
  assert.equal(upstreamCalls, 0);
  const parserError = resStub(); handlers.invalidBody(new Error(credential), {}, parserError, () => assert.fail());
  assert.equal(parserError.httpStatus, 400);
  assert.ok(!JSON.stringify(parserError.body).includes(credential));
  const good = flights.createHandlers(mockService(async () => response()));
  const data = resStub(); await good.search({ body: input }, data);
  assert.equal(data.body.status, 0);
  assert.equal(data.body.data.offers.length, 1);
  assert.ok(!JSON.stringify(data.body).includes(credential));
});
