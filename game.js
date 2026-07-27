(() => {
  'use strict';

  // ===== 常量 =====
  const SIZE = 4;
  const GAP = 0.025;
  const WIN_VALUE = 2048;
  const MOVE_DURATION = 120;

  // ===== 角色 → 数字 映射 =====
  // 排序原则：按元素色系从冷到暖分组（冰→雷→火→草→岩→风→水），同色系内按强度从低到高。
  // 强制约束：雷电将军=1024、芙宁娜=2048（用户指定）。
  // bg: 该角色的氛围背景图文件名（images/bg_<key>.jpg），由 AI 生图提供，缺图时回退元素色渐变。
  const GENSHIN_CHARS = {
    2:    { name: '甘雨',     en: 'Ganyu',        element: 'cryo',    symbol: '❄', img: 'ganyu_s',    bg: 'ganyu' },
    4:    { name: '神里绫华', en: 'Ayaka',        element: 'cryo',    symbol: '❄', img: 'ayaka_s',    bg: 'ayaka' },
    8:    { name: '刻晴',     en: 'Keqing',       element: 'electro', symbol: '⚡', img: 'keqing_s',   bg: 'keqing' },
    16:   { name: '胡桃',     en: 'Hu Tao',       element: 'pyro',    symbol: '🔥', img: 'hutao_s',    bg: 'hutao' },
    32:   { name: '散兵',     en: 'Wanderer',     element: 'anemo',   symbol: '🌬️', img: 'wanderer_s', bg: 'wanderer' },
    64:   { name: '纳西妲',   en: 'Nahida',       element: 'dendro',  symbol: '🌿', img: 'nahida_s',   bg: 'nahida' },
    128:  { name: '钟离',     en: 'Zhongli',      element: 'geo',     symbol: '🪨', img: 'zhongli_s',  bg: 'zhongli' },
    256:  { name: '枫原万叶', en: 'Kazuha',       element: 'anemo',   symbol: '🌬️', img: 'kazuha_s',   bg: 'kazuha' },
    512:  { name: '那维莱特', en: 'Neuvillette',  element: 'hydro',   symbol: '💧', img: 'neuvillette_s', bg: 'neuvillette' },
    1024: { name: '芙宁娜',   en: 'Furina',       element: 'hydro',   symbol: '💧', img: 'furina_s',   bg: 'furina' },
    2048: { name: '雷电将军', en: 'Raiden',       element: 'electro', symbol: '⚡', img: 'raiden_s',   bg: 'raiden' },
  };

  // 元素主色（基于原神官方元素取色，供粒子特效与回退底色读取）
  const ELEMENT_COLORS = {
    cryo:    '#7fd0e8',
    electro: '#b993e4',
    pyro:    '#ec4923',
    dendro:  '#a6c938',
    geo:     '#e3cd65',
    anemo:   '#359697',
    hydro:   '#4aa8d8',
  };

  // ===== DOM 引用 =====
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const tileContainer = document.getElementById('tile-container');
  const gameMessageEl = document.getElementById('game-message');
  const gameMessageText = document.getElementById('game-message-text');
  const keepGoingBtn = document.getElementById('keep-going-button');
  const retryBtn = document.getElementById('retry-button');
  const newGameBtn = document.getElementById('new-game');
  const clearBestBtn = document.getElementById('clear-best');
  const scoreBoxes = document.querySelectorAll('.score-box');
  const themeSelect = document.getElementById('theme-select');
  const fxCanvas = document.getElementById('fx-canvas');
  const fxCtx = fxCanvas.getContext('2d');

  // ===== 游戏状态 =====
  let board;
  let score;
  let bestScore;
  let nextTileId;
  let hasWon;
  let keepPlaying;
  let isOver;
  let isAnimating;
  let theme = 'classic';       // 'classic' | 'genshin'
  let cellLayout = null;
  let renderedTiles = new Map();
  // 演示模式：URL 带 ?demo 时开启，初始填入 11 种方块各一个，禁止移动，便于观察效果
  const demoMode = new URLSearchParams(window.location.search).has('demo');

  // 立绘缓存（buildTileInner 复用，避免重复创建 Image）
  const portraitCache = new Map();

  // ===== 资源预加载（带进度跟踪）=====
  // 收集当前主题所需加载的所有图片 URL，并发加载并报告进度。
  // 朴素模式几乎无图（仅可能的背景）；原神模式加载立绘+背景+元素图标+主背景。
  function collectAssetUrls(currentTheme) {
    const urls = new Set();
    if (currentTheme === 'genshin') {
      // 主大背景
      urls.add('images/bg_s.jpg');
      // 立绘 + 角色氛围背景（均为压缩版 _s）
      for (const value in GENSHIN_CHARS) {
        const ch = GENSHIN_CHARS[value];
        if (ch.img) urls.add(`images/${ch.img}.webp?v=7`);
        if (ch.bg) urls.add(`images/bg_${ch.bg}_s.jpg?v=4`);
      }
      // 元素图标
      ['cryo','electro','pyro','dendro','geo','anemo','hydro'].forEach(el => {
        urls.add(`images/elem_${el}.webp`);
      });
    }
    return Array.from(urls);
  }

  // 加载单张图，返回 Promise（onerror 也 resolve，避免卡住）
  // 加载单张图，返回 Promise（onerror 也 resolve，避免卡住）。
  // 关键：带超时（默认 8 秒），防止慢网下请求 hang 住导致 Promise.all 永不完成 → 白屏。
  function loadImage(url, timeoutMs = 8000) {
    return new Promise(resolve => {
      const img = new Image();
      let settled = false;
      const finish = (ok, image) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ url, ok, img: image });
      };
      const timer = setTimeout(() => finish(false, null), timeoutMs);
      img.onload = () => finish(true, img);
      img.onerror = () => finish(false, null);
      img.src = url;
    });
  }

  // 预加载全部资源，onProgress(0~100) 报告进度。返回 Promise。
  async function preloadAssets(currentTheme, onProgress) {
    const urls = collectAssetUrls(currentTheme);
    if (urls.length === 0) { onProgress(100); return; }
    let done = 0;
    const total = urls.length;
    // 缓存立绘供 buildTileInner 复用
    const results = await Promise.all(urls.map(url =>
      loadImage(url).then(r => {
        done++;
        onProgress(Math.round(done / total * 100));
        // 立绘图缓存到 portraitCache
        if (r.ok && r.img && /\.webp\?/.test(url) && !url.includes('elem_') && !url.includes('bg')) {
          const key = url.match(/images\/([^?]+)/)[1].replace('.webp', '');
          portraitCache.set(key, r.img);
        }
        return r;
      })
    ));
    return results;
  }

  // ===== 主题 =====
  function loadTheme() {
    theme = localStorage.getItem('theme-2048') || 'classic';
    applyTheme();
  }
  function saveTheme() {
    localStorage.setItem('theme-2048', theme);
  }
  function applyTheme() {
    document.body.setAttribute('data-theme', theme);
    if (themeSelect) themeSelect.value = theme;
  }

  // ===== 初始化 =====
  function loadBest() {
    const stored = parseInt(localStorage.getItem('bestScore-2048'), 10);
    bestScore = Number.isFinite(stored) ? stored : 0;
  }
  function saveBest() {
    localStorage.setItem('bestScore-2048', String(bestScore));
  }

  function emptyBoard() {
    const b = [];
    for (let r = 0; r < SIZE; r++) b.push(new Array(SIZE).fill(null));
    return b;
  }

  function init() {
    board = emptyBoard();
    score = 0;
    nextTileId = 1;
    hasWon = false;
    keepPlaying = false;
    isOver = false;
    isAnimating = false;
    tileContainer.innerHTML = '';
    renderedTiles.clear();
    // 清空残留粒子
    particles.length = 0;
    rings.length = 0;
    flashes.length = 0;
    hideMessage();

    if (demoMode) {
      // 演示模式：按数值从小到大，把 11 种方块依次放进棋盘前 11 格（行优先）
      // 不触发胜负判定、不生成随机方块，便于观察每个方块的效果。
      const values = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
      let idx = 0;
      outer: for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (idx >= values.length) break outer;
          const v = values[idx++];
          board[r][c] = { id: nextTileId++, value: v, row: r, col: c, isNew: false, merged: false };
        }
      }
      // 演示模式下视为已选继续游戏，避免 1024/2048 触发胜利弹窗
      hasWon = true;
      keepPlaying = true;
      render();
      return;
    }

    addRandomTile();
    addRandomTile();
    updateScore(0);
    render();
  }

  // ===== 随机生成方块 =====
  function emptyCells() {
    const cells = [];
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (!board[r][c]) cells.push([r, c]);
    return cells;
  }

  function addRandomTile() {
    const cells = emptyCells();
    if (cells.length === 0) return null;
    const [r, c] = cells[Math.floor(Math.random() * cells.length)];
    const value = Math.random() < 0.9 ? 2 : 4;
    const tile = { id: nextTileId++, value, row: r, col: c, isNew: true, merged: false };
    board[r][c] = tile;
    return tile;
  }

  // ===== 单行向左压缩并合并 =====
  function slideLeft(row) {
    const tiles = row.filter(t => t !== null);
    const result = [];
    const mergePositions = []; // 记录合并发生的位置（用于触发特效）
    let gain = 0;
    let i = 0;
    while (i < tiles.length) {
      if (i + 1 < tiles.length && tiles[i].value === tiles[i + 1].value) {
        const merged = Object.assign({}, tiles[i], {
          value: tiles[i].value * 2,
          merged: true,
          isNew: false,
          justMerged: true, // 标记本次合并产生
        });
        result.push(merged);
        mergePositions.push(result.length - 1); // 该合并在线中的索引
        gain += merged.value;
        i += 2;
      } else {
        result.push(Object.assign({}, tiles[i], { merged: false, isNew: false, justMerged: false }));
        i += 1;
      }
    }
    while (result.length < SIZE) result.push(null);

    let moved = false;
    for (let k = 0; k < SIZE; k++) {
      const a = row[k], b = result[k];
      if (a && b) {
        if (a.id !== b.id || a.value !== b.value) { moved = true; break; }
      } else if (a || b) {
        moved = true; break;
      }
    }
    return { line: result, moved, gain, mergePositions };
  }

  // dir: 'left' | 'right' | 'up' | 'down'
  function move(dir) {
    if (demoMode) return; // 演示模式禁止移动
    if (isAnimating || isOver) return;

    let totalGain = 0;
    let anyMoved = false;
    const nextBoard = emptyBoard();
    const pendingMerges = []; // 收集所有合并的目标格（用最终棋盘坐标），动画结束后触发特效

    for (let i = 0; i < SIZE; i++) {
      let line = new Array(SIZE);
      for (let j = 0; j < SIZE; j++) {
        let r, c;
        if (dir === 'left')      { r = i;            c = j; }
        else if (dir === 'right'){ r = i;            c = SIZE - 1 - j; }
        else if (dir === 'up')   { r = j;            c = i; }
        else                     { r = SIZE - 1 - j; c = i; }
        line[j] = board[r][c];
      }

      const { line: merged, moved, gain, mergePositions } = slideLeft(line);
      if (moved) anyMoved = true;
      totalGain += gain;

      for (let j = 0; j < SIZE; j++) {
        let r, c;
        if (dir === 'left')      { r = i;            c = j; }
        else if (dir === 'right'){ r = i;            c = SIZE - 1 - j; }
        else if (dir === 'up')   { r = j;            c = i; }
        else                     { r = SIZE - 1 - j; c = i; }
        if (merged[j]) {
          merged[j].row = r;
          merged[j].col = c;
        }
        nextBoard[r][c] = merged[j];
      }

      // 记录这条线上的合并最终落点
      for (const mp of mergePositions) {
        const tile = merged[mp];
        let r, c;
        if (dir === 'left')      { r = i;            c = mp; }
        else if (dir === 'right'){ r = i;            c = SIZE - 1 - mp; }
        else if (dir === 'up')   { r = mp;           c = i; }
        else                     { r = SIZE - 1 - mp; c = i; }
        pendingMerges.push({ r, c, value: tile.value });
      }
    }

    if (!anyMoved) return;

    board = nextBoard;
    updateScore(score + totalGain);

    isAnimating = true;
    render();

    window.setTimeout(() => {
      finalizeMergedTiles();
      addRandomTile();
      render();
      isAnimating = false;

      // 触发合并特效
      if (pendingMerges.length > 0) {
        for (const mg of pendingMerges) {
          triggerMergeEffect(mg.r, mg.c, mg.value);
        }
      }

      checkEndConditions();
    }, MOVE_DURATION);
  }

  function finalizeMergedTiles() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = board[r][c];
        if (t) {
          t.merged = false;
          t.justMerged = false;
        }
      }
    }
  }

  // ===== 胜负判定 =====
  function checkEndConditions() {
    if (!hasWon) {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (board[r][c] && board[r][c].value >= WIN_VALUE) {
            hasWon = true;
            // 胜利即终局（更大的方块未做，不提供"继续游戏"选项）
            isOver = true;
            // 胜利时来一场全屏粒子风暴
            triggerVictoryStorm();
            window.setTimeout(() => showMessage(true, false), 300);
            return;
          }
        }
      }
    }
    if (isGameOver()) {
      isOver = true;
      showMessage(false, true);
    }
  }

  function isGameOver() {
    if (emptyCells().length > 0) return false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = board[r][c].value;
        if (c + 1 < SIZE && board[r][c + 1].value === v) return false;
        if (r + 1 < SIZE && board[r + 1][c].value === v) return false;
      }
    }
    return true;
  }

  // ===== 得分 =====
  function updateScore(newScore) {
    const delta = newScore - score;
    score = newScore;
    scoreEl.textContent = score;
    if (score > bestScore) {
      bestScore = score;
      bestEl.textContent = bestScore;
      saveBest();
    }
    if (delta > 0) showScoreAddition(delta);
  }

  function showScoreAddition(delta) {
    const el = document.createElement('div');
    el.className = 'score-addition';
    el.textContent = '+' + delta;
    scoreBoxes[0].appendChild(el);
    window.setTimeout(() => el.remove(), 600);
  }

  // ===== 渲染 =====
  function measureLayout() {
    const containerRect = tileContainer.getBoundingClientRect();
    const cells = document.querySelectorAll('.grid-cell');
    if (cells.length < SIZE * SIZE) {
      const size = tileContainer.clientWidth || 1;
      const gapPx = size * GAP;
      const cellSize = (size - (SIZE + 1) * gapPx) / SIZE;
      const positions = [];
      for (let r = 0; r < SIZE; r++) {
        positions.push([]);
        for (let c = 0; c < SIZE; c++) {
          positions[r].push({ x: gapPx + c * (cellSize + gapPx), y: gapPx + r * (cellSize + gapPx) });
        }
      }
      cellLayout = { positions, cellSize };
      resizeFxCanvas();
      return;
    }
    const positions = [];
    let cellSize = 0;
    for (let r = 0; r < SIZE; r++) {
      positions.push([]);
      for (let c = 0; c < SIZE; c++) {
        const el = cells[r * SIZE + c];
        const rect = el.getBoundingClientRect();
        positions[r].push({ x: rect.left - containerRect.left, y: rect.top - containerRect.top });
        if (!cellSize) cellSize = rect.width;
      }
    }
    cellLayout = { positions, cellSize };
    resizeFxCanvas();
  }

  function resizeFxCanvas() {
    const rect = tileContainer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    fxCanvas.width = rect.width * dpr;
    fxCanvas.height = rect.height * dpr;
    fxCanvas.style.width = rect.width + 'px';
    fxCanvas.style.height = rect.height + 'px';
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tileClass(value) {
    if (value <= 2048) return 'tile-' + value;
    return 'tile-super';
  }

  // 渲染单个方块内容（角色背景图 / 立绘 / 数字 / 元素符号）
  // 原神模式下方块层级（从底到顶）：
  //   .tile-bg-img  角色元素氛围背景图（整块覆盖，缺图回退元素色渐变）
  //   .tile-portrait 角色立绘（半透明叠加在背景上）
  //   .tile-number   数字
  //   .tile-element  元素符号角标
  //   .tile-name     角色名标签
  // 关键：用 data-state 标记记录已构建的(主题+值)，仅当变化时才重建 DOM，
  // 避免每次移动都销毁重建 <img> 造成解码空窗 → 闪白。
  function buildTileInner(el, t) {
    const inner = el.firstElementChild;
    const ch = GENSHIN_CHARS[t.value];
    // stateKey 包含 img 字段，更换立绘文件时会触发重建（避免缓存旧 src）
    const stateKey = `${theme}:${t.value}:${ch ? ch.img : ''}`;
    const needRebuild = el.dataset.tileState !== stateKey;

    if (!needRebuild) {
      // 结构不变：仅同步数字文本（合并后值可能已变，但角色身份通常不变；
      // 这里仍保险地更新一次，开销极小）
      const numEl = inner.querySelector('.tile-number');
      if (numEl && numEl.textContent !== String(t.value)) numEl.textContent = t.value;
      return;
    }

    el.dataset.tileState = stateKey;

    if (theme === 'genshin' && ch) {
      el.classList.toggle('has-portrait', !!ch.img);
      inner.innerHTML = '';

      // 背景层：角色氛围图（缺图 onerror 后由 CSS 元素色渐变兜底）
      const bgWrap = document.createElement('div'); bgWrap.className = 'tile-bg'; inner.appendChild(bgWrap);
      if (ch.bg) {
        const bgImg = document.createElement('img');
        bgImg.className = 'tile-bg-img';
        bgImg.src = `images/bg_${ch.bg}_s.jpg?v=4`;
        bgImg.alt = '';
        bgImg.onerror = () => { bgImg.remove(); bgWrap.classList.add('bg-fallback'); };
        bgWrap.appendChild(bgImg);
      } else {
        bgWrap.classList.add('bg-fallback');
      }

      // 立绘层（在上）。?v=2 破坏浏览器缓存，确保加载最新去白底版本
      if (ch.img) {
        const portrait = document.createElement('img');
        portrait.className = 'tile-portrait';
        portrait.src = `images/${ch.img}.webp?v=7`;
        portrait.onerror = () => portrait.remove();
        inner.appendChild(portrait);
      }
      const numberEl = document.createElement('div'); numberEl.className = 'tile-number';
      numberEl.textContent = t.value; inner.appendChild(numberEl);
      const nameEl = document.createElement('div'); nameEl.className = 'tile-name';
      nameEl.textContent = ch.name; inner.appendChild(nameEl);
    } else {
      // classic 风格：纯数字
      el.classList.remove('has-portrait');
      inner.innerHTML = '';
      const numberEl = document.createElement('div');
      numberEl.className = 'tile-number';
      numberEl.textContent = t.value;
      inner.appendChild(numberEl);
    }
  }

  function render() {
    const liveIds = new Set();
    measureLayout();
    const { positions, cellSize } = cellLayout;

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = board[r][c];
        if (!t) continue;
        liveIds.add(t.id);

        let el = renderedTiles.get(t.id);
        const isNewDom = !el;

        if (isNewDom) {
          el = document.createElement('div');
          el.innerHTML = '<div class="tile-inner"></div>';
          tileContainer.appendChild(el);
          renderedTiles.set(t.id, el);
        }

        const x = positions[r][c].x;
        const y = positions[r][c].y;

        el.className = 'tile ' + tileClass(t.value) +
          (theme === 'genshin' && GENSHIN_CHARS[t.value] && GENSHIN_CHARS[t.value].img ? ' has-portrait' : '') +
          (isNewDom && t.isNew ? ' tile-new' : '') +
          (t.merged ? ' tile-merged' : '');

        buildTileInner(el, t);

        el.style.width = cellSize + 'px';
        el.style.height = cellSize + 'px';
        el.style.transform = `translate(${x}px, ${y}px)`;

        if (isNewDom && t.isNew) {
          window.setTimeout(() => el.classList.remove('tile-new'), 200);
        }
        if (t.merged) {
          window.setTimeout(() => el.classList.remove('tile-merged'), 400);
        }
      }
    }

    // 移除已不在 board 中的方块 DOM
    for (const [id, el] of renderedTiles) {
      if (!liveIds.has(id)) {
        el.remove();
        renderedTiles.delete(id);
      }
    }
  }

  // ===== 消息覆盖层 =====
  function showMessage(won, over) {
    gameMessageEl.classList.remove('game-won', 'game-over');
    if (won) {
      gameMessageEl.classList.add('game-won');
      gameMessageText.textContent = 'You Win!';
      keepGoingBtn.classList.add('hidden');  // 不提供"继续游戏"（更大的方块未做）
      retryBtn.textContent = 'Try again';
    } else if (over) {
      gameMessageEl.classList.add('game-over');
      gameMessageText.textContent = 'Game Over!';
      keepGoingBtn.classList.add('hidden');
      retryBtn.textContent = 'Try again';
    }
    gameMessageEl.classList.add('show');
  }
  function hideMessage() {
    gameMessageEl.classList.remove('show');
  }

  // ============================================================
  // 粒子特效引擎
  // ============================================================
  const particles = [];
  const rings = [];
  const flashes = [];

  // 触发一次合并特效：粒子爆发 + 光晕环 + 元素符号闪光
  function triggerMergeEffect(r, c, value) {
    if (theme !== 'genshin') return; // 朴素风格不触发合成特效
    if (!cellLayout) return;
    const { cellSize } = cellLayout;
    const pos = cellLayout.positions[r][c];
    const cx = pos.x + cellSize / 2;
    const cy = pos.y + cellSize / 2;
    const ch = GENSHIN_CHARS[value];
    const color = ch ? (ELEMENT_COLORS[ch.element] || '#ffffff') : '#ffffff';
    const symbol = ch ? ch.symbol : '✦';

    // 粒子数量随数值递增（移动端适度）
    const isSmall = window.innerWidth < 520;
    const baseN = isSmall ? 8 : 12;
    const n = Math.min(baseN + Math.log2(value) * 2, isSmall ? 28 : 40);

    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      const speed = (1.2 + Math.random() * 2.5) * (cellSize / 110);
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.5,
        life: 1,
        decay: 0.018 + Math.random() * 0.015,
        size: 2 + Math.random() * 3.5,
        color,
        gravity: 0.04,
      });
    }

    // 光晕扩散环
    rings.push({ x: cx, y: cy, radius: cellSize * 0.2, maxRadius: cellSize * 0.7, life: 1, color });

    // 元素符号闪光
    flashes.push({ x: cx, y: cy, symbol, life: 1, size: cellSize * 0.5 });
  }

  // 胜利全屏粒子风暴
  function triggerVictoryStorm() {
    if (theme !== 'genshin') return; // 朴素风格不触发胜利特效
    const rect = tileContainer.getBoundingClientRect();
    const colors = ['#f5d98c', '#4aa8d8', '#5cb85c', '#e8754a', '#d4af37'];
    for (let i = 0; i < 80; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      particles.push({
        x: rect.width / 2,
        y: rect.height / 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.008 + Math.random() * 0.01,
        size: 2 + Math.random() * 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        gravity: 0.02,
      });
    }
    rings.push({ x: rect.width / 2, y: rect.height / 2, radius: 10, maxRadius: rect.width * 0.7, life: 1, color: '#f5d98c' });
  }

  function updateFx() {
    const rect = tileContainer.getBoundingClientRect();
    fxCtx.clearRect(0, 0, rect.width, rect.height);
    fxCtx.globalCompositeOperation = 'lighter'; // 发光叠加

    // 粒子
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.98;
      p.life -= p.decay;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      const alpha = Math.max(0, p.life);
      fxCtx.globalAlpha = alpha;
      // 外发光
      fxCtx.fillStyle = p.color;
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, p.size * (0.6 + alpha * 0.6), 0, Math.PI * 2);
      fxCtx.fill();
      // 高光核心
      fxCtx.globalAlpha = alpha * 0.9;
      fxCtx.fillStyle = '#ffffff';
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, p.size * 0.35, 0, Math.PI * 2);
      fxCtx.fill();
    }

    // 光晕环
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.radius += (ring.maxRadius - ring.radius) * 0.15;
      ring.life -= 0.05;
      if (ring.life <= 0) { rings.splice(i, 1); continue; }
      fxCtx.globalAlpha = ring.life * 0.8;
      fxCtx.strokeStyle = ring.color;
      fxCtx.lineWidth = 3 * ring.life;
      fxCtx.beginPath();
      fxCtx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
      fxCtx.stroke();
    }

    fxCtx.globalCompositeOperation = 'source-over';

    // 元素符号闪光
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.life -= 0.04;
      if (f.life <= 0) { flashes.splice(i, 1); continue; }
      const scale = 1 + (1 - f.life) * 0.8;
      fxCtx.globalAlpha = f.life;
      fxCtx.font = `${f.size * scale}px serif`;
      fxCtx.textAlign = 'center';
      fxCtx.textBaseline = 'middle';
      fxCtx.shadowColor = '#fff';
      fxCtx.shadowBlur = 12;
      fxCtx.fillText(f.symbol, f.x, f.y);
      fxCtx.shadowBlur = 0;
    }

    fxCtx.globalAlpha = 1;
    requestAnimationFrame(updateFx);
  }

  // ===== 输入：键盘 =====
  const KEY_MAP = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    a: 'left', A: 'left', d: 'right', D: 'right',
    w: 'up', W: 'up', s: 'down', S: 'down'
  };
  document.addEventListener('keydown', (e) => {
    const dir = KEY_MAP[e.key];
    if (dir) {
      e.preventDefault();
      move(dir);
    }
  });

  // ===== 输入：触摸 / 鼠标滑动 =====
  const SWIPE_THRESHOLD = 24;
  let touchStartX = 0, touchStartY = 0, pointerActive = false;
  const gameContainer = gameMessageEl.parentElement;

  gameContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    pointerActive = true;
  }, { passive: true });

  gameContainer.addEventListener('touchmove', (e) => {
    if (pointerActive) e.preventDefault();
  }, { passive: false });

  gameContainer.addEventListener('touchend', (e) => {
    if (!pointerActive) return;
    pointerActive = false;
    const t = e.changedTouches[0];
    handleSwipe(t.clientX, t.clientY);
  });

  function handleSwipe(endX, endY) {
    const dx = endX - touchStartX;
    const dy = endY - touchStartY;
    const absX = Math.abs(dx), absY = Math.abs(dy);
    if (Math.max(absX, absY) < SWIPE_THRESHOLD) return;
    if (absX >= absY) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  }

  // ===== 按钮事件 =====
  newGameBtn.addEventListener('click', () => init());
  retryBtn.addEventListener('click', () => init());
  keepGoingBtn.addEventListener('click', () => {
    keepPlaying = true;
    hideMessage();
  });

  // 清除最高分（确认后清零并持久化）
  clearBestBtn.addEventListener('click', () => {
    if (bestScore === 0) return; // 已是 0 无需操作
    if (!confirm('确定要清除最高分记录吗？此操作不可撤销。')) return;
    bestScore = 0;
    bestEl.textContent = '0';
    localStorage.removeItem('bestScore-2048');
  });

  // 主题切换
  themeSelect.addEventListener('change', () => {
    theme = themeSelect.value;
    applyTheme();
    saveTheme();
    // 切换主题后重建所有方块内容（结构不同）
    renderedTiles.forEach(el => el.remove());
    renderedTiles.clear();
    render();
  });

  // ===== 窗口缩放 =====
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderedTiles.forEach(el => { el.style.transition = 'none'; });
      render();
      requestAnimationFrame(() => {
        renderedTiles.forEach(el => { el.style.transition = ''; });
      });
    }, 80);
  });

  // ===== 启动 =====
  // 先读主题，设置到 body 让加载层样式就位（不调 applyTheme，避免图片未就绪时闪）
  loadBest();
  bestEl.textContent = bestScore;
  theme = localStorage.getItem('theme-2048') || 'classic';
  document.body.setAttribute('data-theme', theme);

  // 加载界面 DOM 引用
  const loadingScreen = document.getElementById('loading-screen');
  const loadingBar = document.getElementById('loading-bar');
  const loadingPercent = document.getElementById('loading-percent');

  // 预加载资源 → 完成后启动游戏
  // 记录开始时间，确保加载界面至少显示 400ms（避免缓存命中时一闪而过显得突兀）
  const loadStart = Date.now();
  const MIN_LOADING_MS = 400;
  preloadAssets(theme, (pct) => {
    if (loadingBar) loadingBar.style.width = pct + '%';
    if (loadingPercent) loadingPercent.textContent = pct;
  }).then(() => {
    const elapsed = Date.now() - loadStart;
    const startGame = () => {
      // 资源就绪，正式应用主题（触发背景图显示）并启动游戏
      applyTheme();
      init();
      requestAnimationFrame(updateFx);
      // 淡出加载层
      if (loadingScreen) loadingScreen.classList.add('loaded');
    };
    if (elapsed < MIN_LOADING_MS) {
      setTimeout(startGame, MIN_LOADING_MS - elapsed);
    } else {
      startGame();
    }
  });

  // 版权声明年份自动填充
  const yearEl = document.getElementById('legal-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
