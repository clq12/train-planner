'use strict';

(function () {
  const MINUTE = 60000;
  const CHINA_OFFSET = '+08:00';
  const STORAGE_KEY = 'piaolu_itinerary_v1';
  const defaults = Object.freeze({ flight: 120, afterFlight: 90, train: 20 });

  function readOffset(offset) {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (!match || Number(match[3]) >= 60) throw new Error('时差请填写 +08:00 或 -05:00 这样的格式。');
    const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
    if (minutes < -720 || minutes > 840) throw new Error('UTC 时差需在 −12:00 至 +14:00 之间。');
    return minutes;
  }

  function wallTime(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      throw new Error('请填写完整的当地日期和时间。');
    }
    const ms = Date.parse(`${value}:00Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 16) !== value) {
      throw new Error('日期或时间无效。');
    }
    return ms;
  }

  function text(value, limit) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
  }

  function parseLeg(raw) {
    if (!raw || !['train', 'flight', 'ground'].includes(raw.kind)) throw new Error('请选择有效的行程类型。');
    const { kind, departure, arrival } = raw;
    const number = text(raw.number, 32);
    const from = text(raw.from, 80);
    const to = text(raw.to, 80);
    if (!from || !to) throw new Error('请填写出发和到达地点。');
    if (kind !== 'ground' && !number) throw new Error('请填写航班号或车次号。');
    const offset = value => (typeof value === 'string' ? value.trim() : '').replace(/^-00:00$/, '+00:00');
    const departureOffset = kind === 'train' ? CHINA_OFFSET : offset(raw.departureOffset);
    const arrivalOffset = kind === 'train' ? CHINA_OFFSET : offset(raw.arrivalOffset);
    const departureMs = wallTime(departure) - readOffset(departureOffset) * MINUTE;
    const arrivalMs = wallTime(arrival) - readOffset(arrivalOffset) * MINUTE;
    if (arrivalMs <= departureMs) throw new Error('到达必须晚于出发，请核对日期和两端的 UTC 时差。');
    const leg = { kind, number, from, to, departure, arrival, departureOffset, arrivalOffset, departureMs, arrivalMs };
    // Preserve bounded display details for saved search segments; never persist provider payloads or credentials.
    if (kind === 'flight' && raw.flightDetails && typeof raw.flightDetails === 'object') {
      const details = raw.flightDetails;
      leg.flightDetails = {
        source: details.source === 'Duffel' ? 'Duffel' : '',
        airline: text(details.airline, 80), operatingAirline: text(details.operatingAirline, 80),
        departureTerminal: text(details.departureTerminal, 20), arrivalTerminal: text(details.arrivalTerminal, 20),
        stops: Array.isArray(details.stops) ? details.stops.slice(0, 4).map(stop => ({
          code: text(stop?.code, 3), name: text(stop?.name, 80),
          arrival: text(stop?.arrival, 16), departure: text(stop?.departure, 16),
        })) : [],
      };
    }
    return leg;
  }

  function trainToLeg(train, date) {
    const departure = `${date}T${train.startTime}`;
    const duration = /^(\d{1,3}):([0-5]\d)$/.exec(train.duration);
    if (!duration) throw new Error('此车次缺少有效的运行时长，请在日程中手动补录。');
    const minutes = Number(duration[1]) * 60 + Number(duration[2]);
    const arrival = new Date(wallTime(departure) + minutes * MINUTE).toISOString().slice(0, 16);
    if (arrival.slice(11) !== train.arriveTime) throw new Error('此车次时刻和运行时长不一致，请在日程中手动补录。');
    return parseLeg({
      kind: 'train', number: train.trainNo, from: train.fromStation, to: train.toStation, departure, arrival,
    });
  }

  function trainSearchDates(now = Date.now()) {
    // Shift to Beijing before reading UTC calendar fields; browser time zone is irrelevant.
    const beijing = new Date(Number(now) + 8 * 60 * MINUTE);
    const day = offset => {
      const date = new Date(Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() + offset));
      return date.toISOString().slice(0, 10);
    };
    return { min: day(0), value: day(1), max: day(15) };
  }

  function legKey(leg) {
    return JSON.stringify([leg.kind, leg.number.toUpperCase(), leg.from, leg.to, leg.departureMs, leg.arrivalMs]);
  }

  function transferBetween(previous, next, minimumMinutes) {
    const gapMinutes = (next.departureMs - previous.arrivalMs) / MINUTE;
    return { gapMinutes, status: gapMinutes < 0 ? 'overlap' : gapMinutes < minimumMinutes ? 'short' : 'ready' };
  }

  function adjacentTransfers(legs, settings) {
    const sorted = [...legs].sort((a, b) => a.departureMs - b.departureMs || a.arrivalMs - b.arrivalMs || legKey(a).localeCompare(legKey(b)));
    return sorted.slice(1).flatMap((next, i) => {
      const earlier = sorted.slice(0, i + 1);
      // A nested, shorter leg must not hide the leg that finishes last.
      const latest = earlier.reduce((last, leg) => leg.arrivalMs > last.arrivalMs ? leg : last);
      // Keep every direct overlap, including conflicts involving a candidate.
      const origins = earlier.filter(leg => leg === latest || leg.arrivalMs > next.departureMs);
      return origins.map(previous => {
        const minimumMinutes = next.kind === 'flight' ? settings.flight
          : previous.kind === 'flight' ? settings.afterFlight : next.kind === 'train' ? settings.train : 0;
        return { previous, next, minimumMinutes, ...transferBetween(previous, next, minimumMinutes) };
      });
    });
  }

  function normaliseSettings(raw) {
    return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
      const value = raw?.[key];
      return [key, Number.isInteger(value) && value >= 0 && value <= 1440 ? value : fallback];
    }));
  }

  function loadState(storage) {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    const legs = Array.isArray(saved?.legs) ? saved.legs.flatMap(raw => {
      try { return [parseLeg(raw)]; } catch { return []; }
    }) : [];
    return { legs, settings: normaliseSettings(saved?.settings) };
  }

  const api = { STORAGE_KEY, defaults, parseLeg, trainToLeg, trainSearchDates, legKey, transferBetween, adjacentTransfers, normaliseSettings, loadState };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.ItineraryCore = api;
})();
