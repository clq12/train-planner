const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

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

// ========== 请求限流 ==========
// 注意：在 Vercel Serverless 环境中，全局变量不跨实例共享，
// 限流仅在同一实例内有效。多实例并发时 12306 可能收到突发请求。
// 如需更好的限流，应使用外部存储（如 Redis）或 Vercel Edge Middleware。
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 300;

async function throttledFetch(url, options) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
  return fetch(url, options);
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

function getCookieString() {
  return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
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
          return res.json({ status: 0, data: parsed, availableCount: available.length, totalCount: allCount });
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

// ========== 解析 yp_info（票面信息）获取真实票价 ==========
// yp_info 格式：每10个字符一组，代表一种席别
//   第0位：席别代码（O=二等座, M=一等座, 9=商务座, 3=硬卧, 4=软卧, 1=硬座, 6=高级软卧, P=特等座, W/0=无座）
//   第1位：票种（0=成人票等）
//   第2-7位：票价（单位：分，6位数字，前导零）
//   第8-9位：余票数量
function parseYpInfo(ypInfo) {
  const prices = {};
  if (!ypInfo || ypInfo.length < 10) return prices;

  const typeMap = {
    'O': 'second',      // 二等座
    'M': 'first',       // 一等座
    '9': 'business',    // 商务座
    'S': 'business',    // 商务座（备用代码）
    'P': 'special',     // 特等座
    '6': 'highSoft',    // 高级软卧
    '4': 'softSleep',   // 软卧
    '3': 'hardSleep',   // 硬卧
    '1': 'hardSeat',    // 硬座
    'W': 'noSeat',      // 无座
    '0': 'noSeat',      // 无座（备用代码）
  };

  for (let i = 0; i + 10 <= ypInfo.length; i += 10) {
    const chunk = ypInfo.substring(i, i + 10);
    const seatTypeChar = chunk[0];
    // chunk[1] 是票种（成人/儿童等），此处不需要
    const priceStr = chunk.substring(2, 8); // 6位数字，单位：分
    const countStr = chunk.substring(8, 10); // 余票数

    const priceInFen = parseInt(priceStr, 10);
    const count = parseInt(countStr, 10); // 余票数（十进制）
    const seatType = typeMap[seatTypeChar];

    if (seatType && !isNaN(priceInFen) && priceInFen > 0) {
      prices[seatType] = Math.round(priceInFen / 100); // 分 → 元
    }
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

    // 从 yp_info (fields[12]) 解析真实票价
    const prices = parseYpInfo(fields[12]);

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
      prices, // 真实票价（从yp_info解析）
    };
  });
}

// ========== 中转换乘搜索（支持跨日期） ==========
app.get('/api/transfer', async (req, res) => {
  const { from, to, date, date2, transferStation } = req.query;
  if (!from || !to || !date) {
    return res.status(400).json({ status: 1, error: '缺少参数: from, to, date' });
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

    const results = [];
    const maxTransferChecks = transferStation ? 1 : 20;

    for (const hub of transferCandidates.slice(0, maxTransferChecks)) {
      try {
        // 第一段：from → 中转站（出发日期）
        const cookies1 = await getCookies();
        const url1 = `${API_BASE}/otn/leftTicket/queryG?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${hub.code}&purpose_codes=ADULT`;
        const resp1 = await throttledFetch(url1, {
          headers: buildHeaders(cookies1), redirect: 'manual', timeout: 12000,
        });
        if (resp1.status === 302) { await forceRefreshCookies(); continue; }
        if (resp1.status !== 200) continue;
        let data1;
        try { data1 = await resp1.json(); } catch(e) { continue; }
        if (!data1?.data?.result?.length) continue;

        const leg1All = parseTicketData(data1.data);
        const leg1 = leg1All.filter(t => t.canBuy && hasTicketFn(t));
        if (leg1.length === 0) continue;

        // 第二段：查当天 + 第二天 + 第三天（支持跨日期换乘）
        let leg2All = [];
        const dateNext2 = nextDay(dateNext);
        for (const d of [date, dateNext, dateNext2]) {
          const cookies2 = await getCookies();
          const url2 = `${API_BASE}/otn/leftTicket/queryG?leftTicketDTO.train_date=${d}&leftTicketDTO.from_station=${hub.code}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`;
          const resp2 = await throttledFetch(url2, {
            headers: buildHeaders(cookies2), redirect: 'manual', timeout: 12000,
          });
          if (resp2.status === 302) { await forceRefreshCookies(); continue; }
          if (resp2.status !== 200) continue;
          let data2;
          try { data2 = await resp2.json(); } catch(e) { continue; }
          if (!data2?.data?.result?.length) continue;

          const parsed = parseTicketData(data2.data);
          parsed.forEach(t => { t._leg2Date = d; });
          leg2All.push(...parsed);
        }

        const leg2 = leg2All.filter(t => t.canBuy && hasTicketFn(t));
        if (leg2.length === 0) continue;

        // 构建兼容性映射：每趟 leg1 对应能赶上的 leg2 索引
        const compatibility = {};
        for (let i = 0; i < leg1.length; i++) {
          const t1 = leg1[i];
          const arrDate = computeArrivalDate(t1.startDate, t1.startTime, t1.arriveTime, t1.duration);
          const arrMins = parseInt(t1.arriveTime.split(':')[0]) * 60 + parseInt(t1.arriveTime.split(':')[1]);

          const compatibleIndices = [];
          for (let j = 0; j < leg2.length; j++) {
            const t2 = leg2[j];
            const depMins = parseInt(t2.startTime.split(':')[0]) * 60 + parseInt(t2.startTime.split(':')[1]);
            const dayDiff = daysBetween(arrDate, t2._leg2Date);
            let gap;
            if (dayDiff === 0) gap = depMins - arrMins;
            else if (dayDiff > 0) gap = dayDiff * 1440 + (depMins - arrMins);
            else continue;
            if (gap >= 20 && gap <= 720) compatibleIndices.push(j);
          }
          compatibility[i] = compatibleIndices;
        }

        // 清理内部字段
        leg2.forEach(t => delete t._leg2Date);

        results.push({
          hub: hub.name,
          hubCode: hub.code,
          leg1Count: leg1.length,
          leg2Count: leg2.length,
          leg1, leg2, compatibility,
        });
      } catch (e) {
        continue;
      }
    }

    console.log(`✅ Transfer: ${results.length} hubs (${from}→${to}, ${date}~${dateNext})`);
    res.json({ status: 0, data: results });
  } catch (err) {
    console.error('Transfer search failed:', err.message);
    res.status(500).json({ status: 1, error: '换乘查询失败: ' + err.message });
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

