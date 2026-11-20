'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const core = require('../public/itinerary-core.js');
const flight = {
  kind: 'flight', number: 'XX123', from: 'HND', to: 'LAX',
  departure: '2026-11-21T00:20', departureOffset: '+09:00',
  arrival: '2026-11-20T17:35', arrivalOffset: '-08:00',
};
const rail = { trainNo: 'K1256', fromStation: '甲站', toStation: '乙站', startTime: '23:50', arriveTime: '09:04', duration: '33:14' };

function ground(departure, arrival) {
  return core.parseLeg({ kind: 'ground', from: '车站', to: '机场', departure, arrival, departureOffset: '+08:00', arrivalOffset: '+08:00' });
}

test('跨国际日期变更线时按实际时间比较，而不是按票面日期比较', () => {
  const leg = core.parseLeg(flight);
  assert.equal(leg.departureMs, Date.parse('2026-11-20T15:20:00Z'));
  assert.equal(leg.arrivalMs, Date.parse('2026-11-21T01:35:00Z'));
  assert.equal(leg.arrivalMs - leg.departureMs, 615 * 60_000);
});

test('按运行时长算出火车跨两日以及跨年的到达日期', () => {
  const leg = core.trainToLeg(rail, '2026-12-31');
  assert.equal(leg.departure, '2026-12-31T23:50');
  assert.equal(leg.arrival, '2027-01-02T09:04');
  assert.equal(leg.arrivalOffset, '+08:00');
  assert.throws(() => core.trainToLeg({ ...rail, arriveTime: '09:05' }, '2026-12-31'), /时刻和运行时长/);
});

test('拒绝不可能的日期、非法时差和实际逆序的航班', () => {
  assert.throws(() => core.parseLeg({ ...flight, departure: '2026-02-30T10:00' }), /日期/);
  assert.throws(() => core.parseLeg({ ...flight, departureOffset: '+14:30' }), /时差/);
  assert.throws(() => core.parseLeg({ ...flight, arrivalOffset: '-08:00xyz' }), /时差/);
  assert.throws(() => core.parseLeg({ ...flight, arrival: '2026-11-19T17:35' }), /晚于出发/);
  const leg = core.parseLeg({ ...flight, arrivalOffset: '-00:00' });
  assert.equal(leg.arrivalOffset, '+00:00');
});

test('接驳门槛包含刚好达到预留的情况，提前出发视为冲突', () => {
  const prev = ground('2026-12-31T22:00', '2026-12-31T23:00');
  const next = core.trainToLeg(rail, '2026-12-31');
  assert.deepEqual(core.transferBetween(prev, next, 50), { gapMinutes: 50, status: 'ready' });
  assert.deepEqual(core.transferBetween(prev, next, 51), { gapMinutes: 50, status: 'short' });
  assert.deepEqual(core.transferBetween(next, prev, 0), { gapMinutes: -2104, status: 'overlap' });
});

test('火车和航班使用不同的预留规则，切换为地面接驳不套用登机时间', () => {
  const railLeg = core.trainToLeg(rail, '2026-12-31');
  const flightLeg = core.parseLeg({ ...flight, from: '乙站', departure: '2027-01-02T11:04', arrival: '2027-01-02T12:04', departureOffset: '+08:00', arrivalOffset: '+08:00' });
  const next = core.trainToLeg({ ...rail, startTime: '13:00', duration: '01:00', arriveTime: '14:00' }, '2027-01-02');
  const transfers = core.adjacentTransfers([next, flightLeg, railLeg], core.defaults);
  assert.deepEqual(transfers.map(({ status, minimumMinutes, gapMinutes }) => [status, minimumMinutes, gapMinutes]), [['ready', 120, 120], ['short', 90, 56]]);
  const drive = ground('2027-01-02T12:05', '2027-01-02T12:20');
  assert.deepEqual(core.adjacentTransfers([flightLeg, drive], core.defaults).map(({ minimumMinutes, status }) => [minimumMinutes, status]), [[90, 'short']]);
});

test('较长行程覆盖多段时，仍能发现被覆盖行程的冲突', () => {
  const a = ground('2026-12-31T10:00', '2026-12-31T18:00');
  const b = ground('2026-12-31T12:00', '2026-12-31T13:00');
  const c = ground('2026-12-31T14:00', '2026-12-31T15:00');
  const transfers = core.adjacentTransfers([c, b, a], core.defaults);
  assert.deepEqual(transfers.map(({ status }) => status), ['overlap', 'overlap']);
  assert.equal(transfers[1].previous, a);
});

test('读取日程会重新验证已存数据和设置，不信任派生时间戳', () => {
  const savedFlight = { ...flight, departureMs: 1 };
  const raw = { legs: [savedFlight, { ...flight, to: '' }], settings: { flight: 0, afterFlight: -5, train: 25 } };
  const state = core.loadState({ getItem: () => JSON.stringify(raw) });
  assert.equal(state.legs.length, 1);
  assert.equal(state.legs[0].departureMs, core.parseLeg(flight).departureMs);
  assert.deepEqual(state.settings, { flight: 0, afterFlight: 90, train: 25 });
  assert.equal(core.legKey(state.legs[0]), core.legKey(core.parseLeg({ ...flight, number: 'xx123' })));
});

function legAt(kind, number, start, end, from = '接驳点', to = '接驳点') {
  return core.parseLeg({
    kind, number, from, to,
    departure: `2026-11-21T${start}`, arrival: `2026-11-21T${end}`,
    departureOffset: '+08:00', arrivalOffset: '+08:00',
  });
}

function summary(transfers) {
  return transfers.map(({ previous, next, gapMinutes, minimumMinutes, status }) =>
    [previous.number, next.number, gapMinutes, minimumMinutes, status]);
}

test('已结束的短段不会遮蔽长航班与候选的接驳，输入乱序不改变结果', () => {
  const long = legAt('flight', 'F1', '08:00', '18:00');
  const bus = legAt('ground', 'BUS1', '09:00', '10:00');
  const candidate = legAt('train', 'G1', '18:30', '19:30');
  const expected = ['F1', 'G1', 30, 90, 'short'];
  assert.deepEqual(summary(core.adjacentTransfers([long, candidate], core.defaults)), [expected]);
  for (const legs of [[long, bus, candidate], [candidate, long, bus], [bus, candidate, long]]) {
    assert.deepEqual(summary(core.adjacentTransfers(legs, core.defaults)), [
      ['F1', 'BUS1', -540, 90, 'overlap'], expected,
    ]);
  }
});

test('保留每对直接重叠，即使另一个更长的行程覆盖候选和多个后段', () => {
  const long = legAt('flight', 'F1', '08:00', '22:00');
  const candidate = legAt('train', 'G1', '09:00', '18:00');
  const bus = legAt('ground', 'BUS1', '10:00', '11:00');
  const train = legAt('train', 'G2', '12:00', '13:00');
  const transfers = core.adjacentTransfers([train, bus, candidate, long], core.defaults);
  assert.deepEqual(transfers.map(({ previous, next }) => `${previous.number}->${next.number}`), [
    'F1->G1', 'F1->BUS1', 'G1->BUS1', 'F1->G2', 'G1->G2',
  ]);
  assert.ok(transfers.every(transfer => transfer.status === 'overlap'));
});

test('航班后地面段使用落地预留，少一分钟、刚好和负间隔均按门槛判断', () => {
  const landed = legAt('flight', 'F1', '08:00', '18:00');
  for (const [start, gap, expected] of [
    ['18:01', 1, 'short'], ['19:29', 89, 'short'], ['19:30', 90, 'ready'], ['17:59', -1, 'overlap'],
  ]) {
    const bus = legAt('ground', 'BUS1', start, '20:00');
    assert.deepEqual(summary(core.adjacentTransfers([bus, landed], core.defaults)), [
      ['F1', 'BUS1', gap, 90, expected],
    ]);
  }
  const bus = legAt('ground', 'BUS1', '06:00', '07:00');
  assert.deepEqual(summary(core.adjacentTransfers([bus, landed], { ...core.defaults, afterFlight: 300 })), [
    ['BUS1', 'F1', 60, 120, 'short'],
  ]);
});

test('铁路日期按北京时间日历计算，在上海及美洲时区都不偏移', () => {
  const cases = [
    ['2026-11-21T00:30:00+08:00', { min: '2026-11-21', value: '2026-11-22', max: '2026-12-06' }],
    ['2026-11-21T08:30:00+08:00', { min: '2026-11-21', value: '2026-11-22', max: '2026-12-06' }],
    ['2026-11-21T23:59:00+08:00', { min: '2026-11-21', value: '2026-11-22', max: '2026-12-06' }],
    ['2026-11-30T23:59:00+08:00', { min: '2026-11-30', value: '2026-12-01', max: '2026-12-15' }],
    ['2026-12-31T00:30:00+08:00', { min: '2026-12-31', value: '2027-01-01', max: '2027-01-15' }],
    ['2028-02-28T23:59:00+08:00', { min: '2028-02-28', value: '2028-02-29', max: '2028-03-14' }],
  ];
  const modulePath = require.resolve('../public/itinerary-core.js');
  const script = `const core = require(${JSON.stringify(modulePath)}); const cases = ${JSON.stringify(cases)}; console.log(JSON.stringify(cases.map(([time]) => core.trainSearchDates(Date.parse(time)))));`;
  for (const TZ of ['Asia/Shanghai', 'America/Los_Angeles', 'America/New_York']) {
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }));
    assert.deepEqual(actual, cases.map(([, expected]) => expected), TZ);
  }
});

// Exercise the real itinerary page script with a small DOM, without network calls.
class PageElement {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.ownText = '';
  }
  set textContent(value) { this.ownText = value; this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.ownText = ''; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
  getAttribute(name) { return this.attributes?.[name] ?? null; }
  removeAttribute(name) { delete this.attributes?.[name]; }
  scrollIntoView() {}
  focus() { this.listeners.focus?.(); }
}

function pageFixture(legs, candidate = null, storage = new Map(), options = {}) {
  if (legs) storage.set(core.STORAGE_KEY, JSON.stringify({ legs, settings: core.defaults }));
  const ids = new Map();
  const get = id => {
    if (!ids.has(id)) {
      const el = new PageElement();
      el.id = id;
      ids.set(id, el);
    }
    return ids.get(id);
  };
  function form(id, values) {
    const el = get(id);
    el.inputs = Object.fromEntries(Object.entries(values).map(([name, value]) => {
      const input = new PageElement();
      input.value = value;
      return [name, input];
    }));
    el.elements = { namedItem: name => el.inputs[name] };
    el.reset = () => { for (const [name, value] of Object.entries(values)) el.inputs[name].value = value; };
    return el;
  }
  const legForm = form('leg-form', { kind: 'flight', number: '', from: '', to: '', departure: '', arrival: '', departureOffset: '+08:00', arrivalOffset: '+08:00' });
  for (const name of ['from', 'to']) {
    legForm.inputs[name].id = `place-${name}`;
    ids.set(`place-${name}`, legForm.inputs[name]);
  }
  form('settings-form', { flight: '', afterFlight: '', train: '' });
  class FormDataStub {
    constructor(el) { this.entries = Object.entries(el.inputs).map(([name, input]) => [name, String(input.value)]); }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  const context = vm.createContext({
    window: { ItineraryCore: core, PlaceSuggestions: options.withoutPlaces ? undefined : require('../public/place-suggestions.js'), addEventListener() {} },
    document: { getElementById: get, createElement: () => new PageElement() },
    fetch: options.fetch,
    Date: options.Date || Date,
    location: { hash: candidate ? `#train=${encodeURIComponent(JSON.stringify(candidate))}` : '', pathname: '/itinerary.html', search: '' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    history: { replaceState() {} }, URLSearchParams, FormData: FormDataStub,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/itinerary.js'), 'utf8'), context);
  return { get, storage, context };
}

test('候选及正式时间线保留长航班后的不足预留以及全部直接冲突', () => {
  const long = legAt('flight', 'F1', '08:00', '18:00');
  const bus = legAt('ground', 'BUS1', '09:00', '10:00');
  const candidate = legAt('train', 'G1', '18:30', '19:30');
  const page = pageFixture([long, bus], candidate);
  assert.match(page.get('candidate-content').textContent, /航班 F1 → 火车 G1：仅有 30 分钟，少于预留的 90 分钟/);
  assert.match(page.get('timeline').textContent, /航班 F1 → 地面接驳 BUS1：时间冲突/);

  const covering = legAt('flight', 'F2', '08:00', '22:00');
  const nested = legAt('train', 'G2', '09:00', '18:00');
  const earlyBus = legAt('ground', 'BUS2', '10:00', '11:00');
  const laterTrain = legAt('train', 'G3', '12:00', '13:00');
  const preview = pageFixture([covering, earlyBus, laterTrain], nested);
  for (const pattern of [/航班 F2 → 火车 G2：时间冲突/, /火车 G2 → 地面接驳 BUS2：时间冲突/, /火车 G2 → 火车 G3：时间冲突/]) {
    assert.match(preview.get('candidate-content').textContent, pattern);
    assert.match(pageFixture([covering, earlyBus, nested, laterTrain]).get('timeline').textContent, pattern);
  }
});

test('地点不同在候选和时间线三类状态都提示，同地点不误报且保留时间严重性', () => {
  for (const [start, severity, content] of [
    ['17:00', 'gap overlap', /时间冲突/], ['18:30', 'gap short', /少于预留/], ['20:00', 'gap short', /达到预留时间/],
  ]) {
    for (const samePlace of [false, true]) {
      const landed = legAt('flight', 'F1', '08:00', '18:00', '甲机场', '接驳点');
      const train = legAt('train', 'G1', start, '22:00', samePlace ? ' 接驳点 ' : '另一车站', '目的地');
      for (const [page, id] of [[pageFixture([landed], train), 'candidate-content'], [pageFixture([landed, train]), 'timeline']]) {
        const parent = id === 'timeline' ? page.get(id).children[1] : page.get(id);
        const message = parent.children.find(child => child.className?.startsWith('gap'));
        assert.ok(message, `${id} ${start}`);
        assert.match(message.textContent, content);
        assert.equal(message.textContent.includes('两段地点不同，请核对地面接驳。'), !samePlace);
        assert.equal(message.className, samePlace && start === '20:00' ? 'gap' : severity);
      }
    }
  }
});

test('落地后地面预留可保存并在刷新后恢复及重新计算', () => {
  const landed = legAt('flight', 'F1', '08:00', '18:00');
  const bus = legAt('ground', 'BUS1', '19:00', '20:00');
  const page = pageFixture([landed, bus]);
  assert.match(page.get('timeline').textContent, /少于预留的 90 分钟/);
  const settings = page.get('settings-form');
  settings.elements.namedItem('afterFlight').value = '60';
  settings.listeners.submit({ preventDefault() {} });
  assert.match(page.get('settings-status').textContent, /已更新/);
  assert.match(page.get('timeline').textContent, /间隔 60 分钟，达到预留时间/);
  assert.equal(JSON.parse(page.storage.get(core.STORAGE_KEY)).settings.afterFlight, 60);
  const refreshed = pageFixture(null, null, page.storage);
  assert.equal(refreshed.get('settings-form').elements.namedItem('afterFlight').value, 60);
  assert.match(refreshed.get('timeline').textContent, /间隔 60 分钟，达到预留时间/);
});

const indexSource = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function indexFunction(name) {
  const source = indexSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(source, `首页函数 ${name} 存在`);
  return source[0];
}

function indexFixture(extra = {}) {
  const ids = new Map();
  const get = id => {
    if (!ids.has(id)) {
      const el = new PageElement();
      el.style = {};
      el.classList = { add() {}, remove() {}, toggle() {} };
      ids.set(id, el);
    }
    return ids.get(id);
  };
  const context = vm.createContext({
    window: { ItineraryCore: core, addEventListener() {} },
    document: { getElementById: get, querySelectorAll: () => [], addEventListener() {} },
    ...extra,
  });
  return { get, context };
}

test('首页初始化实际使用北京时间的今天、默认明天和查询上限', async () => {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-11-21T00:30:00+08:00'])); }
    static now() { return Date.parse('2026-11-21T00:30:00+08:00'); }
  }
  const { get, context } = indexFixture({
    Date: FixedDate, setupStationInput() {}, updateViaUI() {}, loadStations: async () => {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/itinerary-core.js'), 'utf8'), context);
  vm.runInContext(indexFunction('init'), context);
  await context.init();
  assert.equal(get('travelDate').min, '2026-11-21');
  assert.equal(get('travelDate').value, '2026-11-22');
  assert.equal(get('travelDate').max, '2026-12-06');
});

test('查询期间修改日期输入，结果候选仍使用发起查询时的日期', async () => {
  let finishRequest;
  let requestedUrl;
  const { get, context } = indexFixture({
    currentTrains: [], currentTrainSearchDate: '', currentSort: '', sortAsc: false, trainTypeFilter: '',
    syncStationInputs() {}, syncViaInput: () => true, cityParam: () => '', showProgress() {}, hideProgress() {},
    alert: message => assert.fail(message), hasTicket: () => true, renderTrainList() {},
    computeStrategies: async () => {}, setTimeout() {}, encodeURIComponent,
    fetch: url => {
      requestedUrl = url;
      return new Promise(resolve => { finishRequest = resolve; });
    },
  });
  for (const [id, value] of Object.entries({ fromCode: 'AAA', toCode: 'BBB', fromInput: '甲站', toInput: '乙站', travelDate: '2026-12-31' })) {
    get(id).value = value;
  }
  vm.runInContext(`${indexFunction('doSearch')}\n${indexFunction('itineraryTrainLink')}`, context);
  const pending = context.doSearch();
  assert.match(requestedUrl, /date=2026-12-31/);
  get('travelDate').value = '2027-01-01';
  finishRequest({ json: async () => ({ status: 0, data: [{ ...rail, canBuy: true }] }) });
  await pending;
  assert.equal(context.currentTrainSearchDate, '2026-12-31');
  const link = context.itineraryTrainLink(rail);
  const encoded = /#train=([^\"]+)/.exec(link)?.[1];
  assert.ok(encoded, '已生成有效候选链接');
  const candidate = JSON.parse(decodeURIComponent(encoded));
  assert.equal(candidate.departure, '2026-12-31T23:50');
  assert.equal(candidate.arrival, '2027-01-02T09:04');
});

function key(input, value, extra = {}) {
  const event = { key: value, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  input.listeners.keydown(event);
  return event;
}

function typePlace(page, name, value) {
  const input = page.get('leg-form').inputs[name];
  input.focus();
  input.value = value;
  input.listeners.input();
  return input;
}

function fillManual(page, kind = 'flight') {
  const form = page.get('leg-form');
  for (const [name, value] of Object.entries({ kind, number: 'TEST1', from: '自定义起点', to: 'HND 东京羽田',
    departure: '2026-12-10T08:00', arrival: '2026-12-10T10:00', departureOffset: '+08:00', arrivalOffset: '+08:00' })) {
    form.inputs[name].value = value;
  }
  form.inputs.kind.listeners.change();
  return form;
}

const flushSuggestions = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('两地点框独立；城市歧义不默选，Enter只确认活动选项，Escape/Tab/失焦关闭', () => {
  const page = pageFixture([]);
  const from = typePlace(page, 'from', 'BJ');
  const list = page.get('place-from-options');
  assert.equal(from.getAttribute('role'), 'combobox');
  assert.equal(from.getAttribute('aria-controls'), list.id);
  assert.equal(from.getAttribute('aria-expanded'), 'true');
  assert.equal(from.getAttribute('aria-activedescendant'), null);
  assert.equal(list.children.length, 2);
  assert.ok(key(from, 'Enter').prevented);
  assert.equal(from.value, 'BJ');
  assert.equal(JSON.parse(page.storage.get(core.STORAGE_KEY)).legs.length, 0);
  assert.ok(key(from, 'ArrowDown').prevented);
  assert.equal(list.children[0].getAttribute('aria-selected'), 'true');
  assert.equal(from.getAttribute('aria-activedescendant'), list.children[0].id);
  key(from, 'ArrowDown');
  assert.ok(key(from, 'Enter').prevented);
  assert.equal(from.value, 'PKX 北京大兴机场');
  assert.equal(page.get('leg-form').inputs.to.value, '');
  assert.equal(from.getAttribute('aria-expanded'), 'false');
  assert.equal(from.getAttribute('aria-activedescendant'), null);
  typePlace(page, 'from', 'pek');
  key(from, 'ArrowUp');
  key(from, 'Escape');
  assert.equal(list.hidden, true);
  typePlace(page, 'from', 'sha');
  key(from, 'Tab');
  assert.equal(list.hidden, true);
  typePlace(page, 'from', '首都');
  from.listeners.blur();
  assert.equal(list.hidden, true);
});

test('鼠标及触屏选项保留焦点直到click，手写或清空后保存当前文字', () => {
  const page = pageFixture([]);
  const form = fillManual(page);
  const from = typePlace(page, 'from', 'bjsd');
  const option = page.get('place-from-options').children[0];
  for (const pointerType of ['mouse', 'touch']) {
    let keptFocus = false;
    option.listeners.pointerdown({ pointerType, preventDefault() { keptFocus = true; } });
    assert.equal(keptFocus, true);
  }
  option.listeners.click();
  assert.equal(from.value, 'PEK 北京首都机场');
  typePlace(page, 'to', 'shhq');
  page.get('place-to-options').children[0].listeners.click();
  assert.equal(form.inputs.to.value, 'SHA 上海虹桥机场');
  assert.equal(from.value, 'PEK 北京首都机场');
  typePlace(page, 'from', '国际机场自填');
  assert.equal(page.get('place-from-options').hidden, true);
  form.listeners.submit({ preventDefault() {} });
  const saved = JSON.parse(page.storage.get(core.STORAGE_KEY));
  assert.equal(saved.legs[0].from, '国际机场自填');
  assert.equal(saved.legs[0].to, 'SHA 上海虹桥机场');
  assert.equal(form.inputs.from.value, '');
  assert.equal(page.get('place-to-options').hidden, true);
  typePlace(page, 'from', 'pek');
  typePlace(page, 'from', '');
  assert.equal(page.get('place-from-options').hidden, true);
});

test('中文输入法期间不打开建议、不误选或提交，组合结束后才匹配', () => {
  const page = pageFixture([]);
  const form = fillManual(page);
  const from = typePlace(page, 'from', '首');
  from.listeners.compositionstart();
  from.value = '首都';
  from.listeners.input();
  assert.equal(page.get('place-from-options').hidden, true);
  key(from, 'Enter', { isComposing: true, keyCode: 229 });
  form.listeners.submit({ preventDefault() {} });
  assert.equal(JSON.parse(page.storage.get(core.STORAGE_KEY)).legs.length, 0);
  from.listeners.compositionend();
  assert.equal(page.get('place-from-options').children.length, 1);
  key(from, 'Enter', { isComposing: true });
  assert.equal(from.value, '首都');
  key(from, 'ArrowDown');
  key(from, 'Enter');
  assert.equal(from.value, 'PEK 北京首都机场');
  assert.equal(JSON.parse(page.storage.get(core.STORAGE_KEY)).legs.length, 0);
});

test('train按需加载一次且缓存，异步返回不重开失焦或已切换类型的建议', async () => {
  let resolveStations;
  const calls = [];
  const page = pageFixture([], null, new Map(), { fetch: url => {
    calls.push(url);
    return new Promise(resolve => { resolveStations = resolve; });
  } });
  assert.equal(calls.length, 0);
  typePlace(page, 'from', 'pek');
  assert.equal(calls.length, 0);
  const form = page.get('leg-form');
  form.inputs.kind.value = 'train';
  form.inputs.kind.listeners.change();
  const from = typePlace(page, 'from', 'VnP');
  typePlace(page, 'to', 'bjn');
  assert.deepEqual(calls, ['/api/stations']);
  from.listeners.blur();
  resolveStations({ ok: true, json: async () => ({ status: 0, data: {
    VNP: { name: '北京南', code: 'VNP', pinyin: 'beijingnan', pinyinShort: 'bjn' },
  } }) });
  await flushSuggestions();
  assert.equal(page.get('place-from-options').hidden, true);
  assert.equal(page.get('place-to-options').children[0].textContent, '北京南 · VNP');
  for (const query of ['北京南', 'vNp', 'BEIJINGNAN', 'BjN']) {
    typePlace(page, 'from', query);
    await flushSuggestions();
    const option = page.get('place-from-options').children[0];
    assert.equal(option.textContent, '北京南 · VNP');
    option.listeners.click();
    assert.equal(from.value, '北京南');
  }
  assert.deepEqual(calls, ['/api/stations']);
  typePlace(page, 'from', 'bjn');
  form.inputs.kind.value = 'ground';
  form.inputs.kind.listeners.change();
  await flushSuggestions();
  assert.equal(page.get('place-from-options').hidden, true);
});

test('离线、坏站点响应和目录脚本失败时三个类型仍可自由手填并刷新恢复', async () => {
  for (const kind of ['flight', 'train', 'ground']) {
    for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => ({ ok: false }),
      async () => ({ ok: true, json: async () => ({ status: 1 }) })]) {
      const page = pageFixture([], null, new Map(), { fetch: fetchImpl });
      const form = fillManual(page, kind);
      typePlace(page, 'from', '未收录的自定义地点');
      await flushSuggestions();
      assert.equal(page.get('place-from-options').hidden, true);
      form.listeners.submit({ preventDefault() {} });
      const restored = core.loadState({ getItem: key => page.storage.get(key) });
      assert.equal(restored.legs[0].from, '未收录的自定义地点');
      assert.equal(restored.legs[0].kind, kind);
      assert.match(pageFixture(null, null, page.storage).get('timeline').textContent, /未收录的自定义地点/);
    }
    const page = pageFixture([], null, new Map(), { withoutPlaces: true, fetch: () => assert.fail('No network fallback') });
    const form = fillManual(page, kind);
    typePlace(page, 'from', '自定义国际机场');
    form.listeners.submit({ preventDefault() {} });
    assert.equal(core.loadState({ getItem: key => page.storage.get(key) }).legs[0].from, '自定义国际机场');
  }
});

test('历史航段详情及设置刷新和编辑后保留，取消编辑清空输入和建议', () => {
  const old = { ...flight, flightDetails: { source: 'Duffel', airline: '历史航司', operatingAirline: '承运航司',
    departureTerminal: 'T1', arrivalTerminal: 'T2', stops: [{ code: 'NKG', name: '南京禄口机场',
      arrival: '2026-11-20T12:00', departure: '2026-11-20T12:30' }] } };
  const page = pageFixture([old]);
  assert.match(page.get('timeline').textContent, /历史导入来源：Duffel/);
  const editButton = page.get('timeline').children[0].children[0].children.at(-1).children[0];
  editButton.listeners.click();
  const form = page.get('leg-form');
  typePlace(page, 'from', 'pek');
  page.get('cancel-edit').listeners.click();
  assert.equal(form.inputs.from.value, '');
  assert.equal(page.get('place-from-options').hidden, true);
  editButton.listeners.click();
  form.inputs.number.value = 'NEW123';
  form.listeners.submit({ preventDefault() {} });
  const saved = core.loadState({ getItem: key => page.storage.get(key) });
  assert.deepEqual(saved.legs[0].flightDetails, core.parseLeg(old).flightDetails);
  assert.equal(saved.legs[0].number, 'NEW123');
  assert.equal(saved.legs[0].departureOffset, '+09:00');
  assert.equal(saved.legs[0].arrivalOffset, '-08:00');
  assert.deepEqual(saved.settings, core.defaults);
});

