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
  return card;
}

function transferMessage(transfer) {
  const { previous, next, status, gapMinutes, minimumMinutes } = transfer;
  const prefix = `${label(previous)} → ${label(next)}：`;
  const samePlace = previous.to.trim().toLowerCase() === next.from.trim().toLowerCase();
  const note = samePlace ? '' : '两段地点不同，请核对地面接驳。';
  if (status === 'overlap') return element('p', `${prefix}时间冲突，后一段提前 ${-gapMinutes} 分钟出发。${note}`, 'gap overlap');
  if (status === 'short') {
    return element('p', `${prefix}仅有 ${gapMinutes} 分钟，少于预留的 ${minimumMinutes} 分钟。${note}`, 'gap short');
  }
  return element('p', `${prefix}间隔 ${gapMinutes} 分钟，达到预留时间。${note}`, samePlace ? 'gap' : 'gap short');
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

window.addEventListener('storage', event => {
  if (event.key !== core.STORAGE_KEY && event.key !== null) return;
  if (editing) resetEditor();
  readState();
  render();
});
