'use strict';

const core = window.ItineraryCore;
const byId = id => document.getElementById(id);
const legForm = byId('leg-form');
const settingsForm = byId('settings-form');
const field = name => legForm.elements.namedItem(name);
const types = { flight: '航班', train: '火车', ground: '地面接驳' };
const fields = ['kind', 'number', 'from', 'to'];
let state = { legs: [], settings: { ...core.defaults } };
let editing = null;
let candidate = null;
const places = window.PlaceSuggestions;
const placeEditors = [];
let stationRequest;

function loadStations() {
  if (!stationRequest) {
    stationRequest = fetch('/api/stations').then(response => {
      if (!response.ok) throw new Error('stations unavailable');
      return response.json();
    }).then(result => result.status === 0 ? places.stationsFrom(result.data) : [])
      .catch(() => []);
  }
  return stationRequest;
}

function setupPlaceInput(name) {
  const input = field(name);
  const list = byId(`place-${name}-options`);
  let matches = [];
  let active = -1;
  let focused = false;
  let composing = false;
  let revision = 0;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  function close() {
    revision++;
    matches = [];
    active = -1;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function highlight(index) {
    active = index;
    for (const [i, option] of [...list.children].entries()) option.setAttribute('aria-selected', String(i === active));
    const option = list.children[active];
    if (option) {
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    if (!matches[index]) return;
    input.value = matches[index].value;
    close();
  }
  async function suggest() {
    close();
    const current = revision;
    const kind = field('kind').value;
    if (!places || !focused || composing || kind === 'ground' || !input.value.trim()) return;
    const catalogue = kind === 'flight' ? places.airports : await loadStations();
    if (current !== revision || !focused || composing || kind !== field('kind').value) return;
    matches = places.match(catalogue, input.value);
    list.replaceChildren(...matches.map((place, index) => {
      const option = element('li', place.label);
      option.id = `place-${name}-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      // Keep the input focused until click, including touch-generated clicks.
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => choose(index));
      return option;
    }));
    list.hidden = matches.length === 0;
    input.setAttribute('aria-expanded', String(matches.length > 0));
  }
  input.addEventListener('focus', () => { focused = true; suggest(); });
  input.addEventListener('blur', () => { focused = false; close(); });
  input.addEventListener('input', suggest);
  input.addEventListener('compositionstart', () => { composing = true; close(); });
  input.addEventListener('compositionend', () => { composing = false; suggest(); });
  input.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' || event.key === 'Tab') { close(); return; }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
      event.preventDefault();
      highlight(active < 0 ? (event.key === 'ArrowDown' ? 0 : matches.length - 1)
        : (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === 'Enter' && matches.length) {
      // Opening the list never confirms its first item or submits the form.
      event.preventDefault();
      if (active >= 0) choose(active);
    }
  });
  return { close, isComposing: () => composing };
}

for (const name of ['from', 'to']) placeEditors.push(setupPlaceInput(name));

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
  for (const [caption, instant] of [
    ['出发', leg.departureMs],
    ['到达', leg.arrivalMs],
  ]) {
    const local = core.beijingDateTime(instant);
    const line = element('p', `${caption} `);
    const time = element('time', local.replace('T', ' '));
    time.dateTime = `${local}+08:00`;
    line.append(time);
    card.append(line);
  }
  const details = leg.flightDetails;
  if (details) {
    if (details.airline) card.append(element('p', `航司：${details.airline}${details.operatingAirline && details.operatingAirline !== details.airline ? `；实际承运：${details.operatingAirline}` : ''}`));
    if (details.departureTerminal || details.arrivalTerminal) card.append(element('p', `航站楼：${details.departureTerminal || '待确认'} → ${details.arrivalTerminal || '待确认'}`));
    for (const stop of details.stops) card.append(element('p', `经停 ${stop.code} ${stop.name}：${stop.arrival.replace('T', ' ')} 到达 / ${stop.departure.replace('T', ' ')} 出发（北京时间），是否下机请向航司核对。`, 'note'));
    if (details.source === 'Duffel') card.append(element('p', '历史导入来源：Duffel；保存不等于订票，请再次核对实际时刻。', 'note'));
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
}

function configureInputs() {
  for (const editor of placeEditors) editor.close();
  const kind = field('kind').value;
  const number = field('number');
  number.required = kind !== 'ground';
  number.placeholder = { flight: '如 CA1831', train: '如 G123', ground: '如 机场大巴（选填）' }[kind];
  message('number-label', { flight: '航班号', train: '车次号', ground: '接驳方式（选填）' }[kind]);
}

function defaultEditorDates() {
  const today = core.trainSearchDates(Date.now()).min;
  field('departureDate').value = today;
  field('arrivalDate').value = today;
}

for (const name of ['departure', 'arrival']) {
  byId(`${name}-today`).addEventListener('click', () => {
    field(`${name}Date`).value = core.trainSearchDates(Date.now()).min;
  });
}

function resetEditor() {
  editing = null;
  legForm.reset();
  configureInputs();
  defaultEditorDates();
  message('form-title', '添加一段行程');
  message('save-leg', '添加到日程');
  message('form-error', '');
  byId('cancel-edit').hidden = true;
}

function edit(leg) {
  editing = leg;
  for (const name of fields) field(name).value = leg[name];
  const departure = core.beijingDateTime(leg.departureMs);
  const arrival = core.beijingDateTime(leg.arrivalMs);
  field('departureDate').value = departure.slice(0, 10);
  field('departureTime').value = departure.slice(11);
  field('arrivalDate').value = arrival.slice(0, 10);
  field('arrivalTime').value = arrival.slice(11);
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
  if (event.isComposing || placeEditors.some(editor => editor.isComposing())) return;
  try {
    const raw = Object.fromEntries(new FormData(legForm));
    raw.departure = `${raw.departureDate}T${raw.departureTime}`;
    raw.arrival = `${raw.arrivalDate}T${raw.arrivalTime}`;
    raw.departureOffset = '+08:00';
    raw.arrivalOffset = '+08:00';
    if (editing?.kind === 'flight' && raw.kind === 'flight') raw.flightDetails = editing.flightDetails;
    const leg = core.parseLeg(raw);
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
defaultEditorDates();
render();

window.addEventListener('storage', event => {
  if (event.key !== core.STORAGE_KEY && event.key !== null) return;
  if (editing) resetEditor();
  readState();
  render();
});
