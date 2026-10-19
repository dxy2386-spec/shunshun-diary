/* 顺顺日记 · 前端应用 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  user: null,
  records: [],
  messages: [],
  aiEnabled: false,
  lanUrls: [],
  demoEnabled: true,
  view: 'today',
  historyFilter: '7',
  editingId: null,
  chatBusy: false,
  form: { bristol: 4, color: 'brown', amount: 'medium', ease: 'normal' },
  authMode: 'login',
};

const BRISTOL = {
  1: { name: '硬球', desc: '分离的硬球，排出费力，提示明显便秘倾向。' },
  2: { name: '凹凸', desc: '香肠状但表面凹凸，质地偏硬。' },
  3: { name: '裂纹', desc: '表面有裂纹，属于正常范围。' },
  4: { name: '光滑', desc: '光滑柔软的长条，是最理想的状态。' },
  5: { name: '软块', desc: '柔软的小块，偏软但通常无碍。' },
  6: { name: '糊状', desc: '糊状、边缘不整，提示偏稀。' },
  7: { name: '水样', desc: '水样、无固体成分，提示腹泻。' },
};

const COLORS = {
  brown: { label: '棕褐', full: '棕褐色', value: '#8b5e3c', warn: false },
  dark_brown: { label: '深褐', full: '深褐色', value: '#4d3325', warn: false },
  yellow: { label: '偏黄', full: '偏黄', value: '#c9a227', warn: false },
  green: { label: '偏绿', full: '偏绿', value: '#6f8f4e', warn: false },
  black: { label: '黑色', full: '黑色', value: '#2b2b2b', warn: true },
  red: { label: '红/血', full: '带血/红色', value: '#a7352d', warn: true },
  pale: { label: '灰白', full: '灰白/陶土色', value: '#cfc3ad', warn: true },
};

const AMOUNTS = { small: '偏少', medium: '适中', large: '偏多' };
const EASES = { easy: '顺畅', normal: '正常', strained: '费力', urgent: '急迫' };
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const TIPS = [
  '早起后先喝一杯温水，再给自己留一段不赶时间的如厕时间。',
  '膳食纤维要慢慢加，水也要跟着加，突然猛吃粗粮容易胀气。',
  '有便意别憋。错过那阵反射，下一次可能要等很久。',
  '久坐时每小时起身走两分钟，肠道的动力也会跟着回来。',
  '记录颜色时，回想一下前两餐吃了什么：火龙果、玉米、菠菜都会“染色”。',
  '蹲坐时在脚下垫个小凳，让膝盖略高于髋部，会更省力。',
];

/* ---------- utilities ---------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatChat(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

function localKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysAgoKey(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return localKey(d);
}

function dayDiff(a, b) {
  return Math.round((keyToDate(b) - keyToDate(a)) / 864e5);
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtShortDate(date = new Date()) {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function fmtDateHeading(key) {
  const today = localKey();
  const date = keyToDate(key);
  const base = `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
  if (key === today) return { label: '今天', detail: base };
  if (dayDiff(key, today) === 1) return { label: '昨天', detail: base };
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return { label: base, detail: sameYear ? '' : String(date.getFullYear()) };
}

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function pluralRecords(n) {
  return `${n} 次`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了，早点休息';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function showToast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function setError(name, message) {
  const el = $(`[data-error-for="${name}"]`);
  if (el) el.textContent = message || '';
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    if (res.status === 401 && !path.includes('/api/auth/')) {
      resetToAuth();
    }
    const err = new Error(data.error || '请求失败，请稍后再试');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- artwork ---------- */

function bristolArt(type) {
  const open = '<svg viewBox="0 0 48 36" aria-hidden="true">';
  const close = '</svg>';
  const fill = 'fill="currentColor"';
  switch (Number(type)) {
    case 1:
      return `${open}<circle cx="11" cy="25" r="4.2" ${fill}/><circle cx="21" cy="13" r="5" ${fill}/><circle cx="34" cy="22" r="4.6" ${fill}/><circle cx="25" cy="27" r="3.6" ${fill}/>${close}`;
    case 2:
      return `${open}<path ${fill} d="M7 20c0-4 3-7 7-7 1-4 6-6 9-3 2-4 8-4 10 0 4-2 9 0 9 4 3 1 3 6-1 7-1 3-5 4-8 2-2 3-7 3-9 0-4 2-8 0-9-2-4 2-8 0-8-1Z"/><path d="M18 12c1 2 1 4 0 6M27 10c1 2 1 4 0 6" fill="none" stroke="#fbf7ee" stroke-width="1.2" stroke-linecap="round"/>${close}`;
    case 3:
      return `${open}<rect x="7" y="11" width="34" height="15" rx="7.5" ${fill}/><path d="M15 12c1.5 2 1.5 4 0 6M23 11c1.5 2 1.5 4 0 6M31 13c1.5 2 1.5 4 0 5" fill="none" stroke="#fbf7ee" stroke-width="1.2" stroke-linecap="round"/>${close}`;
    case 4:
      return `${open}<path ${fill} d="M7 21c-1-4 3-8 8-6 4 2 8 7 15 4 4-2 9 0 9 4 0 5-5 7-10 5-6-2-10-6-16-4-3 1-5-1-6-3Z"/><circle cx="13" cy="15" r="2.2" fill="#fbf7ee" opacity=".35"/>${close}`;
    case 5:
      return `${open}<circle cx="15" cy="20" r="7" ${fill}/><circle cx="27" cy="16" r="6.2" ${fill}/><circle cx="33" cy="24" r="6.6" ${fill}/><circle cx="21" cy="27" r="5.4" ${fill}/>${close}`;
    case 6:
      return `${open}<path ${fill} d="M5 25c0-5 3-7 7-7 0-4 4-7 8-6 2-4 8-4 10 0 4-1 8 2 8 6 4 0 6 3 5 7H5Z"/><circle cx="18" cy="29" r="2.2" ${fill}/><circle cx="33" cy="30" r="1.7" ${fill}/>${close}`;
    case 7:
      return `${open}<path ${fill} d="M5 24c3-4 7 3 11 0 4-3 7 3 11 0 4-3 8 2 11 0 3-2 5 0 5 3 0 3-5 4-10 4H11c-5 0-8-2-8-4 0-1 .5-2 2-3Z"/><circle cx="13" cy="12" r="2.4" ${fill}/><circle cx="34" cy="10" r="1.8" ${fill}/>${close}`;
    default:
      return bristolArt(4);
  }
}

function icon(name) {
  return `<svg class="icon"><use href="#i-${name}"></use></svg>`;
}

/* ---------- stats ---------- */

function stats() {
  const today = localKey();
  const byDate = new Map();
  for (const r of state.records) {
    if (!byDate.has(r.localDate)) byDate.set(r.localDate, []);
    byDate.get(r.localDate).push(r);
  }
  const last7 = Array.from({ length: 7 }, (_, i) => daysAgoKey(6 - i));
  const weekTotal = last7.reduce((acc, key) => acc + (byDate.get(key)?.length || 0), 0);
  const todayCount = byDate.get(today)?.length || 0;

  let cursor = byDate.has(today) ? 0 : 1;
  let streak = 0;
  while (byDate.has(daysAgoKey(cursor))) {
    streak += 1;
    cursor += 1;
  }

  const last30 = new Set(Array.from({ length: 30 }, (_, i) => daysAgoKey(i)));
  const recent = state.records.filter((r) => last30.has(r.localDate));
  const bristolCounts = {};
  for (const r of recent) bristolCounts[r.bristol] = (bristolCounts[r.bristol] || 0) + 1;
  const top = Object.entries(bristolCounts).sort((a, b) => b[1] - a[1])[0];

  return {
    today,
    byDate,
    last7,
    weekTotal,
    todayCount,
    streak,
    total: state.records.length,
    activeDays: byDate.size,
    avg: weekTotal / 7,
    topBristol: top ? Number(top[0]) : null,
  };
}

/* ---------- render: today ---------- */

function renderToday() {
  const s = stats();
  $('#greeting-text').textContent = `${greeting()}，${state.user?.nickname || '朋友'}`;
  $('#header-avatar').textContent = (state.user?.nickname || state.user?.email || '顺').trim().charAt(0).toUpperCase();
  $('#today-pill').textContent = `${fmtShortDate()} · ${WEEKDAYS[new Date().getDay()]}`;
  $('#hero-date').textContent = `${fmtShortDate()} · ${WEEKDAYS[new Date().getDay()]}`;
  $('#today-count').textContent = String(s.todayCount);
  $('#hero-label').textContent =
    s.todayCount === 0
      ? '今天还没有记录'
      : s.todayCount <= 3
        ? '今天的节奏，还不错'
        : '次数偏多，留意一下';
  $('#hero-stamp-text').textContent = s.todayCount === 0 ? '慢慢来' : s.todayCount <= 3 ? '挺好的' : '留意下';

  const counts = s.last7.map((key) => s.byDate.get(key)?.length || 0);
  const max = Math.max(3, ...counts);
  $('#hero-chart').innerHTML = s.last7
    .map((key, i) => {
      const d = keyToDate(key);
      const count = counts[i];
      const pct = count === 0 ? 8 : Math.max(14, (count / max) * 100);
      const isToday = key === s.today;
      return `<div class="hero-day ${isToday ? 'is-today' : ''}" title="${key} · ${count} 次">
        <div class="hero-bar-track"><div class="hero-bar ${count ? '' : 'is-empty'}" style="height:${pct}%"></div></div>
        <span class="hero-day-label">${isToday ? '今天' : WEEKDAYS[d.getDay()].slice(1)}</span>
      </div>`;
    })
    .join('');

  $('#quick-stats').innerHTML = `
    <div class="quick-stat"><strong>${s.weekTotal}</strong><span>近 7 天次数</span></div>
    <div class="quick-stat"><strong>${s.avg.toFixed(1)}</strong><span>日均次数</span></div>
    <div class="quick-stat"><strong>${s.streak}</strong><span>连续记录天</span></div>
  `;

  const todayRecords = (s.byDate.get(s.today) || []).slice().sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  $('#today-records').innerHTML = todayRecords.length
    ? todayRecords.map(recordCard).join('')
    : emptyState();

  $('#tip-text').textContent = TIPS[new Date().getDate() % TIPS.length];
}

function emptyState() {
  return `<div class="empty-state">
    <div class="empty-art">${icon('leaf')}</div>
    <strong>今天还是一张白纸</strong>
    <p>有感觉的时候记一笔，十秒钟就够。身体的规律会慢慢浮现。</p>
    <button class="btn btn-ghost" type="button" data-open-record>记录第一次</button>
  </div>`;
}

function recordCard(record, options = {}) {
  const color = COLORS[record.color] || COLORS.brown;
  const easeWarn = record.ease === 'strained' || record.ease === 'urgent';
  return `<article class="record-card" data-record-id="${record.id}">
    <div class="record-visual">${bristolArt(record.bristol)}</div>
    <div class="record-main">
      <div class="record-top">
        <span class="record-time">${fmtTime(record.occurredAt)}</span>
        <span class="record-type">${record.bristol} 型 · ${BRISTOL[record.bristol]?.name || ''}</span>
      </div>
      <div class="record-tags">
        <span class="tag"><i class="dot" style="background:${color.value}"></i>${color.full}</span>
        <span class="tag">${AMOUNTS[record.amount] || record.amount}</span>
        <span class="tag ${easeWarn ? 'warn' : ''}">${EASES[record.ease] || record.ease}</span>
        ${color.warn ? '<span class="tag warn">需留意</span>' : ''}
      </div>
      ${record.notes ? `<p class="record-note">${escapeHtml(record.notes)}</p>` : ''}
    </div>
    <div class="record-actions">
      <button class="mini-icon-btn" type="button" data-edit-record="${record.id}" aria-label="编辑记录">${icon('edit')}</button>
      <button class="mini-icon-btn danger" type="button" data-delete-record="${record.id}" aria-label="删除记录">${icon('trash')}</button>
    </div>
  </article>`;
}

/* ---------- render: history ---------- */

function renderHistory() {
  const s = stats();
  $('#stat-grid').innerHTML = `
    <div class="stat-card">
      <p class="stat-label">近 7 天次数</p>
      <div class="stat-value">${s.weekTotal}<small>次</small></div>
      <p class="stat-sub">近 7 天平均 ${s.avg.toFixed(1)} 次/天</p>
    </div>
    <div class="stat-card accent">
      <p class="stat-label">最常见形态</p>
      <div class="stat-value">${s.topBristol ? `${s.topBristol}<small>型</small>` : '—'}</div>
      <p class="stat-sub">${s.topBristol ? BRISTOL[s.topBristol].name : '记录后自动统计'}</p>
    </div>
    <div class="stat-card accent">
      <p class="stat-label">连续记录</p>
      <div class="stat-value">${s.streak}<small>天</small></div>
      <p class="stat-sub">${s.streak >= 3 ? '好习惯正在形成' : '从今天开始积累'}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">累计记录</p>
      <div class="stat-value">${s.total}<small>次</small></div>
      <p class="stat-sub">${s.activeDays} 个记录日</p>
    </div>
  `;

  const days = Array.from({ length: 14 }, (_, i) => {
    const key = daysAgoKey(13 - i);
    return { key, date: keyToDate(key), count: s.byDate.get(key)?.length || 0 };
  });
  const max = Math.max(2, ...days.map((d) => d.count));
  $('#bar-chart').innerHTML = days
    .map((d, i) => {
      const barHeight = d.count ? Math.max(4, Math.round((d.count / max) * 68)) : 3;
      const label = i % 2 === 0 || i === days.length - 1 ? `${d.date.getMonth() + 1}/${d.date.getDate()}` : '';
      return `<div class="bar-col ${d.count ? '' : 'is-empty'} ${d.key === s.today ? 'is-today' : ''}" title="${d.key} · ${d.count} 次">
        <span class="bar-value">${d.count || ''}</span>
        <div class="bar-fill" style="height:${barHeight}px"></div>
        <span class="bar-label">${label}</span>
      </div>`;
    })
    .join('');

  const filter = state.historyFilter;
  let filtered = state.records;
  if (filter !== 'all') {
    const cutoff = daysAgoKey(Number(filter) - 1);
    filtered = state.records.filter((r) => r.localDate >= cutoff);
  }
  $('#history-count').textContent = `共 ${filtered.length} 条`;

  if (!filtered.length) {
    $('#history-list').innerHTML = `<div class="empty-state">
      <div class="empty-art">${icon('calendar')}</div>
      <strong>这段时间还没有记录</strong>
      <p>每次记录都会成为趋势的一部分，先从今天开始吧。</p>
    </div>`;
    return;
  }

  const groups = new Map();
  for (const r of filtered) {
    if (!groups.has(r.localDate)) groups.set(r.localDate, []);
    groups.get(r.localDate).push(r);
  }
  const sorted = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  $('#history-list').innerHTML = sorted
    .map(([key, records]) => {
      const heading = fmtDateHeading(key);
      const sortedRecords = records.slice().sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
      return `<section class="history-group">
        <div class="history-date"><strong>${heading.label}</strong><span>${heading.detail}</span><span>${pluralRecords(records.length)}</span></div>
        ${sortedRecords.map((r) => recordCard(r)).join('')}
      </section>`;
    })
    .join('');
}

/* ---------- render: assistant ---------- */

function renderChat() {
  const stream = $('#chat-stream');
  const rows = [];
  if (!state.messages.length) {
    rows.push(`<div class="chat-row">
      <div class="chat-avatar">${icon('leaf')}</div>
      <div>
        <div class="chat-bubble">你好，我是顺顺。<br><br>我可以结合你的记录，帮你看看最近的排便情况，也可以聊聊饮食和如厕习惯。<br><br>记录得越连续，我看到的趋势越清楚。今天想聊点什么？</div>
      </div>
    </div>`);
  }
  for (const m of state.messages) {
    if (m.role === 'user') {
      rows.push(`<div class="chat-row user">
        <div>
          <div class="chat-bubble">${formatChat(m.content)}</div>
          <div class="chat-time">${m.createdAt ? fmtTime(m.createdAt) : ''}</div>
        </div>
      </div>`);
    } else {
      rows.push(`<div class="chat-row">
        <div class="chat-avatar">${icon('leaf')}</div>
        <div>
          <div class="chat-bubble">${formatChat(m.content)}${
            m.notice ? `<span class="chat-notice">${escapeHtml(m.notice)}</span>` : ''
          }</div>
          ${m.createdAt ? `<div class="chat-time">${fmtTime(m.createdAt)}</div>` : ''}
        </div>
      </div>`);
    }
  }
  if (state.chatBusy) {
    rows.push(`<div class="chat-row" id="typing-row">
      <div class="chat-avatar">${icon('leaf')}</div>
      <div class="chat-bubble"><span class="typing"><i></i><i></i><i></i></span></div>
    </div>`);
  }
  stream.innerHTML = rows.join('');
  if (state.messages.length || state.chatBusy) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    });
  }
}

function renderAssistantMeta() {
  const badge = $('#ai-badge');
  badge.classList.toggle('local', !state.aiEnabled);
  badge.innerHTML = `<i></i><span>${state.aiEnabled ? 'AI 已连接' : '本地规则分析'}</span>`;
}

/* ---------- render: me ---------- */

function renderMe() {
  const s = stats();
  const user = state.user;
  if (!user) return;
  const initial = (user.nickname || user.email || '顺').trim().charAt(0).toUpperCase();
  $('#profile-avatar').textContent = initial;
  $('#header-avatar').textContent = initial;
  $('#profile-name').textContent = user.nickname;
  $('#profile-email').textContent = user.email;
  const since = new Date(user.createdAt);
  $('#profile-since').textContent = `${since.getFullYear()} 年 ${since.getMonth() + 1} 月加入`;
  $('#profile-stats').innerHTML = `
    <div class="profile-stat"><strong>${s.total}</strong><span>累计记录</span></div>
    <div class="profile-stat"><strong>${s.activeDays}</strong><span>记录天数</span></div>
    <div class="profile-stat"><strong>${s.streak}</strong><span>连续天数</span></div>
  `;
  renderLanShare();
}

function renderLanShare() {
  const code = $('#lan-url');
  if (!code) return;
  const privateHost = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
  const isPublic = location.protocol === 'https:' && !privateHost;
  const url = isPublic ? location.origin : state.lanUrls[0] || '';
  $('#share-title').textContent = isPublic ? '公网分享' : '局域网共享';
  $('#share-hint').textContent = isPublic
    ? '任何拿到这个 HTTPS 链接的人都可以注册使用'
    : '同一 Wi-Fi 下的朋友可以打开这个地址';
  code.textContent = url || '未检测到局域网地址';
  $('#copy-lan-btn').disabled = !url;
}

/* ---------- view routing ---------- */

function setView(view, options = {}) {
  const allowed = ['today', 'history', 'assistant', 'me'];
  if (!allowed.includes(view)) view = 'today';
  state.view = view;
  if (state.user) {
    $('#header-avatar').textContent = (state.user.nickname || state.user.email || '顺').trim().charAt(0).toUpperCase();
  }
  $$('.view').forEach((el) => {
    el.hidden = el.dataset.view !== view;
  });
  $$('.nav-item').forEach((el) => el.classList.toggle('is-active', el.dataset.nav === view));
  if (view === 'today') renderToday();
  if (view === 'history') renderHistory();
  if (view === 'assistant') {
    renderAssistantMeta();
    renderChat();
  }
  if (view === 'me') renderMe();
  if (options.scroll !== false) window.scrollTo(0, 0);
}

function currentViewFromHash() {
  const match = location.hash.match(/^#\/(\w+)/);
  return match ? match[1] : 'today';
}

/* ---------- record sheet ---------- */

function buildPickers() {
  $('#bristol-grid').innerHTML = Object.entries(BRISTOL)
    .map(
      ([type, info]) => `<button class="bristol-option" type="button" data-bristol="${type}" aria-label="${type} 型 ${info.name}">
        ${bristolArt(type)}<b>${type}</b><small>${info.name}</small>
      </button>`,
    )
    .join('');
  $('#color-grid').innerHTML = Object.entries(COLORS)
    .map(
      ([key, c]) => `<button class="color-option" type="button" data-color="${key}" style="--swatch:${c.value}">
        <i></i><span>${c.label}</span>
      </button>`,
    )
    .join('');
}

function syncFormPickers() {
  $$('#bristol-grid [data-bristol]').forEach((el) =>
    el.classList.toggle('is-active', Number(el.dataset.bristol) === Number(state.form.bristol)),
  );
  $$('#color-grid [data-color]').forEach((el) => el.classList.toggle('is-active', el.dataset.color === state.form.color));
  $$('#amount-grid [data-amount]').forEach((el) => el.classList.toggle('is-active', el.dataset.amount === state.form.amount));
  $$('#ease-grid [data-ease]').forEach((el) => el.classList.toggle('is-active', el.dataset.ease === state.form.ease));
  $('#bristol-hint').textContent = BRISTOL[state.form.bristol]?.desc || '';
  const colorWarning = $('#color-warning');
  const warn = COLORS[state.form.color]?.warn;
  colorWarning.hidden = !warn;
  colorWarning.textContent = warn
    ? '这个颜色需要重视。先排除火龙果、甜菜、铁剂等饮食或药物影响；如果持续或伴随腹痛、乏力，请尽快就医。'
    : '';
}

function openRecord(record = null) {
  state.editingId = record ? record.id : null;
  state.form = record
    ? { bristol: record.bristol, color: record.color, amount: record.amount, ease: record.ease }
    : { bristol: 4, color: 'brown', amount: 'medium', ease: 'normal' };
  $('#record-title').textContent = record ? '修改这次记录' : '记录这一次';
  $('#record-time').value = toLocalInput(record ? new Date(record.occurredAt) : new Date());
  $('#record-notes').value = record?.notes || '';
  $('#delete-record-btn').hidden = !record;
  setError('record', '');
  syncFormPickers();
  const dialog = $('#record-dialog');
  if (!dialog.open) dialog.showModal();
  document.body.style.overflow = 'hidden';
}

function closeRecord() {
  const dialog = $('#record-dialog');
  if (dialog.open) dialog.close();
  document.body.style.overflow = '';
}

async function saveRecord(event) {
  event.preventDefault();
  const timeValue = $('#record-time').value;
  if (!timeValue) {
    setError('record', '请选择记录时间');
    return;
  }
  const dt = new Date(timeValue);
  if (Number.isNaN(dt.getTime())) {
    setError('record', '时间格式不正确');
    return;
  }
  const payload = {
    occurredAt: dt.toISOString(),
    localDate: localKey(dt),
    bristol: state.form.bristol,
    color: state.form.color,
    amount: state.form.amount,
    ease: state.form.ease,
    notes: $('#record-notes').value.trim(),
  };
  const submit = $('#record-form button[type="submit"]');
  submit.disabled = true;
  submit.textContent = '保存中…';
  try {
    if (state.editingId) {
      const { record } = await api(`/api/records/${state.editingId}`, { method: 'PATCH', body: payload });
      state.records = state.records.map((r) => (r.id === record.id ? record : r));
      showToast('记录已更新');
    } else {
      const { record } = await api('/api/records', { method: 'POST', body: payload });
      state.records.unshift(record);
      showToast('记录好了，身体又清晰了一点');
    }
    state.records.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
    closeRecord();
    setView(state.view, { scroll: false });
  } catch (err) {
    setError('record', err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = '保存记录';
  }
}

async function deleteRecord(id) {
  const record = state.records.find((r) => r.id === id);
  if (!record) return;
  const result = await confirmAction({
    title: '删除这条记录？',
    text: `${record.localDate} ${fmtTime(record.occurredAt)} 的记录会被删除，无法恢复。`,
    confirmText: '删除',
  });
  if (!result.ok) return;
  try {
    await api(`/api/records/${id}`, { method: 'DELETE' });
    state.records = state.records.filter((r) => r.id !== id);
    if (state.editingId === id) closeRecord();
    setView(state.view, { scroll: false });
    showToast('记录已删除');
  } catch (err) {
    showToast(err.message);
  }
}

/* ---------- confirm dialog ---------- */

let confirmResolver = null;

function settleConfirm(result) {
  const resolver = confirmResolver;
  confirmResolver = null;
  if (resolver) resolver(result);
}

function confirmAction({ title, text, confirmText = '确认', password = false }) {
  return new Promise((resolve) => {
    if (confirmResolver) settleConfirm({ ok: false });
    confirmResolver = resolve;
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = confirmText;
    $('#confirm-password-field').hidden = !password;
    $('#confirm-password').value = '';
    setError('confirm', '');
    const dialog = $('#confirm-dialog');
    if (!dialog.open) dialog.showModal();
  });
}

function bindConfirm() {
  $('#confirm-cancel').addEventListener('click', () => {
    $('#confirm-dialog').close();
    settleConfirm({ ok: false });
  });
  $('#confirm-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const passwordField = $('#confirm-password-field');
    const password = $('#confirm-password').value;
    if (!passwordField.hidden && !password) {
      setError('confirm', '请输入密码');
      return;
    }
    $('#confirm-dialog').close();
    settleConfirm({ ok: true, password });
  });
  $('#confirm-dialog').addEventListener('close', () => settleConfirm({ ok: false }));
}

/* ---------- chat ---------- */

async function sendChat(text) {
  const message = String(text || '').trim();
  if (!message || state.chatBusy) return;
  state.chatBusy = true;
  state.messages.push({ role: 'user', content: message, createdAt: new Date().toISOString() });
  renderChat();
  $('#chat-input').value = '';
  autoGrow($('#chat-input'));
  try {
    const data = await api('/api/chat', { method: 'POST', body: { message } });
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    if (lastUser && data.userMessage) lastUser.createdAt = data.userMessage.createdAt;
    if (data.message) {
      state.messages.push({ ...data.message, notice: data.notice || '' });
    }
  } catch (err) {
    state.messages.push({
      role: 'assistant',
      content: `这次没有连上：${err.message}\n\n你可以稍后再试，或者先把这次情况记录到日记里。`,
      createdAt: new Date().toISOString(),
    });
  } finally {
    state.chatBusy = false;
    renderChat();
  }
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
}

/* ---------- auth / boot ---------- */

function showAuth() {
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  applyDemoVisibility();
  $('#splash').classList.add('is-hidden');
}

function applyDemoVisibility() {
  const enabled = state.demoEnabled !== false;
  $('#demo-login').hidden = !enabled;
  $('#auth-divider').hidden = !enabled;
}

function resetToAuth() {
  state.user = null;
  state.records = [];
  state.messages = [];
  for (const id of ['record-dialog', 'confirm-dialog']) {
    const dialog = document.getElementById(id);
    if (dialog?.open) dialog.close();
  }
  document.body.style.overflow = '';
  showAuth();
}

function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  setView(currentViewFromHash(), { scroll: false });
  $('#splash').classList.add('is-hidden');
}

async function loadAll() {
  const [me, recordsRes, chatRes] = await Promise.all([
    api('/api/auth/me'),
    api('/api/records'),
    api('/api/chat'),
  ]);
  state.user = me.user;
  state.aiEnabled = Boolean(me.aiEnabled);
  state.lanUrls = me.lanUrls?.length ? me.lanUrls : state.lanUrls;
  state.records = recordsRes.records || [];
  state.messages = chatRes.messages || [];
}

function switchAuthTab(mode) {
  state.authMode = mode;
  $$('.auth-tab').forEach((el) => el.classList.toggle('is-active', el.dataset.authTab === mode));
  $('#login-form').hidden = mode !== 'login';
  $('#register-form').hidden = mode !== 'register';
}

async function submitAuth(event, mode) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  setError(mode, '');
  if (mode === 'register' && !data.consent) {
    setError(mode, '请先勾选健康数据说明');
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = mode === 'login' ? '登录中…' : '创建中…';
  try {
    await api(`/api/auth/${mode}`, { method: 'POST', body: data });
    await loadAll();
    showApp();
    showToast(mode === 'login' ? '欢迎回来' : '账号创建好了，开始记录吧');
  } catch (err) {
    setError(mode, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function demoLogin() {
  const btn = $('#demo-login');
  btn.disabled = true;
  try {
    await api('/api/auth/login', { method: 'POST', body: { email: 'demo@shunshun.app', password: 'shunshun123' } });
    await loadAll();
    showApp();
    showToast('已进入体验账号');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  resetToAuth();
  showToast('已退出登录');
}

async function deleteAccount() {
  for (;;) {
    const result = await confirmAction({
      title: '删除账号与全部数据？',
      text: '这会永久删除账号、所有排便记录和助手对话，无法恢复。请输入密码确认。',
      confirmText: '永久删除',
      password: true,
    });
    if (!result.ok) return;
    try {
      await api('/api/account', { method: 'DELETE', body: { password: result.password } });
      resetToAuth();
      showToast('账号和数据已删除');
      return;
    } catch (err) {
      showToast(err.message);
    }
  }
}

/* ---------- events ---------- */

function bindEvents() {
  $$('.auth-tab').forEach((tab) => tab.addEventListener('click', () => switchAuthTab(tab.dataset.authTab)));
  $('#login-form').addEventListener('submit', (e) => submitAuth(e, 'login'));
  $('#register-form').addEventListener('submit', (e) => submitAuth(e, 'register'));
  $('#demo-login').addEventListener('click', demoLogin);

  $$('[data-close-record]').forEach((btn) => btn.addEventListener('click', closeRecord));
  $('#record-form').addEventListener('submit', saveRecord);
  $('#delete-record-btn').addEventListener('click', () => {
    if (state.editingId) deleteRecord(state.editingId);
  });
  $('#record-dialog').addEventListener('click', (e) => {
    if (e.target === $('#record-dialog')) closeRecord();
  });
  $('#record-dialog').addEventListener('close', () => {
    document.body.style.overflow = '';
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-record]')) {
      openRecord();
      return;
    }
    const bristol = e.target.closest('[data-bristol]');
    if (bristol) {
      state.form.bristol = Number(bristol.dataset.bristol);
      syncFormPickers();
      return;
    }
    const color = e.target.closest('[data-color]');
    if (color) {
      state.form.color = color.dataset.color;
      syncFormPickers();
      return;
    }
    const amount = e.target.closest('[data-amount]');
    if (amount) {
      state.form.amount = amount.dataset.amount;
      syncFormPickers();
      return;
    }
    const ease = e.target.closest('[data-ease]');
    if (ease) {
      state.form.ease = ease.dataset.ease;
      syncFormPickers();
      return;
    }
    const edit = e.target.closest('[data-edit-record]');
    if (edit) {
      const record = state.records.find((r) => r.id === Number(edit.dataset.editRecord));
      if (record) openRecord(record);
      return;
    }
    const del = e.target.closest('[data-delete-record]');
    if (del) {
      deleteRecord(Number(del.dataset.deleteRecord));
      return;
    }
    const filter = e.target.closest('[data-filter]');
    if (filter) {
      state.historyFilter = filter.dataset.filter;
      $$('#history-filter .seg').forEach((el) => el.classList.toggle('is-active', el === filter));
      renderHistory();
      return;
    }
    const prompt = e.target.closest('[data-prompt]');
    if (prompt) {
      sendChat(prompt.dataset.prompt);
      return;
    }
    const viewLink = e.target.closest('[data-view-link]');
    if (viewLink) {
      location.hash = `#/${viewLink.dataset.viewLink}`;
      return;
    }
  });

  $('#header-avatar').addEventListener('click', () => {
    location.hash = '#/me';
  });

  window.addEventListener('hashchange', () => {
    if (!state.user) return;
    setView(currentViewFromHash());
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat($('#chat-input').value);
  });
  $('#chat-input').addEventListener('input', (e) => autoGrow(e.target));
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat($('#chat-input').value);
    }
  });

  $('#export-btn').addEventListener('click', () => {
    window.location.href = '/api/export.csv';
    showToast('正在导出 CSV');
  });
  $('#copy-lan-btn').addEventListener('click', async () => {
    const text = $('#lan-url').textContent;
    if (!text || text === '未检测到局域网地址') return;
    try {
      await navigator.clipboard.writeText(text);
      showToast('局域网地址已复制');
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      showToast('局域网地址已复制');
    }
  });
  $('#today-ai').addEventListener('click', () => {
    location.hash = '#/assistant';
    if (state.view !== 'assistant') setView('assistant');
    setTimeout(() => sendChat('帮我分析一下今天的记录，看看是否健康，需要怎么调理'), 60);
  });
  $('#clear-chat-btn').addEventListener('click', async () => {
    const result = await confirmAction({
      title: '清空助手对话？',
      text: '对话记录会被删除，你的排便记录不会受影响。',
      confirmText: '清空',
    });
    if (!result.ok) return;
    try {
      await api('/api/chat', { method: 'DELETE' });
      state.messages = [];
      renderChat();
      showToast('对话已清空');
    } catch (err) {
      showToast(err.message);
    }
  });
  $('#logout-btn').addEventListener('click', logout);
  $('#delete-account-btn').addEventListener('click', deleteAccount);

  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (location.hash === `#/${item.dataset.nav}`) {
        setView(item.dataset.nav);
      }
    });
  });
}

/* ---------- boot ---------- */

async function boot() {
  buildPickers();
  bindEvents();
  bindConfirm();
  switchAuthTab('login');
  const minSplash = new Promise((resolve) => setTimeout(resolve, 450));
  try {
    const config = await api('/api/config');
    state.lanUrls = config.lanUrls || [];
    state.demoEnabled = config.demoEnabled !== false;
    if (config.user) {
      await loadAll();
      await minSplash;
      showApp();
    } else {
      await minSplash;
      showAuth();
    }
  } catch (err) {
    await minSplash;
    showAuth();
    showToast('暂时连不上服务器，请稍后刷新');
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
