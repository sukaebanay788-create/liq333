const klinecharts = window.klinecharts;

const BINANCE_WS_MARKET = 'wss://fstream.binance.com/market/ws';
const BINANCE_API = 'https://fapi.binance.com';

const MIN_VOLUME_BTC = 100000;
const MIN_VOLUME_ETH = 50000;
const MIN_VOLUME_USD = 10000;
const STORAGE_PREFIX = 'binance_liq_';
const MAX_RECENT = 20;

function mapTimeframeToPeriod(tf) {
  const unit = tf.slice(-1);
  const value = parseInt(tf, 10);
  let timespan = 'minute';
  if (unit === 'h') timespan = 'hour';
  else if (unit === 'd') timespan = 'day';
  return { multiplier: value, timespan };
}

function formatPrice(price) {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

const state = {
  coins: new Map(),
  filteredCoins: [],
  currentSymbol: 'BTCUSDT',
  ws: null,
  wsReady: false,
  liquidationWs: null,
  chartInstance: null,
  sortField: 'change',
  sortDesc: true,
  currentTimeframe: '15m',
  lastSubscriptionSet: new Set(),
  currentKlineSymbol: null,
  oldestTime: null,
  isLoadingMore: false,
  liquidationMarkers: [],
  liquidationCount: 0,
  allLiquidations: new Map(),
  recentLiquidations: [],
};

function updateHeader(stateObj) {
  const coin = stateObj.coins.get(stateObj.currentSymbol);
  if (!coin) return;

  document.getElementById('currentSymbol').textContent = `${stateObj.currentSymbol} (${stateObj.currentTimeframe})`;
  document.getElementById('currentPrice').textContent = formatPrice(coin.price);

  const ch = document.getElementById('currentChange');
  const change = coin.change;
  ch.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
  ch.className = `symbol-change ${change >= 0 ? 'positive' : 'negative'}`;
}

function sortCoins(stateObj) {
  stateObj.filteredCoins.sort((a, b) => {
    let va = a[stateObj.sortField];
    let vb = b[stateObj.sortField];

    if (typeof va === 'string') {
      va = va.toLowerCase();
      vb = vb.toLowerCase();
    }

    if (va < vb) return stateObj.sortDesc ? 1 : -1;
    if (va > vb) return stateObj.sortDesc ? -1 : 1;
    return 0;
  });
}

function createCoinRow(coin, stateObj, onSelectCoin) {
  const div = document.createElement('div');
  div.className = `coin-item${coin.symbol === stateObj.currentSymbol ? ' active' : ''}`;
  div.dataset.symbol = coin.symbol;
  div.onclick = () => onSelectCoin(coin.symbol);

  const c24 = coin.change >= 0 ? 'positive' : 'negative';
  const c30 = coin.change30m >= 0 ? 'positive' : 'negative';

  div.innerHTML = `
    <span class="coin-symbol">${coin.symbol.replace('USDT', '')}</span>
    <span class="coin-price">${formatPrice(coin.price)}</span>
    <span class="coin-change ${c24}">${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(2)}%</span>
    <span class="coin-change ${c30}">${coin.change30m >= 0 ? '+' : ''}${coin.change30m.toFixed(2)}%</span>
  `;

  return div;
}

function renderCoinsList(stateObj, onSelectCoin) {
  const container = document.getElementById('coinsList');
  container.innerHTML = '';
  stateObj.filteredCoins.forEach((coin) => container.appendChild(createCoinRow(coin, stateObj, onSelectCoin)));
}

function updateCoinRow(coin) {
  const row = document.querySelector(`.coin-item[data-symbol="${coin.symbol}"]`);
  if (!row) return;

  row.children[1].textContent = formatPrice(coin.price);
  row.children[2].textContent = `${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(2)}%`;
  row.children[2].className = `coin-change ${coin.change >= 0 ? 'positive' : 'negative'}`;
}

function updateCoinsCount(stateObj) {
  document.getElementById('coinsCount').textContent = stateObj.filteredCoins.length;
}

function updateConnectionStatus(stateObj, ok) {
  const el = document.getElementById('connStatus');
  el.textContent = ok ? `Connected (${stateObj.liquidationCount} liq)` : 'Disconnected';
  el.className = `connection-status ${ok ? 'status-connected' : 'status-disconnected'}`;
}

function updateStatusWithCount(stateObj) {
  const el = document.getElementById('connStatus');
  if (el) el.textContent = `Connected (${stateObj.liquidationCount} liq)`;
}

function updateLiquidationFeed(stateObj, onSelectCoin) {
  const feedEl = document.getElementById('liquidationFeed');
  if (!feedEl) return;

  if (stateObj.recentLiquidations.length === 0) {
    feedEl.innerHTML = '<div style="color:#848e9c;text-align:center;">Ожидание ликвидаций...</div>';
    return;
  }

  feedEl.innerHTML = stateObj.recentLiquidations.map((liq, idx) => {
    const sideClass = liq.side === 'SELL' ? 'liq-side-sell' : 'liq-side-buy';
    const sideText = liq.side === 'SELL' ? 'LONG LIQ' : 'SHORT LIQ';
    return `
      <div class="liquidation-feed-item" data-liq-index="${idx}" title="Открыть график ${liq.symbol.replace('USDT', '')}">
        <span class="liq-symbol">${liq.symbol.replace('USDT', '')}</span>
        <span class="${sideClass}">${sideText}</span>
        <span class="liq-volume">${(liq.volume / 1000).toFixed(0)}K</span>
        <span>${liq.price.toFixed(2)}</span>
      </div>
    `;
  }).join('');

  feedEl.querySelectorAll('.liquidation-feed-item').forEach((el) => {
    el.addEventListener('click', () => {
      const item = stateObj.recentLiquidations[Number(el.dataset.liqIndex)];
      if (item) onSelectCoin(item.symbol);
    });
  });
}

async function init() {
  await loadCoins();
  initChart();
  connectWebSocket();
  connectLiquidationWebSocket();
  setupEvents();
  loadChartData(state.currentSymbol);
}

async function loadCoins() {
  try {
    const exchangeInfoRes = await fetch(`${BINANCE_API}/fapi/v1/exchangeInfo`);
    const exchangeData = await exchangeInfoRes.json();

    const usdtPairs = exchangeData.symbols.filter((s) =>
      s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.contractType === 'PERPETUAL'
    );

    const tickersRes = await fetch(`${BINANCE_API}/fapi/v1/ticker/24hr`);
    const tickers = await tickersRes.json();
    const tickersMap = new Map(tickers.map((t) => [t.symbol, t]));

    const promises = usdtPairs.map(async (pair) => {
      const symbol = pair.symbol;
      const ticker = tickersMap.get(symbol);
      if (!ticker) return null;

      try {
        const klines30m = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=30m&limit=2`).then((r) => {
          if (!r.ok) throw new Error('No data');
          return r.json();
        });

        let change30m = 0;
        if (klines30m.length >= 1) {
          const lastCandle = klines30m[klines30m.length - 1];
          const open = parseFloat(lastCandle[1]);
          const close = parseFloat(lastCandle[4]);
          change30m = ((close - open) / open) * 100;
        }

        return {
          symbol,
          price: parseFloat(ticker.lastPrice),
          change: parseFloat(ticker.priceChangePercent),
          change30m,
        };
      } catch (_error) {
        return {
          symbol,
          price: parseFloat(ticker.lastPrice),
          change: parseFloat(ticker.priceChangePercent),
          change30m: 0,
        };
      }
    });

    const results = await Promise.all(promises);
    results.forEach((coinData) => {
      if (coinData) state.coins.set(coinData.symbol, coinData);
    });

    state.filteredCoins = Array.from(state.coins.values());
    sortCoins(state);
    renderCoinsList(state, selectCoin);
    updateCoinsCount(state);
  } catch (error) {
    console.error('Ошибка загрузки монет:', error);
    document.getElementById('coinsList').innerHTML = '<div class="loading">Ошибка загрузки</div>';
  }
}

function initChart() {
  const container = document.getElementById('chart');
  state.chartInstance = klinecharts.init(container, {
    styles: {
      grid: {
        horizontal: { color: '#1e2329' },
        vertical: { color: '#1e2329' }
      },
      candle: {
        upColor: '#0ecb81',
        downColor: '#f6465d',
        borderUpColor: '#0ecb81',
        borderDownColor: '#f6465d',
        wickUpColor: '#0ecb81',
        wickDownColor: '#f6465d'
      }
    }
  });

  window.addEventListener('resize', () => {
    if (state.chartInstance && container) {
      state.chartInstance.resize();
    }
  });
}

function connectLiquidationWebSocket() {
  state.liquidationWs = new WebSocket(`${BINANCE_WS_MARKET}/!forceOrder@arr`);

  state.liquidationWs.onopen = () => console.log('Liquidation WebSocket connected');
  state.liquidationWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.e === 'forceOrder') processLiquidation(msg.o);
  };
  state.liquidationWs.onclose = () => {
    console.log('Liquidation WebSocket closed, reconnecting...');
    setTimeout(connectLiquidationWebSocket, 5000);
  };
  state.liquidationWs.onerror = (e) => console.error('Liquidation WS error:', e);
}

function processLiquidation(order) {
  const symbol = order.s;
  const price = parseFloat(order.p);
  const quantity = parseFloat(order.q);
  const volumeUSD = price * quantity;

  let minVol = MIN_VOLUME_USD;
  if (symbol === 'BTCUSDT') minVol = MIN_VOLUME_BTC;
  else if (symbol === 'ETHUSDT') minVol = MIN_VOLUME_ETH;
  if (volumeUSD < minVol) return;

  const side = order.S;
  console.log(`Ликвидация: ${symbol} ${side} ${volumeUSD.toFixed(0)} USD (цена ${price})`);

  state.recentLiquidations.unshift({ symbol, side, volume: volumeUSD, price, time: order.T });
  if (state.recentLiquidations.length > MAX_RECENT) state.recentLiquidations.pop();
  updateLiquidationFeed(state, selectCoin);

  state.liquidationCount++;
  updateStatusWithCount(state);
}

async function loadChartData(symbol) {
  try {
    const res = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=${state.currentTimeframe}&limit=1400`);
    const klines = await res.json();

    const candles = klines.map((k) => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));

    state.currentCandles = candles;
    state.oldestTime = klines.length > 0 ? klines[0][0] : null;

    if (state.chartInstance) {
      state.chartInstance.applyNewData(candles);
      state.chartInstance.resize();
    }

    if (state.wsReady) subscribeToKlineStream(symbol);
    updateHeader(state);
  } catch (e) {
    console.error('Ошибка загрузки графика:', e);
  }
}

async function loadMoreHistory() {
  if (state.isLoadingMore || !state.oldestTime) return;
  state.isLoadingMore = true;

  const btn = document.getElementById('loadMoreBtn');
  btn.textContent = '⏳';
  btn.disabled = true;

  try {
    const endTime = state.oldestTime - 1;
    const res = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${state.currentSymbol}&interval=${state.currentTimeframe}&limit=1000&endTime=${endTime}`);
    const klines = await res.json();
    if (klines.length === 0) return;

    const newCandles = klines.map((k) => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));

    state.oldestTime = klines[0][0];
    state.currentCandles = [...newCandles, ...state.currentCandles];

    if (state.chartInstance) {
      state.chartInstance.applyNewData(state.currentCandles);
    }
  } catch (e) {
    console.error('Ошибка подгрузки истории:', e);
  } finally {
    btn.textContent = '📜';
    btn.disabled = false;
    state.isLoadingMore = false;
  }
}

function connectWebSocket() {
  state.ws = new WebSocket(BINANCE_WS_MARKET);

  state.ws.onopen = () => {
    state.wsReady = true;
    updateConnectionStatus(state, true);
    updateSubscriptions();
    if (state.currentSymbol) subscribeToKlineStream(state.currentSymbol);
  };

  state.ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) return;
    if (msg.e === '24hrTicker') updateTicker(msg);
    else if (msg.e === 'kline') updateChartWithKline(msg);
  };

  state.ws.onclose = () => {
    state.wsReady = false;
    updateConnectionStatus(state, false);
    state.lastSubscriptionSet.clear();
    state.currentKlineSymbol = null;
    setTimeout(connectWebSocket, 5000);
  };

  state.ws.onerror = (e) => console.error('WS error:', e);
}

function updateSubscriptions() {
  if (!state.wsReady || state.ws.readyState !== WebSocket.OPEN) return;

  const target = new Set(state.filteredCoins.slice(0, 50).map((c) => c.symbol.toLowerCase()));
  const toUnsub = [];
  const toSub = [];

  state.lastSubscriptionSet.forEach((sym) => { if (!target.has(sym)) toUnsub.push(`${sym}@ticker`); });
  target.forEach((sym) => { if (!state.lastSubscriptionSet.has(sym)) toSub.push(`${sym}@ticker`); });

  if (toUnsub.length) state.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: toUnsub, id: Date.now() }));
  if (toSub.length) state.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: toSub, id: Date.now() + 1 }));
  state.lastSubscriptionSet = target;
}

function subscribeToKlineStream(symbol) {
  if (!state.wsReady || state.ws.readyState !== WebSocket.OPEN) return;

  if (state.currentKlineSymbol && state.currentKlineSymbol !== symbol) {
    state.ws.send(JSON.stringify({
      method: 'UNSUBSCRIBE',
      params: [`${state.currentKlineSymbol.toLowerCase()}@kline_${state.currentTimeframe}`],
      id: Date.now(),
    }));
  }

  state.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${symbol.toLowerCase()}@kline_${state.currentTimeframe}`], id: Date.now() + 1 }));
  state.currentKlineSymbol = symbol;
}

function updateTicker(data) {
  const symbol = data.s.toUpperCase();
  const coin = state.coins.get(symbol);
  if (!coin) return;

  coin.price = parseFloat(data.c);
  coin.change = parseFloat(data.P);

  if (symbol === state.currentSymbol) updateHeader(state);
  const idx = state.filteredCoins.findIndex((c) => c.symbol === symbol);
  if (idx !== -1) updateCoinRow(coin);
}

// ГЛАВНОЕ ИСПРАВЛЕНИЕ: правильное обновление свечей в реальном времени
function updateChartWithKline(data) {
  const k = data.k;
  const candle = {
    timestamp: k.t,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v)
  };

  if (!state.currentCandles.length) {
    state.currentCandles.push(candle);
    state.chartInstance.applyNewData([candle]);
    return;
  }

  const last = state.currentCandles[state.currentCandles.length - 1];

  if (candle.timestamp === last.timestamp) {
    // Обновляем текущую (ещё не закрытую) свечу
    state.currentCandles[state.currentCandles.length - 1] = candle;
    state.chartInstance.updateData(candle);
  } else if (candle.timestamp > last.timestamp) {
    // Новая свеча
    state.currentCandles.push(candle);
    state.chartInstance.applyMoreData([candle]);
  }
}

async function refresh30mChanges() {
  const headerSpan = document.querySelector('#listHeader span[data-sort="change30m"]');
  const originalText = headerSpan.textContent;
  headerSpan.textContent = '⏳ 30м';

  const promises = state.filteredCoins.map(async (coin) => {
    try {
      const res = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${coin.symbol}&interval=30m&limit=2`);
      if (!res.ok) return coin;
      const klines = await res.json();
      if (klines.length >= 1) {
        const lastCandle = klines[klines.length - 1];
        const open = parseFloat(lastCandle[1]);
        const close = parseFloat(lastCandle[4]);
        coin.change30m = ((close - open) / open) * 100;
      }
    } catch (_e) {}
    return coin;
  });

  await Promise.all(promises);
  headerSpan.textContent = originalText;
}

function setupEvents() {
  document.querySelectorAll('.tf-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTimeframe(btn.dataset.tf));
  });

  document.querySelectorAll('#listHeader span').forEach((span) => {
    span.addEventListener('click', async () => {
      const field = span.dataset.sort;
      if (field === 'change30m') await refresh30mChanges();
      sortBy(field);
    });
  });

  document.getElementById('loadMoreBtn').addEventListener('click', loadMoreHistory);
}

function sortBy(field) {
  if (state.sortField === field) state.sortDesc = !state.sortDesc;
  else {
    state.sortField = field;
    state.sortDesc = true;
  }

  sortCoins(state);
  renderCoinsList(state, selectCoin);
}

function selectCoin(symbol) {
  state.currentSymbol = symbol;
  document.getElementById('currentSymbol').textContent = `${symbol} (${state.currentTimeframe})`;

  document.querySelectorAll('.coin-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.symbol === symbol);
  });

  loadChartData(symbol);
  updateHeader(state);
}

// ИСПРАВЛЕНИЕ: убираем setPeriod, просто перезагружаем данные
function setTimeframe(tf) {
  state.currentTimeframe = tf;
  document.querySelectorAll('.tf-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tf === tf);
  });

  document.getElementById('currentSymbol').textContent = `${state.currentSymbol} (${tf})`;
  loadChartData(state.currentSymbol);
}

init();
