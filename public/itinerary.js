'use strict';

const core = window.ItineraryCore;
const byId = id => document.getElementById(id);
const legForm = byId('leg-form');
const settingsForm = byId('settings-form');
const field = name => legForm.elements.namedItem(name);
const types = { flight: '航班', train: '火车', ground: '地面接驳' };
const fields = ['kind', 'number', 'from', 'to', 'departure', 'arrival', 'departureOffset', 'arrivalOffset'];
let state = { legs: [], settings: { ...core.defaults } };
let editing = null;
let candidate = null;
let flightOffers = [];
let flightConfigured = false;
let flightSearching = false;

function message(id, text) {
  byId(id).textContent = text;
}

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function button(text, click) {
  const el = element('button', text);
  el.type = 'button';
  el.addEventListener('click', click);
  return el;
}

function save(next, success, target = 'timeline-status') {
  try {
    localStorage.setItem(core.STORAGE_KEY, JSON.stringify(next));
  } catch {
    message(target, '浏览器无法保存日程，请检查本地存储设置后重试。');
    return false;
  }
  state = next;
  message(target, success);
  render();
  return true;
}

function label(leg) {
  return `${types[leg.kind]}${leg.number ? ` ${leg.number}` : ''}`;
}

function legCard(leg) {
  const card = element('article', '', `leg ${leg.kind}`);
  card.append(element('h3', label(leg)), element('p', `${leg.from} → ${leg.to}`, 'route'));
  for (const [caption, local, offset] of [
    ['出发', leg.departure, leg.departureOffset],
    ['到达', leg.arrival, leg.arrivalOffset],
  ]) {
    const line = element('p', `${caption} `);
    const time = element('time', `${local.replace('T', ' ')}（UTC${offset}）`);
    time.dateTime = `${local}${offset}`;
    line.append(time);
    card.append(line);
  }
  const details = leg.flightDetails;
  if (details) {
    if (details.airline) card.append(element('p', `航司：${details.airline}${details.operatingAirline && details.operatingAirline !== details.airline ? `；实际承运：${details.operatingAirline}` : ''}`));
    if (details.departureTerminal || details.arrivalTerminal) card.append(element('p', `航站楼：${details.departureTerminal || '待确认'} → ${details.arrivalTerminal || '待确认'}`));
    for (const stop of details.stops) card.append(element('p', `经停 ${stop.code} ${stop.name}：${stop.arrival.replace('T', ' ')} 到达 / ${stop.departure.replace('T', ' ')} 出发（UTC+08:00），是否下机请向航司核对。`, 'note'));
    if (details.source === 'Duffel') card.append(element('p', '来自 Duffel 查询；保存不等于订票，请再次核对实际时刻。', 'note'));
  }
  return card;
}

function transferMessage(transfer) {
  const { previous, next, status, gapMinutes, minimumMinutes } = transfer;
  const prefix = `${label(previous)} → ${label(next)}：`;
  const samePlace = previous.to.trim().toLowerCase() === next.from.trim().toLowerCase();
  const arrivalTerminal = previous.flightDetails?.arrivalTerminal;
  const departureTerminal = next.flightDetails?.departureTerminal;
  const terminalChange = samePlace && arrivalTerminal && departureTerminal && arrivalTerminal !== departureTerminal;
  const note = !samePlace ? '两段地点不同，请核对地面接驳。' : terminalChange ? `航站楼不同（${arrivalTerminal} → ${departureTerminal}），请核对航站楼接驳。` : '';
  if (status === 'overlap') return element('p', `${prefix}时间冲突，后一段提前 ${-gapMinutes} 分钟出发。${note}`, 'gap overlap');
  if (status === 'short') {
    return element('p', `${prefix}仅有 ${gapMinutes} 分钟，少于预留的 ${minimumMinutes} 分钟。${note}`, 'gap short');
  }
  return element('p', `${prefix}间隔 ${gapMinutes} 分钟，达到预留时间。${note}`, samePlace && !terminalChange ? 'gap' : 'gap short');
}

function renderTimeline() {
  const items = [...state.legs].sort((a, b) => a.departureMs - b.departureMs);
  const transfers = new Map();
  for (const transfer of core.adjacentTransfers(items, state.settings)) {
    if (!transfers.has(transfer.next)) transfers.set(transfer.next, []);
    transfers.get(transfer.next).push(transfer);
  }
  byId('empty').hidden = items.length > 0;
  const list = byId('timeline');
  list.replaceChildren(...items.map(leg => {
    const row = element('li');
    if (transfers.has(leg)) row.append(...transfers.get(leg).map(transferMessage));
    const card = legCard(leg);
    const actions = element('div', '', 'actions');
    actions.append(button('编辑', () => edit(leg)), button('移除', () => {
      const next = { ...state, legs: state.legs.filter(item => item !== leg) };
      if (save(next, `已移除${label(leg)}。`)) {
        if (editing === leg) resetEditor();
        byId('timeline-title').focus();
      }
    }));
    card.append(actions);
    row.append(card);
    return row;
  }));
}

function isDuplicate(leg, omit = null) {
  return state.legs.some(item => item !== omit && core.legKey(item) === core.legKey(leg));
}

function renderCandidate() {
  byId('candidate').hidden = !candidate;
  if (!candidate) return;
  const content = byId('candidate-content');
  content.replaceChildren(legCard(candidate));
  const duplicate = isDuplicate(candidate);
  byId('accept-candidate').disabled = duplicate;
  if (duplicate) {
    content.append(element('p', '这趟车已经在日程中。', 'note'));
    return;
  }
  const comparisons = core.adjacentTransfers([...state.legs, candidate], state.settings)
    .filter(transfer => transfer.previous === candidate || transfer.next === candidate);
  if (comparisons.length) content.append(...comparisons.map(transferMessage));
  else content.append(element('p', '先添加一个航班或其他行程，即可比对接驳时间。', 'note'));
}

function render() {
  renderTimeline();
  renderCandidate();
  renderFlightOffers();
}

function renderFlightOffers() {
  const results = byId('flight-results');
  if (!results) return;
  results.replaceChildren(...flightOffers.map(offer => {
    const card = element('article', '', 'flight-offer');
    card.append(element('h3', `${offer.totalCurrency} ${offer.totalAmount} · ${offer.adults} 位成人经济舱总价`));
    const mode = offer.liveMode === false ? '测试模式，非真实可售航班。' : offer.liveMode === true ? '供应商生产报价，尚未经本站真实联测。' : '供应商未声明模式，尚未经真实联测。';
    card.append(element('p', `${mode} 报价可变，有效期至 ${offer.expiresAt.replace('T', ' ')}（UTC）；以重新查询及航司确认为准。`, 'note'));
    const segments = offer.segments.map(raw => core.parseLeg(raw));
    segments.forEach((leg, index) => {
      if (index > 0) {
        const previous = segments[index - 1];
        const gap = (leg.departureMs - previous.arrivalMs) / 60000;
        card.append(element('p', `中转 ${index}：${previous.to} → ${leg.from}，间隔 ${gap} 分钟。${previous.to !== leg.from ? '需要换机场，请补充实际地面接驳。' : '请核对航站楼、行李直挂及最晚登机时间。'}`, 'note flight-connection'));
      }
      card.append(legCard(leg));
    });
    const missing = segments.filter(leg => !isDuplicate(leg));
    const comparisons = core.adjacentTransfers([...state.legs, ...missing], state.settings)
      .filter(transfer => missing.includes(transfer.previous) || missing.includes(transfer.next));
    if (comparisons.length) {
      card.append(element('h4', '与现有日程及各航段的接驳比较'));
      card.append(...comparisons.map(transferMessage));
    }
    card.append(element('p', '达到预留时间不代表接驳已证实可行；请核对所有机场、车站、航站楼和地面交通。', 'note'));
    const expired = Date.parse(offer.expiresAt) <= Date.now();
    const add = button(!missing.length ? '所有航段已在日程中' : expired ? '报价已过期，请重新查询' : `将 ${missing.length} 段航班加入日程`, () => {
      if (Date.parse(offer.expiresAt) <= Date.now()) {
        message('flight-search-status', '此报价已过期，请重新查询，或按已确认票面手动录入。');
        renderFlightOffers();
        return;
      }
      const legs = segments.filter(leg => !isDuplicate(leg));
      if (legs.length) save({ ...state, legs: [...state.legs, ...legs] }, `已将 ${legs.length} 段航班加入日程；尚未订票。`, 'flight-search-status');
    });
    add.disabled = !missing.length || expired;
    card.append(add);
    return card;
  }));
}

async function checkFlightConfiguration() {
  flightConfigured = false;
  byId('flight-search-submit').disabled = true;
  if (!window.DomesticFlights) {
    message('flight-search-status', '机场列表仍可使用，但航班搜索组件未加载；请刷新页面或手动录入。');
    return;
  }
  message('flight-search-status', '正在检查航班搜索配置…');
  try {
    const response = await fetch('/api/domestic-flights/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || data.status !== 0 || typeof data.configured !== 'boolean') throw new Error();
    flightConfigured = data.configured;
    message('flight-search-status', flightConfigured ? '可查询国内单程报价；结果未经真实联测，覆盖取决于账号。' : '国内航班搜索未配置，请在下方手动录入航班。');
  } catch {
    message('flight-search-status', '无法检查航班服务，请稍后重试，或手动录入航班。');
  }
  byId('flight-search-submit').disabled = !flightConfigured || flightSearching || !window.DomesticFlights;
}

function configureFlightSearch() {
  const flights = window.DomesticFlights;
  const form = byId('flight-search-form');
  if (!form) return;

  // Airport options and dates are also present in HTML as a network-failure fallback.
  // Replace the inline list with the canonical list when the optional service loads.
  if (flights && Array.isArray(flights.airports)) {
    for (const id of ['flight-origin', 'flight-destination']) {
      const select = byId(id);
      const previous = select.value;
      select.replaceChildren(...flights.airports.map(airport => {
        const option = element('option', `${airport.code} · ${airport.name}`);
        option.value = airport.code;
        return option;
      }));
      select.value = flights.airports.some(airport => airport.code === previous) ? previous : id === 'flight-origin' ? 'PEK' : 'SHA';
    }
  }

  if (flights && typeof flights.searchDates === 'function') {
    Object.assign(byId('flight-date'), flights.searchDates(Date.now()));
  } else {
    const today = core.trainSearchDates(Date.now());
    const max = new Date(Date.parse(`${today.min}T00:00:00Z`) + 330 * 86400000).toISOString().slice(0, 10);
    Object.assign(byId('flight-date'), { min: today.min, value: today.value, max });
  }

  if (!flights || typeof flights.validateSearch !== 'function') {
    flightConfigured = false;
    byId('flight-search-submit').disabled = true;
    message('flight-search-status', '机场列表已就绪，但航班搜索组件未加载；请刷新页面或手动录入。');
    const retry = byId('flight-config-retry');
    retry.textContent = '刷新页面重试';
    retry.addEventListener('click', () => window.location.reload());
    return;
  }

  byId('flight-config-retry').addEventListener('click', checkFlightConfiguration);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!flightConfigured || flightSearching) return;
    let query;
    try {
      const values = Object.fromEntries(new FormData(form));
      query = flights.validateSearch({ ...values, adults: Number(values.adults), maxConnections: Number(values.maxConnections), limit: 10 }, Date.now());
    } catch {
      message('flight-search-status', '请选择列表内不同机场及有效日期，成人数需为1至6。');
      return;
    }
    flightSearching = true;
    byId('flight-search-submit').disabled = true;
    byId('flight-config-retry').disabled = true;
    flightOffers = [];
    renderFlightOffers();
    message('flight-search-status', '正在查询航班报价，请稍候…');
    try {
      const response = await fetch('/api/domestic-flights/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok || data.status !== 0) {
        if (data.code === 'NOT_CONFIGURED') flightConfigured = false;
        message('flight-search-status', data.code === 'NOT_CONFIGURED' ? '国内航班搜索未配置，请手动录入航班。' : '暂时无法查询航班，请稍后重试或手动录入。');
        return;
      }
      if (!Array.isArray(data.data?.offers)) throw new Error();
      flightOffers = data.data.offers.slice(0, 10);
      message('flight-search-status', flightOffers.length ? `找到 ${flightOffers.length} 个报价；${query.origin} → ${query.destination}，${query.departureDate}。报价及覆盖尚未经真实联测。` : '没有可显示的国内航班报价。空结果不代表该航线无航班，请另行核对或手动录入。');
      renderFlightOffers();
    } catch {
      flightOffers = [];
      renderFlightOffers();
      message('flight-search-status', '航班查询暂不可用，请稍后重试或手动录入。');
    } finally {
      flightSearching = false;
      byId('flight-search-submit').disabled = !flightConfigured || !window.DomesticFlights;
      byId('flight-config-retry').disabled = false;
    }
  });
  return checkFlightConfiguration();
}

function configureInputs() {
  const kind = field('kind').value;
  const number = field('number');
  number.required = kind !== 'ground';
  number.placeholder = { flight: '如 CA1831', train: '如 G123', ground: '如 机场大巴（选填）' }[kind];
  const isTrain = kind === 'train';
  message('number-label', { flight: '航班号', train: '车次号', ground: '接驳方式（选填）' }[kind]);
  for (const name of ['departureOffset', 'arrivalOffset']) {
    field(name).readOnly = isTrain;
    if (isTrain) field(name).value = '+08:00';
  }
}

function resetEditor() {
  editing = null;
  legForm.reset();
  configureInputs();
  message('form-title', '添加一段行程');
  message('save-leg', '添加到日程');
  message('form-error', '');
  byId('cancel-edit').hidden = true;
}

function edit(leg) {
  editing = leg;
  for (const name of fields) field(name).value = leg[name];
  configureInputs();
  message('form-title', `编辑${label(leg)}`);
  message('save-leg', '保存修改');
  message('form-error', '');
  byId('cancel-edit').hidden = false;
  byId('form-title').focus();
}

function readCandidate() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has('train')) return null;
  try {
    const data = fragment.get('train');
    if (data.length > 1000) throw new Error();
    const leg = core.parseLeg(JSON.parse(data));
    if (leg.kind !== 'train') throw new Error();
    return leg;
  } catch {
    message('timeline-status', '无法读取候选车次，请返回火车查询后重试。');
    return null;
  }
}

function dismissCandidate() {
  candidate = null;
  history.replaceState(null, '', location.pathname + location.search);
  renderCandidate();
  byId('timeline-title').focus();
}

legForm.addEventListener('submit', event => {
  event.preventDefault();
  try {
    const leg = core.parseLeg(Object.fromEntries(new FormData(legForm)));
    if (isDuplicate(leg, editing)) throw new Error('这段行程已存在。');
    const legs = editing ? state.legs.map(item => item === editing ? leg : item) : [...state.legs, leg];
    if (save({ ...state, legs }, `已保存${label(leg)}。`, 'form-error')) {
      resetEditor();
      message('timeline-status', `已保存${label(leg)}。`);
    }
  } catch (error) {
    message('form-error', error.message);
  }
});
field('kind').addEventListener('change', configureInputs);
byId('cancel-edit').addEventListener('click', resetEditor);

settingsForm.addEventListener('submit', event => {
  event.preventDefault();
  const entries = [...new FormData(settingsForm)].map(([key, value]) => [key, Number(value)]);
  save({ ...state, settings: core.normaliseSettings(Object.fromEntries(entries)) }, '已更新接驳预留。', 'settings-status');
});

byId('accept-candidate').addEventListener('click', () => {
  if (!candidate || isDuplicate(candidate)) return;
  if (save({ ...state, legs: [...state.legs, candidate] }, `已加入${label(candidate)}。`)) dismissCandidate();
});
byId('dismiss-candidate').addEventListener('click', dismissCandidate);

function readState() {
  try {
    state = core.loadState(localStorage);
  } catch {
    message('timeline-status', '浏览器无法读取已保存的日程。');
  }
  for (const [name, value] of Object.entries(state.settings)) settingsForm.elements.namedItem(name).value = value;
}

readState();
candidate = readCandidate();
configureInputs();
render();
configureFlightSearch();

window.addEventListener('storage', event => {
  if (event.key !== core.STORAGE_KEY && event.key !== null) return;
  if (editing) resetEditor();
  readState();
  render();
});
