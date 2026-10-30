const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 支持（方便其他前端接入）
try {
  const cors = require('cors');
  app.use(cors());
} catch(e) { /* cors not installed, skip */ }

// 简单gzip
try {
  const compression = require('compression');
  app.use(compression());
} catch(e) {
  // compression not installed, skip
}

const API_BASE = 'https://kyfw.12306.cn';

// 更真实的浏览器指纹
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 完整的请求头模板
function buildHeaders(cookie, extra = {}) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': 'https://kyfw.12306.cn/otn/leftTicket/init',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

// ========== 并发控制 ==========
// 12306 查询是 IO 密集型：瓶颈在"等响应"，不在"算"，所以用异步并发就够
// （Node 单线程 + 非阻塞 IO），不需要 worker_threads 那种真多线程。
// 旧实现是"距上次请求不足 300ms 就等"的开关，同批到达的请求会一起跳过等待、
// 一起打 12306（实测 8 个并发只用 0.43s，说明它根本没排队）。现在改成
// "信号量 + 最小间隔"：真正限制在途请求数，既加速又不会把 12306 打爆。
// 环境变量可调：MAX_CONCURRENCY（默认 4）、MIN_REQUEST_INTERVAL（默认 150ms）
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.MAX_CONCURRENCY || '4', 10));
const MIN_REQUEST_INTERVAL = Math.max(0, parseInt(process.env.MIN_REQUEST_INTERVAL || '150', 10));

// 被 12306 限流时（返回 302）进入全局冷却，避免越撞越死
let cooldownUntil = 0;
function triggerCooldown(ms) {
  const until = Date.now() + ms;
  if (until > cooldownUntil) {
    cooldownUntil = until;
    console.log(`⏸️ 12306 疑似限流，全局冷却 ${ms}ms`);
  }
}

let activeRequests = 0;      // 在途请求数
let lastRequestTime = 0;     // 上次放行时刻
const waitingSlots = [];     // 排队等待放行的 resolve
let drainTimer = null;

function pumpQueue() {
  if (drainTimer) return;
  if (activeRequests >= MAX_CONCURRENCY || waitingSlots.length === 0) return;

  const earliest = Math.max(lastRequestTime + MIN_REQUEST_INTERVAL, cooldownUntil);
  const wait = earliest - Date.now();
  if (wait > 0) {
    drainTimer = setTimeout(() => { drainTimer = null; pumpQueue(); }, wait);
    return;
  }

  const resolve = waitingSlots.shift();
  activeRequests++;
  lastRequestTime = Date.now();
  resolve();
  if (activeRequests < MAX_CONCURRENCY && waitingSlots.length > 0) pumpQueue();
}

function acquireSlot() {
  return new Promise(resolve => { waitingSlots.push(resolve); pumpQueue(); });
}

async function throttledFetch(url, options) {
  await acquireSlot();
  try {
    return await fetch(url, options);
  } finally {
    activeRequests--;
    pumpQueue();
  }
}

// ========== 查询缓存 ==========
// 多策略会反复查同一个区间（同车换乘/买长乘短/买短乘长 都会回到原区间），
// 60 秒内直接复用结果：既快，又大幅减少打到 12306 的请求数（降低被限流概率）。
// 环境变量 QUERY_CACHE_TTL 可关（设为 0）或调整 TTL
const QUERY_CACHE_TTL = Math.max(0, parseInt(process.env.QUERY_CACHE_TTL || '60000', 10));
const QUERY_CACHE_MAX = 500;
const queryCache = new Map();

function cacheKeyOf(from, to, date) { return from + '|' + to + '|' + date; }

function cacheGet(from, to, date) {
  if (!QUERY_CACHE_TTL) return null;
  const k = cacheKeyOf(from, to, date);
  const hit = queryCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.t > QUERY_CACHE_TTL) { queryCache.delete(k); return null; }
  return hit.value;
}

function cacheSet(from, to, date, value) {
  if (!QUERY_CACHE_TTL) return;
  const k = cacheKeyOf(from, to, date);
  queryCache.set(k, { t: Date.now(), value });
  if (queryCache.size > QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    queryCache.delete(oldest);
  }
}

// ========== Cookie 管理（核心修复） ==========
let cookieJar = {};        // key-value cookie store
let cookieTime = 0;
const COOKIE_TTL = 180000; // 3分钟刷新
let cookiePromise = null;

// 解析 set-cookie 头，更新 cookie jar
function parseCookies(setCookies) {
  if (!setCookies) return;
  const list = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const raw of list) {
    // "JSESSIONID=xxx; Path=/otn; HttpOnly" → 提取 key=value
    const parts = raw.split(';')[0].trim();
    const eqIdx = parts.indexOf('=');
    if (eqIdx > 0) {
      const key = parts.slice(0, eqIdx).trim();
      const val = parts.slice(eqIdx + 1).trim();
      if (val && val !== 'deleted') {
        cookieJar[key] = val;
      }
    }
  }
}

// ========== 额外 Cookie（可选，用来"加 cookie"） ==========
// 余票查询本身不需要登录，程序访问 init 页就能拿到 JSESSIONID 等 3 个 cookie。
// 如果 12306 开始频繁 302，可以把你浏览器里的完整 cookie 粘进来补充：
//   方式1：项目根目录建 cookie.txt，一行字符串，如 RAIL_DEVICEID=xxx; RAIL_EXPIRATION=yyy
//   方式2：启动前设环境变量 COOKIE_EXTRA="同样的格式"
// 规则：只补缺，不覆盖程序自己拿到的会话 cookie（避免粘了个过期 JSESSIONID 反而挂掉）
const EXTRA_COOKIE_FILE = path.join(__dirname, 'cookie.txt');
let extraCookieCache = { fromFile: '', mtime: 0 };

function getExtraCookies() {
  let fromFile = extraCookieCache.fromFile;
  try {
    const st = fs.statSync(EXTRA_COOKIE_FILE);
    if (st.mtimeMs !== extraCookieCache.mtime) {
      fromFile = fs.readFileSync(EXTRA_COOKIE_FILE, 'utf8').trim().replace(/^cookie:\s*/i, '');
      extraCookieCache = { fromFile, mtime: st.mtimeMs };
      console.log(`🍪 已加载 cookie.txt（${fromFile.length} 字符）`);
    }
  } catch (e) { /* 没有 cookie.txt 就走自动获取 */ }

  const fromEnv = (process.env.COOKIE_EXTRA || '').trim().replace(/^cookie:\s*/i, '');
  return [fromEnv, fromFile].filter(Boolean).join('; ');
}

function getCookieString() {
  const jar = { ...cookieJar };
  for (const pair of getExtraCookies().split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v && !(k in jar)) jar[k] = v;  // 只补缺，不覆盖
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function refreshCookies() {
  try {
    console.log('🍪 Refreshing cookies from 12306...');

    // 访问余票查询页面获取session cookie（这一步就够了）
    const resp = await fetch('https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc', {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      redirect: 'follow',
      timeout: 15000,
    });

    // 收集所有 Set-Cookie
    let setCookies = [];
    if (resp.headers.raw) {
      const raw = resp.headers.raw();
      setCookies = raw['set-cookie'] || [];
    } else {
      const sc = resp.headers.get('set-cookie');
      if (sc) setCookies = [sc];
    }
    parseCookies(setCookies);

    cookieTime = Date.now();
    console.log(`🍪 Cookies refreshed. Keys: ${Object.keys(cookieJar).join(', ')}`);
    return getCookieString();
  } catch (e) {
    console.error('Cookie refresh failed:', e.message);
    return getCookieString();
  }
}

async function getCookies() {
  const now = Date.now();
  if (Object.keys(cookieJar).length > 0 && (now - cookieTime) < COOKIE_TTL) {
    return getCookieString();
  }
  if (cookiePromise) return cookiePromise;
  cookiePromise = refreshCookies().finally(() => { cookiePromise = null; });
  return cookiePromise;
}

// 强制刷新cookie（302时调用）— 不清空旧cookie，只追加新cookie
async function forceRefreshCookies() {
  cookieTime = 0;
  cookiePromise = null;
  return getCookies();
}

// ========== 车站数据 ==========
let stationCache = null;
let stationCacheTime = 0;

function parseStationData(text) {
  const stations = {};
  // 12306格式: @shortCode|站名|电报码|拼音全拼|拼音首字母|索引|...
  const regex = /@([^\|]+)\|([^\|]+)\|([^\|]+)\|([^\|]+)\|([^\|]+)\|([^\|]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const [, shortCode, name, code, pinyin, pinyinShort, index] = match;
    stations[code] = { name, code, pinyin, pinyinShort, index: parseInt(index) };
  }
  return stations;
}

app.get('/api/stations', async (req, res) => {
  try {
    const now = Date.now();
    if (stationCache && (now - stationCacheTime) < 3600000) {
      return res.json({ status: 0, data: stationCache });
    }
    const cookies = await getCookies();
    const resp = await fetch(`${API_BASE}/otn/resources/js/framework/station_name.js?station_version=1.9306`, {
      headers: buildHeaders(cookies),
      timeout: 10000,
    });
    const text = await resp.text();
    const stations = parseStationData(text);
    stationCache = stations;
    stationCacheTime = now;
    res.json({ status: 0, data: stations });
  } catch (err) {
    console.error('Stations failed:', err.message);
    res.status(500).json({ status: 1, error: '获取车站数据失败: ' + err.message });
  }
});

// ========== 余票查询（核心修复） ==========
app.get('/api/ticket', async (req, res) => {
  const { from, to, date } = req.query;
  if (!from || !to || !date) {
    return res.status(400).json({ status: 1, error: '缺少参数: from, to, date' });
  }

  // 命中缓存直接返回（多策略会反复查同一个区间）
  const cachedTicket = cacheGet(from, to, date);
  if (cachedTicket) {
    return res.json(cachedTicket);
  }

  const maxRetries = 4;
  let lastErr = '';

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const cookies = await getCookies();
      const url = `${API_BASE}/otn/leftTicket/queryG?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`;

      const resp = await throttledFetch(url, {
        headers: buildHeaders(cookies),
        redirect: 'manual',
        timeout: 15000,
      });

      // 302 = cookie过期，从302响应收集cookie后重试
      if (resp.status === 302) {
        console.log(`⚠️ Attempt ${attempt + 1}: Got 302, collecting cookies from redirect...`);
        // 从302响应收集新cookie
        const raw302 = resp.headers.raw ? resp.headers.raw() : {};
        parseCookies(raw302['set-cookie'] || resp.headers.get('set-cookie'));
        // 跟随重定向目标也收集cookie
        const loc = resp.headers.get('location') || '';
        if (loc) {
          try {
            const fullUrl = loc.startsWith('http') ? loc : `https://kyfw.12306.cn${loc}`;
            const rResp = await fetch(fullUrl, {
              headers: { 'User-Agent': UA, 'Cookie': getCookieString() },
              redirect: 'follow', timeout: 10000,
            });
            const rRaw = rResp.headers.raw ? rResp.headers.raw() : {};
            parseCookies(rRaw['set-cookie'] || rResp.headers.get('set-cookie'));
          } catch(e) { /* ignore */ }
        }
        // 也从init页刷新
        await forceRefreshCookies();
        lastErr = 'Cookie expired, refreshed';
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      if (resp.status !== 200) {
        lastErr = `HTTP ${resp.status}`;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // 收集响应中的新cookie
      const rawHeaders = resp.headers.raw ? resp.headers.raw() : {};
      parseCookies(rawHeaders['set-cookie'] || resp.headers.get('set-cookie'));

      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        // 可能返回了HTML（验证码页面）
        if (text.includes('captcha') || text.includes('验证') || text.includes('<html')) {
          lastErr = '12306要求验证码或返回了非JSON数据';
          // 尝试刷新cookie
          await forceRefreshCookies();
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        lastErr = `Invalid JSON: ${text.substring(0, 100)}`;
        continue;
      }

      // 详细日志：记录12306返回的数据结构
      const dataKeys = Object.keys(data);
      const hasData = !!data.data;
      const dataType = typeof data.data;
      const dataDataKeys = hasData && typeof data.data === 'object' ? Object.keys(data.data) : [];
      const hasResult = hasData && data.data.result !== undefined;
      const resultIsArray = hasResult && Array.isArray(data.data.result);
      const resultLen = resultIsArray ? data.data.result.length : 'N/A';
      console.log(`📊 12306 response: keys=[${dataKeys}], httpstatus=${data.httpstatus}, data.type=${dataType}, data.keys=[${dataDataKeys}], result=${hasResult}, isArray=${resultIsArray}, len=${resultLen}`);

      // 安全获取 result 数组（兼容多种响应格式）
      let resultArr = null;
      if (data.data && Array.isArray(data.data.result)) {
        resultArr = data.data.result;
      } else if (data.data && typeof data.data === 'object' && !data.data.result) {
        // data.data 存在但没有 result — 可能格式变了
        console.warn('⚠️ data.data exists but no result field. data.data keys:', Object.keys(data.data));
        console.warn('⚠️ data.data sample:', JSON.stringify(data.data).substring(0, 500));
      }

      if (resultArr && resultArr.length > 0) {
        try {
          const parsed = parseTicketData(data.data);
          // 只返回有票且可购买的车次
          const available = parsed.filter(t => t.canBuy && hasTicketFn(t));
          const allCount = parsed.length;
          console.log(`✅ Ticket query OK: ${allCount} trains, ${available.length} with tickets (${from}→${to})`);
          const payload = { status: 0, data: parsed, availableCount: available.length, totalCount: allCount };
          cacheSet(from, to, date, payload);
          return res.json(payload);
        } catch (parseErr) {
          console.error('❌ parseTicketData failed:', parseErr.message, parseErr.stack);
          lastErr = '数据解析失败: ' + parseErr.message;
          continue;
        }
      }

      // 返回了200但没有数据
      if (resultArr && resultArr.length === 0) {
        return res.json({ status: 0, data: [], availableCount: 0, totalCount: 0 });
      }

      // data.data 不存在或为 null
      if (!data.data) {
        console.warn('⚠️ 12306 response has no data field. Full response:', JSON.stringify(data).substring(0, 500));
        lastErr = `12306未返回数据 (httpstatus: ${data.httpstatus})`;
        continue;
      }

      lastErr = `No results (httpstatus: ${data.httpstatus}, messages: ${JSON.stringify(data.messages || '')})`;
    } catch (err) {
      lastErr = err.message;
      console.error(`Ticket query attempt ${attempt + 1} failed:`, err.message);
    }
  }

  console.error('Ticket query failed after retries:', lastErr);
  res.json({ status: 1, error: '查询失败: ' + lastErr });
});

// 判断是否有票的函数（服务端版本）
function hasTicketFn(t) {
  if (!t) return false;
  // 先检查常规席位（二等/硬座/无座）
  const commonSeats = ['second', 'hardSeat', 'noSeat'];
  for (const k of commonSeats) {
    const v = t[k];
    if (v && v !== '无' && v !== '--' && v !== '') return true;
  }
  // 高铁/动车检查一等座和商务座
  const trainNo = t.trainNo || t.trainCode || '';
  const tp = trainNo.charAt(0).toUpperCase();
  if (tp === 'G' || tp === 'D' || tp === 'C') {
    for (const k of ['first', 'business']) {
      const v = t[k];
      if (v && v !== '无' && v !== '--' && v !== '') return true;
    }
  }
  // 普通列车检查卧铺
  for (const k of ['softSleep', 'hardSleep']) {
    const v = t[k];
    if (v && v !== '无' && v !== '--' && v !== '') return true;
  }
  return false;
}

// ========== 解析票价串（yp_ex_str）获取真实票价 ==========
// 注意：12306 已不再在 yp_info(fields[12]) 里放票价 —— 该字段现在是一段 64 字符的加密串，
// 按旧的"每10字符取6位价格"解析必然得到空对象。真实票价改放在 yp_ex_str(fields[39])。
// 格式：每 10 个字符一组，代表一种席别
//   第0位  ：席别代码（9=商务座 M=一等座 O=二等座 D=动卧 4=软卧 3=硬卧 1=硬座 W=无座）
//   第1-4位：票价整数部分（元）
//   第5位  ：票价小数部分（角）
//   第6位  ：标志（0=正常席别，3=无座，票价为同席别价格）
//   第7-9位：余票数量
// 例：9199500001M092900021O055300021O055303000
//     → 商务座1995元(1张) / 一等座929元(21张) / 二等座553元(21张) / 无座553元(0张)
const PRICE_CHUNK = /^[0-9A-Z]\d{4}\d[03]\d{3}$/;

const PRICE_SEAT_MAP = {
  '9': 'business',   // 商务座
  'S': 'business',   // 商务座（备用代码）
  'M': 'first',      // 一等座
  'O': 'second',     // 二等座
  'P': 'special',    // 特等座
  '6': 'highSoft',   // 高级软卧
  '4': 'softSleep',  // 软卧
  '3': 'hardSleep',  // 硬卧
  '1': 'hardSeat',   // 硬座
  'D': 'dongwo',     // 动卧（G/C 车次）
  'J': 'dongwo',     // 动卧上铺（D 车次）
  'I': 'dongwo',     // 动卧下铺（D 车次）
};

function isPriceString(s) {
  if (typeof s !== 'string' || s.length < 10 || s.length % 10 !== 0) return false;
  for (let i = 0; i < s.length; i += 10) {
    if (!PRICE_CHUNK.test(s.slice(i, i + 10))) return false;
  }
  return true;
}

// 优先取 yp_ex_str(fields[39])；字段顺序变动时，回退到"段数与 yp_ex 席别数一致"的字段
function findPriceString(fields) {
  if (isPriceString(fields[39])) return fields[39];
  const ypEx = fields[34] || '';
  const seatCount = Math.floor(ypEx.length / 2);
  for (let i = 0; i < fields.length; i++) {
    const s = fields[i];
    if (isPriceString(s) && (!seatCount || s.length / 10 === seatCount)) return s;
  }
  return '';
}

function parseYpExStr(priceStr) {
  const prices = {};
  if (!priceStr || priceStr.length % 10 !== 0) return prices;

  for (let i = 0; i + 10 <= priceStr.length; i += 10) {
    const chunk = priceStr.substr(i, 10);
    if (!PRICE_CHUNK.test(chunk)) continue;

    const price = parseInt(chunk.substr(1, 4), 10) + parseInt(chunk[5], 10) / 10;
    let seatType = PRICE_SEAT_MAP[chunk[0]];
    if (chunk[6] === '3') seatType = 'noSeat'; // 标志3 = 无座

    if (seatType && !isNaN(price) && price > 0 && !(seatType in prices)) {
      prices[seatType] = Math.round(price * 10) / 10; // 保留一位小数（12306 票价可能带 .5）
    }
  }

  // 动卧在 12306 的 D 字头车次里就是"软卧"，但前端没有动卧列，兜底成软卧价
  if (prices.dongwo && !('softSleep' in prices)) {
    prices.softSleep = prices.dongwo;
  }

  return prices;
}

// ========== 解析车次 ==========
function parseTicketData(data) {
  const stationMap = data.map || {};
  return (data.result || []).map(item => {
    const fields = item.split('|');
    const canBuy = fields[11] === 'Y';
    const fromStationCode = fields[6];
    const toStationCode = fields[7];
    const fromName = stationMap[fromStationCode] || fromStationCode;
    const toName = stationMap[toStationCode] || toStationCode;

    // 从 yp_ex_str 解析真实票价（旧 yp_info 已改为加密串，不再含票价）
    const prices = parseYpExStr(findPriceString(fields));

    function fmt(val) {
      if (!val || val === '' || val === '无') return '无';
      if (val === '有') return '有';
      if (val === '***') return '--';
      const n = parseInt(val);
      if (!isNaN(n)) return n > 0 ? `${n}` : '无';
      return val;
    }

    return {
      trainNo: fields[3],
      trainCode: fields[2],
      secret: fields[0],
      fromStation: fromName,
      fromStationCode,
      toStation: toName,
      toStationCode,
      startTime: fields[8],
      arriveTime: fields[9],
      duration: fields[10],
      canBuy,
      startDate: fields[13],
      trainLocation: fields[15],
      business: fmt(fields[32]),
      first: fmt(fields[31]),
      second: fmt(fields[30]),
      softSleep: fmt(fields[23]),
      hardSleep: fmt(fields[28]),
      hardSeat: fmt(fields[29]),
      noSeat: fmt(fields[33]),
      prices, // 真实票价（从 yp_ex_str 解析）
    };
  });
}

// ========== 中转换乘搜索（支持跨日期，流式进度） ==========
app.get('/api/transfer', async (req, res) => {
  const { from, to, date, date2, transferStation } = req.query;
  if (!from || !to || !date) {
    return res.status(400).json({ status: 1, error: '缺少参数: from, to, date' });
  }

  // 流式响应：设置 headers
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 不缓冲

  function sendEvent(obj) {
    res.write(JSON.stringify(obj) + '\n');
  }

  // 计算第二天日期
  function nextDay(d) {
    const dt = new Date(d + 'T00:00:00+08:00');
    dt.setDate(dt.getDate() + 1);
    return dt.toISOString().split('T')[0];
  }
  const dateNext = date2 || nextDay(date);

  // 根据第一段的出发时间、到达时间和duration，计算实际到达日期
  // startDate 格式为 "YYYYMMDD"（12306 返回），是第一段的出发日期
  // duration 格式为 "HH:MM"（小时可能超过24，如 "28:30"）
  function computeArrivalDate(startDateStr, startTimeStr, arriveTimeStr, durationStr) {
    const y = parseInt(startDateStr.substring(0, 4));
    const m = parseInt(startDateStr.substring(4, 6));
    const d = parseInt(startDateStr.substring(6, 8));

    const depH = parseInt(startTimeStr.split(':')[0]);
    const depM = parseInt(startTimeStr.split(':')[1]);
    const arrH = parseInt(arriveTimeStr.split(':')[0]);
    const arrM = parseInt(arriveTimeStr.split(':')[1]);

    const depMinutes = depH * 60 + depM;
    const arrMinutes = arrH * 60 + arrM;

    // 使用 duration 字段精确计算跨日天数
    // 12306 的 duration 格式为 "HH:MM"，小时可超过24（如 "28:30"）
    let dayOffset = 0;
    if (durationStr) {
      const durParts = durationStr.split(':');
      const durH = parseInt(durParts[0]) || 0;
      const durM = parseInt(durParts[1]) || 0;
      const totalDurMinutes = durH * 60 + durM;
      // 用总行程时间推算跨日天数
      dayOffset = Math.floor(totalDurMinutes / 1440);
      // 如果到达时刻 < 出发时刻，说明时间显示上跨了午夜，确保至少 +1 天
      if (arrMinutes < depMinutes && dayOffset === 0) {
        dayOffset = 1;
      }
    } else {
      // 没有 duration 时退回到旧逻辑
      if (arrMinutes < depMinutes) {
        dayOffset = 1;
      }
    }

    // 使用 UTC 计算避免服务器时区影响（12306 数据均为北京时间 UTC+8）
    // 先转为 UTC 时间戳（减去8小时偏移），加上天数偏移，再转回 UTC+8
    const baseMs = Date.UTC(y, m - 1, d) - 8 * 3600000;
    const resultMs = baseMs + dayOffset * 86400000 + 8 * 3600000;
    const resultDate = new Date(resultMs);
    const ry = resultDate.getUTCFullYear();
    const rm = String(resultDate.getUTCMonth() + 1).padStart(2, '0');
    const rd = String(resultDate.getUTCDate()).padStart(2, '0');
    return `${ry}-${rm}-${rd}`;
  }

  // 计算两个日期之间的天数差
  function daysBetween(date1Str, date2Str) {
    const d1 = new Date(date1Str + 'T00:00:00+08:00');
    const d2 = new Date(date2Str + 'T00:00:00+08:00');
    return Math.round((d2 - d1) / 86400000);
  }

  try {
    // 获取站点数据
    let stations = stationCache;
    if (!stations) {
      const cookies = await getCookies();
      const resp = await fetch(`${API_BASE}/otn/resources/js/framework/station_name.js?station_version=1.9306`, {
        headers: buildHeaders(cookies), timeout: 10000,
      });
      stations = parseStationData(await resp.text());
      stationCache = stations;
    }

    const majorHubs = [
      '济南西', '济南', '济南东', '徐州东', '徐州', '南京南', '南京',
      '郑州东', '郑州', '石家庄', '武汉', '长沙南', '长沙',
      '合肥南', '合肥', '天津南', '天津', '沈阳北', '沈阳',
      '哈尔滨西', '哈尔滨', '长春西', '长春', '大连北', '大连',
      '西安北', '西安', '成都东', '成都', '重庆西', '重庆',
      '贵阳北', '贵阳', '昆明南', '昆明', '南宁东', '南宁',
      '广州南', '广州', '深圳北', '深圳', '杭州东', '杭州',
      '上海虹桥', '上海', '南昌西', '南昌', '福州南', '福州',
      '太原南', '太原', '呼和浩特东', '呼和浩特', '兰州西', '兰州',
      '乌鲁木齐', '银川', '西宁',
    ];

    let transferCandidates = [];
    if (transferStation) {
      const tsCode = stations[transferStation]?.code;
      if (tsCode) {
        transferCandidates = [{ name: transferStation, code: tsCode }];
      } else {
        const found = Object.values(stations).find(s => s.name === transferStation);
        if (found) transferCandidates = [found];
      }
    } else {
      transferCandidates = majorHubs
        .map(name => {
          const s = Object.values(stations).find(st => st.name === name);
          return s ? { name: s.name, code: s.code } : null;
        })
        .filter(Boolean);
    }

    // 枢纽去重：济南西/济南/济南东 同属一城，只留第一个；
    // 并排除与出发地/目的地同城的枢纽（北京→上海 里经上海换乘没有意义）
    // 注意：城市名本身可能以方位字结尾（济南、南京），所以只在长度≥3时去掉尾字
    function cityKey(name) {
      let s = String(name || '').trim();
      s = s.replace(/虹桥$/, '');           // 上海虹桥 → 上海
      if (s.length >= 3) s = s.replace(/[东西南北站]$/, '');  // 济南西 → 济南，济南 保持不变
      return s;
    }
    const fromCity = cityKey((stations[from] || {}).name || '');
    const toCity = cityKey((stations[to] || {}).name || '');

    let hubPool = transferCandidates;
    if (!transferStation) {
      const seenCity = new Set();
      hubPool = transferCandidates.filter(s => {
        const key = cityKey(s.name);
        if (!key) return true;
        if (key === fromCity || key === toCity) return false;  // 同城不换乘
        if (seenCity.has(key)) return false;                   // 同城枢纽去重
        seenCity.add(key);
        return true;
      });
    }

    const results = [];
    const maxTransferChecks = transferStation ? 1 : 20;
    const hubsToCheck = hubPool.slice(0, maxTransferChecks);
    const HUB_CONCURRENCY = Math.max(1, parseInt(process.env.HUB_CONCURRENCY || '5', 10));

    // 单个枢纽：第一段 + 第二段（当天/次日/第三天，三天并发），返回可换乘组合
    async function checkHub(hub) {
      try {
        // 第一段：from → 中转站（出发日期），命中缓存则不再打 12306
        let leg1 = null;
        const cached1 = cacheGet(from, hub.code, date);
        if (cached1) {
          leg1 = cached1.data;
        } else {
          const cookies1 = await getCookies();
          const url1 = `${API_BASE}/otn/leftTicket/queryG?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${hub.code}&purpose_codes=ADULT`;
          const resp1 = await throttledFetch(url1, {
            headers: buildHeaders(cookies1), redirect: 'manual', timeout: 12000,
          });
          if (resp1.status === 302) { triggerCooldown(3000); await forceRefreshCookies(); return null; }
          if (resp1.status !== 200) return null;
          let data1;
          try { data1 = await resp1.json(); } catch (e) { return null; }
          if (!data1?.data?.result?.length) return null;

          // 不过滤 canBuy，显示全部车次（含无票），由前端标灰
          leg1 = parseTicketData(data1.data);
          cacheSet(from, hub.code, date, { status: 0, data: leg1 });
        }
        if (!leg1 || leg1.length === 0) return null;

        // 第二段：当天 + 第二天 + 第三天（支持跨日期换乘），三个日期并发查
        const dateNext2 = nextDay(dateNext);
        const leg2Groups = await Promise.all([date, dateNext, dateNext2].map(async (d) => {
          const cached2 = cacheGet(hub.code, to, d);
          if (cached2) return cached2.data.map(t => ({ ...t, _leg2Date: d }));

          const cookies2 = await getCookies();
          const url2 = `${API_BASE}/otn/leftTicket/queryG?leftTicketDTO.train_date=${d}&leftTicketDTO.from_station=${hub.code}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`;
          const resp2 = await throttledFetch(url2, {
            headers: buildHeaders(cookies2), redirect: 'manual', timeout: 12000,
          });
          if (resp2.status === 302) { triggerCooldown(3000); await forceRefreshCookies(); return []; }
          if (resp2.status !== 200) return [];
          let data2;
          try { data2 = await resp2.json(); } catch (e) { return []; }
          if (!data2?.data?.result?.length) return [];
          const parsed2 = parseTicketData(data2.data);
          cacheSet(hub.code, to, d, { status: 0, data: parsed2 });
          return parsed2.map(t => ({ ...t, _leg2Date: d }));
        }));

        const leg2All = [];
        leg2Groups.forEach(group => { leg2All.push(...group); });
        if (leg2All.length === 0) return null;

        // 判断某趟第一段能否接上某趟第二段（换乘间隔 20 分钟 ~ 12 小时）
        function canConnect(t1, t2) {
          const arrDate = computeArrivalDate(t1.startDate, t1.startTime, t1.arriveTime, t1.duration);
          const arrMins = parseInt(t1.arriveTime.split(':')[0]) * 60 + parseInt(t1.arriveTime.split(':')[1]);
          const depMins = parseInt(t2.startTime.split(':')[0]) * 60 + parseInt(t2.startTime.split(':')[1]);
          const dayDiff = daysBetween(arrDate, t2._leg2Date);
          let gap;
          if (dayDiff === 0) gap = depMins - arrMins;
          else if (dayDiff > 0) gap = dayDiff * 1440 + (depMins - arrMins);
          else return false;
          return gap >= 20 && gap <= 720;
        }

        // 去重：同一趟车连着三天都可能出现（时刻完全一样，只是日期不同），
        // 前端不显示日期，三条并排就会被看成"重复数据"。
        // 同一车次只留一条：可衔接的第一段越多越好 → 再有票优先 → 再日期更早优先
        const byTrainNo = new Map();
        const scoreOf = (cand) =>
          leg1.filter(x => canConnect(x, cand)).length * 100 + (cand.canBuy && hasTicketFn(cand) ? 1 : 0);

        for (const t of leg2All) {
          const prev = byTrainNo.get(t.trainNo);
          if (!prev) { byTrainNo.set(t.trainNo, t); continue; }
          const sc = scoreOf(t), sp = scoreOf(prev);
          if (sc > sp || (sc === sp && String(t._leg2Date) < String(prev._leg2Date))) {
            byTrainNo.set(t.trainNo, t);
          }
        }
        const leg2 = Array.from(byTrainNo.values());

        // 构建兼容性映射：每趟 leg1 对应能赶上的 leg2 索引
        const compatibility = {};
        for (let i = 0; i < leg1.length; i++) {
          const compatibleIndices = [];
          for (let j = 0; j < leg2.length; j++) {
            if (canConnect(leg1[i], leg2[j])) compatibleIndices.push(j);
          }
          compatibility[i] = compatibleIndices;
        }

        // 清理内部字段
        leg2.forEach(t => delete t._leg2Date);

        return {
          hub: hub.name,
          hubCode: hub.code,
          leg1Count: leg1.length,
          leg2Count: leg2.length,
          leg1, leg2, compatibility,
        };
      } catch (e) {
        return null;
      }
    }

    // 枢纽并发执行（实际 HTTP 仍受全局并发池约束），进度按完成数回传
    let hubCursor = 0;
    let finishedHubs = 0;
    async function hubWorker() {
      while (true) {
        const idx = hubCursor++;
        if (idx >= hubsToCheck.length) return;
        const hub = hubsToCheck[idx];
        let r = await checkHub(hub);
        // 被限流（302）时等一下重试一次，别直接丢掉这个枢纽
        if (!r) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          r = await checkHub(hub);
        }
        if (r) results.push(r);
        finishedHubs++;
        sendEvent({ type: 'progress', current: finishedHubs, total: hubsToCheck.length, hub: hub.name, found: results.length });
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(HUB_CONCURRENCY, hubsToCheck.length) }, () => hubWorker())
    );

    console.log(`✅ Transfer: ${results.length} hubs (${from}→${to}, ${date}~${dateNext})`);
    sendEvent({ type: 'result', status: 0, data: results });
    res.end();
  } catch (err) {
    console.error('Transfer search failed:', err.message);
    sendEvent({ type: 'result', status: 1, error: '换乘查询失败: ' + err.message });
    res.end();
  }
});

// ========== 按车次号搜索 ==========
app.get('/api/schedule-by-no', async (req, res) => {
  const { trainNo, date } = req.query;
  if (!trainNo || !date) {
    return res.status(400).json({ status: 1, error: '缺少参数: trainNo, date' });
  }

  const upperTrainNo = trainNo.toUpperCase();
  
  // 主要干线站点对
  const searchPairs = [
    ['AOH','VNP'],['VNP','AOH'],
    ['BJP','SHH'],['SHH','BJP'],
    ['IZQ','VNP'],['VNP','IZQ'],
    ['NKH','BJP'],['BJP','NKH'],
    ['CSH','BJP'],['BJP','CSH'],
    ['CDW','BJP'],['BJP','CDW'],
    ['XKS','VNP'],['VNP','XKS'],
    ['TIH','AOH'],['AOH','TIH'],
    ['WHN','BJP'],['BJP','WHN'],
    ['CQW','BJP'],['BJP','CQW'],
  ];

  try {
    let trainInfo = null;

    for (const [from, to] of searchPairs) {
      const cookies = await getCookies();
      try {
        const url = `${API_BASE}/otn/leftTicket/queryG?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`;
        const resp = await throttledFetch(url, {
          headers: buildHeaders(cookies),
          redirect: 'manual', timeout: 10000,
        });
        if (resp.status === 302) {
          await forceRefreshCookies();
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        if (resp.status !== 200) continue;

        const rawHeaders = resp.headers.raw ? resp.headers.raw() : {};
        parseCookies(rawHeaders['set-cookie'] || resp.headers.get('set-cookie'));

        const data = await resp.json();
        if (!data?.data?.result) continue;

        for (const item of data.data.result) {
          const fields = item.split('|');
          if (fields[3].toUpperCase() === upperTrainNo) {
            trainInfo = { trainCode: fields[2], trainNo: fields[3], fromStationCode: fields[6], toStationCode: fields[7] };
            break;
          }
        }
        if (trainInfo) break;
      } catch (e) { continue; }
      await new Promise(r => setTimeout(r, 300));
    }

    if (!trainInfo) {
      return res.json({ status: 1, error: `未找到车次 ${trainNo}，请确认车次号正确` });
    }

    // 查询时刻表
    const cookies = await getCookies();
    const scheduleUrl = `${API_BASE}/otn/czxx/queryByTrainNo?train_no=${trainInfo.trainCode}&from_station_telecode=${trainInfo.fromStationCode}&to_station_telecode=${trainInfo.toStationCode}&depart_date=${date}`;
    const scheduleResp = await throttledFetch(scheduleUrl, {
      headers: buildHeaders(cookies),
      redirect: 'manual', timeout: 10000,
    });

    if (scheduleResp.status === 302) {
      await forceRefreshCookies();
    }

    const scheduleData = await scheduleResp.json().catch(() => null);
    if (!scheduleData) {
      return res.json({ status: 1, error: '时刻表接口返回非JSON数据' });
    }

    if (scheduleData.data && scheduleData.data.data) {
      const stops = scheduleData.data.data.map(s => ({
        stationName: s.station_name,
        stationNo: s.station_no,
        arriveTime: s.arrive_time,
        startTime: s.start_time,
        stopoverTime: s.stopover_time,
        isStart: s.station_no === '01',
        isEnd: false,
      }));
      if (stops.length > 0) stops[stops.length - 1].isEnd = true;
      res.json({ status: 0, data: { trainNo: trainInfo.trainNo, stops } });
    } else {
      res.json({ status: 1, error: '未查到时刻表数据' });
    }
  } catch (err) {
    console.error('Schedule by no failed:', err.message);
    res.status(500).json({ status: 1, error: '查询时刻表失败: ' + err.message });
  }
});

// ========== 列车时刻表 ==========
app.get('/api/schedule', async (req, res) => {
  const { trainNo, date, fromCode, toCode } = req.query;
  if (!trainNo || !date) {
    return res.status(400).json({ status: 1, error: '缺少参数: trainNo, date' });
  }
  try {
    const cookies = await getCookies();
    const url = `${API_BASE}/otn/czxx/queryByTrainNo?train_no=${trainNo}&from_station_telecode=${fromCode || ''}&to_station_telecode=${toCode || ''}&depart_date=${date}`;
    const resp = await throttledFetch(url, {
      headers: buildHeaders(cookies),
      redirect: 'manual',
      timeout: 10000,
    });

    if (resp.status === 302) {
      await forceRefreshCookies();
      // 重试一次
      const cookies2 = await getCookies();
      const resp2 = await fetch(url, {
        headers: buildHeaders(cookies2),
        redirect: 'manual',
        timeout: 10000,
      });
      const text2 = await resp2.text();
      let data2;
      try { data2 = JSON.parse(text2); } catch(e) {
        if (text2.includes('captcha') || text2.includes('验证') || text2.includes('<html')) {
          return res.json({ status: 1, error: '12306要求验证码，请稍后重试' });
        }
        return res.json({ status: 1, error: '时刻表接口返回非JSON数据' });
      }
      if (data2.data && data2.data.data) {
        const stops = data2.data.data.map(s => ({
          stationName: s.station_name,
          stationNo: s.station_no,
          arriveTime: s.arrive_time,
          startTime: s.start_time,
          stopoverTime: s.stopover_time,
          isStart: s.station_no === '01',
          isEnd: false,
        }));
        if (stops.length > 0) stops[stops.length - 1].isEnd = true;
        return res.json({ status: 0, data: stops });
      }
      return res.json({ status: 1, error: '未查到时刻表数据' });
    }

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch(e) {
      if (text.includes('captcha') || text.includes('验证') || text.includes('<html')) {
        return res.json({ status: 1, error: '12306要求验证码，请稍后重试' });
      }
      return res.json({ status: 1, error: '时刻表接口返回非JSON数据' });
    }
    if (data.data && data.data.data) {
      const stops = data.data.data.map(s => ({
        stationName: s.station_name,
        stationNo: s.station_no,
        arriveTime: s.arrive_time,
        startTime: s.start_time,
        stopoverTime: s.stopover_time,
        isStart: s.station_no === '01',
        isEnd: false,
      }));
      if (stops.length > 0) stops[stops.length - 1].isEnd = true;
      res.json({ status: 0, data: stops });
    } else {
      res.json({ status: 1, error: '未查到时刻表数据' });
    }
  } catch (err) {
    console.error('Schedule failed:', err.message);
    res.status(500).json({ status: 1, error: '查询时刻表失败: ' + err.message });
  }
});

// ========== 健康检查 ==========
app.get('/api/health', (req, res) => {
  res.json({
    status: 0,
    message: 'Train Planner API is running',
    time: new Date().toISOString(),
  });
});

// 当前 cookie 情况（只回名字，不回值，方便排查）
app.get('/api/cookie-status', async (req, res) => {
  try {
    if (!Object.keys(cookieJar).length) await getCookies();
    const extras = getExtraCookies()
      .split(';')
      .map(s => s.split('=')[0].trim())
      .filter(Boolean);
    res.json({
      status: 0,
      auto: Object.keys(cookieJar),
      extra: extras,
      ageMs: cookieTime ? Date.now() - cookieTime : null,
      ttlMs: COOKIE_TTL,
    });
  } catch (err) {
    res.status(500).json({ status: 1, error: err.message });
  }
});

// ========== 全局错误处理 ==========
app.use((err, req, res, next) => {
  console.error('🔥 Unhandled error:', err.message, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ status: 1, error: '服务器内部错误: ' + err.message });
  }
});

// ========== 静态文件 ==========
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 本地运行时自动打开浏览器，Vercel/serverless 环境跳过
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚂 Train Planner server running at http://localhost:${PORT}`);
    getCookies().then(() => console.log('✅ Initial cookies obtained'));

    const url = `http://localhost:${PORT}`;
    const { exec } = require('child_process');
    const platform = process.platform;
    let cmd;
    if (platform === 'win32') cmd = `start "" "${url}"`;
    else if (platform === 'darwin') cmd = `open "${url}"`;
    else cmd = `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null`;
    exec(cmd, (err) => {
      if (err) console.log(`📌 请手动打开浏览器访问: ${url}`);
      else console.log('🌐 已自动打开浏览器');
    });
  });
}

// 导出 app 给 Vercel serverless
module.exports = app;

