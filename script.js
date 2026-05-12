(function() {
    if (typeof klinecharts === 'undefined') {
        document.getElementById('chart').innerHTML = '<div style="color:red; padding:20px;">KLineChart не загружена</div>';
        return;
    }

    // --- СПИСОК СИМВОЛОВ ---
    const SYMBOLS = [
        'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
        'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
        'UNIUSDT', 'MATICUSDT', 'SHIBUSDT', 'LTCUSDT', 'ATOMUSDT'
    ];

    let selectedSymbol = 'BTCUSDT';
    let currentInterval = '1m';
    let currentChartData = [];

    let chart = null;
    let wsChart = null;
    let wsScreener = null;
    let currentFetchController = null;

    // --- ПЕРЕМЕННЫЕ ДЛЯ ЛИКВИДАЦИЙ ---
    const LIQ_MARKERS = new Map();
    const LIQ_VISIBILITY_DURATION = 30000;
    const MIN_LIQ_COST_USDT = 20000; // порог отрисовки: только ликвидации ≥ 20 000 USDT
    let liquidationWs = null;

    // --- ЛОГ ---
    const logPanel = document.getElementById('log-panel');
    function log(msg, type = 'info') {
        const time = new Date().toLocaleTimeString();
        const div = document.createElement('div');
        div.textContent = `[${time}] ${msg}`;
        div.className = 'log-' + type;
        logPanel.appendChild(div);
        logPanel.scrollTop = logPanel.scrollHeight;
    }

    function formatPrice(price, symbol) {
        if (symbol === 'SHIBUSDT') return price.toFixed(8);
        if (symbol === 'DOGEUSDT') return price.toFixed(6);
        if (price >= 10) return price.toFixed(2);
        if (price >= 1) return price.toFixed(3);
        return price.toFixed(4);
    }

    function getPricePrecision(price) {
        if (price < 0.00001) return 8;
        if (price < 0.0001) return 7;
        if (price < 0.001) return 6;
        if (price < 0.01) return 5;
        if (price < 0.1) return 4;
        return 2;
    }

    function updateChartPricePrecision(price) {
        if (!chart) return;
        const precision = getPricePrecision(price);
        if (typeof chart.setPriceVolumePrecision === 'function') {
            chart.setPriceVolumePrecision(precision, 2);
        }
    }

    // --- СКРИНЕР ---
    function buildScreenerRows() {
        const tbody = document.querySelector('#screener-table tbody');
        tbody.innerHTML = '';
        SYMBOLS.forEach(sym => {
            const tr = document.createElement('tr');
            tr.id = 'row-' + sym;
            tr.innerHTML = `<td class="pair">${sym.replace('USDT', '')}</td><td class="price">-</td><td class="change neutral">-</td>`;
            tr.addEventListener('click', () => selectSymbol(sym));
            tbody.appendChild(tr);
        });
    }

    function updateScreenerRow(symbol, price, changePercent) {
        const row = document.getElementById('row-' + symbol);
        if (!row) return;
        const priceCell = row.querySelector('.price');
        const changeCell = row.querySelector('.change');
        if (priceCell) priceCell.textContent = formatPrice(price, symbol);
        if (changeCell) {
            const pct = parseFloat(changePercent);
            changeCell.textContent = (pct > 0 ? '+' : '') + changePercent + '%';
            changeCell.className = 'change ' + (pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral');
        }
        if (selectedSymbol === symbol && chart) {
            updateChartPricePrecision(price);
        }
    }

    async function initScreenerData() {
        const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            data.forEach(item => {
                const price = parseFloat(item.lastPrice);
                const changePercent = parseFloat(item.priceChangePercent).toFixed(2);
                updateScreenerRow(item.symbol, price, changePercent);
            });
        } catch (err) { console.error(err); }
    }

    function startScreenerWebSocket() {
        if (wsScreener) wsScreener.close();
        const streams = SYMBOLS.map(s => s.toLowerCase() + '@miniTicker').join('/');
        wsScreener = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
        wsScreener.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.data) {
                    const { s: symbol, c: closeStr, o: openStr } = msg.data;
                    const price = parseFloat(closeStr);
                    const openPrice = parseFloat(openStr);
                    if (openPrice) {
                        const changePercent = ((price - openPrice) / openPrice * 100).toFixed(2);
                        updateScreenerRow(symbol, price, changePercent);
                    }
                }
            } catch (err) {}
        };
        wsScreener.onclose = () => setTimeout(startScreenerWebSocket, 5000);
    }

    function selectSymbol(sym) {
        if (selectedSymbol === sym) return;
        log(`Смена символа: ${selectedSymbol} → ${sym}`);

        if (chart) {
            LIQ_MARKERS.forEach((ids) => {
                try { chart.removeOverlay(ids.lineId); } catch (e) {}
                try { chart.removeOverlay(ids.annotId); } catch (e) {}
            });
            LIQ_MARKERS.clear();
        }

        selectedSymbol = sym;
        document.querySelectorAll('#screener-table tbody tr').forEach(tr => tr.classList.remove('active'));
        const activeRow = document.getElementById('row-' + sym);
        if (activeRow) activeRow.classList.add('active');
        loadChart(sym, currentInterval);
    }

    // --- ГРАФИК ---
    function initChart() {
        if (chart) {
            if (typeof chart.destroy === 'function') chart.destroy();
            chart = null;
        }
        chart = klinecharts.init(document.getElementById('chart'), {
            styles: {
                grid: {
                    horizontal: { color: '#2b2f36', style: 'dash' },
                    vertical: { color: '#2b2f36', style: 'dash' }
                },
                candle: {
                    bar: { upColor: '#0ecb81', downColor: '#f6465d', noChangeColor: '#848e9c' }
                },
                xAxis: { axisLine: { color: '#2b2f36' }, tickText: { color: '#848e9c', size: 11 } },
                yAxis: { axisLine: { color: '#2b2f36' }, tickText: { color: '#848e9c', size: 11 } }
            },
            worker: false
        });
        log('График инициализирован');
    }

    window.addEventListener('resize', () => {
        if (chart && typeof chart.resize === 'function') chart.resize();
    });

    async function fetchHistory(symbol, interval, limit, signal) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.json();
        return raw.map(d => ({
            timestamp: d[0],
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));
    }

    async function loadChart(symbol, interval) {
        log(`Загрузка графика ${symbol} ${interval}`);
        if (wsChart) {
            wsChart.onclose = null;
            wsChart.close();
            wsChart = null;
        }
        if (currentFetchController) currentFetchController.abort();
        currentFetchController = new AbortController();
        const { signal } = currentFetchController;
        try {
            const history = await fetchHistory(symbol, interval, 500, signal);
            if (signal.aborted) return;
            currentChartData = history;
            if (!chart) initChart();
            chart.applyNewData(history);
            if (history.length) {
                updateChartPricePrecision(history[history.length - 1].close);
            }
            const wsUrl = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`;
            connectChartWebSocket(wsUrl, symbol, interval);
        } catch (err) {
            if (err.name === 'AbortError') return;
            log(`Ошибка загрузки истории: ${err.message}`, 'error');
            setTimeout(() => {
                if (selectedSymbol === symbol && currentInterval === interval) loadChart(symbol, interval);
            }, 3000);
        }
    }

    function connectChartWebSocket(wsUrl, symbol, interval) {
        if (wsChart) wsChart.close();
        wsChart = new WebSocket(wsUrl);
        wsChart.onopen = () => log('WebSocket графика открыт');
        wsChart.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.e === 'kline') {
                    const k = msg.k;
                    const candle = {
                        timestamp: k.t,
                        open: parseFloat(k.o),
                        high: parseFloat(k.h),
                        low: parseFloat(k.l),
                        close: parseFloat(k.c),
                        volume: parseFloat(k.v)
                    };
                    const last = currentChartData[currentChartData.length - 1];
                    if (candle.timestamp === last?.timestamp) {
                        currentChartData[currentChartData.length - 1] = candle;
                        chart.updateData(candle);
                    } else if (!last || candle.timestamp > last.timestamp) {
                        currentChartData.push(candle);
                        chart.applyMoreData([candle]);
                    }
                    if (selectedSymbol === symbol) {
                        updateChartPricePrecision(candle.close);
                    }
                }
            } catch (e) {
                console.warn(e);
            }
        };
        wsChart.onclose = () => {
            log('WebSocket графика закрыт, переподключение через 3с', 'warn');
            setTimeout(() => {
                if (selectedSymbol === symbol && currentInterval === interval) {
                    connectChartWebSocket(wsUrl, symbol, interval);
                }
            }, 3000);
        };
    }

    // --- ПОТОК ЛИКВИДАЦИЙ (исправленный URL) ---
    function startLiquidationStream(symbolsArr) {
        if (liquidationWs) {
            liquidationWs.onclose = null;
            liquidationWs.close(1000, 'Переподключение');
            liquidationWs = null;
        }

        const streams = symbolsArr.map(s => `${s.toLowerCase()}@forceOrder`).join('/');
        // НОВЫЙ ПРАВИЛЬНЫЙ ЭНДПОИНТ ДЛЯ РЫНОЧНЫХ ДАННЫХ
        const wsUrl = `wss://fstream.binance.com/market/stream?streams=${streams}`;
        liquidationWs = new WebSocket(wsUrl);

        liquidationWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.data && msg.data.e === 'forceOrder') {
                    const order = msg.data.o;
                    const symbol = order.s;
                    const price = parseFloat(order.ap);
                    const side = order.S;
                    const quantity = parseFloat(order.q);
                    const tradeTime = order.T;
                    const costUSDT = quantity * price;

                    const sideText = side === 'SELL' ? 'LONG Liq' : 'SHORT Liq';
                    const logType = side === 'SELL' ? 'sell' : 'buy';

                    // Всегда пишем в лог
                    log(
                        `Ликвидация: ${sideText} ${symbol} по ${formatPrice(price, symbol)} ` +
                        `(Qty: ${quantity}, $${costUSDT.toFixed(2)})`,
                        logType
                    );

                    // На график наносим только ликвидации ≥ 20 000 USDT и только для текущего символа
                    if (symbol === selectedSymbol && costUSDT >= MIN_LIQ_COST_USDT) {
                        drawLiquidationMarker(price, side, quantity, tradeTime, costUSDT);
                    }
                }
            } catch (err) {
                console.warn('Ошибка парсинга ликвидации:', err);
            }
        };

        liquidationWs.onclose = (event) => {
            log(`WebSocket ликвидаций закрыт (${event.code}). Переподключение через 5с.`, 'warn');
            setTimeout(() => startLiquidationStream(symbolsArr), 5000);
        };

        liquidationWs.onerror = (error) => {
            log('Ошибка WebSocket ликвидаций', 'error');
            console.error(error);
        };

        log(`Запущен поток ликвидаций для ${symbolsArr.length} символов.`);
    }

    function drawLiquidationMarker(price, side, quantity, tradeTime, costUSDT) {
        if (!chart) return;

        const lineId = `liq-line-${tradeTime}-${Math.random()}`;
        const annotId = `liq-annot-${tradeTime}-${Math.random()}`;
        const shortLabel = side === 'SELL' ? 'L' : 'S';
        const color = side === 'SELL' ? '#ff4d4f' : '#0ecb81';

        LIQ_MARKERS.set(`${tradeTime}_${side}`, { lineId, annotId });

        // Линия цены
        chart.createOverlay({
            name: 'priceLine',
            id: lineId,
            points: [{ timestamp: tradeTime, value: price }],
            extendData: `${shortLabel} $${costUSDT.toFixed(0)}`,
            styles: {
                line: {
                    color: color,
                    size: 2,
                    dashed: true
                }
            }
        });

        // Текстовая аннотация
        chart.createOverlay({
            name: 'simpleAnnotation',
            id: annotId,
            points: [{ timestamp: tradeTime, value: price }],
            extendData: `${shortLabel} ${formatPrice(price, selectedSymbol)}`,
            styles: {
                text: {
                    color: '#ffffff',
                    size: 11,
                    backgroundColor: color
                },
                offset: [0, -15]
            }
        });

        // Автоудаление через LIQ_VISIBILITY_DURATION
        setTimeout(() => {
            try {
                chart.removeOverlay(lineId);
                chart.removeOverlay(annotId);
            } catch (e) { /* уже удалён */ }
            LIQ_MARKERS.delete(`${tradeTime}_${side}`);
        }, LIQ_VISIBILITY_DURATION);
    }

    // --- КНОПКИ ИНТЕРВАЛОВ ---
    function bindIntervalButtons() {
        document.querySelectorAll('.interval-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const interval = this.dataset.interval;
                if (currentInterval === interval) return;
                log(`Смена интервала: ${currentInterval} → ${interval}`);
                currentInterval = interval;
                document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                loadChart(selectedSymbol, interval);
            });
        });
    }

    // --- СТАРТ ПРИЛОЖЕНИЯ ---
    function startApp() {
        log('Приложение запущено');
        buildScreenerRows();
        initChart();
        bindIntervalButtons();
        initScreenerData();
        startScreenerWebSocket();
        startLiquidationStream(SYMBOLS);
        document.getElementById('row-BTCUSDT')?.classList.add('active');
        loadChart('BTCUSDT', '1m');
    }

    window.addEventListener('DOMContentLoaded', startApp);
})();
