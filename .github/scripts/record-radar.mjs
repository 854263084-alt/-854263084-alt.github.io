import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const dataFile = resolve(root, 'data/radar-history.json');
const API = 'https://api.coingecko.com/api/v3';
const DEX_API = 'https://api.dexscreener.com';
const MACRO_ENDPOINTS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json'
];
const NEWS_ENDPOINTS = [
  'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20',
  'https://api.gdeltproject.org/api/v2/doc/doc?query=(bitcoin%20OR%20ethereum%20OR%20cryptocurrency)&mode=artlist&format=json&maxrecords=20&timespan=1d'
];
const CORE_IDS = ['bitcoin', 'ethereum', 'solana', 'hyperliquid', 'aster-2', 'uniswap', 'zcash', 'helium', 'ethena', 'ondo-finance'];
const MAX_POINTS = 96;
const MAX_NEWS = 20;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const compact = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (compact) return new Date(Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]), Number(compact[4]), Number(compact[5]), Number(compact[6])));
  const raw = Number(value);
  const date = new Date(Number.isFinite(raw) ? (raw < 1e12 ? raw * 1000 : raw) : value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter(item => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

async function fetchJSON(url, timeout = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'ChainPulseRadar/1.1 (public GitHub Actions snapshot)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function mergeMarkets(groups) {
  const map = new Map();
  groups.flat().filter(item => item && item.id).forEach(item => {
    map.set(item.id, { ...(map.get(item.id) || {}), ...item });
  });
  return [...map.values()];
}

function compactTrending(items) {
  return (Array.isArray(items) ? items : []).map(entry => {
    const item = entry?.item || entry || {};
    const data = item.data || {};
    return {
      item: {
        id: item.id,
        name: item.name,
        symbol: item.symbol,
        market_cap_rank: item.market_cap_rank,
        thumb: item.thumb || item.small || item.image || '',
        score: item.score,
        data: {
          price: finite(data.price ?? item.current_price),
          price_change_percentage_24h: { usd: finite(data.price_change_percentage_24h?.usd ?? item.price_change_percentage_24h) }
        }
      }
    };
  }).filter(entry => entry.item.id);
}

function compactMarket(item) {
  return {
    id: item.id,
    name: item.name,
    symbol: item.symbol,
    market_cap_rank: item.market_cap_rank,
    image: item.image || '',
    current_price: finite(item.current_price),
    price_change_percentage_1h_in_currency: finite(item.price_change_percentage_1h_in_currency),
    price_change_percentage_24h: finite(item.price_change_percentage_24h),
    price_change_percentage_7d_in_currency: finite(item.price_change_percentage_7d_in_currency),
    total_volume: finite(item.total_volume),
    market_cap: finite(item.market_cap)
  };
}

function compactCategory(item) {
  return {
    id: item.id,
    name: item.name,
    market_cap: finite(item.market_cap),
    market_cap_change_24h: finite(item.market_cap_change_24h),
    volume_24h: finite(item.volume_24h)
  };
}

function macroTitle(title) {
  const raw = String(title || '');
  const lower = raw.toLowerCase();
  if (/non.?farm|payroll|employment change/.test(lower)) return '美国非农就业数据';
  if (/consumer price|\bcpi\b/.test(lower)) return '美国 CPI / 通胀数据';
  if (/fomc|federal reserve|fed .*rate|interest rate/.test(lower)) return '美联储 / FOMC 相关事件';
  if (/pce/.test(lower)) return '美国 PCE 通胀数据';
  if (/unemployment/.test(lower)) return '美国失业率数据';
  if (/jolts/.test(lower)) return '美国 JOLTS 职位空缺';
  if (/ism/.test(lower)) return '美国 ISM 景气数据';
  if (/ppi/.test(lower)) return '美国 PPI 数据';
  return `美国宏观：${raw}`;
}

function normaliseMacroEvents(rows) {
  const keywords = /cpi|consumer price|non.?farm|employment change|payroll|fomc|federal reserve|interest rate|fed|unemployment|jolts|ism|ppi|gdp|retail sales|pce/i;
  const events = (Array.isArray(rows) ? rows : [])
    .filter(row => String(row?.country || '').toUpperCase() === 'USD' && keywords.test(String(row?.title || '')))
    .map((row, index) => {
      const date = parseDate(row.date);
      if (!date) return null;
      const impact = String(row.impact || '').toLowerCase();
      const parts = [];
      if (row.forecast) parts.push(`预测 ${row.forecast}`);
      if (row.previous) parts.push(`前值 ${row.previous}`);
      return {
        id: `macro-${date.getTime()}-${index}`,
        datetime: date.toISOString(),
        title: macroTitle(row.title),
        description: `来源宏观日历：${String(row.title || '')}${parts.length ? `；${parts.join('，')}` : ''}`,
        type: '宏观',
        topic: '宏观数据 / 政策',
        impact: impact === 'high' ? 'high' : impact === 'medium' ? 'mid' : 'low',
        source: 'Forex Factory 日历',
        scope: 'macro',
        dateKind: 'scheduled',
        official: false,
        verification: '日历来源'
      };
    })
    .filter(Boolean);
  return uniqueBy(events, item => `${item.datetime}|${item.title}`).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

function classifyNews(title) {
  const text = String(title || '').toLowerCase();
  if (/delist|delisting|remove.*trading|will remove|下架/.test(text)) return { type: '交易所下币', topic: '交易所流动性', impact: 'high', summary: '涉及交易对下架、停止交易或服务调整。', advice: '核对公告原文、受影响交易对和执行时间。' };
  if (/unlock|vesting|token release|解锁/.test(text)) return { type: '代币解锁', topic: '代币供给变化', impact: 'high', summary: '涉及解锁、归属或代币释放安排。', advice: '核对解锁规模、占流通比例和接收方。' };
  if (/airdrop|空投/.test(text)) return { type: '空投', topic: '社区激励', impact: 'mid', summary: '涉及空投资格、领取或分发安排。', advice: '只使用项目官方链接，防范假空投和授权钓鱼。' };
  if (/governance|proposal|snapshot|\bvote\b|dao|治理|提案|投票/.test(text)) return { type: '治理 / 投票', topic: '治理 / 社区决策', impact: 'mid', summary: '涉及治理讨论、提案、投票或 DAO 决策。', advice: '核对提案全文、投票截止时间和最终执行条件。' };
  if (/community call|community meeting|town hall|\bama\b|twitter spaces|\bspaces\b|社区会议/.test(text)) return { type: '社区会议 / AMA', topic: '社区沟通', impact: 'low', summary: '涉及社区会议、AMA 或公开交流。', advice: '关注是否给出明确时间、参与入口和后续结论。' };
  if (/buyback|repurchase|回购/.test(text)) return { type: '回购', topic: '价值捕获 / 资金使用', impact: 'mid', summary: '涉及代币或协议资产的回购安排。', advice: '核对资金来源、规模、执行频率和披露方式。' };
  if (/\bburn\b|销毁/.test(text)) return { type: '销毁', topic: '代币供给变化', impact: 'mid', summary: '涉及代币销毁、回收或供给调整。', advice: '核对销毁地址、实际数量和是否已上链执行。' };
  if (/migration|token swap|redenomination|迁移|置换/.test(text)) return { type: '代币迁移', topic: '合约 / 代币迁移', impact: 'high', summary: '涉及代币、合约或计价单位迁移。', advice: '核对官方迁移入口、截止时间和旧币处理方式。' };
  if (/mainnet|testnet|hard fork|\bupgrade\b|主网|测试网|硬分叉|升级/.test(text)) return { type: '主网 / 测试网 / 升级', topic: '网络与协议升级', impact: 'mid', summary: '涉及主网、测试网、协议升级或硬分叉。', advice: '核对实际启用范围、版本要求和链上执行状态。' };
  if (/product launch|feature release|\blaunch\b|\brelease\b|产品发布|新功能/.test(text)) return { type: '产品发布', topic: '产品与生态', impact: 'mid', summary: '涉及产品、功能或服务发布。', advice: '核对是否已开放使用，以及数据是否支持实际采用。' };
  if (/partnership|collaboration|integrat|合作|集成/.test(text)) return { type: '重大合作', topic: '生态合作', impact: 'mid', summary: '涉及合作、集成或生态扩展。', advice: '核对合作范围、是否已落地及双方原始公告。' };
  if (/list(ing|ed)?|will list|上币/.test(text)) return { type: '交易所上币', topic: '交易所流动性', impact: 'mid', summary: '涉及新币种、交易对或交易服务上线。', advice: '核对交易所公告、交易对和流动性，不把上币标题等同于基本面。' };
  if (/hack|exploit|attack|breach|漏洞|被盗/.test(text)) return { type: '风险事件', topic: '安全与资金风险', impact: 'high', summary: '涉及安全漏洞、攻击或资产风险。', advice: '优先核对资产敞口、官方处置和链上影响。' };
  if (/etf|sec|regulation|lawsuit|监管/.test(text)) return { type: '监管 / ETF', topic: '监管与市场结构', impact: 'mid', summary: '涉及监管、ETF 或法律进展。', advice: '关注原始文件、审批状态与生效时间。' };
  return { type: '市场资讯', topic: '市场资讯', impact: 'low', summary: '属于市场资讯，尚不足以形成可验证事件。', advice: '标题仅作线索，请打开原文核实。' };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCoinCatalog(snapshot) {
  const map = new Map();
  const names = [];
  const trending = (snapshot.trending || []).map(entry => entry?.item || entry || {});
  [...(snapshot.markets || []), ...(snapshot.dexPairs || []), ...trending].forEach(item => {
    const symbol = String(item?.symbol || '').toUpperCase();
    const name = String(item?.name || '').trim();
    if (!/^[A-Z0-9]{2,12}$/.test(symbol) || /^(USD|USDT|USDC|BUSD|DAI|ETH|BTC)$/.test(symbol)) return;
    const ref = { id: item.id || `symbol:${symbol}`, symbol, name: name || symbol };
    map.set(symbol, ref);
    if (name.length >= 4) names.push({ name: name.toLowerCase(), ref });
  });
  return { map, names };
}

function extractEventCoins(title, catalog) {
  const text = String(title || '');
  const upper = text.toUpperCase();
  const selected = new Map();
  catalog.map.forEach((ref, symbol) => {
    if (new RegExp(`(^|[^A-Z0-9])${escapeRegExp(symbol)}(?=$|[^A-Z0-9])`, 'i').test(upper)) selected.set(ref.id, ref);
  });
  catalog.names.forEach(entry => {
    if (text.toLowerCase().includes(entry.name)) selected.set(entry.ref.id, entry.ref);
  });
  [...upper.matchAll(/\b([A-Z0-9]{2,16})(?:USDT|USDC|USD|BTC|ETH)\b/g)].forEach(match => {
    const symbol = match[1];
    const ref = catalog.map.get(symbol) || { id: `symbol:${symbol}`, symbol, name: `公告代码 ${symbol}` };
    if (!/^(USD|USDT|USDC|BUSD|DAI|ETH|BTC)$/.test(symbol) && !selected.has(ref.id)) {
      selected.set(ref.id, ref);
    }
  });
  return [...selected.values()].slice(0, 3);
}

function eventResultFromTitle(title, official) {
  if (!official) return '';
  const text = String(title || '').toLowerCase();
  if (/approved|passed|adopted|获批|通过/.test(text)) return '官方公告标题显示该事项已通过或获批；执行细节请以原文为准。';
  if (/postponed|delayed|延期|推迟/.test(text)) return '官方公告标题显示该事项已延期；请以公告中的新时间为准。';
  if (/cancelled|canceled|withdrawn|取消|撤回/.test(text)) return '官方公告标题显示该事项已取消或撤回；请打开来源核对范围。';
  if (/completed|complete|已完成|完成/.test(text)) return '官方公告标题显示该事项已完成；请打开来源核对最终执行结果。';
  return '';
}

function extractBinanceArticles(payload) {
  const found = [];
  const visited = new WeakSet();
  function walk(value, depth) {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach(item => walk(item, depth + 1));
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const title = value.title || value.articleTitle || value.headline;
    if (title && (value.releaseDate || value.publishDate || value.code || value.id || value.url)) found.push(value);
    ['articles', 'articleList', 'catalogs', 'items', 'rows', 'data', 'result'].forEach(key => walk(value[key], depth + 1));
  }
  walk(payload, 0);
  return found;
}

function normaliseNewsArticle(row, source) {
  const title = String(row?.title || row?.articleTitle || '').trim();
  if (!title) return null;
  const date = parseDate(row.releaseDate || row.publishDate || row.publishedAt || row.seendate || row.date);
  const fallbackUrl = row.code ? `https://www.binance.com/en/support/announcement/${encodeURIComponent(row.code)}` : '';
  const kind = classifyNews(title);
  return {
    id: `news-${source}-${String(row.code || safeUrl(row.url || row.articleUrl || fallbackUrl) || title).slice(0, 140)}`,
    title,
    publishedAt: date ? date.toISOString() : null,
    url: safeUrl(row.url || row.articleUrl || fallbackUrl),
    source,
    type: kind.type,
    topic: kind.topic,
    impact: kind.impact,
    summary: kind.summary,
    conclusion: kind.advice,
    official: source === '币安公告'
  };
}

function newsEvents(news, catalog) {
  return news
    .filter(item => classifyNews(item.title).type !== '市场资讯' && item.publishedAt)
    .map((item, index) => {
      const kind = classifyNews(item.title);
      const official = Boolean(item.official || item.source === '币安公告');
      const coins = extractEventCoins(item.title, catalog);
      const summary = kind.summary || '该公告涉及项目或交易所事件。';
      return {
        id: `event-${item.id}-${index}`,
        datetime: item.publishedAt,
        title: `${kind.type}：${item.title}`,
        description: `${official ? '交易所官方公告。' : '聚合来源线索，需以官方渠道确认。'}${summary} ${kind.advice || item.conclusion || '请打开来源核实。'}`,
        type: kind.type,
        topic: kind.topic || '项目 / 币种事件',
        impact: kind.impact,
        source: item.source,
        sourceUrl: item.url,
        scope: 'coin',
        dateKind: 'published',
        coins,
        official,
        verification: official ? '已验证来源' : '待确认',
        result: eventResultFromTitle(item.title, official),
        news: true
      };
    });
}

async function fetchDexPairs() {
  const boosts = await fetchJSON(`${DEX_API}/token-boosts/top/v1`);
  const candidates = (Array.isArray(boosts) ? boosts : []).filter(item => item?.chainId && item?.tokenAddress).slice(0, 16);
  const groups = new Map();
  candidates.forEach(item => {
    const chain = String(item.chainId);
    if (!groups.has(chain)) groups.set(chain, []);
    groups.get(chain).push(item);
  });
  const resultGroups = await Promise.allSettled([...groups.entries()].map(([chain, items]) => {
    const addresses = items.slice(0, 8).map(item => encodeURIComponent(item.tokenAddress)).join(',');
    return fetchJSON(`${DEX_API}/tokens/v1/${encodeURIComponent(chain)}/${addresses}`);
  }));
  const boostsByToken = new Map(candidates.map(item => [`${item.chainId}:${String(item.tokenAddress).toLowerCase()}`, item]));
  const pairs = resultGroups.filter(result => result.status === 'fulfilled').flatMap(result => Array.isArray(result.value) ? result.value : []);
  return uniqueBy(pairs.map(pair => {
    const chain = String(pair.chainId || '');
    const address = String(pair.baseToken?.address || '').toLowerCase();
    const boost = boostsByToken.get(`${chain}:${address}`);
    const liquidity = finite(pair.liquidity?.usd);
    if (!boost || liquidity === null || liquidity < 15000) return null;
    return {
      id: `dex:${chain}:${address}`,
      name: pair.baseToken?.name || 'DEX Token',
      symbol: pair.baseToken?.symbol || 'DEX',
      rank: 'DEX',
      image: pair.info?.imageUrl || boost.icon || '',
      current_price: finite(pair.priceUsd),
      price_change_percentage_1h_in_currency: finite(pair.priceChange?.h1),
      price_change_percentage_24h: finite(pair.priceChange?.h24),
      price_change_percentage_7d_in_currency: null,
      total_volume: finite(pair.volume?.h24),
      market_cap: finite(pair.marketCap || pair.fdv),
      liquidity,
      dexBoost: true,
      boostAmount: finite(boost.totalAmount || boost.amount),
      source: 'DexScreener',
      url: safeUrl(pair.url)
    };
  }).filter(Boolean), item => item.id).sort((a, b) => (b.boostAmount || 0) - (a.boostAmount || 0)).slice(0, 10);
}

function defaultStore() {
  return {
    schema: 1,
    updatedAt: null,
    sourceState: {},
    snapshot: {
      global: null,
      fear: null,
      trending: [],
      categories: [],
      markets: [],
      dexPairs: [],
      macroEvents: [],
      cryptoEvents: [],
      news: []
    },
    history: { coins: {}, categories: {} }
  };
}

async function readStore() {
  try {
    const parsed = JSON.parse(await readFile(dataFile, 'utf8'));
    const fallback = defaultStore();
    return {
      ...fallback,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      snapshot: { ...fallback.snapshot, ...(parsed?.snapshot && typeof parsed.snapshot === 'object' ? parsed.snapshot : {}) },
      history: { ...fallback.history, ...(parsed?.history && typeof parsed.history === 'object' ? parsed.history : {}) }
    };
  } catch {
    return defaultStore();
  }
}

function setSource(store, name, status, at) {
  store.sourceState[name] = { status, at: at || new Date().toISOString() };
}

function hasSnapshotData(snapshot, name) {
  if (name === 'coingecko') return Boolean(snapshot.global || snapshot.trending?.length || snapshot.categories?.length || snapshot.markets?.length);
  if (name === 'sentiment') return Boolean(snapshot.fear);
  if (name === 'dex') return Boolean(snapshot.dexPairs?.length);
  if (name === 'macro') return Boolean(snapshot.macroEvents?.length);
  if (name === 'news') return Boolean(snapshot.news?.length);
  return false;
}

function markFailure(store, name) {
  const previous = store.sourceState[name];
  setSource(store, name, hasSnapshotData(store.snapshot, name) ? 'cache' : 'unavailable', previous?.at || null);
}

function appendHistory(store, now) {
  const timestamp = now.getTime();
  const minTime = timestamp - 8 * 24 * 60 * 60 * 1000;
  store.history.coins = store.history.coins && typeof store.history.coins === 'object' ? store.history.coins : {};
  store.history.categories = store.history.categories && typeof store.history.categories === 'object' ? store.history.categories : {};
  const append = (bucket, id, point) => {
    if (!id || !point.some(value => value !== null)) return;
    const current = bucket[id] && typeof bucket[id] === 'object' ? bucket[id] : {};
    const points = Array.isArray(current.points) ? current.points.filter(row => Array.isArray(row) && Number(row[0]) >= minTime) : [];
    const last = points.at(-1);
    if (!last || timestamp - Number(last[0]) > 5 * 60 * 1000) points.push([timestamp, ...point]);
    bucket[id] = {
      firstSeenAt: current.firstSeenAt || now.toISOString(),
      lastSeenAt: now.toISOString(),
      points: points.slice(-MAX_POINTS)
    };
  };
  const trackedCoins = [...store.snapshot.markets, ...store.snapshot.dexPairs];
  const trackedCoinIds = new Set(trackedCoins.map(item => item.id).filter(Boolean));
  const trackedCategoryIds = new Set(store.snapshot.categories.map(item => item.id).filter(Boolean));
  Object.keys(store.history.coins).forEach(id => { if (!trackedCoinIds.has(id)) delete store.history.coins[id]; });
  Object.keys(store.history.categories).forEach(id => { if (!trackedCategoryIds.has(id)) delete store.history.categories[id]; });
  trackedCoins.forEach(item => append(store.history.coins, item.id, [finite(item.current_price), finite(item.total_volume), finite(item.market_cap)]));
  store.snapshot.categories.forEach(item => append(store.history.categories, item.id, [finite(item.volume_24h), finite(item.market_cap), finite(item.market_cap_change_24h)]));
}

async function main() {
  const store = await readStore();
  const now = new Date();
  const base = await Promise.allSettled([
    fetchJSON(`${API}/global`),
    fetchJSON(`${API}/search/trending`),
    fetchJSON(`${API}/coins/categories?order=market_cap_desc`),
    fetchJSON('https://api.alternative.me/fng/?limit=1&format=json')
  ]);

  let marketSuccess = 0;
  if (base[0].status === 'fulfilled') { store.snapshot.global = base[0].value; marketSuccess++; }
  if (base[1].status === 'fulfilled') { store.snapshot.trending = compactTrending(base[1].value?.coins); marketSuccess++; }
  if (base[2].status === 'fulfilled') { store.snapshot.categories = (Array.isArray(base[2].value) ? base[2].value : []).map(compactCategory).filter(item => item.id).slice(0, 160); marketSuccess++; }
  if (base[3].status === 'fulfilled') { store.snapshot.fear = base[3].value; setSource(store, 'sentiment', 'live', now.toISOString()); } else markFailure(store, 'sentiment');

  const trendIds = store.snapshot.trending.map(item => (item.item || item).id).filter(Boolean);
  const ids = [...new Set([...CORE_IDS, ...trendIds])].slice(0, 55).join(',');
  const suffix = '&order=market_cap_desc&price_change_percentage=1h,24h,7d';
  const prices = await Promise.allSettled([
    fetchJSON(`${API}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}${suffix}`),
    fetchJSON(`${API}/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1${suffix}`)
  ]);
  const groups = [];
  if (prices[0].status === 'fulfilled') { groups.push(Array.isArray(prices[0].value) ? prices[0].value : []); marketSuccess++; }
  if (prices[1].status === 'fulfilled') { groups.unshift(Array.isArray(prices[1].value) ? prices[1].value : []); marketSuccess++; }
  if (groups.length) store.snapshot.markets = mergeMarkets(groups).map(compactMarket).filter(item => item.id);
  if (marketSuccess) setSource(store, 'coingecko', marketSuccess === 5 ? 'live' : 'partial', now.toISOString()); else markFailure(store, 'coingecko');

  const extras = await Promise.allSettled([
    fetchDexPairs(),
    Promise.allSettled(MACRO_ENDPOINTS.map(url => fetchJSON(url))).then(results => {
      const rows = results.filter(result => result.status === 'fulfilled').flatMap(result => Array.isArray(result.value) ? result.value : []);
      if (!results.some(result => result.status === 'fulfilled')) throw new Error('macro unavailable');
      return normaliseMacroEvents(rows);
    }),
    Promise.allSettled(NEWS_ENDPOINTS.map(url => fetchJSON(url))).then(results => {
      if (!results.some(result => result.status === 'fulfilled')) throw new Error('news unavailable');
      const articles = [];
      if (results[0]?.status === 'fulfilled') extractBinanceArticles(results[0].value).forEach(row => {
        const item = normaliseNewsArticle(row, '币安公告');
        if (item) articles.push(item);
      });
      if (results[1]?.status === 'fulfilled') (results[1].value?.articles || []).forEach(row => {
        const item = normaliseNewsArticle(row, 'GDELT 聚合');
        if (item) articles.push(item);
      });
      return uniqueBy(articles, item => item.url || item.title).sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).slice(0, MAX_NEWS);
    })
  ]);

  if (extras[0].status === 'fulfilled') { store.snapshot.dexPairs = extras[0].value; setSource(store, 'dex', 'live', now.toISOString()); } else markFailure(store, 'dex');
  if (extras[1].status === 'fulfilled') { store.snapshot.macroEvents = extras[1].value; setSource(store, 'macro', 'live', now.toISOString()); } else markFailure(store, 'macro');
  if (extras[2].status === 'fulfilled') {
    store.snapshot.news = extras[2].value;
    setSource(store, 'news', 'live', now.toISOString());
  } else markFailure(store, 'news');
  // 新闻接口暂时不可用时，仍用最近成功的公告快照重新生成事件字段；状态会明确保留为缓存。
  store.snapshot.cryptoEvents = newsEvents(Array.isArray(store.snapshot.news) ? store.snapshot.news : [], buildCoinCatalog(store.snapshot));

  if (marketSuccess || extras.some(result => result.status === 'fulfilled')) {
    appendHistory(store, now);
    store.updatedAt = now.toISOString();
  }
  await writeFile(dataFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  console.log(`Snapshot ${store.updatedAt || 'unchanged'} · CoinGecko ${store.sourceState.coingecko?.status || 'unavailable'} · DEX ${store.sourceState.dex?.status || 'unavailable'} · news ${store.sourceState.news?.status || 'unavailable'}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
