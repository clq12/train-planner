'use strict';

(function () {
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s·'’\-]+/g, '');
  const initials = pinyin => pinyin.split(' ').map(syllable => syllable[0]).join('');

  // IATA airport code, city/name, and syllable-separated pinyin for each.
  const airports = [
    ['PEK', '北京', '首都', 'bei jing', 'shou du', 'BJS'],
    ['PKX', '北京', '大兴', 'bei jing', 'da xing', 'BJS'],
    ['SHA', '上海', '虹桥', 'shang hai', 'hong qiao'],
    ['PVG', '上海', '浦东', 'shang hai', 'pu dong'],
    ['CAN', '广州', '白云', 'guang zhou', 'bai yun'],
    ['SZX', '深圳', '宝安', 'shen zhen', 'bao an'],
    ['CTU', '成都', '双流', 'cheng du', 'shuang liu'],
    ['TFU', '成都', '天府', 'cheng du', 'tian fu'],
    ['CKG', '重庆', '江北', 'chong qing', 'jiang bei'],
    ['KMG', '昆明', '长水', 'kun ming', 'chang shui'],
    ['XIY', '西安', '咸阳', 'xi an', 'xian yang'],
    ['HGH', '杭州', '萧山', 'hang zhou', 'xiao shan'],
    ['NKG', '南京', '禄口', 'nan jing', 'lu kou'],
    ['WUH', '武汉', '天河', 'wu han', 'tian he'],
    ['CGO', '郑州', '新郑', 'zheng zhou', 'xin zheng'],
    ['CSX', '长沙', '黄花', 'chang sha', 'huang hua'],
    ['TAO', '青岛', '胶东', 'qing dao', 'jiao dong'],
    ['TNA', '济南', '遥墙', 'ji nan', 'yao qiang'],
    ['XMN', '厦门', '高崎', 'xia men', 'gao qi'],
    ['FOC', '福州', '长乐', 'fu zhou', 'chang le'],
    ['HAK', '海口', '美兰', 'hai kou', 'mei lan'],
    ['SYX', '三亚', '凤凰', 'san ya', 'feng huang'],
    ['HRB', '哈尔滨', '太平', 'ha er bin', 'tai ping'],
    ['CGQ', '长春', '龙嘉', 'chang chun', 'long jia'],
    ['SHE', '沈阳', '桃仙', 'shen yang', 'tao xian'],
    ['DLC', '大连', '周水子', 'da lian', 'zhou shui zi'],
    ['TSN', '天津', '滨海', 'tian jin', 'bin hai'],
    ['TYN', '太原', '武宿', 'tai yuan', 'wu su'],
    ['SJW', '石家庄', '正定', 'shi jia zhuang', 'zheng ding'],
    ['NNG', '南宁', '吴圩', 'nan ning', 'wu xu'],
    ['KWL', '桂林', '两江', 'gui lin', 'liang jiang'],
    ['KWE', '贵阳', '龙洞堡', 'gui yang', 'long dong bao'],
    ['URC', '乌鲁木齐', '天山', 'wu lu mu qi', 'tian shan'],
    ['LHW', '兰州', '中川', 'lan zhou', 'zhong chuan'],
    ['XNN', '西宁', '曹家堡', 'xi ning', 'cao jia bao'],
    ['INC', '银川', '河东', 'yin chuan', 'he dong'],
    ['LXA', '拉萨', '贡嘎', 'la sa', 'gong ga'],
    ['WUX', '无锡', '硕放', 'wu xi', 'shuo fang'],
    ['NGB', '宁波', '栎社', 'ning bo', 'li she'],
    ['WNZ', '温州', '龙湾', 'wen zhou', 'long wan'],
    ['HFE', '合肥', '新桥', 'he fei', 'xin qiao'],
    ['KHN', '南昌', '昌北', 'nan chang', 'chang bei'],
    ['ZUH', '珠海', '金湾', 'zhu hai', 'jin wan'],
  ].map(([code, city, shortName, cityPinyin, shortPinyin, cityCode]) => {
    const name = `${city}${shortName}机场`;
    const fullPinyin = `${cityPinyin} ${shortPinyin}`;
    const value = `${code} ${name}`;
    const aliases = [name, value, city, shortName, `${shortName}机场`, `${city}${shortName}`, `${city}${shortName}国际机场`,
      cityPinyin, shortPinyin, fullPinyin, `${fullPinyin} ji chang`, `${fullPinyin} guo ji ji chang`,
      initials(cityPinyin), initials(shortPinyin), initials(fullPinyin), `${initials(fullPinyin)}jc`, cityCode];
    const cityAliases = [city, cityPinyin, initials(cityPinyin), cityCode].filter(Boolean).map(normalize);
    return { code, name, value, label: value, cityAliases, aliases: aliases.filter(Boolean).map(normalize) };
  });

  function stationsFrom(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    return Object.values(data).flatMap(station => {
      const code = typeof station?.code === 'string' ? station.code.toUpperCase() : '';
      const name = typeof station?.name === 'string' ? station.name.trim() : '';
      if (!/^[A-Z]{3}$/.test(code) || !name || name.length > 80) return [];
      const aliases = [name, station.pinyin, station.pinyinShort].filter(value => typeof value === 'string').map(normalize);
      // Keep the same stored station name as candidates imported from the rail search.
      return [{ code, name, value: name, label: `${name} · ${code}`, aliases }];
    });
  }

  function match(places, value, limit = 8) {
    const query = normalize(value);
    if (!query) return [];
    const cityMatches = places.filter(place => place.cityAliases?.includes(query));
    const catalogue = cityMatches.length ? cityMatches : places;
    return catalogue.flatMap(place => {
      const code = normalize(place.code);
      if (code === query) return [{ place, score: 0 }];
      if (place.aliases.includes(query)) return [{ place, score: 1 }];
      if (code.startsWith(query) || place.aliases.some(alias => alias.startsWith(query))) return [{ place, score: 2 }];
      if (place.aliases.some(alias => alias.includes(query))) return [{ place, score: 3 }];
      return [];
    }).sort((a, b) => a.score - b.score).slice(0, limit).map(result => result.place);
  }

  const api = { airports, stationsFrom, match };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.PlaceSuggestions = api;
})();
