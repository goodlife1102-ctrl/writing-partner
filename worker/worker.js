/**
 * 스피치라이터의 5분 완성 글쓰기 — 서버
 * Cloudflare Workers + D1
 *
 * 사용자는 참가 코드를 넣고 구글 로그인만 하면 바로 쓴다. API 키를 넣을 일이 없다.
 * 관리자는 대시보드에서 그날의 키를 넣고, 총량을 정하고, 누가 몇 건 썼는지 본다.
 * 키는 이 서버 안에만 있고 사용자 브라우저로 내려가지 않는다.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...CORS } });

/* ---------- 한국 시간 ---------- */
const kst = () => new Date(Date.now() + 9 * 3600 * 1000);
const today = () => kst().toISOString().slice(0, 10);
const nowStr = () => kst().toISOString().slice(0, 19).replace('T', ' ');

/* ---------- 설정 ---------- */
const DEFAULTS = {
  daily_total_cap: '200',   // 하루 전체 상한
  per_user_daily: '2',      // 1인당 하루 무료 횟수
  provider: 'claude',       // claude | gemini
  model: '',                // 비우면 기본 모델
  notice: '',               // 사이트 상단 공지
  open: '1',                // 0 이면 전체가 프롬프트 복사 방식으로
  entry_code: '',           // 비우면 누구나, 채우면 그 코드를 아는 사람만
  claude_key: '',           // 클로드 키 (밖으로 절대 안 나감)
  gemini_key: '',           // 제미나이 키 (밖으로 절대 안 나감)
  claude_model: '',         // 비우면 기본값
  gemini_model: '',         // 비우면 기본값
};
async function getSettings(env) {
  const out = { ...DEFAULTS };
  try {
    const { results } = await env.DB.prepare('SELECT k,v FROM settings').all();
    (results || []).forEach((r) => (out[r.k] = r.v));
  } catch (e) {}
  return out;
}
const aiKeyOf = (env, s) =>
  (s.provider === 'gemini'
    ? (s.gemini_key || '').trim() || env.GEMINI_KEY
    : (s.claude_key || '').trim() || env.CLAUDE_KEY) || env.AI_KEY || '';
const modelOf = (s) => (s.provider === 'gemini' ? s.gemini_model : s.claude_model) || s.model || '';

/* ---------- 관리자 ---------- */
const okAdmin = (env, pw) => !!env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD;

/* ---------- 사용자 식별 — 구글 로그인 ---------- */
async function whoIs(env, body) {
  const idToken = body.idToken;
  if (!idToken) return null;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!r.ok) return null;
  const j = await r.json();
  if (env.GOOGLE_CLIENT_ID && j.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (j.email_verified !== 'true' && j.email_verified !== true) return null;
  if (Number(j.exp) * 1000 < Date.now()) return null;
  return { sub: 'g:' + j.sub, email: (j.email || '').toLowerCase(), name: j.name || j.email || '이름없음' };
}
async function touchUser(env, u) {
  await env.DB.prepare(
    `INSERT INTO users (sub,email,name,created_at,last_seen,blocked,bonus)
     VALUES (?,?,?,?,?,0,0)
     ON CONFLICT(sub) DO UPDATE SET email=excluded.email, name=excluded.name, last_seen=excluded.last_seen`
  ).bind(u.sub, u.email, u.name, nowStr(), nowStr()).run();
  return (await env.DB.prepare('SELECT blocked,bonus FROM users WHERE sub=?').bind(u.sub).first()) || { blocked: 0, bonus: 0 };
}
async function counts(env, sub) {
  const d = today();
  const mine = await env.DB.prepare('SELECT COUNT(*) c FROM usage WHERE sub=? AND day=?').bind(sub, d).first();
  const all = await env.DB.prepare('SELECT COUNT(*) c FROM usage WHERE day=?').bind(d).first();
  const min1 = await env.DB.prepare(
    "SELECT COUNT(*) c FROM usage WHERE sub=? AND at > datetime('now','-60 seconds')"
  ).bind(sub).first();
  return { mine: mine?.c || 0, all: all?.c || 0, lastMinute: min1?.c || 0 };
}

/* ---------- AI 호출 ---------- */
async function callClaude(key, model, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model || 'claude-sonnet-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 401) throw new Error('관리자 키가 올바르지 않습니다. 관리자에게 알려 주세요.');
    if (r.status === 429) throw new Error('요청이 몰렸습니다. 잠시 뒤 다시 시도해 주세요.');
    throw new Error('AI 오류 ' + r.status + ' ' + t.slice(0, 200));
  }
  const j = await r.json();
  return (j.content || []).map((c) => c.text || '').join('');
}
async function callGemini(key, model, prompt) {
  const m = encodeURIComponent(model || 'gemini-2.5-flash');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8000, temperature: 1 } }),
  });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 429) throw new Error('요청이 몰렸습니다. 잠시 뒤 다시 시도해 주세요.');
    throw new Error('AI 오류 ' + r.status + ' ' + t.slice(0, 200));
  }
  const j = await r.json();
  const c = (j.candidates || [])[0];
  return (((c && c.content && c.content.parts) || []).map((p) => p.text || '').join('')) || '';
}
const runAI = (s, key, prompt) =>
  s.provider === 'gemini' ? callGemini(key, modelOf(s), prompt) : callClaude(key, modelOf(s), prompt);

/* ---------- 라우팅 ---------- */
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');

    try {
      /* 사이트가 처음 열릴 때 부르는 곳 */
      if (p === '/api/config') {
        const s = await getSettings(env);
        return json({
          ok: true,
          notice: s.notice,
          clientId: env.GOOGLE_CLIENT_ID || '',
          open: s.open === '1' && !!aiKeyOf(env, s),
          needCode: !!(s.entry_code && s.entry_code.trim()),
          perUserDaily: Number(s.per_user_daily),
        });
      }

      /* 입장 — 이름(과 필요하면 참가 코드)만 확인한다 */
      if (p === '/api/enter' && req.method === 'POST') {
        const body = await req.json();
        const s = await getSettings(env);
        if (s.entry_code && s.entry_code.trim() && String(body.code || '').trim() !== s.entry_code.trim())
          return json({ ok: false, error: '참가 코드가 맞지 않습니다.' }, 403);
        const u = await whoIs(env, body);
        if (!u) return json({ ok: false, error: '로그인이 만료됐습니다. 다시 로그인해 주세요.' }, 401);
        const meta = await touchUser(env, u);
        if (meta.blocked) return json({ ok: false, error: '이용이 제한되었습니다. 관리자에게 문의해 주세요.' }, 403);
        const c = await counts(env, u.sub);
        const limit = Number(s.per_user_daily) + Number(meta.bonus || 0);
        return json({
          ok: true, name: u.name, email: u.email, used: c.mine, limit, left: Math.max(0, limit - c.mine),
          open: s.open === '1' && !!aiKeyOf(env, s), notice: s.notice,
        });
      }

      /* 글 생성 */
      if (p === '/api/generate' && req.method === 'POST') {
        const body = await req.json();
        const s = await getSettings(env);
        if (s.entry_code && s.entry_code.trim() && String(body.code || '').trim() !== s.entry_code.trim())
          return json({ ok: false, error: '참가 코드가 맞지 않습니다.' }, 403);
        const u = await whoIs(env, body);
        if (!u) return json({ ok: false, error: '로그인이 만료됐습니다. 다시 로그인해 주세요.' }, 401);
        const meta = await touchUser(env, u);
        if (meta.blocked) return json({ ok: false, error: '이용이 제한되었습니다.' }, 403);

        const prompt = String(body.prompt || '');
        if (prompt.length < 20) return json({ ok: false, error: '내용이 너무 짧습니다.' }, 400);
        if (prompt.length > 30000) return json({ ok: false, error: '내용이 너무 깁니다. 참고자료를 줄여 주세요.' }, 400);

        const c = await counts(env, u.sub);
        const limit = Number(s.per_user_daily) + Number(meta.bonus || 0);
        if (c.lastMinute >= 5) return json({ ok: false, error: '너무 빠르게 요청하셨습니다. 잠시 뒤 다시 시도해 주세요.' }, 429);

        const key = aiKeyOf(env, s);
        const closed = s.open !== '1' || !key;
        const overUser = c.mine >= limit;
        const overAll = c.all >= Number(s.daily_total_cap);

        if (closed || overUser || overAll) {
          return json({
            ok: true, fallback: true,
            reason: closed ? 'closed' : overUser ? 'user' : 'total',
            message: closed
              ? '지금은 자동 생성이 잠겨 있습니다. 지시문을 복사해 두었으니 무료 AI에 붙여넣으시면 같은 글을 받으실 수 있습니다.'
              : overUser
              ? `오늘 ${limit}회를 모두 쓰셨습니다. 지시문을 복사해 두었으니 무료 AI에 붙여넣어 주세요. 내일 다시 열립니다.`
              : '오늘 전체 이용량이 가득 찼습니다. 지시문을 복사해 두었으니 무료 AI에 붙여넣어 주세요.',
            prompt, used: c.mine, limit, left: Math.max(0, limit - c.mine),
          });
        }

        const text = await runAI(s, key, prompt);
        await env.DB.prepare("INSERT INTO usage (sub,email,kind,at,day,chars) VALUES (?,?,?,datetime('now'),?,?)")
          .bind(u.sub, u.email || u.name, String(body.kind || 'draft'), today(), text.length).run();

        return json({ ok: true, text, used: c.mine + 1, limit, left: Math.max(0, limit - c.mine - 1) });
      }

      /* ---------- 관리자 ---------- */
      if (p.startsWith('/api/admin/')) {
        const body = req.method === 'POST' ? await req.json() : Object.fromEntries(url.searchParams);
        if (!okAdmin(env, body.pw)) return json({ ok: false, error: '비밀번호가 맞지 않습니다.' }, 403);

        if (p === '/api/admin/overview') {
          const s = await getSettings(env);
          const d = today();
          const t = await env.DB.prepare('SELECT COUNT(*) c FROM usage WHERE day=?').bind(d).first();
          const users = await env.DB.prepare(
            `SELECT u.sub,u.name,u.email,u.created_at,u.last_seen,u.blocked,u.bonus,
                    (SELECT COUNT(*) FROM usage g WHERE g.sub=u.sub) total,
                    (SELECT COUNT(*) FROM usage g WHERE g.sub=u.sub AND g.day=?) todayc
             FROM users u ORDER BY u.last_seen DESC LIMIT 500`
          ).bind(d).all();
          const recent = await env.DB.prepare('SELECT email,kind,at,day,chars FROM usage ORDER BY id DESC LIMIT 200').all();
          const daily = await env.DB.prepare('SELECT day, COUNT(*) c FROM usage GROUP BY day ORDER BY day DESC LIMIT 30').all();
          const key = aiKeyOf(env, s);
          const safe = { ...s };
          delete safe.claude_key; delete safe.gemini_key; // 키 원문은 절대 내보내지 않는다
          const hint = (k) => (k ? k.slice(0, 6) + '…' + k.slice(-4) : '');
          const ck = (s.claude_key || '').trim() || env.CLAUDE_KEY || '';
          const gk = (s.gemini_key || '').trim() || env.GEMINI_KEY || '';
          return json({
            ok: true, settings: safe, todayTotal: t?.c || 0,
            hasKey: !!key, keyHint: hint(key),
            claudeSet: !!ck, claudeHint: hint(ck),
            geminiSet: !!gk, geminiHint: hint(gk),
            users: users.results || [], recent: recent.results || [], daily: daily.results || [],
          });
        }

        if (p === '/api/admin/settings' && req.method === 'POST') {
          const allow = Object.keys(DEFAULTS);
          for (const [k, v] of Object.entries(body.settings || {})) {
            if (!allow.includes(k)) continue;
            if ((k === 'claude_key' || k === 'gemini_key') && v === '__keep__') continue; // 빈칸이면 기존 키 유지
            await env.DB.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
              .bind(k, String(v)).run();
          }
          return json({ ok: true });
        }

        if (p === '/api/admin/user' && req.method === 'POST') {
          const { sub, action, value } = body;
          if (action === 'block') await env.DB.prepare('UPDATE users SET blocked=1 WHERE sub=?').bind(sub).run();
          if (action === 'unblock') await env.DB.prepare('UPDATE users SET blocked=0 WHERE sub=?').bind(sub).run();
          if (action === 'bonus') await env.DB.prepare('UPDATE users SET bonus=? WHERE sub=?').bind(Number(value) || 0, sub).run();
          if (action === 'delete') {
            await env.DB.prepare('DELETE FROM usage WHERE sub=?').bind(sub).run();
            await env.DB.prepare('DELETE FROM users WHERE sub=?').bind(sub).run();
          }
          return json({ ok: true });
        }

        if (p === '/api/admin/reset' && req.method === 'POST') {
          if (body.what === 'today') await env.DB.prepare('DELETE FROM usage WHERE day=?').bind(today()).run();
          if (body.what === 'old') await env.DB.prepare("DELETE FROM usage WHERE at < datetime('now','-90 days')").run();
          if (body.what === 'all') { await env.DB.prepare('DELETE FROM usage').run(); await env.DB.prepare('DELETE FROM users').run(); }
          return json({ ok: true });
        }
      }

      return json({ ok: false, error: '없는 주소입니다.' }, 404);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },
};
