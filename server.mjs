import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_DAYS = 30;
const MAX_BODY = 64 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = await createDatabase({ dataDir: DATA_DIR, databaseUrl: process.env.DATABASE_URL });
await db.init();

const COLORS = new Set(['brown', 'dark_brown', 'yellow', 'green', 'black', 'red', 'pale']);
const AMOUNTS = new Set(['small', 'medium', 'large']);
const EASES = new Set(['easy', 'normal', 'strained', 'urgent']);
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

const AI_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
const AI_BASE = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const CLI_FLAGS = new Set(process.argv.slice(2));
const PUBLIC_MODE = CLI_FLAGS.has('--public') || process.env.PUBLIC_MODE === '1';
const TRUST_PROXY = CLI_FLAGS.has('--trust-proxy') || process.env.TRUST_PROXY === '1';
const DEMO_ENABLED = process.env.DEMO_ENABLED ? process.env.DEMO_ENABLED === '1' : !PUBLIC_MODE;

/* ---------- helpers ---------- */

function nowIso() {
  return new Date().toISOString();
}

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function lanUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => {
      if (!net || net.family !== 'IPv4' || net.internal) return false;
      const [a, b] = net.address.split('.').map(Number);
      return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
    })
    .sort((x, y) => {
      const score = (address) => (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2);
      return score(x.address) - score(y.address);
    })
    .map((net) => `http://${net.address}:${PORT}`);
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求格式不正确'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = stored.split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function setSessionCookie(req, res, token) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || req.socket.encrypted;
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const cookie = `ss_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
    secure ? '; Secure' : ''
  }`;
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'ss_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.createSession({
    userId,
    tokenHash: hashToken(token),
    expiresAt: expires,
    createdAt: nowIso(),
  });
  setSessionCookie(req, res, token);
}

async function getAuth(req) {
  const token = parseCookies(req).ss_session;
  if (!token) return null;
  const row = await db.findAuthSession(hashToken(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.deleteSession(hashToken(token));
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    created_at: row.created_at,
    is_admin: Boolean(row.is_admin),
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    createdAt: user.created_at,
    isAdmin: Boolean(user.is_admin),
  };
}

function requireAdmin(user, res) {
  if (!user?.is_admin) {
    sendError(res, 403, '需要管理员权限');
    return false;
  }
  return true;
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const authAttempts = new Map();
const registrationAttempts = new Map();

function clientIp(req) {
  if (TRUST_PROXY) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return String(cfIp).trim();
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function tooManyAttempts(ip) {
  const now = Date.now();
  const bucket = authAttempts.get(ip);
  if (!bucket || bucket.reset < now) {
    authAttempts.set(ip, { count: 1, reset: now + 10 * 60 * 1000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 30;
}

function tooManyRegistrations(ip) {
  const now = Date.now();
  const bucket = registrationAttempts.get(ip);
  if (!bucket || bucket.reset < now) {
    registrationAttempts.set(ip, { count: 1, reset: now + 60 * 60 * 1000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 8;
}

const chatBuckets = new Map();
function chatRateLimited(userId) {
  const now = Date.now();
  const bucket = chatBuckets.get(userId);
  if (!bucket || bucket.reset < now) {
    chatBuckets.set(userId, { count: 1, reset: now + 60 * 1000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 12;
}

/* ---------- record logic ---------- */

function normalizeRecord(body, existing = null) {
  const bristol = Number(body.bristol);
  if (!Number.isInteger(bristol) || bristol < 1 || bristol > 7) throw new Error('请选择便便形态（1-7 型）');
  const color = String(body.color || '');
  if (!COLORS.has(color)) throw new Error('请选择颜色');
  const amount = String(body.amount || '');
  if (!AMOUNTS.has(amount)) throw new Error('请选择量');
  const ease = String(body.ease || '');
  if (!EASES.has(ease)) throw new Error('请选择排便感受');
  const notes = String(body.notes || '').trim().slice(0, 500);
  const occurredAt = new Date(body.occurredAt || Date.now());
  if (Number.isNaN(occurredAt.getTime())) throw new Error('时间格式不正确');
  if (occurredAt.getTime() > Date.now() + 10 * 60 * 1000) throw new Error('不能记录未来的时间');
  const localDate = String(body.localDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error('日期格式不正确');
  return {
    bristol,
    color,
    amount,
    ease,
    notes,
    occurredAt: occurredAt.toISOString(),
    localDate,
  };
}

function recordRow(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    bristol: row.bristol,
    color: row.color,
    amount: row.amount,
    ease: row.ease,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRecords(userId, limit = 400) {
  return (await db.listRecords(userId, limit)).map(recordRow);
}

/* ---------- local AI fallback ---------- */

const BRISTOL_LABEL = {
  1: '1 型 · 一颗颗硬球',
  2: '2 型 · 香肠状、表面凹凸',
  3: '3 型 · 香肠状、表面有裂纹',
  4: '4 型 · 光滑柔软的长条',
  5: '5 型 · 柔软的小块',
  6: '6 型 · 糊状、边缘不整',
  7: '7 型 · 水样',
};

const COLOR_LABEL = {
  brown: '棕褐色',
  dark_brown: '深褐色',
  yellow: '偏黄',
  green: '偏绿',
  black: '黑色',
  red: '带血/红色',
  pale: '灰白/陶土色',
};

const EASE_LABEL = { easy: '顺畅', normal: '正常', strained: '费力', urgent: '急迫' };
const AMOUNT_LABEL = { small: '偏少', medium: '适中', large: '偏多' };

function daysBetweenKeys(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 864e5);
}

function buildHealthSummary(records, today = todayKey()) {
  const recent = records.filter((r) => {
    const diff = daysBetweenKeys(r.localDate, today);
    return diff >= 0 && diff < 7;
  });
  const todayRecords = records.filter((r) => r.localDate === today);
  const days = 7;
  const bristolCounts = {};
  const colorCounts = {};
  const easeCounts = {};
  for (const r of recent) {
    bristolCounts[r.bristol] = (bristolCounts[r.bristol] || 0) + 1;
    colorCounts[r.color] = (colorCounts[r.color] || 0) + 1;
    easeCounts[r.ease] = (easeCounts[r.ease] || 0) + 1;
  }
  const topBristol = Object.entries(bristolCounts).sort((a, b) => b[1] - a[1])[0];
  const notes = recent.filter((r) => r.notes).slice(0, 8).map((r) => r.notes);
  return {
    recent,
    todayRecords,
    weekTotal: recent.length,
    perDay: recent.length / days,
    bristolCounts,
    colorCounts,
    easeCounts,
    topBristol,
    notes,
  };
}

function localAnalysis(records, today = todayKey()) {
  const s = buildHealthSummary(records, today);
  if (!s.recent.length) {
    return [
      '我还看不到你最近 7 天的记录，所以暂时没法做有针对性的分析。',
      '',
      '先记下今天的一次吧。记录时尽量选准形态、颜色和排便感受，连续记 3 天以上，我就能帮你看趋势了。',
      '',
      '在那之前，可以先守住三个基础习惯：每天喝够 1.5–2 升水、每餐有蔬菜或全谷物、饭后走 10–15 分钟。',
      '',
      '小提示：如果出现便血、黑便、持续剧烈腹痛，不用等记录，直接去医院。',
    ].join('\n');
  }

  const lines = [];
  const perDayText = s.perDay < 1 ? `平均每 ${Math.round(1 / s.perDay)} 天 1 次` : `平均每天 ${s.perDay.toFixed(1)} 次`;
  const trackedDays = new Set(s.recent.map((r) => r.localDate)).size;
  const enoughData = trackedDays >= 4;
  if (enoughData) {
    lines.push(`看了你最近 7 天的 ${s.weekTotal} 次记录，今天 ${s.todayRecords.length} 次，${perDayText}。`);
  } else {
    lines.push(
      `你最近 7 天有 ${s.weekTotal} 次记录，分布在 ${trackedDays} 天里，今天 ${s.todayRecords.length} 次。才开始记录，样本还少，先看初步状态。`,
    );
  }

  const shapeNotes = [];
  const ideal = (s.bristolCounts[3] || 0) + (s.bristolCounts[4] || 0);
  const hard = (s.bristolCounts[1] || 0) + (s.bristolCounts[2] || 0);
  const loose = (s.bristolCounts[6] || 0) + (s.bristolCounts[7] || 0);
  if (s.topBristol) shapeNotes.push(`最常见的是 ${BRISTOL_LABEL[s.topBristol[0]]}`);
  if (ideal > 0 && ideal >= s.weekTotal * 0.5) {
    shapeNotes.push('大多落在 3–4 型的理想区间');
  } else if (hard >= 2 && hard >= loose) {
    shapeNotes.push('偏硬的比例不低，有便秘倾向');
  } else if (loose >= 2 && loose >= hard) {
    shapeNotes.push('偏稀的比例不低，有腹泻倾向');
  } else if (hard === 1) {
    shapeNotes.push('有一次偏硬，先观察是否和饮水、蔬菜量有关');
  } else if (loose === 1) {
    shapeNotes.push('有一次偏稀，注意当天是否吃了生冷或刺激性食物');
  }
  lines.push(`· ${shapeNotes.join('，')}。`);

  const redFlags = [];
  const warnings = [];
  const minor = [];
  if (s.colorCounts.black) redFlags.push('出现了黑便');
  if (s.colorCounts.red) redFlags.push('记录到带血或红色');
  if (s.colorCounts.pale) redFlags.push('出现了灰白/陶土色');
  const oddColor = (s.colorCounts.yellow || 0) + (s.colorCounts.green || 0);
  if (oddColor >= 3) warnings.push('颜色偏黄或偏绿出现得比较多');
  else if (oddColor) minor.push('有几次颜色偏黄或偏绿');
  if ((s.easeCounts.strained || 0) >= 2) warnings.push('有多次排便费力');
  else if (s.easeCounts.strained) minor.push('有 1 次排便费力');
  if ((s.easeCounts.urgent || 0) >= 2) warnings.push('有多次急迫感');
  else if (s.easeCounts.urgent) minor.push('有 1 次急迫感');
  if (enoughData && s.weekTotal > 21) warnings.push('一周超过 21 次，频率偏高');
  if (enoughData && s.weekTotal < 3 && trackedDays >= 4) warnings.push('一周少于 3 次，频率偏低');

  const noteText = s.notes.join(' ');
  if (/血|黑便|柏油/.test(noteText)) redFlags.push('备注里提到了出血相关情况');
  if (/剧痛|疼得|发烧|发热|呕吐|体重下降|消瘦/.test(noteText)) redFlags.push('备注里出现了需要尽快评估的症状');

  if (redFlags.length) {
    lines.push(`判断：需要尽快就医。${redFlags.join('；')}。这类情况不适合只靠饮食调理。`);
  } else if (warnings.length) {
    lines.push(`判断：整体需要留意。${warnings.join('；')}。先从饮食和作息调整，观察 1–2 周。`);
  } else if (!enoughData) {
    lines.push('判断：目前看到的形态和颜色没有明显危险信号，但记录天数还少，先别急着下结论。');
  } else if (minor.length) {
    lines.push(`判断：整体没有明显异常，${minor.join('；')}。先观察是否和某几天的饮食、饮水或作息有关。`);
  } else {
    lines.push('判断：从记录看整体比较健康，形态、颜色和感受都没有明显异常。继续保持现在的节奏就好。');
  }

  lines.push('');
  if (hard > loose) {
    lines.push('调理重点：');
    lines.push('· 每天额外补 1–2 份高纤维食物，比如燕麦、火龙果、猕猴桃、奇亚籽或绿叶菜。');
    lines.push('· 水量分次喝够，别等口渴；早起先喝一杯温水。');
    lines.push('· 固定一个宽松的如厕时间，有便意别憋，蹲坐时脚下垫个小凳更省力。');
  } else if (loose > hard) {
    lines.push('调理重点：');
    lines.push('· 这几天先避开冰饮、酒精、辛辣和太油的食物，少喝含糖饮料。');
    lines.push('· 主食选白粥、面条、米饭等温和易消化的，搭配少量熟蔬菜和瘦肉。');
    lines.push('· 注意补水和电解质；如果腹泻超过 2 天或伴发热，尽快就医。');
  } else {
    lines.push('调理重点：');
    lines.push('· 保持每天 25–30 克膳食纤维：蔬菜、全谷物、豆类换着吃。');
    lines.push('· 每天 1.5–2 升水，配合 30 分钟快走或轻度运动。');
    lines.push('· 尽量固定作息和如厕时间，减少久坐。');
  }

  if (!redFlags.length) {
    lines.push('· 继续记录 1–2 周，形态或频率持续变化时再回来看趋势。');
  }
  lines.push('');
  if (redFlags.length) {
    lines.push('请尽快去消化内科或急诊评估，别自行用药拖延。');
  } else {
    lines.push('如果便血、黑便、剧烈腹痛、发热、持续两周以上的便秘或腹泻出现，请直接就医。');
  }
  return lines.join('\n');
}

function localChatReply(message, records, today = todayKey()) {
  const text = String(message || '');
  if (/剧痛|疼得厉害|高烧|发烧|发热|呕吐|头晕|明显乏力/.test(text)) {
    return [
      '你描述里出现了需要认真对待的症状。',
      '',
      '如果同时有便血、黑便、持续腹痛、发热、呕吐或明显乏力，建议尽快去消化内科或急诊评估，不要只靠饮食调理。',
      '',
      '在就医前可以少量多次补水，避免自行吃止泻药或止痛药掩盖症状。如果症状轻微且很快缓解，也建议记录下来观察变化。',
    ].join('\n');
  }
  if (/腹痛|肚子疼|肚子痛|绞痛/.test(text)) {
    return [
      '腹痛的原因很多，单凭一句话没法判断，需要看位置、持续时间和有没有伴随症状。',
      '',
      '· 如果疼痛轻微、很快缓解，可以先记录位置和当天饮食，注意补水，暂时吃清淡一点。',
      '· 如果疼痛剧烈、持续加重，或伴随发热、呕吐、便血、黑便、明显乏力，请尽快去急诊或消化内科。',
      '· 不要自行吃止痛药掩盖症状；持续不缓解时让医生评估更稳妥。',
    ].join('\n');
  }
  const describesStool =
    /水样|稀|糊|不成形|拉肚子|腹泻|便秘|拉不出|费力|硬|颗粒|羊粪|球状|黑色|发黑|带血|鲜血|灰白|陶土|偏绿|绿色|偏黄|黏液/.test(
      text,
    );
  if (/今天|今日/.test(text) && !describesStool && /分析|看看|怎么样|健康|正常|要紧|调理|怎么办/.test(text)) {
    return localTodayAnalysis(records, today);
  }
  if (/分析|怎么样|健康|看看|报告|最近/.test(text) && !describesStool) {
    return localAnalysis(records, today);
  }
  if (/便秘|拉不出|费力|硬|颗粒|羊粪|球状/.test(text)) {
    return [
      '便秘先别急着用泻药，可以从这几件事开始：',
      '',
      '· 纤维要慢慢加：燕麦、猕猴桃、火龙果、奇亚籽、绿叶菜，突然猛加反而容易胀气。',
      '· 水跟着纤维一起加，每天 1.5–2 升，分次喝。',
      '· 每天固定一个不赶时间的如厕时段，饭后 20–30 分钟利用胃结肠反射最合适。',
      '· 有便意别憋；脚下垫个小凳，让膝盖略高于髋部。',
      '· 每天快走 30 分钟，久坐每小时起来活动一下。',
      '',
      '如果已经连续 2 周以上排便困难，或伴腹痛、便血、体重下降，建议去消化内科看看。',
    ].join('\n');
  }
  if (/腹泻|拉稀|水样|急迫|不成形|拉肚子|糊状/.test(text)) {
    return [
      '腹泻时首要任务是防脱水：',
      '',
      '· 小口多次补水，可以喝口服补液盐；避免冰饮、酒精、浓茶和含糖饮料。',
      '· 暂时选白粥、面条、米饭、熟蔬菜和瘦肉，避开生冷、辛辣和油腻。',
      '· 注意手卫生，观察有没有发热、明显腹痛或血便。',
      '',
      '如果 48 小时内没有缓解，或出现高热、血便、明显乏力，请尽快就医，别自行吃止泻药掩盖症状。',
    ].join('\n');
  }
  if (/吃|饮食|纤维|水果|食物/.test(text)) {
    return [
      '想让排便更规律，饮食可以这样搭：',
      '',
      '· 主食里换一部分燕麦、糙米、玉米或全麦面包。',
      '· 每天 2–3 份水果，猕猴桃、火龙果、梨、西梅对很多人比较友好。',
      '· 每餐至少一半是蔬菜，豆类和菌菇也可以轮换。',
      '· 水要跟上，纤维加得越多越要喝够水。',
      '· 酸奶、泡菜等发酵食物可以适量吃，但别指望单一食物解决问题。',
      '',
      '记录时顺便写一句当天吃了什么，更容易找到自己的规律。',
    ].join('\n');
  }
  if (/颜色|黑|血|绿|黄|白|陶土|黏液/.test(text)) {
    return [
      '颜色可以这样粗略判断：',
      '',
      '· 棕褐色、深褐色：通常正常，深浅和饮食有关。',
      '· 偏黄、偏绿：可能和吃进去的食物或通过时间偏快有关，偶尔出现可以先观察。',
      '· 黑色、柏油样：如果不是铁剂或铋剂导致，要尽快就医。',
      '· 鲜红或带血：先排除痔疮，但也建议让医生评估。',
      '· 灰白、陶土色：需要尽快就医，可能和胆道问题有关。',
      '',
      '单次颜色异常不用过度紧张，但持续出现或伴随腹痛、发热、乏力时，请及时就医。',
    ].join('\n');
  }
  return [
    '我可以帮你看排便记录里的形态、颜色、频率和感受，也可以聊饮食与如厕习惯。',
    '',
    '你可以试试问我：',
    '· 分析一下我最近一周的记录',
    '· 最近有点便秘，怎么调理',
    '· 便便颜色偏绿要紧吗',
    '',
    '记录得越连续，我能看到的趋势越清楚。',
  ].join('\n');
}

function localTodayAnalysis(records, today = todayKey()) {
  const todayRecords = records
    .filter((r) => r.localDate === today)
    .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  if (!todayRecords.length) {
    return [
      '今天还没有记录，所以我暂时看不到今天的形态和颜色。',
      '',
      '你可以点底部的「+」记一笔，或者在聊天里直接描述，比如「今天拉的是水样，肚子有点痛」。',
      '',
      '如果现在有便血、黑便、剧烈腹痛或发热，不用等记录，尽快就医。',
    ].join('\n');
  }
  const lines = [];
  const times = todayRecords.map((r) => new Date(r.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })).join('、');
  lines.push(`今天记录了 ${todayRecords.length} 次（${times}）。`);
  const shapes = [...new Set(todayRecords.map((r) => `${r.bristol} 型`))].join('、');
  const colors = [...new Set(todayRecords.map((r) => COLOR_LABEL[r.color] || r.color))].join('、');
  const eases = [...new Set(todayRecords.map((r) => EASE_LABEL[r.ease] || r.ease))].join('、');
  lines.push(`· 形态：${shapes}；颜色：${colors}；感受：${eases}。`);

  const has = (fn) => todayRecords.some(fn);
  if (has((r) => r.color === 'black' || r.color === 'red' || r.color === 'pale')) {
    lines.push('判断：今天出现了需要重视的颜色。如果不是铁剂、铋剂或某些食物导致，建议尽快去消化内科评估。');
  } else if (has((r) => r.bristol >= 6)) {
    lines.push('判断：今天的便便偏稀。先补水和电解质，暂时避开生冷、油腻和辛辣，观察 24–48 小时。');
  } else if (has((r) => r.bristol <= 2)) {
    lines.push('判断：今天的便便偏干硬，有便秘倾向。先增加水和可溶性纤维，别硬撑。');
  } else if (has((r) => r.ease === 'strained' || r.ease === 'urgent')) {
    lines.push('判断：形态本身在常见范围内，但排便感受不太舒服。可能和当天的饮水、饮食或节奏有关，先观察。');
  } else {
    lines.push('判断：从今天的记录看，形态、颜色和感受都在常见范围内，没有明显危险信号。');
  }

  if (has((r) => /血|黑便|柏油|剧痛|发烧|发热|呕吐/.test(r.notes || ''))) {
    lines.push('备注里出现了需要尽快评估的描述，建议直接去医院，不要只靠饮食调理。');
  }

  lines.push('');
  lines.push('今天可以这样做：');
  if (has((r) => r.bristol <= 2)) {
    lines.push('· 温水少量多次，晚餐加一份绿叶菜或猕猴桃。');
    lines.push('· 饭后走 10–15 分钟，有便意别憋。');
  } else if (has((r) => r.bristol >= 6)) {
    lines.push('· 小口补口服补液盐，吃白粥、面条等温和食物。');
    lines.push('· 如果 24–48 小时没有缓解，或出现发热、血便，尽快就医。');
  } else {
    lines.push('· 今晚吃清淡一点，保证蔬菜和水分，别吃得太撑。');
    lines.push('· 睡前留一点放松时间，规律作息对肠道很重要。');
  }
  lines.push('· 明天同一时间再记一次，连续趋势比单次更有参考价值。');
  return lines.join('\n');
}

/* ---------- remote AI ---------- */

function recordBrief(records) {
  return records.slice(0, 40).map((r) => ({
    date: r.localDate,
    time: new Date(r.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    bristol: r.bristol,
    color: COLOR_LABEL[r.color] || r.color,
    amount: AMOUNT_LABEL[r.amount] || r.amount,
    ease: EASE_LABEL[r.ease] || r.ease,
    notes: r.notes || undefined,
  }));
}

async function askRemoteAI(user, message, records, history) {
  const summary = buildHealthSummary(records);
  const trackedDays = new Set(summary.recent.map((r) => r.localDate)).size;
  const system = [
    '你是「顺顺日记」里的肠道健康科普助手，用温和、具体、简洁的中文回答。',
    '你不能做医学诊断，也不能替代医生；不要开药，不要给出具体药物剂量。',
    '请结合用户提供的排便记录给出生活方式、饮食和如厕习惯建议。',
    '如果出现便血、黑便、灰白便、剧烈腹痛、发热、呕吐、体重下降，或便秘/腹泻持续两周以上，要明确建议尽快就医。',
    '不要编造记录里没有的信息。回答控制在 350 字以内，用短段落和「·」列表。',
    '界面已有免责声明，结尾不必重复。',
    '',
    `最近 7 天概况：记录 ${summary.weekTotal} 次，覆盖 ${trackedDays} 天，今天 ${summary.todayRecords.length} 次。`,
    trackedDays < 4
      ? '用户刚开始记录，样本很少。不要仅凭频率低或次数少下结论，先说明样本不足，再给一般性建议。'
      : '记录天数已足够观察大致频率，但仍不能据此做医学诊断。',
    `记录明细：${JSON.stringify(recordBrief(summary.recent))}`,
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const res = await fetch(`${AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.5,
      max_tokens: 700,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`AI 服务返回 ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') throw new Error('AI 服务没有返回内容');
  return content.trim();
}

/* ---------- demo data ---------- */

async function seedDemo() {
  const email = 'demo@shunshun.app';
  const existing = await db.findUserByEmail(email);
  if (existing) return;
  const createdAt = nowIso();
  const user = await db.createUser({
    email,
    username: 'demo',
    nickname: '小顺',
    passwordHash: hashPassword('shunshun123'),
    createdAt,
    consentAt: null,
  });
  const userId = user.id;
  const pattern = [
    { offset: 0, hour: 8, minute: 12, bristol: 4, color: 'brown', amount: 'medium', ease: 'easy', notes: '起床后喝了温水，很顺' },
    { offset: 1, hour: 9, minute: 5, bristol: 4, color: 'brown', amount: 'medium', ease: 'normal', notes: '' },
    { offset: 2, hour: 20, minute: 40, bristol: 3, color: 'brown', amount: 'medium', ease: 'normal', notes: '晚饭后散步 20 分钟' },
    { offset: 3, hour: 8, minute: 30, bristol: 4, color: 'brown', amount: 'large', ease: 'easy', notes: '昨天吃了火龙果' },
    { offset: 4, hour: 18, minute: 15, bristol: 5, color: 'brown', amount: 'small', ease: 'urgent', notes: '下午喝了冰咖啡' },
    { offset: 5, hour: 9, minute: 40, bristol: 3, color: 'brown', amount: 'medium', ease: 'normal', notes: '' },
    { offset: 6, hour: 8, minute: 55, bristol: 2, color: 'dark_brown', amount: 'small', ease: 'strained', notes: '前一天蔬菜吃得少，水也喝少了' },
    { offset: 8, hour: 9, minute: 20, bristol: 4, color: 'brown', amount: 'medium', ease: 'easy', notes: '' },
    { offset: 9, hour: 21, minute: 10, bristol: 4, color: 'brown', amount: 'medium', ease: 'normal', notes: '' },
    { offset: 10, hour: 7, minute: 50, bristol: 3, color: 'brown', amount: 'large', ease: 'easy', notes: '周末作息规律' },
    { offset: 11, hour: 19, minute: 25, bristol: 5, color: 'yellow', amount: 'small', ease: 'normal', notes: '吃了较多玉米和南瓜' },
    { offset: 12, hour: 8, minute: 45, bristol: 4, color: 'brown', amount: 'medium', ease: 'normal', notes: '' },
  ];
  for (const p of pattern) {
    const d = new Date();
    d.setDate(d.getDate() - p.offset);
    d.setHours(p.hour, p.minute, 0, 0);
    const ts = nowIso();
    await db.createRecord({
      userId,
      occurredAt: d.toISOString(),
      localDate: todayKey(d),
      bristol: p.bristol,
      color: p.color,
      amount: p.amount,
      ease: p.ease,
      notes: p.notes,
      createdAt: ts,
      updatedAt: ts,
    });
  }
}

if (DEMO_ENABLED) await seedDemo();

/* ---------- static files ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, 403, '禁止访问');
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    if (!path.extname(rel)) {
      return serveStatic(req, res, '/index.html');
    }
    return sendError(res, 404, '页面不存在');
  }
  if (!stat.isFile()) return sendError(res, 404, '页面不存在');
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  };
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

/* ---------- routing ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendError(res, 400, '请求地址不正确');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );

  if (pathname.startsWith('/api/')) {
    const method = req.method || 'GET';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !checkOrigin(req)) {
      return sendError(res, 403, '来源校验失败');
    }
    try {
      if (pathname === '/api/health' && method === 'GET') {
        await db.ping();
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/config' && method === 'GET') {
        const user = await getAuth(req);
        return sendJson(res, 200, {
          aiEnabled: Boolean(AI_KEY),
          demoEnabled: DEMO_ENABLED,
          user: user ? publicUser(user) : null,
        });
      }

      if (pathname === '/api/auth/register' && method === 'POST') {
        const ip = clientIp(req);
        if (tooManyRegistrations(ip)) return sendError(res, 429, '注册太频繁了，请稍后再试');
        if (tooManyAttempts(ip)) return sendError(res, 429, '尝试次数过多，请稍后再试');
        const body = await readBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const nickname = String(body.nickname || '').trim().slice(0, 24);
        const password = String(body.password || '');
        const consent = body.consent === true || body.consent === 'on' || body.consent === 'true';
        if (!USERNAME_RE.test(username)) return sendError(res, 400, '账号需为 3–24 位字母、数字或下划线');
        if (nickname.length < 1) return sendError(res, 400, '请输入昵称');
        if (password.length < 8) return sendError(res, 400, '密码至少需要 8 位');
        if (password.length > 128) return sendError(res, 400, '密码过长');
        if (!consent) return sendError(res, 400, '请先同意健康数据说明');
        if (!DEMO_ENABLED && username === 'demo') return sendError(res, 403, '体验账号未开放');
        const exists = await db.findUserByUsername(username);
        if (exists) return sendError(res, 409, '这个账号已经被注册');
        const createdAt = nowIso();
        const user = await db.createUser({
          email: `${username}@users.local`,
          username,
          nickname,
          passwordHash: hashPassword(password),
          createdAt,
          consentAt: createdAt,
        });
        const adminName = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
        if (adminName && username === adminName) {
          await db.setAdmin(user.id, true);
          user.is_admin = true;
        }
        await createSession(req, res, user.id);
        return sendJson(res, 201, { user: publicUser(user) });
      }

      if (pathname === '/api/auth/login' && method === 'POST') {
        const ip = clientIp(req);
        if (tooManyAttempts(ip)) return sendError(res, 429, '尝试次数过多，请稍后再试');
        const body = await readBody(req);
        const account = String(body.username || body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        let user = await db.findUserByUsername(account);
        if (!user && account.includes('@')) user = await db.findUserByEmail(account);
        if (!DEMO_ENABLED && (user?.username === 'demo' || account === 'demo')) {
          return sendError(res, 403, '体验账号未开放');
        }
        if (!user || !verifyPassword(password, user.password_hash)) {
          return sendError(res, 401, '账号或密码不正确');
        }
        await db.deleteExpiredSessions(user.id, nowIso());
        await createSession(req, res, user.id);
        return sendJson(res, 200, { user: publicUser(user) });
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        const token = parseCookies(req).ss_session;
        if (token) await db.deleteSession(hashToken(token));
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
      }

      const user = await getAuth(req);
      if (!user) return sendError(res, 401, '请先登录');

      if (pathname === '/api/auth/me' && method === 'GET') {
        const stats = await db.getUserStats(user.id);
        return sendJson(res, 200, {
          user: publicUser(user),
          stats: { total: stats.total, firstDate: stats.firstDate },
          aiEnabled: Boolean(AI_KEY),
          lanUrls: lanUrls(),
        });
      }

      if (pathname === '/api/admin/overview' && method === 'GET') {
        if (!requireAdmin(user, res)) return;
        return sendJson(res, 200, { ...(await db.adminOverview()), currentUsername: user.username });
      }

      const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)(\/records)?$/);
      if (adminUserMatch) {
        if (!requireAdmin(user, res)) return;
        const targetId = Number(adminUserMatch[1]);
        const target = await db.findUserById(targetId);
        if (!target) return sendError(res, 404, '用户不存在');
        if (adminUserMatch[2] && method === 'GET') {
          return sendJson(res, 200, {
            user: publicUser(target),
            records: await getRecords(targetId, 400),
          });
        }
        if (!adminUserMatch[2] && method === 'DELETE') {
          if (targetId === user.id) return sendError(res, 400, '不能删除当前登录的管理员账号');
          if (target.is_admin && (await db.countAdmins()) <= 1) {
            return sendError(res, 409, '至少需要保留一个管理员');
          }
          await db.addAdminAction({
            adminId: user.id,
            targetUserId: targetId,
            action: 'delete_user',
            details: `删除用户 ${target.username}`,
            createdAt: nowIso(),
          });
          await db.deleteUser(targetId);
          return sendJson(res, 200, { ok: true });
        }
        if (!adminUserMatch[2] && method === 'PATCH') {
          const body = await readBody(req);
          const isAdmin = Boolean(body.isAdmin);
          if (targetId === user.id && !isAdmin) return sendError(res, 400, '不能取消自己的管理员权限');
          if (target.is_admin && !isAdmin && (await db.countAdmins()) <= 1) {
            return sendError(res, 409, '至少需要保留一个管理员');
          }
          const updated = await db.setAdmin(targetId, isAdmin);
          await db.addAdminAction({
            adminId: user.id,
            targetUserId: targetId,
            action: isAdmin ? 'grant_admin' : 'revoke_admin',
            details: `${isAdmin ? '授予' : '取消'} ${target.username} 的管理员权限`,
            createdAt: nowIso(),
          });
          return sendJson(res, 200, { user: publicUser(updated) });
        }
      }

      const adminRecordMatch = pathname.match(/^\/api\/admin\/records\/(\d+)$/);
      if (adminRecordMatch && method === 'DELETE') {
        if (!requireAdmin(user, res)) return;
        const recordId = Number(adminRecordMatch[1]);
        const record = await db.getRecordById(recordId);
        if (!record) return sendError(res, 404, '记录不存在');
        const target = await db.findUserById(record.user_id);
        await db.addAdminAction({
          adminId: user.id,
          targetUserId: record.user_id,
          action: 'delete_record',
          details: `删除 ${target?.username || record.user_id} 的记录 ${record.local_date}`,
          createdAt: nowIso(),
        });
        await db.deleteRecordById(recordId);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/records' && method === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 400, 1), 400);
        return sendJson(res, 200, { records: await getRecords(user.id, limit) });
      }

      if (pathname === '/api/records' && method === 'POST') {
        const body = await readBody(req);
        const data = normalizeRecord(body);
        const ts = nowIso();
        const row = await db.createRecord({ ...data, userId: user.id, createdAt: ts, updatedAt: ts });
        return sendJson(res, 201, { record: recordRow(row) });
      }

      const recordMatch = pathname.match(/^\/api\/records\/(\d+)$/);
      if (recordMatch) {
        const id = Number(recordMatch[1]);
        const existing = await db.getRecord(id, user.id);
        if (!existing) return sendError(res, 404, '记录不存在');
        if (method === 'DELETE') {
          await db.deleteRecord(id, user.id);
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'PATCH' || method === 'PUT') {
          const body = await readBody(req);
          const merged = { ...recordRow(existing), ...body };
          const data = normalizeRecord(
            {
              bristol: merged.bristol,
              color: merged.color,
              amount: merged.amount,
              ease: merged.ease,
              notes: merged.notes,
              occurredAt: merged.occurredAt,
              localDate: merged.localDate,
            },
            existing,
          );
          const row = await db.updateRecord(id, user.id, { ...data, updatedAt: nowIso() });
          return sendJson(res, 200, { record: recordRow(row) });
        }
      }

      if (pathname === '/api/chat' && method === 'GET') {
        const messages = (await db.listMessages(user.id, 60))
          .reverse()
          .map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at }));
        return sendJson(res, 200, { messages, aiEnabled: Boolean(AI_KEY) });
      }

      if (pathname === '/api/chat' && method === 'DELETE') {
        await db.clearMessages(user.id);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/chat' && method === 'POST') {
        if (chatRateLimited(user.id)) return sendError(res, 429, '消息发送太快了，歇一下再试');
        const body = await readBody(req);
        const text = String(body.message || '').trim();
        if (!text) return sendError(res, 400, '请输入内容');
        if (text.length > 1000) return sendError(res, 400, '消息太长了，请控制在 1000 字以内');
        const history = (await db.listMessages(user.id, 8))
          .reverse();
        const records = await getRecords(user.id, 200);
        let reply = '';
        let mode = 'local';
        let notice = '';
        if (AI_KEY) {
          try {
            reply = await askRemoteAI(user, text, records, history);
            mode = 'ai';
          } catch (err) {
            console.error('[ai]', err.message);
            reply = localChatReply(text, records);
            notice = 'AI 服务暂时不可用，已使用本地健康规则为你分析。';
          }
        } else {
          reply = localChatReply(text, records);
        }
        const ts = nowIso();
        await db.createMessage({ userId: user.id, role: 'user', content: text, createdAt: ts });
        const assistant = await db.createMessage({
          userId: user.id,
          role: 'assistant',
          content: reply,
          createdAt: nowIso(),
        });
        return sendJson(res, 200, {
          userMessage: { role: 'user', content: text, createdAt: ts },
          message: {
            id: assistant.id,
            role: 'assistant',
            content: reply,
            createdAt: nowIso(),
          },
          mode,
          notice,
        });
      }

      if (pathname === '/api/analyze' && method === 'POST') {
        const body = await readBody(req);
        const days = Math.min(Math.max(Number(body.days) || 7, 1), 30);
        const cutoff = new Date(Date.now() - days * 864e5);
        const records = (await getRecords(user.id, 400)).filter((r) => new Date(r.occurredAt) >= cutoff);
        let content = localAnalysis(records);
        let mode = 'local';
        if (AI_KEY) {
          try {
            content = await askRemoteAI(user, `请分析我最近 ${days} 天的排便记录，告诉我是否健康，以及怎么调理。`, records, []);
            mode = 'ai';
          } catch (err) {
            console.error('[ai]', err.message);
          }
        }
        return sendJson(res, 200, { content, mode });
      }

      if (pathname === '/api/export.csv' && method === 'GET') {
        const records = await getRecords(user.id, 100000);
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const safeCell = (v) => {
          const str = String(v ?? '');
          return /^[=+\-@]/.test(str) ? `'${str}` : str;
        };
        const rows = [
          ['日期', '时间', '形态（1-7）', '颜色', '量', '感受', '备注'].map(esc).join(','),
          ...records.map((r) =>
            [
              r.localDate,
              new Date(r.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
              r.bristol,
              COLOR_LABEL[r.color] || r.color,
              AMOUNT_LABEL[r.amount] || r.amount,
              EASE_LABEL[r.ease] || r.ease,
              safeCell(r.notes),
            ]
              .map(esc)
              .join(','),
          ),
        ];
        const body = '\uFEFF' + rows.join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="shunshun-records.csv"',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }

      if (pathname === '/api/account' && method === 'DELETE') {
        const body = await readBody(req);
        const password = String(body.password || '');
        const row = await db.findUserById(user.id);
        if (!row || !verifyPassword(password, row.password_hash)) return sendError(res, 403, '密码不正确');
        await db.deleteUser(user.id);
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
      }

      return sendError(res, 404, '接口不存在');
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器开小差了';
      const status = /请求|格式|请|不能/.test(message) ? 400 : 500;
      if (status === 500) {
        console.error('[server]', err);
        return sendError(res, 500, '服务器开小差了，请稍后再试');
      }
      return sendError(res, status, message);
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, '不支持的请求方法');
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  顺顺日记已启动');
  console.log(`  本机访问: http://localhost:${PORT}`);
  const nets = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal);
  for (const net of nets) console.log(`  手机访问: http://${net.address}:${PORT}`);
  console.log(`  AI 状态: ${AI_KEY ? `已启用（${AI_MODEL}）` : '本地规则分析（未配置 API Key）'}`);
  console.log(`  数据库: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'}`);
  console.log(`  运行模式: ${PUBLIC_MODE ? '公开注册' : '本地/局域网'}${DEMO_ENABLED ? ' · 体验账号开启' : ' · 体验账号关闭'}`);
  console.log('');
});
