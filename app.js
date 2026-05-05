// Binance Futures Screener — KLineChart edition
const BINANCE_WS = 'wss://fstream.binance.com/ws';
const BINANCE_API = 'https://fapi.binance.com';

// ---------- Лог-окно ----------
const MAX_LOG_LINES = 200;
const logLines = [];

function log(level, ...args) {
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
    const text = args.map(a => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
    }).join(' ');
    logLines.push({ time, level, text });
    if (logLines.length > MAX_LOG_LINES) logLines.shift();
    renderLog();
    if (level === 'error') console.error(`[${time}]`, ...args);
    else console.log(`[${time}] [${level}]`, ...args);
}

function renderLog() {
    const el = document.getElementById('logPanel');
    if (!el) return;
    el.innerHTML = logLines.slice(-50).map(l =>
        `<div class="log-line log-${l.level}"><span class="log-time">${l.time}</span> <span class="log-level">[${l.level}]</span> ${escapeHtml(l.text)}</div>`
    ).join('');
    el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Перехват глобальных ошибок в окно логов
window.addEventListener('error', (e) => {
    log('error', e.message + (e.filename ? ` @ ${e.filename}:${e.lineno}` : ''));
});
window.addEventListener('unhandledrejection', (e) => {
    log('error', 'unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});

let coins = new Map();
let filteredCoins = [];
let currentSymbol = 'BTCUSDT';
let ws = null;
let chart = null;
let sortField = 'change';
let sortDesc = true;
let currentTimeframe = '15m';
let lastSubscriptionSet = new Set();
let currentKlineSymbol = null;
let wsReady = false;

let currentCandles = [];
let oldestTime = null;
let isLoadingMore = false;

// ---------- Ликвидации ----------
let liquidationWs = null;
const MAX_MARKERS_PER_SYMBOL = 500;
const MIN_VOLUME_USD = 5000;
const MIN_VOLUME_BTC = 100000;
let liquidationCount = 0;

const allLiquidations = new Map();
const STORAGE_PREFIX = 'binance_liq_kc_';

let recentLiquidations = [];
const MAX_RECENT = 20;

function getTimeframeMs(tf) {
    const unit = tf.slice(-1);
    const value = parseInt(tf);
    switch (unit) {
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        default: return 15 * 60 * 1000;
    }
}

// Инициализация
async function init() {
    setupLogPanel();
    log('info', 'Старт приложения');
    initChart();
    setupEvents();
    await loadCoins();
    connectWebSocket();
    connectLiquidationWebSocket();
    loadChartData(currentSymbol);
}

function setupLogPanel() {
    const clearBtn = document.getElementById('logClearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            logLines.length = 0;
            renderLog();
        });
    }
    const toggleBtn = document.getElementById('logToggleBtn');
    const panel = document.getElementById('logContainer');
    if (toggleBtn && panel) {
        toggleBtn.addEventListener('click', () => {
            panel.classList.toggle('collapsed');
            toggleBtn.textContent = panel.classList.contains('collapsed') ? '▲' : '▼';
            if (chart) chart.resize();
        });
    }
}

// Загрузка списка фьючерсов
async function loadCoins() {
    try {
        const exchangeInfoRes = await fetch(`${BINANCE_API}/fapi/v1/exchangeInfo`);
        const exchangeData = await exchangeInfoRes.json();

        const usdtPairs = exchangeData.symbols.filter(s =>
            s.quoteAsset === 'USDT' &&
            s.status === 'TRADING' &&
            s.contractType === 'PERPETUAL'
        );

        const tickersRes = await fetch(`${BINANCE_API}/fapi/v1/ticker/24hr`);
        const tickers = await tickersRes.json();
        const tickersMap = new Map(tickers.map(t => [t.symbol, t]));

        const promises = usdtPairs.map(async (pair) => {
            const symbol = pair.symbol;
            const ticker = tickersMap.get(symbol);
            if (!ticker) return null;

            try {
                const klines30m = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=30m&limit=2`).then(r => {
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
            } catch (e) {
                return {
                    symbol,
                    price: parseFloat(ticker.lastPrice),
                    change: parseFloat(ticker.priceChangePercent),
                    change30m: 0,
                };
            }
        });

        const results = await Promise.all(promises);
        results.forEach(coinData => {
            if (coinData) coins.set(coinData.symbol, coinData);
        });

        filteredCoins = Array.from(coins.values());
        sortCoins();
        renderCoinsList();
        updateCoinsCount();
        log('info', `Загружено ${filteredCoins.length} фьючерсов`);
    } catch (error) {
        log('error', 'Ошибка загрузки монет:', error);
        document.getElementById('coinsList').innerHTML = '<div class="loading">Ошибка загрузки</div>';
    }
}

// ---------- График (KLineChart) ----------
function initChart() {
    // Кастомный overlay: круглый маркер ликвидации над/под свечой.
    // lock:true чтобы overlay не перехватывал события мыши.
    klinecharts.registerOverlay({
        name: 'liqMarker',
        totalStep: 1,
        lock: true,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        createPointFigures: ({ overlay, coordinates }) => {
            if (!coordinates || coordinates.length === 0) return [];
            const data = overlay.extendData || {};
            const color = data.color || '#f6465d';
            const text = data.text || '';
            const position = data.position || 'belowBar';
            const offsetY = position === 'belowBar' ? 8 : -8;
            const cx = coordinates[0].x;
            const cy = coordinates[0].y + offsetY;
            return [
                {
                    type: 'circle',
                    attrs: { x: cx, y: cy, r: 3 },
                    styles: { style: 'fill', color },
                },
                {
                    type: 'text',
                    attrs: {
                        x: cx,
                        y: cy + (position === 'belowBar' ? 9 : -9),
                        text,
                        align: 'center',
                        baseline: 'middle',
                    },
                    styles: { color, size: 9, family: 'Helvetica Neue, sans-serif' },
                },
            ];
        },
    });

    chart = klinecharts.init('chart', {
        styles: {
            grid: {
                show: true,
                horizontal: { color: '#1e2329' },
                vertical: { color: '#1e2329' },
            },
            candle: {
                bar: {
                    upColor: '#0ecb81',
                    downColor: '#f6465d',
                    upBorderColor: '#0ecb81',
                    downBorderColor: '#f6465d',
                    upWickColor: '#0ecb81',
                    downWickColor: '#f6465d',
                },
                priceMark: {
                    last: {
                        upColor: '#0ecb81',
                        downColor: '#f6465d',
                    },
                },
                tooltip: {
                    showRule: 'always',
                    showType: 'rect',
                },
            },
            xAxis: {
                axisLine: { color: '#1e2329' },
                tickLine: { color: '#1e2329' },
                tickText: { color: '#848e9c' },
            },
            yAxis: {
                axisLine: { color: '#1e2329' },
                tickLine: { color: '#1e2329' },
                tickText: { color: '#848e9c' },
            },
            crosshair: {
                horizontal: {
                    line: { color: '#848e9c' },
                    text: { backgroundColor: '#2b3139', color: '#fff', borderColor: '#2b3139' },
                },
                vertical: {
                    line: { color: '#848e9c' },
                    text: { backgroundColor: '#2b3139', color: '#fff', borderColor: '#2b3139' },
                },
            },
            indicator: {
                tooltip: {
                    showRule: 'always',
                    showType: 'rect',
                },
            },
        },
    });

    // Встроенный EMA с параметрами и стилями.
    // ВАЖНО: для каждой линии нужно указать ПОЛНЫЙ набор стилей
    // (style, smooth, color, size, dashedValue) — иначе klinecharts@9.8.12
    // падает с TypeError("reading '0'") при перерисовке (баг в merge линий).
    const emaLine = (color, size) => ({
        style: 'solid', smooth: false, color, size, dashedValue: [2, 2],
    });
    chart.createIndicator({
        name: 'EMA',
        calcParams: [65, 125, 450],
        styles: {
            lines: [
                emaLine('#a0a4ab', 1),
                emaLine('#a0a4ab', 1),
                emaLine('#e0e3e8', 2),
            ],
        },
    }, true, { id: 'candle_pane' });

    window.addEventListener('resize', () => chart.resize());
    log('chart_init', 'KLineChart инициализирован');
}

// ---------- Ликвидации ----------
function connectLiquidationWebSocket() {
    liquidationWs = new WebSocket(`${BINANCE_WS}/!forceOrder@arr`);

    liquidationWs.onopen = () => {
        log('ws', 'Ликвидационный WebSocket подключён');
    };

    liquidationWs.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.e === 'forceOrder') {
                processLiquidation(msg.o);
            }
        } catch (e) {
            log('error', 'Ошибка обработки ликвидации:', e);
        }
    };

    liquidationWs.onclose = () => {
        log('ws', 'Ликвидационный WebSocket закрыт, переподключение через 5с');
        setTimeout(connectLiquidationWebSocket, 5000);
    };

    liquidationWs.onerror = () => {
        log('error', 'Liquidation WS error');
    };
}

function loadSavedMarkers(symbol) {
    const key = STORAGE_PREFIX + symbol;
    const saved = localStorage.getItem(key);
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (e) {
            console.error('Ошибка парсинга сохранённых маркеров:', e);
            return [];
        }
    }
    return [];
}

function saveMarkers(symbol, markers) {
    const key = STORAGE_PREFIX + symbol;
    try {
        localStorage.setItem(key, JSON.stringify(markers));
    } catch (e) {
        console.error('Ошибка сохранения маркеров в localStorage:', e);
        if (e.name === 'QuotaExceededError') {
            const keys = Object.keys(localStorage).filter(k => k.startsWith(STORAGE_PREFIX));
            keys.sort((a, b) => (localStorage.getItem(a)?.length || 0) - (localStorage.getItem(b)?.length || 0));
            for (let i = 0; i < Math.min(5, keys.length); i++) {
                localStorage.removeItem(keys[i]);
            }
            try {
                localStorage.setItem(key, JSON.stringify(markers));
            } catch (e2) {
                console.error('Повторная ошибка сохранения');
            }
        }
    }
}

function updateLiquidationFeed() {
    const feedEl = document.getElementById('liquidationFeed');
    if (!feedEl) return;
    if (recentLiquidations.length === 0) {
        feedEl.innerHTML = '<div style="color: #848e9c; text-align: center;">Ожидание ликвидаций...</div>';
        return;
    }
    feedEl.innerHTML = recentLiquidations.map(liq => {
        const sideClass = liq.side === 'SELL' ? 'liq-side-sell' : 'liq-side-buy';
        const sideText = liq.side === 'SELL' ? 'LONG LIQ' : 'SHORT LIQ';
        return `
            <div class="liquidation-feed-item">
                <span class="liq-symbol">${liq.symbol.replace('USDT', '')}</span>
                <span class="${sideClass}">${sideText}</span>
                <span class="liq-volume">${(liq.volume / 1000).toFixed(0)}K</span>
                <span>${liq.price.toFixed(2)}</span>
            </div>
        `;
    }).join('');
}

function processLiquidation(order) {
    const symbol = order.s;
    const price = parseFloat(order.p);
    const quantity = parseFloat(order.q);
    const volumeUSD = price * quantity;

    const minVol = symbol === 'BTCUSDT' ? MIN_VOLUME_BTC : MIN_VOLUME_USD;
    if (volumeUSD < minVol) return;

    log('liq', `${symbol} ${order.S === 'SELL' ? 'LONG_LIQ' : 'SHORT_LIQ'} ${(volumeUSD / 1000).toFixed(0)}K @ ${price.toFixed(2)}`);

    const side = order.S;
    const timeMs = order.T;
    const timeframeMs = getTimeframeMs(currentTimeframe);
    const candleOpenTimeMs = Math.floor(timeMs / timeframeMs) * timeframeMs;

    const isLongLiquidation = (side === 'SELL');

    // Определяем value (цена) для размещения маркера у high/low свечи
    const candle = currentCandles.find(c => c.timestamp === candleOpenTimeMs);
    const value = candle
        ? (isLongLiquidation ? candle.low : candle.high)
        : price;

    const marker = {
        time: candleOpenTimeMs,
        value,
        position: isLongLiquidation ? 'belowBar' : 'aboveBar',
        color: side === 'SELL' ? '#f6465d' : '#0ecb81',
        text: `${(volumeUSD / 1000).toFixed(0)}K`,
    };

    recentLiquidations.unshift({
        symbol,
        side,
        volume: volumeUSD,
        price,
        time: timeMs,
    });
    if (recentLiquidations.length > MAX_RECENT) recentLiquidations.pop();
    updateLiquidationFeed();

    if (!allLiquidations.has(symbol)) {
        allLiquidations.set(symbol, loadSavedMarkers(symbol));
    }
    const symbolMarkers = allLiquidations.get(symbol);

    const exists = symbolMarkers.some(m => m.time === marker.time && m.text === marker.text);
    if (!exists) {
        symbolMarkers.push(marker);
        if (symbolMarkers.length > MAX_MARKERS_PER_SYMBOL) {
            symbolMarkers.shift();
        }
        saveMarkers(symbol, symbolMarkers);
    }

    if (symbol === currentSymbol) {
        try {
            addMarkerToChart(marker);
        } catch (e) {
            log('error', 'Не удалось добавить маркер на график:', e);
        }
        liquidationCount = symbolMarkers.length;
        updateStatusWithCount();
    }
}

function addMarkerToChart(marker) {
    if (!chart) return;
    chart.createOverlay({
        name: 'liqMarker',
        extendData: { color: marker.color, text: marker.text, position: marker.position },
        points: [{ timestamp: marker.time, value: marker.value }],
    });
}

function renderAllMarkers(symbol) {
    if (!chart) return;
    chart.removeOverlay({ name: 'liqMarker' });
    const markers = allLiquidations.get(symbol) || [];
    markers.forEach(addMarkerToChart);
}

function updateStatusWithCount() {
    const el = document.getElementById('connStatus');
    if (el) {
        el.textContent = `Connected (${liquidationCount} liq)`;
    }
}

// ---------- Загрузка / обновление графика ----------
async function loadChartData(symbol) {
    try {
        log('info', `Загрузка графика ${symbol} ${currentTimeframe}`);
        const res = await fetch(
            `${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=${currentTimeframe}&limit=1400`
        );
        const klines = await res.json();

        currentCandles = klines.map(k => ({
            timestamp: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
        }));

        oldestTime = klines.length > 0 ? klines[0][0] : null;

        chart.applyNewData(currentCandles);

        if (!allLiquidations.has(symbol)) {
            allLiquidations.set(symbol, loadSavedMarkers(symbol));
        }
        renderAllMarkers(symbol);
        liquidationCount = (allLiquidations.get(symbol) || []).length;
        updateStatusWithCount();

        if (wsReady) subscribeToKlineStream(symbol);
        updateHeader(symbol);
        log('info', `Загружено ${currentCandles.length} свечей, маркеров: ${liquidationCount}`);
    } catch (e) {
        log('error', 'Ошибка загрузки графика:', e);
    }
}

async function loadMoreHistory() {
    if (isLoadingMore || !oldestTime) return;
    isLoadingMore = true;
    const btn = document.getElementById('loadMoreBtn');
    btn.textContent = '⏳';
    btn.disabled = true;
    try {
        log('info', `Подгрузка истории ${currentSymbol} до ${new Date(oldestTime).toISOString()}`);
        const endTime = oldestTime - 1;
        const res = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${currentSymbol}&interval=${currentTimeframe}&limit=1000&endTime=${endTime}`);
        const klines = await res.json();
        if (klines.length === 0) {
            log('info', 'Больше истории нет');
            return;
        }
        const newCandles = klines.map(k => ({
            timestamp: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
        }));
        oldestTime = klines[0][0];
        currentCandles = [...newCandles, ...currentCandles];
        chart.applyNewData(currentCandles);
        renderAllMarkers(currentSymbol);
        log('info', `Подгружено ${newCandles.length} свечей`);
    } catch (e) {
        log('error', 'Ошибка подгрузки истории:', e);
    } finally {
        btn.textContent = '📜 Ещё';
        btn.disabled = false;
        isLoadingMore = false;
    }
}

// ---------- WebSocket тикер + клайн ----------
function connectWebSocket() {
    ws = new WebSocket(BINANCE_WS);
    ws.onopen = () => {
        wsReady = true;
        updateConnectionStatus(true);
        updateSubscriptions();
        if (currentSymbol) subscribeToKlineStream(currentSymbol);
        log('ws', 'Основной WebSocket подключён');
    };
    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.id) return;
            if (msg.e === '24hrTicker') updateTicker(msg);
            else if (msg.e === 'kline') updateChartWithKline(msg);
        } catch (e) {
            log('error', 'Ошибка обработки WS:', e);
        }
    };
    ws.onclose = () => {
        wsReady = false;
        updateConnectionStatus(false);
        lastSubscriptionSet.clear();
        currentKlineSymbol = null;
        log('ws', 'Основной WebSocket закрыт, переподключение через 5с');
        setTimeout(connectWebSocket, 5000);
    };
    ws.onerror = () => log('error', 'WS error');
}

function updateSubscriptions() {
    if (!wsReady || ws.readyState !== WebSocket.OPEN) return;
    const target = new Set(filteredCoins.slice(0, 50).map(c => c.symbol.toLowerCase()));
    const toUnsub = [], toSub = [];
    lastSubscriptionSet.forEach(sym => { if (!target.has(sym)) toUnsub.push(`${sym}@ticker`); });
    target.forEach(sym => { if (!lastSubscriptionSet.has(sym)) toSub.push(`${sym}@ticker`); });
    if (toUnsub.length) ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: toUnsub, id: Date.now() }));
    if (toSub.length) ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: toSub, id: Date.now() + 1 }));
    lastSubscriptionSet = target;
}

function subscribeToKlineStream(symbol) {
    if (!wsReady || ws.readyState !== WebSocket.OPEN) return;
    if (currentKlineSymbol && currentKlineSymbol !== symbol) {
        ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [`${currentKlineSymbol.toLowerCase()}@kline_${currentTimeframe}`], id: Date.now() }));
    }
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${symbol.toLowerCase()}@kline_${currentTimeframe}`], id: Date.now() + 1 }));
    currentKlineSymbol = symbol;
}

function updateTicker(data) {
    const symbol = data.s.toUpperCase();
    const coin = coins.get(symbol);
    if (!coin) return;
    coin.price = parseFloat(data.c);
    coin.change = parseFloat(data.P);
    if (symbol === currentSymbol) updateHeader(symbol);
    const idx = filteredCoins.findIndex(c => c.symbol === symbol);
    if (idx !== -1) updateCoinRow(coin);
}

function updateChartWithKline(data) {
    try {
        const k = data.k;
        const candleTime = k.t;
        const newCandle = {
            timestamp: candleTime,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
        };

        const lastCandle = currentCandles.length > 0 ? currentCandles[currentCandles.length - 1] : null;

        if (!lastCandle) {
            currentCandles = [newCandle];
            chart.applyNewData(currentCandles);
            return;
        }

        if (candleTime === lastCandle.timestamp) {
            const prevHigh = lastCandle.high;
            const prevLow = lastCandle.low;
            if (newCandle.high > prevHigh * 1.5 || newCandle.low < prevLow * 0.5) {
                log('warn', `Выброс в ${data.s}, игнорируем`);
                return;
            }
            Object.assign(lastCandle, newCandle);
            chart.updateData(newCandle);
        } else if (candleTime > lastCandle.timestamp) {
            currentCandles.push(newCandle);
            if (currentCandles.length > 1000) currentCandles.shift();
            chart.updateData(newCandle);
        }
    } catch (e) {
        log('error', 'Ошибка обновления свечи:', e);
    }
}

function updateHeader(symbol) {
    const coin = coins.get(symbol);
    if (!coin) return;
    document.getElementById('currentSymbol').textContent = symbol + ' (' + currentTimeframe + ')';
    document.getElementById('currentPrice').textContent = formatPrice(coin.price);
    const ch = document.getElementById('currentChange');
    const change = coin.change;
    ch.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    ch.className = 'symbol-change ' + (change >= 0 ? 'positive' : 'negative');
}

function formatPrice(p) {
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    return p.toFixed(6);
}

async function refresh30mChanges() {
    const headerSpan = document.querySelector('#listHeader span[data-sort="change30m"]');
    const originalText = headerSpan.textContent;
    headerSpan.textContent = '⏳ 30м';
    const promises = filteredCoins.map(async (coin) => {
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
        } catch (e) {}
        return coin;
    });
    await Promise.all(promises);
    headerSpan.textContent = originalText;
}

function setupEvents() {
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.addEventListener('click', () => setTimeframe(btn.dataset.tf));
    });
    document.querySelectorAll('#listHeader span').forEach(span => {
        span.addEventListener('click', async () => {
            const field = span.dataset.sort;
            if (field === 'change30m') await refresh30mChanges();
            sortBy(field);
        });
    });
    document.getElementById('loadMoreBtn').addEventListener('click', loadMoreHistory);
}

function sortBy(field) {
    if (sortField === field) sortDesc = !sortDesc;
    else { sortField = field; sortDesc = true; }
    sortCoins();
    renderCoinsList();
}

function sortCoins() {
    filteredCoins.sort((a, b) => {
        let va = a[sortField], vb = b[sortField];
        if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        if (va < vb) return sortDesc ? 1 : -1;
        if (va > vb) return sortDesc ? -1 : 1;
        return 0;
    });
}

function renderCoinsList() {
    const container = document.getElementById('coinsList');
    container.innerHTML = '';
    filteredCoins.forEach(c => container.appendChild(createCoinRow(c)));
}

function createCoinRow(coin) {
    const div = document.createElement('div');
    div.className = 'coin-item' + (coin.symbol === currentSymbol ? ' active' : '');
    div.dataset.symbol = coin.symbol;
    div.onclick = () => selectCoin(coin.symbol);
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

function updateCoinRow(coin) {
    const row = document.querySelector(`.coin-item[data-symbol="${coin.symbol}"]`);
    if (!row) return;
    row.children[1].textContent = formatPrice(coin.price);
    row.children[2].textContent = `${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(2)}%`;
    row.children[2].className = `coin-change ${coin.change >= 0 ? 'positive' : 'negative'}`;
}

function selectCoin(symbol) {
    currentSymbol = symbol;
    log('info', `Выбрана монета ${symbol}`);
    document.querySelectorAll('.coin-item').forEach(el => {
        el.classList.toggle('active', el.dataset.symbol === symbol);
    });
    loadChartData(symbol);
    updateHeader(symbol);
}

function updateCoinsCount() {
    document.getElementById('coinsCount').textContent = filteredCoins.length;
}

function updateConnectionStatus(ok) {
    const el = document.getElementById('connStatus');
    el.textContent = ok ? `Connected (${liquidationCount} liq)` : 'Disconnected';
    el.className = 'connection-status ' + (ok ? 'status-connected' : 'status-disconnected');
}

function setTimeframe(tf) {
    currentTimeframe = tf;
    log('info', `Таймфрейм: ${tf}`);
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === tf);
    });
    document.getElementById('currentSymbol').textContent = currentSymbol + ' (' + tf + ')';
    loadChartData(currentSymbol);
}

init();
