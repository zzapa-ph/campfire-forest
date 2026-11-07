// 모닥불 숲 서버: 정적 파일은 public 폴더에서 바로 나가고,
// /ws (같은 숲에 모이기)와 /api (편지함)만 이 Worker가 받습니다.
// 숲은 하나(main)이고, 사람들의 위치와 편지는 Durable Object 하나가 함께 관리합니다.

const MAX_PEERS = 80;            // 한 숲에 동시에 머무는 최대 인원
const MAX_PRESENCE = 4096;       // 상태 메시지 최대 크기 (바이트)
const WRITE_GAP_MS = 15000;      // 한 사람이 편지함에 다시 쓰기까지 최소 간격
const MAX_LETTER_DOCS = 5000;    // 편지를 남긴 사람 수 상한

// 욕설, 비하, 연락처, 링크는 서버에서도 한 번 더 막음
const BAD = /(시발|씨발|씨빨|시바|ㅅㅂ|ㅆㅂ|ㅅ1ㅂ|병신|븅신|ㅂㅅ|좆|존나|졸라|개새|개색|새끼|미친놈|미친년|꺼져|죽어|죽여|닥쳐|느금|니애미|애미|애비|fuck|shit|bitch|sex|섹스|야동)/i;
const SPAM = /(https?:|www\.|\.com|\.net|\.kr|\.io|\.me|@|\d{2,4}[- .]?\d{3,4}[- .]?\d{4}|카톡|카카오|오픈채팅|텔레그램|텔레|라인아이디|인스타|insta|광고|홍보|무료상담)/i;
const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
const plain = t => norm(t).replace(/[\s.,·*_\-~!?]/g, '');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      const stub = env.FOREST.get(env.FOREST.idFromName('main'));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  }
};

export class Forest {
  constructor(state, env) {
    this.state = state; this.env = env; this.sql = state.storage.sql; this.rate = new Map();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, owner TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (coll, id))`);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.join(req);
    if (url.pathname.startsWith('/api/coll/')) return this.api(req, url);
    return new Response('not found', { status: 404 });
  }

  /* ---------- 같은 숲에 모이기 ---------- */
  others(except) { return this.state.getWebSockets().filter(w => w !== except); }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }

  join(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    if (this.state.getWebSockets().length >= MAX_PEERS) return new Response('forest is full', { status: 503 });
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    const peer = crypto.randomUUID().replace(/-/g, '').slice(0, 14);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ peer, presence: null });
    const peers = this.others(server).map(w => w.deserializeAttachment()).filter(a => a && a.presence);
    this.send(server, { t: 'init', you: peer, peers });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_PRESENCE) return;
    const att = ws.deserializeAttachment(); if (!att) return;
    // 한 사람이 너무 자주 보내면 흘려보냄 (초당 약 15번까지)
    const now = Date.now(), r = this.rate.get(att.peer) || { t: now, n: 0 };
    if (now - r.t > 1000) { r.t = now; r.n = 0; } r.n++; this.rate.set(att.peer, r); if (r.n > 15) return;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    if (m.t !== 'p' || !m.p || typeof m.p !== 'object' || Array.isArray(m.p)) return;
    const first = !att.presence; att.presence = m.p; ws.serializeAttachment(att);
    const out = { t: first ? 'join' : 'upd', peer: att.peer, presence: m.p };
    for (const w of this.others(ws)) this.send(w, out);
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }
  leave(ws) {
    const att = ws.deserializeAttachment(); if (!att) return;
    this.rate.delete(att.peer);
    for (const w of this.others(ws)) this.send(w, { t: 'leave', peer: att.peer });
    try { ws.close(1000, 'bye'); } catch (e) {}
  }

  /* ---------- 숲속 편지함 ---------- */
  json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
  async hash(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }

  async api(req, url) {
    const [, , , coll, rawId] = url.pathname.split('/');
    if (!['letters', 'reports', 'feedback', 'stats'].includes(coll)) return this.json({ error: 'unknown collection' }, 404);
    const uid = req.headers.get('X-Uid'), tok = req.headers.get('X-Token') || '';
    // 건의함은 만든 사람(관리자 키를 가진 사람)만 전체를 읽음
    if (coll === 'feedback' && req.method === 'GET' && !rawId) {
      const key = req.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
      if (!this.env.ADMIN_KEY || key !== this.env.ADMIN_KEY) return this.json({ error: 'admin only' }, 403);
    }
    if (req.method === 'GET' && !rawId) {
      const rows = this.sql.exec('SELECT id, data FROM docs WHERE coll = ? ORDER BY updated DESC LIMIT 1000', coll).toArray();
      return this.json({ docs: rows.map(r => ({ id: r.id, data: JSON.parse(r.data) })) });
    }
    const id = decodeURIComponent(rawId || '');
    if (!/^[a-z0-9-]{8,40}$/.test(id)) return this.json({ error: 'bad id' }, 400);
    if (req.method === 'GET') {
      if (coll === 'feedback') { const own = this.sql.exec('SELECT owner FROM docs WHERE coll = ? AND id = ?', coll, id).toArray()[0];
        if (own && (uid !== id || own.owner !== await this.hash(tok))) return this.json({ exists: false }); }
      const row = this.sql.exec('SELECT data FROM docs WHERE coll = ? AND id = ?', coll, id).toArray()[0];
      return this.json(row ? { exists: true, data: JSON.parse(row.data) } : { exists: false });
    }
    if (req.method !== 'PUT') return this.json({ error: 'method' }, 405);

    // 자기 문서에만 쓸 수 있음: 처음 쓸 때 받은 비밀 토큰으로 주인을 확인
    if (uid !== id || tok.length < 20 || tok.length > 200) return this.json({ error: 'not yours' }, 403);
    const owner = await this.hash(tok);
    const row = this.sql.exec('SELECT owner, updated FROM docs WHERE coll = ? AND id = ?', coll, id).toArray()[0];
    if (row && row.owner !== owner) return this.json({ error: 'not yours' }, 403);
    if (row && Date.now() - row.updated < WRITE_GAP_MS) return this.json({ error: 'too fast' }, 429);
    if (!row && coll !== 'reports' && coll !== 'stats') {
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM docs WHERE coll = ?', coll).toArray()[0].n;
      if (n >= MAX_LETTER_DOCS) return this.json({ error: 'full' }, 507);
    }
    const text = await req.text(); if (text.length > 8000) return this.json({ error: 'too big' }, 400);
    let body; try { body = JSON.parse(text); } catch (e) { return this.json({ error: 'bad json' }, 400); }

    let clean;
    if (coll === 'letters') {
      const items = Array.isArray(body.items) ? body.items.slice(-10) : null; if (!items) return this.json({ error: 'bad body' }, 400);
      clean = { items: [] };
      for (const it of items) {
        const t = norm(it && it.text).slice(0, 60), k = String(it && it.k || '').slice(0, 24);
        if (!t || !/^[a-z0-9]+$/.test(k)) return this.json({ error: 'bad item' }, 400);
        if (BAD.test(t) || BAD.test(plain(t)) || SPAM.test(t) || SPAM.test(plain(t))) return this.json({ error: 'not allowed' }, 400);
        clean.items.push({ k, text: t, t: Math.min(Date.now(), Number(it.t) || Date.now()) });
      }
    } else if (coll === 'feedback') {
      const items = Array.isArray(body.items) ? body.items.slice(-20) : null; if (!items) return this.json({ error: 'bad body' }, 400);
      const CATS = ['bug', 'ux', 'idea', 'etc'];
      clean = { items: items.map(it => ({
        k: String(it && it.k || '').replace(/[^a-z0-9]/g, '').slice(0, 24), cat: CATS.includes(it && it.cat) ? it.cat : 'etc',
        text: norm(it && it.text).slice(0, 300), t: Math.min(Date.now(), Number(it && it.t) || Date.now()),
        where: norm(it && it.where).slice(0, 40), pos: it && it.pos && Number.isFinite(it.pos.x) && Number.isFinite(it.pos.z) ? { x: +it.pos.x, z: +it.pos.z } : null,
        dev: it && it.dev === 'mobile' ? 'mobile' : 'desktop', scr: String(it && it.scr || '').slice(0, 12), lowQ: !!(it && it.lowQ) })).filter(it => it.text.length >= 2) };
    } else if (coll === 'stats') {
      // 하루별 숫자만: v 방문, w 태운 걱정, b 넣은 장작, e 먹은 마시멜로
      const days = body && typeof body.days === 'object' && !Array.isArray(body.days) ? body.days : null; if (!days) return this.json({ error: 'bad body' }, 400);
      const n = x => Math.max(0, Math.min(9999, Math.floor(Number(x) || 0)));
      clean = { days: {} };
      for (const k of Object.keys(days).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-14)) { const o = days[k] || {}; clean.days[k] = { v: n(o.v) ? 1 : 0, w: n(o.w), b: n(o.b), e: n(o.e) }; }
    } else {
      const keys = Array.isArray(body.keys) ? body.keys.slice(-100) : null; if (!keys) return this.json({ error: 'bad body' }, 400);
      clean = { keys: keys.map(k => String(k).slice(0, 80)).filter(k => /^[a-z0-9-]{8,40}:[a-z0-9]{1,24}$/.test(k)) };
    }
    this.sql.exec('INSERT INTO docs (coll, id, data, owner, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated = excluded.updated',
      coll, id, JSON.stringify(clean), owner, Date.now());
    return this.json({ ok: true });
  }
}
