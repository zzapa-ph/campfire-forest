/* 모닥불 숲: 클라우드플레어 연결부
   게임 코드가 쓰는 window.claude.use('room' | 'db' | 'user')를 클라우드플레어 Worker로 이어 줍니다.
   - room: 같은 숲에 있는 사람들의 위치와 상태 (WebSocket, /ws)
   - db:   숲속 편지함과 가리기 신고 (/api/coll/...)
   - user: 이 브라우저의 익명 아이디 */
(function () {
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  let uid = get('forest-uid'), tok = get('forest-tok');
  if (!uid || !/^[a-z0-9-]{8,40}$/.test(uid) || !tok) { uid = rid(); tok = rid() + rid(); put('forest-uid', uid); put('forest-tok', tok); }

  /* ---- 같은 숲에 있는 사람들 ---- */
  let roomP = null;
  function makeRoom() {
    if (roomP) return roomP;
    roomP = new Promise(resolve => {
      const me = { peer: 'me', sameTab: true, isMe: true, kind: 'viewer', presence: null };
      const peers = new Map(), subs = [];
      let ws = null, myPres = null, retry = 1000, done = false, lastSend = 0, pending = null;
      const finish = () => { if (!done) { done = true; resolve(api); } };
      const list = () => [me, ...peers.values()];
      const emit = ch => subs.forEach(fn => { try { fn(ch); } catch (e) { console.warn(e); } });
      const peerOf = q => ({ peer: q.peer, sameTab: false, isMe: false, kind: 'viewer', presence: q.presence });
      const send = () => {
        if (!ws || ws.readyState !== 1 || !myPres) return;
        const now = Date.now();
        if (now - lastSend < 90) { if (!pending) pending = setTimeout(() => { pending = null; send(); }, 95); return; }
        lastSend = now; ws.send(JSON.stringify({ t: 'p', p: myPres }));
      };
      const api = {
        peers: () => list(),
        presence(p) { myPres = p; me.presence = p; send(); return Promise.resolve(); },
        onPeers(fn) { subs.push(fn); try { fn({ joined: list(), updated: [], left: [] }); } catch (e) {} return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
        emit() {}, on() { return () => {}; }
      };
      function connect() {
        try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
        catch (e) { finish(); return; }
        ws.onopen = () => { retry = 1000; finish(); send(); };
        ws.onmessage = e => {
          let m; try { m = JSON.parse(e.data); } catch (_) { return; }
          if (m.t === 'init') {
            const left = [...peers.values()]; peers.clear();
            const joined = (m.peers || []).map(q => { const o = peerOf(q); peers.set(q.peer, o); return o; });
            emit({ joined, updated: [], left });
          } else if (m.t === 'join') {
            const o = peerOf(m); peers.set(m.peer, o); emit({ joined: [o], updated: [], left: [] });
          } else if (m.t === 'upd') {
            let o = peers.get(m.peer);
            if (!o) { o = peerOf(m); peers.set(m.peer, o); emit({ joined: [o], updated: [], left: [] }); }
            else { o.presence = m.presence; emit({ joined: [], updated: [o], left: [] }); }
          } else if (m.t === 'leave') {
            const o = peers.get(m.peer); if (o) { peers.delete(m.peer); emit({ joined: [], updated: [], left: [o] }); }
          }
        };
        ws.onclose = () => {
          finish();
          const left = [...peers.values()]; peers.clear(); if (left.length) emit({ joined: [], updated: [], left });
          setTimeout(connect, retry); retry = Math.min(15000, retry * 2);
        };
        ws.onerror = () => {};
      }
      connect(); setTimeout(finish, 6000);
    });
    return roomP;
  }

  /* ---- 숲속 편지함 ---- */
  function makeDb() {
    const H = { 'Content-Type': 'application/json', 'X-Uid': uid, 'X-Token': tok };
    const meta = { fromCache: false, hasPendingWrites: false };
    const refreshers = {};
    const snapOf = docs => ({ docs: docs.map(d => ({ id: d.id, exists: true, data: () => d.data, metadata: meta })), size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta });
    const collection = c => ({
      path: c,
      onSnapshot(next, err) {
        let stop = false, last = '';
        const once = async () => {
          try { const r = await fetch('/api/coll/' + c, { cache: 'no-store' }); if (r.ok) { const t = await r.text(); if (t !== last) { last = t; next(snapOf(JSON.parse(t).docs || [])); } } } catch (e) {}
        };
        const loop = async () => { if (stop) return; await once(); if (!stop) setTimeout(loop, 20000); };
        (refreshers[c] = refreshers[c] || []).push(once); loop();
        return () => { stop = true; };
      },
      doc: id => doc(c + '/' + id)
    });
    const doc = path => {
      const [c, id] = path.split('/');
      const url = '/api/coll/' + c + '/' + encodeURIComponent(id);
      return {
        id, path,
        async get() { const r = await fetch(url, { cache: 'no-store', headers: H }); const j = r.ok ? await r.json() : { exists: false }; return { id, exists: !!j.exists, data: () => j.data, metadata: meta }; },
        async set(data) {
          const r = await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify(data) });
          if (!r.ok) { const code = r.status === 429 ? 'resource_exhausted' : r.status === 507 ? 'quota_exceeded' : r.status >= 500 ? 'unavailable' : 'invalid_argument'; throw { code, message: await r.text() }; }
          (refreshers[c] || []).forEach(f => setTimeout(f, 200));
        }
      };
    };
    return { collection, doc };
  }

  const user = { id: async () => uid, can: async () => true, isOwner: () => false, canEdit: () => false };
  window.claude = { use: async name => name === 'room' ? makeRoom() : name === 'db' ? makeDb() : name === 'user' ? user : null };
})();
