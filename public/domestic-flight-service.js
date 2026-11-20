'use strict';

// Shared validation/catalogue. Credentials are supplied only by server.js at runtime.
(function () {
  const core = typeof module === 'object' && module.exports ? require('./itinerary-core.js') : window.ItineraryCore;
  // Deliberately bounded mainland airport allowlist, not a complete CN airport catalogue.
  const airports = Object.freeze([
    ['PEK', '北京首都机场'], ['PKX', '北京大兴机场'], ['SHA', '上海虹桥机场'], ['PVG', '上海浦东机场'],
    ['CAN', '广州白云机场'], ['SZX', '深圳宝安机场'], ['CTU', '成都双流机场'], ['TFU', '成都天府机场'],
    ['CKG', '重庆江北机场'], ['KMG', '昆明长水机场'], ['XIY', '西安咸阳机场'], ['HGH', '杭州萧山机场'],
    ['NKG', '南京禄口机场'], ['WUH', '武汉天河机场'], ['CGO', '郑州新郑机场'], ['CSX', '长沙黄花机场'],
    ['TAO', '青岛胶东机场'], ['TNA', '济南遥墙机场'], ['XMN', '厦门高崎机场'], ['FOC', '福州长乐机场'],
    ['HAK', '海口美兰机场'], ['SYX', '三亚凤凰机场'], ['HRB', '哈尔滨太平机场'], ['CGQ', '长春龙嘉机场'],
    ['SHE', '沈阳桃仙机场'], ['DLC', '大连周水子机场'], ['TSN', '天津滨海机场'],
    ['TYN', '太原武宿机场'], ['SJW', '石家庄正定机场'], ['NNG', '南宁吴圩机场'], ['KWL', '桂林两江机场'],
    ['KWE', '贵阳龙洞堡机场'], ['URC', '乌鲁木齐天山机场'], ['LHW', '兰州中川机场'], ['XNN', '西宁曹家堡机场'],
    ['INC', '银川河东机场'], ['LXA', '拉萨贡嘎机场'], ['WUX', '无锡硕放机场'], ['NGB', '宁波栎社机场'],
    ['WNZ', '温州龙湾机场'], ['HFE', '合肥新桥机场'], ['KHN', '南昌昌北机场'], ['ZUH', '珠海金湾机场'],
  ].map(([code, name]) => Object.freeze({ code, name, country: 'CN' })));
  const airportMap = new Map(airports.map(airport => [airport.code, airport]));
  const MAX_RESULTS = 10;
  const messages = Object.freeze({
    NOT_CONFIGURED: [503, '国内航班搜索未配置，请继续手动录入航班。'],
    INVALID_INPUT: [400, '请使用列表内不同的中国内地机场、北京时间今天起330天内的日期、1至6位成人、经济舱及0或1次中转；结果数需为1至10。'],
    UPSTREAM_AUTH: [502, '航班服务授权不可用，请联系管理员或手动录入。'],
    UPSTREAM_LIMIT: [503, '航班服务繁忙，请稍后重试或手动录入。'],
    UPSTREAM_TIMEOUT: [504, '航班服务响应超时，请稍后重试或手动录入。'],
    UPSTREAM_UNAVAILABLE: [502, '暂时无法查询航班，请稍后重试或手动录入。'],
    INVALID_RESPONSE: [502, '航班服务返回了无法核对的数据，请手动录入。'],
  });
  class FlightError extends Error {
    constructor(code) { super(messages[code][1]); this.code = code; }
  }
  function safeError(error) {
    const code = error instanceof FlightError && Object.hasOwn(messages, error.code) ? error.code : 'UPSTREAM_UNAVAILABLE';
    return { httpStatus: messages[code][0], body: { status: 1, code, error: messages[code][1], configured: code !== 'NOT_CONFIGURED' } };
  }
  function searchDates(now = Date.now()) {
    const min = core.trainSearchDates(now).min;
    return { min, value: core.trainSearchDates(now).value, max: new Date(Date.parse(`${min}T00:00:00Z`) + 330 * 86400000).toISOString().slice(0, 10) };
  }
  function validateSearch(input, now = Date.now()) {
    const fail = () => { throw new FlightError('INVALID_INPUT'); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
    const allowed = ['origin', 'destination', 'departureDate', 'adults', 'cabinClass', 'maxConnections', 'limit'];
    if (Object.keys(input).some(key => !allowed.includes(key))) fail();
    const origin = typeof input.origin === 'string' ? input.origin.trim().toUpperCase() : '';
    const destination = typeof input.destination === 'string' ? input.destination.trim().toUpperCase() : '';
    if (!airportMap.has(origin) || !airportMap.has(destination) || origin === destination) fail();
    const departureDate = input.departureDate;
    if (typeof departureDate !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(departureDate)) fail();
    const ms = Date.parse(`${departureDate}T00:00:00Z`);
    const range = searchDates(now);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== departureDate || departureDate < range.min || departureDate > range.max) fail();
    const adults = input.adults === undefined ? 1 : input.adults;
    const maxConnections = input.maxConnections === undefined ? 1 : input.maxConnections;
    const limit = input.limit === undefined ? MAX_RESULTS : input.limit;
    if (!Number.isInteger(adults) || adults < 1 || adults > 6 || !Number.isInteger(maxConnections) || maxConnections < 0 || maxConnections > 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) fail();
    if (input.cabinClass !== undefined && input.cabinClass !== 'economy') fail();
    return { origin, destination, departureDate, adults, cabinClass: 'economy', maxConnections, limit };
  }
  function requestBody(query) {
    return { data: {
      slices: [{ origin: query.origin, destination: query.destination, departure_date: query.departureDate }],
      passengers: Array.from({ length: query.adults }, () => ({ type: 'adult' })),
      cabin_class: 'economy', max_connections: query.maxConnections,
    } };
  }
  function clean(value, length = 80) { return typeof value === 'string' ? value.trim().slice(0, length) : ''; }
  function domesticAirport(airport) {
    if (!airport || airport.iata_country_code !== 'CN' || (airport.type && airport.type !== 'airport')) throw new Error('airport');
    const known = airportMap.get(airport.iata_code);
    if (!known) throw new Error('airport');
    return known;
  }
  function localTime(raw) {
    // Duffel timestamps are local airport times, without a zone suffix.
    if (typeof raw !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$/.test(raw)) throw new Error('time');
    return raw.slice(0, 16);
  }
  function normaliseOffer(raw, query, now, responseLiveMode) {
    if (!raw || typeof raw.id !== 'string' || !/^off_[a-zA-Z0-9_]{1,90}$/.test(raw.id) || typeof raw.total_amount !== 'string' || !/^\d{1,10}(\.\d{1,4})?$/.test(raw.total_amount) || typeof raw.total_currency !== 'string' || !/^[A-Z]{3}$/.test(raw.total_currency)) throw new Error('offer');
    if (!Array.isArray(raw.slices) || raw.slices.length !== 1) throw new Error('one way');
    if (!Array.isArray(raw.passengers) || raw.passengers.length !== query.adults || raw.passengers.some(passenger => passenger.type !== 'adult')) throw new Error('passengers');
    const expiry = Date.parse(raw.expires_at);
    if (!Number.isFinite(expiry) || expiry <= now) throw new Error('expired');
    const slice = raw.slices[0];
    if (domesticAirport(slice.origin).code !== query.origin || domesticAirport(slice.destination).code !== query.destination) throw new Error('route');
    if (!Array.isArray(slice.segments) || slice.segments.length < 1 || slice.segments.length > query.maxConnections + 1) throw new Error('segments');
    const segments = slice.segments.map(segment => {
      const origin = domesticAirport(segment.origin);
      const destination = domesticAirport(segment.destination);
      if (origin.code === destination.code) throw new Error('route');
      if (!Array.isArray(segment.passengers) || segment.passengers.length !== query.adults || segment.passengers.some(passenger => passenger.cabin_class !== 'economy')) throw new Error('cabin');
      const airlineCode = clean(segment.marketing_carrier?.iata_code, 2);
      const flightNumber = clean(segment.marketing_carrier_flight_number, 8);
      if (!/^[A-Z0-9]{2}$/.test(airlineCode) || !/^[0-9]{1,5}[A-Z]?$/.test(flightNumber)) throw new Error('flight number');
      if (segment.stops != null && (!Array.isArray(segment.stops) || segment.stops.length > 4)) throw new Error('stops');
      const stops = (segment.stops || []).map(stop => {
        const airport = domesticAirport(stop.airport);
        return { code: airport.code, name: airport.name, arrival: localTime(stop.arriving_at), departure: localTime(stop.departing_at) };
      });
      const leg = core.parseLeg({
        kind: 'flight', number: `${airlineCode}${flightNumber}`,
        from: `${origin.code} ${origin.name}`, to: `${destination.code} ${destination.name}`,
        departure: localTime(segment.departing_at), arrival: localTime(segment.arriving_at), departureOffset: '+08:00', arrivalOffset: '+08:00',
        flightDetails: {
          source: 'Duffel', airline: clean(segment.marketing_carrier?.name), operatingAirline: clean(segment.operating_carrier?.name),
          departureTerminal: clean(segment.origin_terminal, 20), arrivalTerminal: clean(segment.destination_terminal, 20), stops,
        },
      });
      let last = leg.departureMs;
      for (const stop of stops) {
        const arrival = Date.parse(`${stop.arrival}:00+08:00`);
        const departure = Date.parse(`${stop.departure}:00+08:00`);
        // Reuse the strict calendar validation used by manual legs.
        core.parseLeg({ kind: 'ground', from: stop.code, to: stop.code, departure: stop.arrival, arrival: stop.departure, departureOffset: '+08:00', arrivalOffset: '+08:00' });
        if (arrival <= last || departure >= leg.arrivalMs) throw new Error('stop order');
        last = departure;
      }
      return leg;
    });
    if (segments[0].from !== `${query.origin} ${airportMap.get(query.origin).name}` || segments.at(-1).to !== `${query.destination} ${airportMap.get(query.destination).name}` || segments[0].departure.slice(0, 10) !== query.departureDate || segments[0].departureMs <= now) throw new Error('route/date');
    const connections = segments.slice(1).map((next, i) => {
      const previous = segments[i];
      const gapMinutes = (next.departureMs - previous.arrivalMs) / 60000;
      if (gapMinutes < 0) throw new Error('segment order');
      return { from: previous.to, to: next.from, gapMinutes, airportChange: previous.to !== next.from };
    });
    return {
      id: raw.id, totalAmount: raw.total_amount, totalCurrency: raw.total_currency,
      expiresAt: new Date(expiry).toISOString(), adults: query.adults, cabinClass: 'economy',
      liveMode: typeof raw.live_mode === 'boolean' ? raw.live_mode : typeof responseLiveMode === 'boolean' ? responseLiveMode : null,
      segments, connections,
    };
  }
  function normaliseOffers(payload, query, now = Date.now()) {
    if (!payload?.data || !Array.isArray(payload.data.offers)) throw new FlightError('INVALID_RESPONSE');
    const seen = new Set();
    const offers = [];
    let discarded = 0;
    // Bound work even if an upstream implementation ignores its own result limits.
    for (const raw of payload.data.offers.slice(0, 200)) {
      try {
        const offer = normaliseOffer(raw, query, now, payload.data.live_mode);
        if (seen.has(offer.id)) continue;
        seen.add(offer.id);
        if (offers.length < query.limit) offers.push(offer);
      } catch { discarded++; }
    }
    return { offers, discarded, limited: payload.data.offers.length > offers.length + discarded, searchedAt: new Date(now).toISOString() };
  }
  function createFlightService({ fetchImpl, getToken, now = Date.now }) {
    let active = 0;
    const tokenValue = () => {
      try { const value = getToken(); return typeof value === 'string' ? value.trim() : ''; } catch { return ''; }
    };
    return {
      configured: () => Boolean(tokenValue()),
      async search(input) {
        const token = tokenValue();
        if (!token) throw new FlightError('NOT_CONFIGURED');
        const query = validateSearch(input, now());
        if (active >= 2) throw new FlightError('UPSTREAM_LIMIT');
        active++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
          const response = await fetchImpl('https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=15000', {
            method: 'POST', redirect: 'error', signal: controller.signal, timeout: 25000, size: 3000000,
            headers: { Authorization: `Bearer ${token}`, 'Duffel-Version': 'v2', Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody(query)),
          });
          if (!response.ok) throw new FlightError(response.status === 401 || response.status === 403 ? 'UPSTREAM_AUTH' : response.status === 429 ? 'UPSTREAM_LIMIT' : 'UPSTREAM_UNAVAILABLE');
          const result = { ...normaliseOffers(await response.json(), query, now()), query };
          // Never reflect a credential even if an upstream response unexpectedly echoes it.
          if (JSON.stringify(result).includes(token)) throw new FlightError('INVALID_RESPONSE');
          return result;
        } catch (error) {
          if (error instanceof FlightError) throw error;
          throw new FlightError(controller.signal.aborted || error?.type === 'request-timeout' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE');
        } finally { clearTimeout(timer); active--; }
      },
    };
  }
  function createHandlers(service) {
    return {
      status(req, res) { res.set('Cache-Control', 'no-store'); res.json({ status: 0, configured: service.configured() }); },
      async search(req, res) {
        res.set('Cache-Control', 'no-store');
        try { res.json({ status: 0, data: await service.search(req.body) }); }
        catch (error) { const safe = safeError(error); res.status(safe.httpStatus).json(safe.body); }
      },
      invalidBody(error, req, res, next) {
        if (!error) return next();
        const safe = safeError(new FlightError('INVALID_INPUT'));
        res.set('Cache-Control', 'no-store'); res.status(safe.httpStatus).json(safe.body);
      },
    };
  }
  const shared = { airports, MAX_RESULTS, searchDates, validateSearch };
  if (typeof module === 'object' && module.exports) module.exports = { ...shared, requestBody, normaliseOffers, createFlightService, createHandlers, safeError };
  else window.DomesticFlights = shared;
})();
