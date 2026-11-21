// ==UserScript==
// @name         Moderator Suite by Atra
// @namespace    looksmax-approval-queue-patched
// @version      5.19.0
// @description  Moderator Suite by Atra — every looksmax.org mod tool in one black & white-gold script: approval queue (alt/VPN/AI check, auto bans), Report Center, DM filter and the alt counter next to every username.
// @author       Atra
// @match        https://looksmax.org/*
// @match        https://*.looksmax.org/*
// @icon         https://www.google.com/s2/favicons?domain=looksmax.org
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      proxycheck.io
// @connect      looksmax.org
// @connect      api.zerogpt.com
// @connect      api.sapling.ai
// @connect      api-free.deepl.com
// @connect      api.deepl.com
// @connect      translate.googleapis.com
// @license      MIT
// ==/UserScript==

// ===================== QUICK START =====================
// 1. Install with a userscript manager that supports GM_xmlhttpRequest
//    (e.g. Tampermonkey). Only one copy: remove older queue / report scripts.
// 2. On looksmax.org the gold "LM" button in the top bar opens the suite
//    panel: tools on/off, options, service check.
// 3. Approval queue: set your Rank once (row "Queue" → Rank). Sub-mods and
//    approval mods pick theirs — then the suite never tries a ban. When a
//    round is checked and decided, tap "Save N" in the panel at the top.
// 4. Report Center on /reports, DM filter on /conversations, alt counter
//    next to every username.
// 5. Ban appeals are never touched: you decide, then tap "Save appeal".
// 6. AI check (Sapling), VPN check (proxycheck) and translation (DeepL) use
//    shared keys. Your own key: userscript menu → "Set Sapling key (AI check)",
//    "Change proxycheck key", "Set DeepL key (translation)".
// 7. Problems? Contact @Atra (line at the bottom of every panel).

const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

const LM_VERSIONS = { suite: '5.19.0', queue: '4.23.0', reports: '15.9.0', dms: '2.4.0', alts: '3.9.0' };

const LM_SERVER = 'http://185.94.29.80:3456';

const LMS = (() => {
  const SVC_KEY = 'lmSuite:svc';
  const BAN_KEY = 'lmSuite:ban';
  const AC_NS = 'lmAltCounter:v2:';
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v === null ? d : v; } catch (_) { return d; } };

  let pend = null, svcTimer = 0;
  const lastW = {};
  function svcRead() {
    const st = read(SVC_KEY, {});
    if (pend) Object.keys(pend).forEach((k) => { if (!st[k] || pend[k].t >= st[k].t) st[k] = pend[k]; });
    return st;
  }
  function svc(name, ok, msg) {
    const now = Date.now();
    const m = !ok && msg ? String(msg).replace(/\s+/g, ' ').slice(0, 140) : '';
    const prev = (pend && pend[name]) || lastW[name];

    if (prev && prev.ok === !!ok && (prev.m || '') === m && now - prev.t < 20000) return;
    if (!pend) pend = {};
    pend[name] = { ok: !!ok, t: now, m };
    if (svcTimer) return;
    svcTimer = setTimeout(() => {
      svcTimer = 0;
      const st = read(SVC_KEY, {});
      Object.keys(pend || {}).forEach((k) => { st[k] = pend[k]; lastW[k] = pend[k]; });
      pend = null;
      try { localStorage.setItem(SVC_KEY, JSON.stringify(st)); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('lm-suite-svc')); } catch (_) {}
    }, 800);
  }
  function banned(ids, by) {
    ids = [...new Set((ids || []).map(Number).filter((x) => x > 0))];
    if (!ids.length) return;
    const now = Date.now();
    try {
      const r = read(AC_NS + 'bannedIds', null) || {};
      r.ids = r.ids || {};
      for (const id of ids) {
        r.ids[id] = 1;
        localStorage.setItem(AC_NS + 's:' + id, JSON.stringify({ t: now, st: 'banned' }));
      }
      r.t = now;
      localStorage.setItem(AC_NS + 'bannedIds', JSON.stringify(r));
      localStorage.setItem(BAN_KEY, JSON.stringify({ ids, by: by || '', t: now }));
    } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('lm-suite-ban', { detail: { ids, by: by || '' } })); } catch (_) {}
  }
  const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function today() {
    const q = read('__lmqToday', null);
    const r = read('lrt-today-v2', null) || read('lrt-today-v1', null);
    const a = read('lmSuite:altBans', null);
    const ok = (o) => o && o.d === dayKey();
    return {
      queue: ok(q) ? q.saved || 0 : 0,
      queueBans: ok(q) ? q.ban || 0 : 0,
      reports: ok(r) ? +r.n || 0 : 0,
      reportBans: ok(r) ? +r.ban || 0 : 0,
      altBans: ok(a) ? +a.n || 0 : 0,
    };
  }
  function countAltBans(n) {
    if (!n) return;
    const a = read('lmSuite:altBans', null);
    const v = (a && a.d === dayKey() ? +a.n || 0 : 0) + n;
    try { localStorage.setItem('lmSuite:altBans', JSON.stringify({ d: dayKey(), n: v })); } catch (_) {}
  }

  let qBusy = false;
  const idleFns = [];
  function queueBusy(v) {
    if (v === undefined) return qBusy;
    v = !!v;
    if (v === qBusy) return qBusy;
    qBusy = v;
    if (!v) idleFns.slice().forEach((f) => { try { f(); } catch (_) {} });
    return qBusy;
  }
  const onQueueIdle = (f) => { idleFns.push(f); };

  const OPT_KEY = 'lmSuite:opt';

  const OPT_DEFAULTS = { lmServer: 1 };
  const opt = (k) => { const o = read(OPT_KEY, {}); return k in o ? !!o[k] : !!OPT_DEFAULTS[k]; };
  function setOpt(k, v) {
    const o = read(OPT_KEY, {});
    o[k] = v ? 1 : 0;
    try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch (_) {}
  }

  const ST_KEY = 'lmSuite:status';
  const stLast = {};
  function status(tool, data) {
    if (data === undefined) return read(ST_KEY, {})[tool] || null;
    const sig = JSON.stringify(data);
    if (stLast[tool] === sig) return;
    stLast[tool] = sig;
    const all = read(ST_KEY, {});
    all[tool] = Object.assign({ t: Date.now() }, data);
    try { localStorage.setItem(ST_KEY, JSON.stringify(all)); } catch (_) {}
  }
  return { svc, svcRead, banned, today, countAltBans, dayKey, queueBusy, onQueueIdle, opt, setOpt, status, BAN_KEY, SVC_KEY, OPT_KEY, ST_KEY };
})();

function LM_SWIPE_CLOSE(sheet, handles, close) {
  let y0 = 0, x0 = 0, dy = 0, on = false, t0 = 0;
  const start = (e) => {
    if (e.touches.length !== 1 || e.target.closest('button, a, input, textarea, select')) return;
    on = true; dy = 0; t0 = Date.now();
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
    sheet.style.transition = 'none';
  };
  const move = (e) => {
    if (!on) return;
    const d = e.touches[0].clientY - y0;
    if (Math.abs(e.touches[0].clientX - x0) > Math.abs(d) + 12) return;
    dy = Math.max(0, d);
    if (e.cancelable) e.preventDefault();
    sheet.style.setProperty('--lm-drag', dy + 'px');
  };
  const end = () => {
    if (!on) return;
    on = false;
    sheet.style.transition = '';
    const fast = dy > 40 && Date.now() - t0 < 220;
    if (dy > 110 || fast) close();
    sheet.style.setProperty('--lm-drag', '0px');
  };
  handles.filter(Boolean).forEach((h) => {
    h.style.touchAction = 'none';
    h.addEventListener('touchstart', start, { passive: true });
    h.addEventListener('touchmove', move, { passive: false });
    h.addEventListener('touchend', end, { passive: true });
    h.addEventListener('touchcancel', end, { passive: true });
  });
}

function LM_WARN_SAFE(form, params, fill, warningId) {
  const labelOf = (el) => {
    const l = el.closest('label') || (el.id && form.querySelector('label[for="' + el.id + '"]'));
    return ((l && l.textContent) || '') + ' ' + (el.name || '');
  };
  const pts = form.querySelector('input[name="points"]') ||
    [...form.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')].find((i) => /^points$|warning_points/i.test(i.name || ''));
  const boxes = [...form.querySelectorAll('input[type="checkbox"]')];
  const ptsOn = boxes.find((c) => /points_enable|apply warning points/i.test(labelOf(c)));
  const expiry = boxes.filter((c) => /expir/i.test(labelOf(c)));
  const filled = !!fill && Object.prototype.hasOwnProperty.call(fill, pts ? pts.name : 'points') && fill[pts ? pts.name : 'points'] !== null;
  if (String(warningId) === '14') {
    if (!pts && !filled) return { ok: false, why: 'permaban: no points field in the warn form — nothing sent' };
    if (pts) params.set(pts.name, '100');
    if (ptsOn) params.set(ptsOn.name, ptsOn.value || '1');
    expiry.forEach((c) => params.delete(c.name));

    const never = form.querySelector('input[type="radio"][name*="expir" i][value="never"], input[type="radio"][name*="expir" i][value="0"]');
    if (never) params.set(never.name, never.value);
    return { ok: true };
  }
  if (!filled) return { ok: false, why: 'warning details (points) were not filled by the forum — nothing sent, trying again' };
  return { ok: true };
}

const LM_SPLIT = (t) => String(t || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
const LM_DET = (() => {
  const norm = (list) => {
    const s = LM_SPLIT((Array.isArray(list) ? list : [list]).join(' '));
    const ck = /cookie/i.test(s);
    const ip = /\bip\b|ip[\s-]*address/i.test(s);
    const other = [];
    if (/e-?mail/i.test(s)) other.push('Email');
    if (/fingerprint|browser|user[\s-]?agent/i.test(s)) other.push('Fingerprint');
    if (/device/i.test(s)) other.push('Device');
    return { ck, ip, other };
  };
  function kind(list) {
    const n = norm(list || []);
    return n.ck && n.ip ? 'both' : n.ck ? 'cookie' : n.ip ? 'ip' : n.other.length ? 'other' : '';
  }
  function label(list) {
    const n = norm(list || []);
    const base = n.ck && n.ip ? 'Cookie + IP' : n.ck ? 'Cookie' : n.ip ? 'IP only' : '';
    if (!n.other.length) return base;
    return (n.ck || n.ip ? (n.ck && n.ip ? 'Cookie + IP' : n.ck ? 'Cookie' : 'IP') + ' + ' : '') + n.other.join(' + ');
  }
  function css() {
    if (document.getElementById('lm-det-css')) return;
    const st = document.createElement('style');
    st.id = 'lm-det-css';
    st.textContent =
      '.lm-det{display:inline-flex;align-items:center;gap:5px;height:19px;padding:0 8px 0 7px;border-radius:999px;box-sizing:border-box;' +
      'font:800 10px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;letter-spacing:.05em;text-transform:uppercase;' +
      'white-space:nowrap;border:1px solid rgba(255,255,255,.14);color:#b9b3a6;background:rgba(255,255,255,.05);vertical-align:middle;flex:none}' +
      '.lm-det::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}' +
      '.lm-det[data-k=both]{color:#ff8d99;border-color:rgba(255,84,102,.5);background:rgba(255,84,102,.14)}' +
      '.lm-det[data-k=cookie]{color:#ffab8f;border-color:rgba(255,138,101,.46);background:rgba(255,138,101,.12)}' +
      '.lm-det[data-k=ip]{color:#ffd28a;border-color:rgba(255,182,72,.42);background:rgba(255,182,72,.10)}' +
      '.lm-det[data-k=via]{text-transform:none;letter-spacing:.01em;font-weight:700}';
    (document.head || document.documentElement).appendChild(st);
  }

  function pill(list, via) {
    const k = kind(list);
    const txt = label(list);
    if (!txt && !via) return null;
    css();
    const e = document.createElement('span');
    e.className = 'lm-det';
    e.dataset.k = via ? 'via' : k;
    e.textContent = via ? 'via @' + via + (txt ? ' · ' + txt : '') : txt;
    e.title = via ? 'Not linked directly — only through @' + via : 'Found by ' + txt;
    return e;
  }
  return { kind, label, pill, css };
})();

const MY_DEEPL_KEY = "dada4146-9851-402f-aa5f-9caa0afa02de:fx";

const LM_TR = (() => {
  const GM_KEY = 'deeplApiKey';
  const CACHE_KEY = 'lmTr:v1';
  const TARGET_KEY = 'lmTr:target';
  const TTL = 14 * 86400e3, MAX = 1500;

  const KEY_OFF = '__off__';
  const key = () => {
    let k = '';
    try { k = String(GM_getValue(GM_KEY, '') || '').trim(); } catch (_) {}
    if (k === KEY_OFF) return '';
    return k || String(MY_DEEPL_KEY || '').trim();
  };

  const target = () => 'OFF';
  const setTarget = (v) => { try { localStorage.setItem(TARGET_KEY, v); } catch (_) {} };

  let dn = null;
  try { dn = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (_) {}
  const langName = (c) => {
    c = String(c || '').toUpperCase();
    if (!c) return 'unknown language';
    try { if (dn) return dn.of(c.toLowerCase()) || c; } catch (_) {}
    return c;
  };

  const SLANG = [
    [/\bfe?m?oids?\b/i, 'foid', 'derogatory word for a woman'],
    [/\b(go\s+)?rop(e|ed|ing)\b|\bkys\b|\bkill\s+yourself\b/i, 'rope / kys', 'telling someone to kill themselves (suicide)'],
    [/\b(go(ing)?\s+)?ER\b/, 'ER / go ER', 'glorifying a mass murderer — threat of violence'],
    [/\bldar\b/i, 'LDAR', '“lie down and rot” — giving up on life'],
    [/\bmog(s|ged|ger|ging)?\b/i, 'mog', 'to look much better than someone'],
    [/\bcop(e|ing|ium)\b/i, 'cope', 'denial / self-deception (often mocking)'],
    [/\bsub-?(human|[1-5])\b/i, 'subhuman', 'insult: extremely unattractive'],
    [/\bchad(lite)?s?\b/i, 'chad', 'very attractive man'],
    [/\b(stacy|stacies|becky|beckies)\b/i, 'stacy / becky', 'attractive / average woman'],
    [/\bnormies?\b/i, 'normie', 'average person'],
    [/\b(in|vol|gym|height|frame|wrist|eye|race)cels?\b/i, '…cel', 'celibate because of X (incel = involuntarily)'],
    [/\b(black|red|blue)\s?pill(ed)?\b/i, 'blackpill', 'belief that looks decide everything'],
    [/\b(soft|hard|looks)\s?max(x)?(ing|ed)?\b/i, 'looksmax', 'improving looks (soft = no surgery, hard = surgery)'],
    [/\bmew(ing)?\b/i, 'mewing', 'tongue posture for the jaw'],
    [/\bbone\s?smash(ing)?\b/i, 'bonesmashing', 'hitting your own face to change the bones (self-harm)'],
    [/\bpsl\b/i, 'PSL', 'looks rating scale'],
    [/\b[lmh]tn\b/i, 'LTN / MTN / HTN', 'low / mid / high tier normie (looks rating)'],
    [/\bascen(d|ded|sion)\b/i, 'ascend', 'to become (much) more attractive'],
    [/\bjfl\b/i, 'JFL', '“just f*cking laugh” — mocking'],
    [/\bngmi\b/i, 'NGMI', '“not gonna make it”'],
    [/\bit'?s\s+over\b/i, 'it’s over', 'hopeless, giving up'],
    [/\bcuck(ed|old)?s?\b/i, 'cuck', 'insult'],
    [/\bsimps?\b/i, 'simp', 'man who is overly devoted to a woman (insult)'],
    [/\btrann(y|ies)\b/i, 'tranny', 'slur against trans people'],
  ];
  function slang(...texts) {
    const t = texts.filter(Boolean).join('\n');
    const out = [];
    for (const [re, w, m] of SLANG) if (re.test(t)) out.push({ w, m });
    return out;
  }

  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const xmlUn = (s) => String(s).replace(/<n\s*\/>/g, '\n').replace(/<\/?x>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

  const SLANG_WRAP = new RegExp(SLANG.filter(([, w]) => w !== 'ER / go ER').map(([re]) => re.source).join('|'), 'gi');
  const protect = (s) => xmlEsc(s).replace(SLANG_WRAP, (m) => '<x>' + m + '</x>').replace(/\r?\n/g, '<n/>');

  const SW = {
    en: 'the and is you to of a in it that i for this my not with are have be on was what just like your me so but do he they'.split(' '),
    es: 'que de el la y en los las por para una un es no con se del lo como pero mi más muy está yo tu eres porque esto'.split(' '),
    de: 'und der die das ist nicht ich du ein eine zu mit auf es den sie wir auch was wie aber bin hast mein dass sich'.split(' '),
    fr: 'le la les et est pas je tu de des un une que qui en du pour sur ce il elle mais avec sont très suis'.split(' '),
    tr: 've bir bu da de için ne ben sen çok gibi var yok mi ama daha ile değil kadar neden olan benim'.split(' '),
    pt: 'que não de o a e é um uma para com os as mas eu você muito isso está mais meu'.split(' '),
    it: 'che di il la e è non un una per con sono ma io ti mi questo molto anche perché'.split(' '),
    pl: 'i w nie się na to że jest z do jak ale co tak mnie jestem jestes'.split(' '),
    nl: 'de het een en is niet ik je van dat op te met zijn maar wat'.split(' '),
  };
  const SWS = Object.fromEntries(Object.entries(SW).map(([k, v]) => [k, new Set(v)]));
  function guess(text) {
    const t = String(text || '');
    const letters = t.match(/\p{L}/gu) || [];
    if (letters.length < 8) return { lang: '?', foreign: false };
    const share = (re) => (t.match(re) || []).length / letters.length;
    if (share(/[Ѐ-ӿ]/g) > 0.25) return { lang: 'cyrillic', foreign: true };
    if (share(/[؀-ۿ֐-׿Ͱ-Ͽऀ-ॿ฀-๿぀-ヿ一-鿿가-힯]/g) > 0.25) {
      return { lang: 'other-script', foreign: true };
    }
    const words = t.toLowerCase().match(/\p{L}+/gu) || [];
    if (words.length < 4) return { lang: '?', foreign: false };
    let best = 'en', bestN = 0;
    const n = {};
    for (const [k, set] of Object.entries(SWS)) {
      let c = 0;
      for (const w of words) if (set.has(w)) c++;
      n[k] = c;
      if (c > bestN) { bestN = c; best = k; }
    }
    if (/[ñ¿¡]/.test(t)) n.es = (n.es || 0) + 2;
    if (/[ğşı]/i.test(t)) n.tr = (n.tr || 0) + 2;
    if (/ß/.test(t)) n.de = (n.de || 0) + 2;
    for (const k of Object.keys(n)) if (n[k] > bestN) { bestN = n[k]; best = k; }

    const foreign = best !== 'en' && bestN >= 2 && bestN >= (n.en || 0) * 1.3;
    return { lang: foreign ? best : 'en', foreign, en: n.en || 0, words: words.length };
  }

  function gm(opts, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const fin = (f, v) => { if (!done) { done = true; clearTimeout(wd); f(v); } };
      const wd = setTimeout(() => fin(reject, new Error('no answer')), ms || 15000);
      try {
        GM_xmlhttpRequest(Object.assign({}, opts, {
          timeout: ms || 15000,
          onload: (r) => fin(resolve, { status: r.status, text: r.responseText || '' }),
          onerror: () => fin(reject, new Error('not reachable')),
          ontimeout: () => fin(reject, new Error('no answer')),
        }));
      } catch (e) { fin(reject, e); }
    });
  }

  let hostPick = '';
  const deeplHost = (k) => hostPick || (/:fx$/i.test(k) ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
  const otherHost = (h) => /api-free/.test(h) ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
  let deeplDownUntil = 0, deeplWhy = '';
  async function viaDeepl(texts, tgt) {
    const k = key();
    const call = (host) => gm({
      method: 'POST', url: host + '/v2/translate',
      headers: { 'Authorization': 'DeepL-Auth-Key ' + k, 'Content-Type': 'application/json' },
      data: JSON.stringify({ text: texts.map(protect), target_lang: tgt === 'EN' ? 'EN-US' : tgt, tag_handling: 'xml', ignore_tags: ['x'] }),
    }, 20000);
    const host = deeplHost(k);
    let r = await call(host);
    if ((r.status === 403 || r.status === 401) && !hostPick) {
      const alt = otherHost(host);
      const r2 = await call(alt).catch(() => null);
      if (r2 && r2.status !== 403 && r2.status !== 401) { r = r2; hostPick = alt; console.log('[TRANSLATE] DeepL key works on ' + alt); }
    }
    if (r.status === 456) throw new Error('DeepL free characters used up');
    if (r.status === 403 || r.status === 401) throw new Error('DeepL key not accepted');
    if (r.status === 429) throw new Error('DeepL busy');
    if (r.status !== 200) throw new Error('DeepL HTTP ' + r.status);
    const j = JSON.parse(r.text);
    if (!j || !Array.isArray(j.translations) || j.translations.length !== texts.length) throw new Error('DeepL: unexpected answer');
    return j.translations.map((x) => ({ text: xmlUn(x.text || ''), src: String(x.detected_source_language || '').toUpperCase().slice(0, 2), via: 'DeepL' }));
  }
  async function viaGoogle(text, tgt) {
    const r = await gm({
      method: 'GET',
      url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + tgt.toLowerCase() + '&dt=t&q=' + encodeURIComponent(text),
    }, 15000);
    if (r.status !== 200) throw new Error('Google HTTP ' + r.status);
    const j = JSON.parse(r.text);
    const out = (Array.isArray(j && j[0]) ? j[0] : []).map((seg) => (seg && typeof seg[0] === 'string' ? seg[0] : '')).join('');
    if (!out) throw new Error('Google: empty answer');
    return { text: out, src: String((j && j[2]) || '').toUpperCase().split('-')[0].slice(0, 2), via: 'Google' };
  }

  let cache = null, cacheTimer = 0;
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return s.length + ':' + h; };
  const loadCache = () => {
    if (cache) return cache;
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (_) { cache = {}; }
    const now = Date.now();
    for (const k of Object.keys(cache)) if (!cache[k] || now - cache[k].t > TTL) delete cache[k];
    return cache;
  };
  const saveCacheSoon = () => {
    if (cacheTimer) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = 0;
      const c = loadCache();
      const keys = Object.keys(c);
      if (keys.length > MAX) keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - MAX).forEach((k) => delete c[k]);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (_) {}
    }, 800);
  };

  let gActive = 0;
  const gWait = [];
  const gSlot = async (fn) => {
    if (gActive >= 2) await new Promise((r) => gWait.push(r));
    gActive++;
    try { return await fn(); } finally { gActive--; const n = gWait.shift(); if (n) n(); }
  };

  const onReports = () => /^\/reports(\/|$)/.test(location.pathname);
  async function translate(texts, tgt) {
    if (!onReports()) return texts.map(() => null);
    tgt = tgt === 'EN' ? 'EN' : 'DE';
    const c = loadCache();
    const out = texts.map((t) => { const e = c[tgt + '|' + hash(t)]; return e ? { text: e.x, src: e.s, via: e.v, cached: true } : null; });
    const todo = texts.map((t, i) => i).filter((i) => !out[i] && String(texts[i] || '').trim());
    let lastErr = '';
    if (todo.length && key() && Date.now() > deeplDownUntil) {
      try {
        const res = await viaDeepl(todo.map((i) => texts[i]), tgt);
        todo.forEach((i, n) => { out[i] = res[n]; });
        deeplWhy = '';
      } catch (e) {
        lastErr = e.message;
        deeplWhy = e.message;

        deeplDownUntil = Date.now() + (/used up|key/i.test(e.message) ? 3600e3 : 120e3);
        console.warn('[TRANSLATE] ' + e.message + ' — using Google meanwhile');
      }
    }
    const rest = todo.filter((i) => !out[i]);
    await Promise.all(rest.map((i) => gSlot(async () => {
      try { out[i] = await viaGoogle(texts[i], tgt); }
      catch (e) { lastErr = e.message; out[i] = null; }
    })));
    let any = false;
    todo.forEach((i) => {
      if (!out[i]) return;
      any = true;
      c[tgt + '|' + hash(texts[i])] = { x: out[i].text, s: out[i].src, v: out[i].via, t: Date.now() };
    });
    if (todo.length) {
      saveCacheSoon();
      try { LMS.svc('translate', any || !lastErr, any ? '' : lastErr); } catch (_) {}
    }
    return out;
  }

  let usageAt = 0, usageVal = null;
  async function usage() {
    const k = key();
    if (!k || !onReports()) return null;
    if (Date.now() - usageAt < 600e3) return usageVal;
    usageAt = Date.now();
    try {
      const r = await gm({ method: 'GET', url: deeplHost(k) + '/v2/usage', headers: { 'Authorization': 'DeepL-Auth-Key ' + k } }, 10000);
      const j = r.status === 200 ? JSON.parse(r.text) : null;
      usageVal = j && Number.isFinite(j.character_count) ? { n: j.character_count, max: j.character_limit } : null;
    } catch (_) { usageVal = null; }
    return usageVal;
  }
  const service = () => key() ? (Date.now() < deeplDownUntil ? 'Google (DeepL: ' + deeplWhy + ')' : 'DeepL') : 'Google (no DeepL key)';

  if (window.self === window.top && typeof GM_registerMenuCommand === 'function') {
    try {
      GM_registerMenuCommand('Set DeepL key (translation)', () => {
        let v = null;
        try { v = window.prompt('Your free DeepL API key (ends in ":fx"). Empty = Google without key:', key()); } catch (_) {}
        if (v === null || v === undefined) return;
        try { GM_setValue(GM_KEY, String(v).trim() || KEY_OFF); } catch (_) {}
        deeplDownUntil = 0;
        hostPick = '';
        alert(String(v).trim() ? 'DeepL key saved — reload the Report Center.' : 'No key — Google is used.');
      });
    } catch (_) {}
  }
  return { translate, guess, slang, langName, target, setTarget, hasKey: () => !!key(), usage, service };
})();

async function moduleQueue() {
  "use strict";

  const IS_TOP = window.self === window.top;
  const KEY_PROXYCHECK = "proxycheckApiKey";
  const KEY_SERVER = "serverApiKey";

  const KEY_OFF = "__off__";
  function _keyOff(name) {
    try { return String(GM_getValue(name, "") || "").trim() === KEY_OFF; }
    catch (_) { return false; }
  }
  function _readKey(name) {
    try {
      const v = String(GM_getValue(name, "") || "").trim();
      return v === KEY_OFF ? "" : v;
    } catch (_) { return ""; }
  }
  function _askKey(name, label, allowOff) {
    if (!IS_TOP) return _readKey(name);
    let v = null;
    try {
      v = window.prompt("Enter " + label +
        " (stored only locally in the userscript manager):",
        _readKey(name));
    } catch (_) {}
    if (v === null || v === undefined) return _readKey(name);
    v = String(v).trim();
    try { GM_setValue(name, v || (allowOff ? KEY_OFF : "")); } catch (_) {}
    return v;
  }

  const KEY_ZG_TIMEOUT = "zgTimeoutSec";
  function _zgWatchdogMs() {
    try {
      const v = parseInt(GM_getValue(KEY_ZG_TIMEOUT, ""), 10);
      if (Number.isFinite(v) && v >= 2 && v <= 60) return v * 1000;
    } catch (_) {}
    return (typeof window !== "undefined" && +window.__ZG_WATCHDOG_MS__) || 8000;
  }

  const MY_ZEROGPT_KEY = "d378c830-a488-4bfe-8a6c-a7f61df4ae2d";

  const KEY_OWN_ZEROGPT = "ownZeroGptKey";
  let OWN_ZEROGPT_KEY = _keyOff(KEY_OWN_ZEROGPT) ? "" : (_readKey(KEY_OWN_ZEROGPT) || MY_ZEROGPT_KEY.trim());

  const MY_SAPLING_KEY = "APLB03XE5WZLGMNKCE1N1TR06HNRN8PQ";

  const KEY_SAPLING = "saplingApiKey";
  let SAPLING_KEY = _keyOff(KEY_SAPLING) ? "" : (_readKey(KEY_SAPLING) || MY_SAPLING_KEY.trim());
  const _aiName = () => (SAPLING_KEY ? "Sapling" : "ZeroGPT");

  let API_KEY = _readKey(KEY_PROXYCHECK) || "c4c219-6932x0-313224-7300nm";
  let ZEROGPT_API_KEY = _readKey(KEY_SERVER) ||
    "f2044d346b70cb73b339d9e597c01cf7d0b09e7bb6aa400cf1d6f7a9731cba27";

  const DUAL_KEY = "__lmqDualView";
  let _dualBusy = null;
  const _dualIds = new Set();
  const _dualSrc = new Map();
  function _dualOn() {
    try { return localStorage.getItem(DUAL_KEY) !== "off"; } catch (_) { return true; }
  }

  if (IS_TOP) {
    try {
      GM_registerMenuCommand(_dualOn()
        ? "Both directions (100 at once): ON — turn off"
        : "Both directions (100 at once): OFF — turn on", () => {
        try { localStorage.setItem(DUAL_KEY, _dualOn() ? "off" : "on"); } catch (_) {}
        location.reload();
      });
      GM_registerMenuCommand("Change proxycheck key", () => {
        API_KEY = _askKey(KEY_PROXYCHECK, "proxycheck.io API key");
        location.reload();
      });
      GM_registerMenuCommand("Set Sapling key (AI check)", () => {
        SAPLING_KEY = _askKey(KEY_SAPLING, "your Sapling API key (empty = ZeroGPT again)", true);
        location.reload();
      });
      GM_registerMenuCommand("Set own ZeroGPT key", () => {
        OWN_ZEROGPT_KEY = _askKey(KEY_OWN_ZEROGPT,
          "your ZeroGPT API key (empty = use the external server again)", true);
        location.reload();
      });
      GM_registerMenuCommand("AI check timeout (sec.)", () => {
        let cur = "8";
        try { cur = String(GM_getValue(KEY_ZG_TIMEOUT, "") || "8"); } catch (_) {}
        let v = null;
        try {
          v = window.prompt(
            "AI check timeout in seconds (2-60).\n" +
            "Smaller = faster, but more \"manual\" when the AI check is slow.\n" +
            "Larger = more automation, but slower. Default 8:", cur);
        } catch (_) {}
        if (v === null || v === undefined) return;
        const n = parseInt(String(v).trim(), 10);
        if (!Number.isFinite(n) || n < 2 || n > 60) { alert("Please enter a number between 2 and 60."); return; }
        try { GM_setValue(KEY_ZG_TIMEOUT, String(n)); } catch (_) {}
        alert("AI check timeout = " + n + " s. Applies immediately, no reload needed.");
      });
      GM_registerMenuCommand("AI check self-test", () => {
        const t0 = Date.now();
        const sample = "I want to improve my looks and skin and learn from the people on this forum.";
        const call = SAPLING_KEY ? _spRequest([sample]).then((p) => ({ percentage: p[0] }))
          : OWN_ZEROGPT_KEY ? _zgDirectOnce(sample) : _zgCheckRaw(sample);
        Promise.resolve(call).then(
          (r) => alert(_aiName() + " OK after " + ((Date.now() - t0) / 1000).toFixed(1) +
            "s — score " + (r && r.percentage) + "%" +
            (SAPLING_KEY ? "\n" + _spUsageText() : " (key: " + (OWN_ZEROGPT_KEY ? "own" : "none") + ")")),
          (e) => alert(_aiName() + " ERROR after " + ((Date.now() - t0) / 1000).toFixed(1) +
            "s:\n" + (e && e.message) + "\n(watchdog = no answer / hanging)"),
        );
      });
    } catch (_) {}
  }

  const ALT_GENDER_CHECK = false;
  const SCRIPT_VERSION = LM_VERSIONS.queue;

  const LM_MAX_CONCURRENT = 10;
  let _lmActive = 0;
  const _lmQueue = [];

  function _isSameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; }
    catch (_) { return false; }
  }

  function _lmFetch(opts, timeoutMs) {
    return new Promise((resolve) => {
      let timedOut = false;
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (ctrl) ctrl.abort(); } catch (_) {}
        resolve({ kind: "timeout" });
      }, timeoutMs);
      let p;
      try {
        p = fetch(opts.url, {
          method: opts.method || "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: opts.headers || undefined,
          body: opts.data || undefined,
          signal: ctrl ? ctrl.signal : undefined,
        });
      } catch (e) {
        clearTimeout(timer);
        return resolve({ kind: "error", error: e });
      }
      p.then((r) => r.text().then((text) => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve({ kind: "load", res: { status: r.status, responseText: text, finalUrl: r.url } });
      })).catch((e) => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve({ kind: "error", error: e });
      });
    });
  }

  function _lmGm(opts, timeoutMs) {
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest(Object.assign({}, opts, {
          timeout: timeoutMs,
          onload: (res) => resolve({ kind: "load", res: res }),
          onerror: (e) => resolve({ kind: "error", error: e }),
          ontimeout: () => resolve({ kind: "timeout" }),
          onabort: (e) => resolve({ kind: "error", error: e }),
        }));
      } catch (e) {
        resolve({ kind: "error", error: e });
      }
    });
  }

  function _lmRequest(opts) {
    const run = async () => {
      _lmActive++;
      const timeoutMs = opts.timeout || 15000;
      let out;
      try {
        if (_isSameOrigin(opts.url) && typeof fetch === "function") {
          out = await _lmFetch(opts, timeoutMs);
          const st = out.kind === "load" ? out.res.status : 0;
          if (out.kind === "error" || st === 401 || st === 403) {
            const alt = await _lmGm(opts, timeoutMs);
            if (alt.kind === "load" && alt.res.status === 200) out = alt;
          }
        } else {
          out = await _lmGm(opts, timeoutMs);
        }
      } catch (e) {
        out = { kind: "error", error: e };
      }
      _lmActive--;
      if (_lmQueue.length) _lmQueue.shift()();
      try {
        if (out.kind === "load") { if (opts.onload) opts.onload(out.res); }
        else if (out.kind === "timeout") {
          (opts.ontimeout || opts.onerror || function () {})();
        } else if (opts.onerror) opts.onerror(out.error);
      } catch (e) {
        console.error("[LM] callback error:", e);
      }
    };
    if (_lmActive < LM_MAX_CONCURRENT) run();
    else _lmQueue.push(run);
  }

  const ipCache = {};

  class TtlMap extends Map {
    constructor(ms) { super(); this.ms = ms; this._n = 0; }

    set(k, v) {
      if (++this._n % 40 === 0) this.sweep();
      return super.set(k, { v: v, t: Date.now() });
    }
    sweep() {
      const now = Date.now();
      for (const [k, e] of super.entries()) if (!e || now - e.t > this.ms) super.delete(k);
    }

    has(k) {
      const e = super.get(k);
      if (!e) return false;
      if (Date.now() - e.t > this.ms) { super.delete(k); return false; }
      return true;
    }
    get(k) { const e = super.get(k); return e ? e.v : undefined; }
  }
  const CACHE_TTL_MS = 45000;

  const _touchedIds = new Set();
  function _idOfUrl(u) {
    const m = String(u || "").match(/\.(\d+)\/?(?:[?#].*)?$/) ||
      String(u || "").match(/\/members\/(\d+)\/?(?:[?#].*)?$/);
    return m ? m[1] : null;
  }
  const genderCache = new TtlMap(CACHE_TTL_MS);
  const userStateCache = new TtlMap(CACHE_TTL_MS);
  const filters = [
    "NORMAL",
    "FEMALE",
    "TOO SHORT",
    "OTHER ALT",
    "APPROVED ALT",
    "VPN",
  ];
  const activeFilters = new Set();

  let _timeFilter = "";
  const _filtersOn = () => activeFilters.size > 0 || !!_timeFilter;
  const messagesMap = new Map();
  window.__highlightMessageMap = messagesMap;

  const QUEUE_SORT_KEY = "__xfQueueSortUrl";
  const QUEUE_RESUME_KEY = "__xfQueueResume";
  const QUEUE_ASC_URL = "/approval-queue/?content_type=user";
  const QUEUE_DESC_URL =
    "/approval-queue/?content_type=user&order=content_date&direction=desc";

  const DUAL_FETCH_MS = 8000;

  const _dual = { state: "", own: 0, other: 0, err: "" };
  let _pageEpoch = 0;
  let _dualPrefetch = null;
  function _dualOtherUrls() {
    if (!_isQueuePage() || !_dualOn()) return [];
    let sp;
    try { sp = new URLSearchParams(location.search); } catch (_) { return []; }

    const ct = sp.get("content_type") || "";
    if (ct && ct !== "user") return [];

    if (!ct) return [QUEUE_ASC_URL, QUEUE_DESC_URL];
    return [/^desc$/i.test(sp.get("direction") || "") ? QUEUE_ASC_URL : QUEUE_DESC_URL];
  }
  function _dualOtherUrl() { return _dualOtherUrls()[0] || null; }
  function _queueDocOk(doc) {
    if (!doc || !doc.documentElement) return false;
    const root = doc.documentElement;
    if (root.getAttribute("data-logged-in") === "false") return false;
    if (/^(login|error|no_permission|login_form)$/i.test(root.getAttribute("data-template") || "")) return false;
    return !!(doc.querySelector('input[name^="queue["]') || doc.querySelector(".block-body, .blockMessage"));
  }
  async function _fetchQueueDoc(url, why) {
    try {
      const r = await _xfGet(new URL(url, location.origin).href);
      if (r.status !== 200) { if (why) why.err = "HTTP " + r.status; return null; }
      const doc = new DOMParser().parseFromString(r.text, "text/html");
      if (_queueDocOk(doc)) return doc;
      if (why) {
        why.err = doc.documentElement && doc.documentElement.getAttribute("data-logged-in") === "false"
          ? "not logged in" : "no queue on that page";
      }
      return null;
    } catch (e) {
      if (why) why.err = e && e.name === "AbortError" ? "timeout" : "network";
      return null;
    }
  }

  function _dualFetch(url) {
    return (async () => {
      const why = {};
      let doc = await _fetchQueueDoc(url, why);
      if (!doc && why.err !== "not logged in") {
        await _sleep(800);
        doc = await _fetchQueueDoc(url, why);
      }
      return { doc: doc, err: doc ? "" : (why.err || "not loaded") };
    })();
  }
  function _rowIdOf(m) {
    return _userIdFromRadio(m.querySelector('input[type="radio"][name^="queue[user]["]'));
  }

  function _queueRows(root) {
    return [...root.querySelectorAll(".message")].filter((m) =>
      !(m.parentElement && m.parentElement.closest(".message")) &&
      !!m.querySelector('input[type="radio"][name^="queue["]'));
  }

  const _NON_APP_ATTR = [/Verification badge request/i, /^Post$/i, /^Thread$/i, /Username Change/i];
  function _isForeignRow(m) {
    if (!m || !m.querySelector) return false;
    if (m.dataset && m.dataset.lmqForeign) return true;
    const anyQ = m.querySelector('input[type="radio"][name^="queue["]');
    if (!anyQ) return false;
    const usr = m.querySelector('input[type="radio"][name^="queue[user]["]');
    if (!usr) return true;
    const at = m.querySelector(".message-attribution-opposite");
    const type = at ? (at.textContent || "").trim() : "";
    return !!type && _NON_APP_ATTR.some((re) => re.test(type));
  }
  function _inForeignRow(el) {
    const m = el && el.closest ? el.closest(".message") : null;
    return !!(m && _isForeignRow(m));
  }
  function _isBanAppealRow(m) {
    try {
      return [...m.querySelectorAll("a")].some((a) =>
        /^\s*ban[\s-]*appeals?\s*$/i.test(a.textContent || "") ||
        /\/forums\/[^/?#]*ban[-_]?appeal/i.test(a.getAttribute("href") || ""));
    } catch (_) { return false; }
  }

  const FOREIGN_KINDS = [
    ["APPEALS", "BAN APPEALS", "Ban appeal"],
    ["POSTS", "POSTS", "Post"],
    ["THREADS", "THREADS", "Thread"],
    ["NAMES", "NAME CHANGES", "Name change"],
    ["BADGES", "BADGES", "Badge request"],
    ["SPAM", "SPAM HITS", "Spam phrase"],
    ["OTHER", "OTHER", "Not an application"],
  ];
  function _foreignType(m) {
    const at = m.querySelector(".message-attribution-opposite");
    return at ? (at.textContent || "").replace(/\s+/g, " ").trim() : "";
  }
  function _foreignForum(m) {
    try {
      const links = [...m.querySelectorAll('a[href*="/forums/"]')];
      const a = links[links.length - 1];
      return a ? (a.textContent || "").replace(/\s+/g, " ").trim() : "";
    } catch (_) { return ""; }
  }
  function _foreignKinds(m) {
    if (m.dataset && m.dataset.lmqKinds) return m.dataset.lmqKinds.split(",");
    const type = _foreignType(m);
    const radio = _foreignKey(m);
    const ct = (radio.match(/^queue\[([^\]]+)\]/) || [])[1] || "";
    let main;
    if (_isBanAppealRow(m)) main = "APPEALS";
    else if (/user\s*name\s*change|name\s*change/i.test(type) || /username|name_change/i.test(ct)) main = "NAMES";
    else if (/verification|badge/i.test(type) || /badge|verif/i.test(ct)) main = "BADGES";
    else if (/^thread\b/i.test(type) || ct === "thread") main = "THREADS";
    else if (/^post\b/i.test(type) || ct === "post") main = "POSTS";
    else main = "OTHER";
    const out = [main];
    try { if (/spam phrase matched/i.test(m.textContent || "")) out.push("SPAM"); } catch (_) {}
    if (m.dataset) m.dataset.lmqKinds = out.join(",");
    return out;
  }

  function _foreignWhat(m) {
    const k = _foreignKinds(m);
    const def = FOREIGN_KINDS.find((x) => x[0] === k[0]);
    let what = def ? def[2] : "Not an application";
    if (k[0] === "POSTS" || k[0] === "THREADS") { const f = _foreignForum(m); if (f) what += " in " + f; }
    if (k[0] === "OTHER") { const t = _foreignType(m).split(",")[0]; if (t && t.length < 40) what = t; }
    if (k.includes("SPAM")) what += " · spam phrase";
    return what;
  }

  function _foreignKey(row) {
    const r = row.querySelector('input[type="radio"][name^="queue["]');
    return r ? r.name : "";
  }

  function _foreignPicked(row) {
    let cur = null, def = null;
    row.querySelectorAll('input[type="radio"][name^="queue["]').forEach((r) => {
      if (r.checked) cur = r;
      if (r.defaultChecked) def = r;
    });
    if (!cur) return false;
    return def ? cur !== def : cur.value !== "";
  }
  function _foreignChoiceText(row) {
    const r = row.querySelector('input[type="radio"][name^="queue["]:checked');
    if (!r) return "";
    const l = r.closest("label") || (r.id && row.querySelector('label[for="' + r.id + '"]'));
    const t = l ? (l.textContent || "").replace(/\s+/g, " ").trim() : "";
    return t || r.value || "";
  }

  let _fScan = null;
  function _foreignCacheReset() { _fScan = null; }
  function _foreignScan() {
    const now = Date.now();
    if (_fScan && now - _fScan.t < 400 && _fScan.rows.every((m) => m.isConnected)) return _fScan;
    const rows = _queueRows(document).filter(_isForeignRow);
    const picked = rows.filter(_foreignPicked);
    _fScan = {
      t: now, rows: rows, picked: picked,
      appeals: rows.filter(_isBanAppealRow).length,
      pickedAppeals: picked.filter(_isBanAppealRow).length,
      kinds: {},
    };
    rows.forEach((m) => _foreignKinds(m).forEach((k) => { _fScan.kinds[k] = (_fScan.kinds[k] || 0) + 1; }));
    return _fScan;
  }
  function _foreignPending() { return _foreignScan().picked; }

  function _foreignLeftText() {
    const fs = _foreignScan(), n = fs.rows.length, a = fs.appeals;
    if (!n) return "";
    if (a === n) return a + " ban appeal" + (a === 1 ? "" : "s");
    return n + " item" + (n === 1 ? "" : "s") + (a ? " (" + a + " ban appeal" + (a === 1 ? "" : "s") + ")" : "");
  }

  const _Q_FIELD = /^(queue|reason|notify)\[/;
  function _foreignNames() {
    const out = new Set();
    _queueRows(document).filter(_isForeignRow).forEach((m) => {
      m.querySelectorAll("[name]").forEach((el) => { if (el.name && _Q_FIELD.test(el.name)) out.add(el.name); });
    });
    return out;
  }

  function _withForeignOff(fn) {
    const els = [];
    try {
      _queueRows(document).filter(_isForeignRow).forEach((m) => {
        m.querySelectorAll("input[name], select[name], textarea[name]").forEach((el) => {
          if (!el.disabled && _Q_FIELD.test(el.name)) { el.disabled = true; els.push(el); }
        });
      });
    } catch (_) {}
    try { return fn(); }
    finally {
      if (els.length) setTimeout(() => els.forEach((el) => { el.disabled = false; }), 1500);
    }
  }

  function _foreignNote(row) {
    try {
      let note = row.querySelector(".lmq-hands");
      if (!note) {
        note = _el("div", "lmq-hands");
        note.append(_el("b"), _el("span"));
        const cell = row.querySelector(".message-cell--user") || row.querySelector(".message-cell--main") || row;
        cell.appendChild(note);
      }
      const appeal = _isBanAppealRow(row);
      const mine = _foreignPicked(row);
      const what = _foreignWhat(row);
      note.dataset.k = _foreignKinds(row)[0].toLowerCase();
      const b = note.firstChild, s = note.lastChild;
      if (mine) {
        note.dataset.s = "mine";
        _setTxtSafe(b, "Your choice: " + (_foreignChoiceText(row) || "picked"));
        _setTxtSafe(s, "Only sent when you tap “" + (appeal ? "Save appeal" : "Save choice") +
          "” in the bar below — the suite never sends it by itself.");
      } else {
        delete note.dataset.s;
        _setTxtSafe(b, what + " · hands off");
        const age = _ageText(_rowTime(row));
        const verb = /^(names|badges)$/.test(note.dataset.k) ? "Requested " : "Posted ";
        _setTxtSafe(s, (age ? verb + age + " · " : "") + "the suite never touches this — decide it yourself or leave it.");
      }
    } catch (_) {}
  }
  function _setTxtSafe(el, v) { if (el && el.textContent !== v) el.textContent = v; }

  function _rowTime(m) {
    if (!m || !m.dataset) return 0;
    if (m.dataset.lmqT) return +m.dataset.lmqT;
    const t = m.querySelector('.message-attribution time, .message-attribution-main time') || m.querySelector('time');
    let ms = 0;
    if (t) {
      const n = +(t.getAttribute('data-time') || t.getAttribute('data-timestamp') || 0);
      if (n > 0) ms = n * 1000;
      else {
        const iso = String(t.getAttribute('datetime') || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
        const p = iso ? Date.parse(iso) : NaN;
        if (Number.isFinite(p)) ms = p;
      }
    }
    if (ms) m.dataset.lmqT = String(ms);
    return ms;
  }

  function _timeBucket(ms) {
    if (!ms) return "";
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const t0 = d.getTime();
    if (ms >= t0) return "today";
    if (ms >= t0 - 86400e3) return "yesterday";
    if (ms >= t0 - 7 * 86400e3) return "week";
    return "older";
  }

  function _chipInView(a) {
    try {
      const row = a && a.closest('.xfcf');
      if (!row) return;
      requestAnimationFrame(() => {
        const r = a.getBoundingClientRect(), rr = row.getBoundingClientRect();
        if (r.left < rr.left) row.scrollLeft -= rr.left - r.left + 10;
        else if (r.right > rr.right) row.scrollLeft += r.right - rr.right + 10;
      });
    } catch (_) {}
  }
  function _ageText(ms) {
    if (!ms) return "";

    const d0 = new Date(ms); d0.setHours(0, 0, 0, 0);
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const days = Math.round((t0.getTime() - d0.getTime()) / 86400e3);
    const b = _timeBucket(ms);
    return b === "today" ? "today" : b === "yesterday" ? "yesterday" : days + " days ago";
  }
  function _markForeign(row) {
    if (!row || !row.dataset) return;
    if (!row.dataset.lmqForeign) {
      row.dataset.lmqForeign = _isBanAppealRow(row) ? "appeal" : "1";
      try { messagesMap.delete(row); } catch (_) {}
      _foreignCacheReset();
    }
    _foreignNote(row);
  }

  function _foreignTouched(row) {
    _markForeign(row);
    _foreignNote(row);
    _foreignCacheReset();
    try { _dock.sig = ""; _dockRender(); } catch (_) {}
  }

  let _awaitingReload = false;
  function _foreignHoldsReload(what) {
    const sc = _foreignScan();
    if (!sc.picked.length) return false;
    _awaitingReload = true;
    const n = sc.picked.length;
    const one = sc.pickedAppeals === n ? (n === 1 ? "ban appeal" : "ban appeals") : (n === 1 ? "choice" : "choices");
    _dockMsg("Your " + one + " " + (n === 1 ? "is" : "are") + " waiting — tap “Save " +
      (sc.pickedAppeals === n ? "appeal" : "choice") + "” or set " + (n === 1 ? "it" : "them") +
      " back to Do nothing. " + what + " after that.", "info");
    return true;
  }
  function _reloadWhenFree(fn, what) {
    if (!_foreignHoldsReload(what)) { fn(); return; }
    const iv = setInterval(() => {
      if (_foreignSaving) return;
      _foreignCacheReset();
      if (_foreignHoldsReload(what)) return;
      clearInterval(iv);
      fn();
    }, 2000);
  }

  let _foreignSaving = false;
  let _foreignWaiting = false;
  async function _foreignSave() {
    if (_foreignSaving) return;
    if (!_foreignPending().length) return;
    if (!_tabActive()) { _dockMsg("The queue is open in another tab — save it there.", "info"); return; }
    const form = _queueForm();
    if (!form) { _dockMsg("Form not found — use the forum's Save button.", "info"); return; }
    _foreignSaving = true;
    _dock.sig = "";
    _dockRender();
    let held = false;
    try {
      const t0 = Date.now();

      while (_saveInFlight && Date.now() - t0 < 5 * 60 * 1000) {
        if (!_foreignWaiting) { _foreignWaiting = true; _dock.sig = ""; _dockRender(); }
        await _sleep(400);
      }
      _foreignWaiting = false;
      if (_saveInFlight) throw new Error("the queue is still saving — tap again in a moment");
      _saveInFlight = true;
      held = true;
      _foreignCacheReset();
      const rows = _foreignPending();
      if (!rows.length) return;
      const names = new Set();
      const keys = [];
      rows.forEach((r) => {
        r.querySelectorAll("[name]").forEach((el) => { if (el.name) names.add(el.name); });
        const k = _foreignKey(r);
        if (k) keys.push(k);
      });
      const fd = new FormData(form);
      const p = new URLSearchParams();
      let mine = 0;
      for (const [k, v] of fd.entries()) {
        if (typeof v !== "string") continue;
        if (/^(queue|reason|notify)\[/.test(k)) {
          if (!names.has(k)) continue;
          mine++;
        }
        p.append(k, v);
      }
      if (!mine) throw new Error("your choice is not in the form");
      _dockMsg("Saving your " + (rows.length === 1 ? "choice" : rows.length + " choices") + " …", "saving");
      console.log("[APPEAL] saving your choice on " + keys.join(", ") + " (only these fields)");
      const actionUrl = new URL(form.getAttribute("action") || location.href, location.href).href;
      const res = await _xfPost(actionUrl, p);
      const out = _xfResult(res);
      if (out.status === "failed") throw new Error(out.error || "the forum refused it");
      const gone = await _foreignWaitGone(keys, _jobIdsFrom(res.json));
      if (gone.left.length) {
        _dockMsg("Sent — the forum still shows " + gone.left.length + " of them. Check again in a moment.", "info");
        console.warn("[APPEAL] still in the queue after the forum's job: " + gone.left.join(", "));
      } else {
        rows.forEach((r) => { try { r.remove(); } catch (_) {} });
        _dockMsg((rows.length === 1 ? "Saved ✓ — your choice went through" : "Saved ✓ — " + rows.length + " choices went through"), "info");
        console.log("[APPEAL] saved ✓");
        setTimeout(() => { if (/^Saved ✓ — /.test(_dock.msg)) _dockMsg("", ""); }, 3500);
      }
    } catch (e) {
      console.warn("[APPEAL] not saved:", e && e.message);
      _dockMsg("Not saved — " + ((e && e.message) || "error") + ". Your choice is still set.", "info");
    } finally {
      if (held) _saveInFlight = false;
      _foreignSaving = false;
      _foreignWaiting = false;
      _foreignCacheReset();
      _foreignScan().rows.forEach(_foreignNote);
      try { if (window.__updateFilterCounts) window.__updateFilterCounts(); } catch (_) {}
      _dock.sig = "";
      _dockRender();
      _maybeScheduleSave();
    }
  }

  async function _foreignWaitGone(keys, jobIds) {
    const start = Date.now();
    let left = keys.slice();
    while (Date.now() - start < 60000) {
      const jr = await _runJobOnce(jobIds && jobIds.length ? jobIds : null);
      if (jr.more === true) continue;
      const doc = await _fetchQueueDoc(location.href);
      if (doc) {
        _queueLeftFromDoc(doc, true);
        left = keys.filter((k) => !!doc.querySelector('input[name="' + k + '"]'));
        if (!left.length) break;
      }
      await _sleep(1200);
    }
    return { left: left };
  }

  function _fixForeignIds(row) {
    try {
      row.querySelectorAll("[id]").forEach((el) => {
        const old = el.id;
        if (!old || !document.getElementById(old)) return;
        const neu = old + "-lmq2";
        el.id = neu;
        row.querySelectorAll("[for]").forEach((x) => { if (x.getAttribute("for") === old) x.setAttribute("for", neu); });
        ["aria-labelledby", "aria-describedby", "aria-controls"].forEach((a) => {
          row.querySelectorAll("[" + a + "]").forEach((x) => {
            x.setAttribute(a, x.getAttribute(a).split(/\s+/).map((t) => (t === old ? neu : t)).join(" "));
          });
        });
        row.querySelectorAll("[href]").forEach((x) => { if (x.getAttribute("href") === "#" + old) x.setAttribute("href", "#" + neu); });
      });
    } catch (_) {}
  }

  function _dualAppend(doc, url) {
    const form = _queueForm();
    if (!form || !doc) return 0;
    const mine = _queueRows(document);
    const have = new Set(mine.map(_rowIdOf).filter(Boolean));
    const rows = _queueRows(doc).filter((m) => {
      const id = _rowIdOf(m);
      if (!id || have.has(id)) return false;
      have.add(id);
      return true;
    });
    if (!rows.length) return 0;
    let sep = document.querySelector(".lmq-dual-sep");
    if (!sep || !form.contains(sep)) {
      if (sep) sep.remove();
      sep = document.createElement("div");
      sep.className = "lmq-dual-sep";
      sep.style.cssText = "margin:14px 0 8px;padding:8px 12px;border:1px dashed rgba(224,205,158,.55);" +
        "border-radius:10px;color:#e0cd9e;background:rgba(224,205,158,.06);text-align:center;" +
        "font:700 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
      const lastOwn = mine.filter((m) => form.contains(m)).pop();
      if (lastOwn) lastOwn.parentNode.insertBefore(sep, lastOwn.nextSibling);
      else (form.querySelector(".block-body") || form).appendChild(sep);
    }
    let after = [...document.querySelectorAll(".message[data-lmq-dual]")]
      .filter((m) => form.contains(m)).pop() || sep;
    rows.forEach((m) => {
      const node = document.adoptNode(m);
      node.dataset.lmqSwapped = "1";
      node.dataset.lmqDual = "1";
      _fixForeignIds(node);
      after.parentNode.insertBefore(node, after.nextSibling);
      after = node;
      _syncDeps(node);
      const id = _rowIdOf(node);
      if (id) { _dualIds.add(id); _dualSrc.set(id, url || _dualOtherUrl()); }
    });
    const urls = _dualOtherUrls();
    sep.textContent = urls.length > 1
      ? "▼ More applications from both ends of the queue · " + _dualIds.size + " more"
      : "▼ From the other end of the queue (" + (urls[0] === QUEUE_DESC_URL ? "newest" : "oldest") +
        " first) · " + _dualIds.size + " more";
    return rows.length;
  }
  function _dualSetState(state, err) {
    _dual.state = state;
    _dual.err = err || "";
    _dual.own = _queueRows(document).filter((m) => !m.dataset.lmqDual && !_isForeignRow(m)).length;
    _dual.other = _dualIds.size;
    _dock.sig = "";
    _dockRender();
  }

  function _dualMerge(givenDocs) {
    if (_isPaused()) return Promise.resolve(0);
    if (!_tabActive()) return Promise.resolve(0);
    const urls = _dualOtherUrls();
    if (!urls.length) { _dualSetState(_dualOn() ? "none" : "off"); return Promise.resolve(0); }
    if (_dualBusy) return _dualBusy;
    const epoch = _pageEpoch;
    _dualSetState("loading");
    const run = (async () => {

      const pre = _dualPrefetch;
      _dualPrefetch = null;
      const jobs = urls.map((url) => {
        const given = givenDocs && givenDocs.get ? givenDocs.get(url) : null;
        if (given) return { url: url, p: Promise.resolve({ doc: given, err: "" }) };
        const pp = pre && pre.ps && Date.now() - pre.t < 15000 ? pre.ps.get(url) : null;
        return { url: url, p: pp || _dualFetch(url) };
      });
      const deadline = _sleep(DUAL_FETCH_MS).then(() => null);
      const results = await Promise.all(jobs.map((j) => Promise.race([j.p, deadline])));
      if (epoch !== _pageEpoch) return 0;
      let added = 0, loaded = 0;
      const errs = [];
      results.forEach((res, i) => {
        const url = jobs[i].url;
        if (!res) {

          errs.push("slow — added when it arrives");
          jobs[i].p.then((late) => {
            if (!late || !late.doc || epoch !== _pageEpoch || _saveInFlight || _dualBusy) return;
            const n = _dualAppend(late.doc, url);
            _dualSetState("on");
            console.log("[QUEUE] both ends (late): +" + n + " application(s)");
            if (n) _guardedHighlight();
          }).catch(() => {});
          return;
        }
        if (!res.doc) { errs.push(res.err); return; }
        loaded++;
        added += _dualAppend(res.doc, url);
      });
      if (!loaded) {
        console.log("[QUEUE] other end not loaded (" + errs.join(", ") + ") — this round with one view");
        _dualSetState("failed", errs[0] || "not loaded");
        return 0;
      }
      _dualSetState("on");
      console.log("[QUEUE] both ends: +" + added + " application(s) from " + loaded + " view(s)" +
        (added ? "" : " (all already on this page)") + (errs.length ? " · " + errs.join(", ") : ""));
      if (added) _guardedHighlight();
      return added;
    })().catch((e) => { console.warn("[QUEUE] both directions failed:", e); _dualSetState("failed", "script error"); return 0; })
      .finally(() => { _dualBusy = null; _maybeScheduleSave(); });
    _dualBusy = run;
    return run;
  }
  function _dualText() {
    if (!_dualOn()) return "off (script menu)";
    if (!_dualOtherUrl()) return "not on this view";
    if (_dual.state === "loading") return "loading the other end …";
    if (_dual.state === "failed") return "other end not loaded (" + _dual.err + ") — next round again";
    if (_dual.state === "on") return _dual.own + " + " + _dual.other + (_dual.other ? "" : " (queue small: all on this page)");
    return "—";
  }

  const TAB_LOCK_KEY = "__lmqActiveTab";
  const TAB_LOCK_STALE_MS = 6000;
  const TAB_ID = (() => {
    try {
      let id = sessionStorage.getItem("__lmqTabId");
      if (!id) {
        id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem("__lmqTabId", id);
      }
      return id;
    } catch (_) { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  })();
  let _tabWasActive = false;
  let _tabOutdated = false;

  const TAB_LOCK_FRESH_MS = 1500;
  let _tabLockOkAt = 0;
  function _tabLockRead() {
    try { return JSON.parse(localStorage.getItem(TAB_LOCK_KEY) || "null"); } catch (_) { return null; }
  }

  function _tabActive() {
    if (!IS_TOP || !_isQueuePage()) return true;
    if (_tabOutdated) return false;
    const now = Date.now();
    if (_tabWasActive && now - _tabLockOkAt < TAB_LOCK_FRESH_MS) return true;
    let cur = _tabLockRead();
    if (cur && cur.id !== TAB_ID) {
      if (now - cur.ts < TAB_LOCK_STALE_MS) return false;
      if (_tabWasActive) { _tabOutdated = true; return false; }
    }
    try { localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({ id: TAB_ID, ts: now })); }
    catch (_) { return true; }
    cur = _tabLockRead();
    const mine = !cur || cur.id === TAB_ID;
    if (mine) { _tabWasActive = true; _tabLockOkAt = now; }
    return mine;
  }
  function _tabWatch() {
    if (!IS_TOP || !_isQueuePage()) return;
    _tabActive();
    let shown = false;
    setInterval(() => {

      if (_dock.el && !_dock.el.isConnected) { _dock.sig = ""; _dockRender(); }
      const wasActive = _tabWasActive && !_tabOutdated;
      if (_tabActive()) {
        shown = false;
        if (!wasActive) {

          console.log("[QUEUE] taking over the queue in this tab — fresh reload");
          location.reload();
        }
        return;
      }
      if (_tabOutdated) {
        console.log("[QUEUE] another tab worked on the queue meanwhile — fresh reload");
        try { localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({ id: TAB_ID, ts: Date.now() })); } catch (_) {}
        location.reload();
        return;
      }
      if (!shown) {
        shown = true;
        console.log("[QUEUE] the queue is open in another tab — this tab waits");
        _dockMsg("Queue is open in another tab — this one waits and takes over by itself", "info");
      }
    }, 2000);
    window.addEventListener("pagehide", () => {
      try {
        const cur = _tabLockRead();
        if (cur && cur.id === TAB_ID) localStorage.removeItem(TAB_LOCK_KEY);
      } catch (_) {}
    });
  }

  function _isQueuePage() {
    return /^\/approval-queue\/?$/.test(location.pathname);
  }
  function _sortedSearchOf(url) {
    try { return new URL(url, location.origin).search || ""; }
    catch (_) { return ""; }
  }
  function _isSortedQueueView() {
    return /(?:^|[?&])(content_type|order|direction)=/.test(location.search || "");
  }
  function _rememberSortedView() {
    if (!_isQueuePage() || !_isSortedQueueView()) return;
    try {
      localStorage.setItem(QUEUE_SORT_KEY, location.pathname + location.search);
      localStorage.removeItem(QUEUE_RESUME_KEY);
    } catch (_) {}
  }

  function _markQueueResume() {
    try {
      if (_isSortedQueueView()) localStorage.setItem(QUEUE_RESUME_KEY, String(Date.now()));
      else localStorage.removeItem(QUEUE_RESUME_KEY);
    } catch (_) {}
  }
  function _resumeSortedView() {
    if (!_isQueuePage()) return;
    if (location.search) return;
    let resume = null;
    try {
      resume = localStorage.getItem(QUEUE_RESUME_KEY);
      if (resume) localStorage.removeItem(QUEUE_RESUME_KEY);
    } catch (_) { return; }
    if (!resume) return;

    const at = Number(resume);
    if (!(at > 1e12) || Date.now() - at > 3 * 60 * 1000) return;
    let target = null;
    try { target = localStorage.getItem(QUEUE_SORT_KEY); } catch (_) {}
    if (!target) return;
    console.log("[QUEUE] back to the sorted view: " + target);
    location.replace(target);
    return true;
  }

  _rememberSortedView();

  let _pausedAtStart = false;
  try { _pausedAtStart = sessionStorage.getItem("__lmqPause") === "paused"; } catch (_) {}
  if (!_resumeSortedView() && IS_TOP && _isQueuePage() && !_pausedAtStart) {
    try {
      const us = _dualOtherUrls();
      if (us.length) _dualPrefetch = { t: Date.now(), ps: new Map(us.map((u) => [u, _dualFetch(u)])) };
    } catch (_) {}
  }

  (function armQueueResume() {
    if (!_isQueuePage()) return;
    let armed = false, tries = 0;
    const attach = () => {
      const form = document.querySelector(
        'form.approvalQueue, form[action*="/approval-queue/process"]');
      if (!form) {
        if (++tries < 40) setTimeout(attach, 250);
        return;
      }
      if (armed) return;
      armed = true;
      const mark = () => { _markQueueResume(); };
      form.addEventListener("submit", mark, true);
      form.addEventListener("click", (e) => {
        const b = e.target && e.target.closest
          ? e.target.closest('button[type="submit"]') : null;
        if (b) mark();
      }, true);
      console.log("[QUEUE] return after save armed");
    };
    attach();
  })();

  const REJECTION_TEMPLATES = {
    ai:
      "Please submit a new application with original reasoning not generated " +
      "by AI tools.",
    notLm:
      "Your application does not relate to looksmaxing. Please submit a " +
      "new application with a relevant and appropriate reason.",
    troll:
      "We only accept serious applications. Please reapply with a " +
      "thoughtful and legitimate reason.",
    deleted:
      "You must wait three months after deleting your account before " +
      "signing up again. Please reapply once the waiting period has passed.",
    vpn:
      "Your application was rejected because it was submitted via a VPN or " +
      "proxy. Please reapply without using a VPN or proxy so we can verify " +
      "your IP address.",
    tooShort:
      "Your application was rejected because your response was too " +
      "short. Please reapply with more detailed and thoughtful answers.",

    duplicate:
      "You already have another account waiting for approval. Only one " +
      "account per person is allowed.",
  };

  const _reasonGuards = new Map();
  let _reasonGuardTimer = null;

  function _setNativeValue(el, value) {
    const tag = el.tagName.toLowerCase();
    const proto = tag === "textarea"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  let _ownInput = 0;
  function _ownClick(el) {
    _ownInput++;
    try { el.click(); } finally { _ownInput--; }
  }

  function _setRadio(radio) {
    if (!radio) return false;
    if (!radio.checked) {
      try { _ownClick(radio); } catch (_) {}
    }
    if (!radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event("input", { bubbles: true }));
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return !!radio.checked;
  }

  function _activateDependency(radio) {
    try {
      const parentLi = radio.closest("li");
      const dep = parentLi && parentLi.querySelector(".inputChoices-dependencies");
      if (dep) dep.classList.remove("is-disabled");
      const innerUl = dep && dep.querySelector(".inputChoices");
      if (innerUl) innerUl.classList.remove("is-disabled");
    } catch (_) {}
  }

  function _userIdFromRadio(radio) {
    const m = radio && radio.name ? radio.name.match(/\[(\d+)\]\s*$/) : null;
    return m ? m[1] : null;
  }

  function _userIdFromMessage(message) {
    const r = message.querySelector('input[type="radio"][name^="queue[user]["]');
    const id = _userIdFromRadio(r);
    if (id) return id;
    const a = message.querySelector("[data-user-id]");
    return a ? a.getAttribute("data-user-id") : null;
  }

  function _findReasonInput(message, uid) {
    if (uid) {
      const exact = message.querySelector('input[name="reason[user][' + uid + ']"]');
      if (exact) return exact;
    }
    return message.querySelector(
      'input[name^="reason["], textarea[name^="reason["]'
    );
  }

  function _assertReasonGuards() {
    _reasonGuards.forEach((g, k) => {
      try {
        const inp = g.input;
        if (!inp || !inp.isConnected) { _reasonGuards.delete(k); return; }
        if (inp.disabled || inp.readOnly) {
          inp.disabled = false;
          inp.readOnly = false;
          inp.classList.remove("is-disabled");
        }
        if (inp.value !== g.text && !g.userEdited) _setNativeValue(inp, g.text);
      } catch (_) {}
    });
  }

  const _guardListening = new WeakSet();
  function _registerReasonGuard(userId, input, text) {
    if (!input || !text) return;
    const key = String(userId || "unknown");
    const prev = _reasonGuards.get(key);
    if (!(prev && prev.input === input && prev.text === text)) {
      _reasonGuards.set(key, { input: input, text: text, userEdited: false });
    }
    if (!_guardListening.has(input)) {
      _guardListening.add(input);
      try {
        const mark = (e) => {
          if (!e.isTrusted) return;
          const g = _reasonGuards.get(key);
          if (g && g.input === input) g.userEdited = true;
        };
        input.addEventListener("input", mark);
        input.addEventListener("change", mark);
      } catch (_) {}
    }
    _assertReasonGuards();
    if (!_reasonGuardTimer) {
      _reasonGuardTimer = setInterval(_assertReasonGuards, 400);
    }
  }

  document.addEventListener("click", (e) => {
    try {
      const b = e.target && e.target.closest
        ? e.target.closest('.formSubmitRow-controls button[type="submit"]')
        : null;
      if (b) _stopReasonGuards();
    } catch (_) {}
  }, true);

  function _stopReasonGuards() {
    if (_reasonGuardTimer) { clearInterval(_reasonGuardTimer); _reasonGuardTimer = null; }
    _reasonGuards.clear();
  }

  function _gateBanner(text, details) {
    try {
      const el = _notice("xfSaveGateBanner", "err", "Not saved — please check");
      if (!el) return;
      _noticeBody(el, text + " Nothing was saved, so no decision gets lost. " +
        "Check the row and tap Save again.",
        details && details.length ? details.join("\n") : "", [
        { label: "Reload & retry", primary: true, run: () => { _saveStateSet(null); location.reload(); } },
      ]);
      _dockMsg("Not saved — tap for details", "hold");
      _autoRecover("Not saved");
    } catch (_) {}
  }

  function _autoRecover() { return false; }

  const BAN_CHECK_KEY = "__xfBanCheckList";
  function _banCheckLoad() {
    try { return JSON.parse(localStorage.getItem(BAN_CHECK_KEY) || "[]") || []; }
    catch (_) { return []; }
  }
  function _banCheckSave(list) {
    try { localStorage.setItem(BAN_CHECK_KEY, JSON.stringify(list.slice(-200))); }
    catch (_) {}
  }
  function _recordBanCheck(message, name, action, status, error) {
    try {
      const link = message.querySelector(".message-userDetails a.username, a.username");
      const url = link ? normalizeProfileUrl(link.getAttribute("href")) : null;
      const list = _banCheckLoad().filter((e) => e.url !== url);
      list.push({ name: name || "?", url: url, action: action, status: status,
        error: error || "", ts: Date.now() });
      _banCheckSave(list);
      _renderBanCheckPanel();
    } catch (_) {}
  }
  function _renderBanCheckPanel() {
    try {
      if (!_isQueuePage() || !IS_TOP || !document.body) return;

      if (_banCheckLoad().length) _banCheckSave([]);
      const list = _banCheckLoad();
      if (!list.length) {
        const old = document.getElementById("xfBanCheckPanel");
        if (old) old.remove();
        return;
      }
      const el = _notice("xfBanCheckPanel", "warn",
        list.length + " ban" + (list.length === 1 ? "" : "s") + " did not go through — check the profile");
      if (!el) return;
      el.appendChild(_el("div", "lmq-notice-b",
        "These applications stay in the queue. Banned? If not, ban manually."));
      const ul = _el("ul", "lmq-notice-list");
      list.slice().reverse().forEach((e) => {
        const li = _el("li");
        const a = _el("a", null, e.name);
        a.href = e.url || "#";
        a.target = "_blank";
        a.rel = "noopener";
        li.appendChild(a);
        const when = new Date(e.ts);
        li.appendChild(document.createTextNode(" — " + e.action + ", " +
          (e.status === "failed" ? "failed" : "unconfirmed") +
          (e.error ? " (" + e.error + ")" : "") + ", " +
          when.toLocaleDateString("en-GB") + " " +
          when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })));
        ul.appendChild(li);
      });
      el.appendChild(ul);
      const acts = _el("div", "lmq-notice-a");
      const clear = _el("button", "lmq-btn lmq-btn--sm", "Checked — clear list");
      clear.type = "button";
      clear.addEventListener("click", (ev) => {
        ev.preventDefault();
        _banCheckSave([]);
        _renderBanCheckPanel();
      });
      acts.appendChild(clear);
      el.appendChild(acts);
    } catch (_) {}
  }

  function _gateBannerClear() {
    try {

      const el = document.getElementById("xfSaveGateBanner");
      if (el) el.hidden = true;
      if (_dock.kind === "hold") _dockMsg("", "");
    } catch (_) {}
  }

  window.__xfForceSave = function () {
    const btn = document.querySelector(
      '.formSubmitRow-controls button[type="submit"]'
    );
    if (!btn) { console.warn("[FORCE-SAVE] no save button found"); return false; }
    console.log("[FORCE-SAVE] saving without gate");
    _stopReasonGuards();
    _withForeignOff(() => btn.click());
    return true;
  };

  let _modIdentityCache = null;
  function _modIdentity() {
    if (_modIdentityCache) return _modIdentityCache;
    let name = null;
    let id = null;
    try {
      const link = document.querySelector("a.p-navgroup-link--user") ||
        document.querySelector('a.p-navgroup-link--iconic[href="/account/"]') ||
        document.querySelector('a[href="/account/"]');
      if (link) {
        const t = link.querySelector(".p-navgroup-linkText");
        name = (t ? t.textContent : link.textContent || "").trim() || null;
        const av = link.querySelector("[data-user-id]");
        id = av ? av.getAttribute("data-user-id") : null;
      }
      if (!name) {
        const t = document.querySelector(".p-navgroup-linkText");
        if (t) name = (t.textContent || "").trim() || null;
      }
    } catch (_) {}
    _modIdentityCache = { name: name || "unknown", id: id || null };
    return _modIdentityCache;
  }

  function _statCategory(action, reasonKey, summary, extra) {
    if (extra && extra.category) return extra.category;
    if (action === "approve") return "approve";
    if (action === "reject") return reasonKey || "reject";
    if (action === "ban") return "female";
    if (action === "ban-alt") return "alt-approved";
    if (action === "ban-alt-generic") return "alt-banned-unapproved";
    if (action === "ban-female-alt") return "female-alt";
    if (action === "ban-deleted-not-waited") return "alt-deleted-not-waited";
    return action || "unknown";
  }

  const BULK_FLUSH_DELAY_MS = 700;
  const BULK_MAX_WAIT_MS = 4000;
  const BULK_MAX_BUFFER = 300;
  let _statsBuffer = [];
  let _markBuffer = [];
  let _bulkTimer = null;
  let _bulkInFlight = false;
  let _bulkFirstPendingAt = 0;

  const DEDUP_DOWN_KEY = "__xfDedupDownUntil";
  const DEDUP_FAILS_KEY = "__xfDedupFails";

  const DEDUP_STEPS = [30, 120, 360, 1440];

  const _serverOff = () => true;
  function _dedupServerDown() {
    if (_serverOff()) return true;
    try { return Number(localStorage.getItem(DEDUP_DOWN_KEY) || 0) > Date.now(); }
    catch (_) { return false; }
  }
  function _markDedupServerDown() {
    if (_serverOff()) return;
    if (_dedupServerDown()) return;
    let fails = 0;
    try { fails = Number(localStorage.getItem(DEDUP_FAILS_KEY) || 0) + 1; } catch (_) {}
    const min = DEDUP_STEPS[Math.min(fails, DEDUP_STEPS.length) - 1];
    const wait = min >= 60 ? (min / 60) + " h" : min + " min";
    LMS.svc("server", false, "no answer — local dedup, next try in " + wait);
    try {
      localStorage.setItem(DEDUP_DOWN_KEY, String(Date.now() + min * 60000));
      localStorage.setItem(DEDUP_FAILS_KEY, String(fails));
    } catch (_) {}
    console.warn("[DEDUP] server not responding — local only, next try in " + wait);
  }
  function _dedupServerOk() {
    try { localStorage.removeItem(DEDUP_FAILS_KEY); } catch (_) {}
    LMS.svc("server", true);
  }

  function _bulkSend(url, payload) {
    if (_dedupServerDown()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const fin = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: url,
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": ZEROGPT_API_KEY,
          },
          data: JSON.stringify(payload),
          timeout: 8000,
          onload(res) { fin(res.status >= 200 && res.status < 300); },
          onerror() { fin(false); },
          ontimeout() { fin(false); },
        });
      } catch (_) { fin(false); }
    });
  }

  function _requeue(arr) {
    if (arr.length > BULK_MAX_BUFFER) arr = arr.slice(0, BULK_MAX_BUFFER);
    return arr;
  }

  function _bulkFlush() {
    if (_bulkInFlight) { _bulkFlushSoon(); return; }
    const stats = _statsBuffer; _statsBuffer = [];
    const marks = _markBuffer; _markBuffer = [];
    _bulkFirstPendingAt = 0;
    if (!stats.length && !marks.length) return;

    _bulkInFlight = true;
    const jobs = [];
    if (stats.length) {
      jobs.push(_bulkSend(SERVER_BASE + "/stats/event-bulk", { events: stats })
        .then((ok) => {
          if (ok) console.log("[STATS] " + stats.length + " event(s) in 1 request");
          else { _statsBuffer = _requeue(stats.concat(_statsBuffer));
                 console.warn("[STATS] batch send failed, " + stats.length + " requeued"); }
        }));
    }
    if (marks.length) {
      jobs.push(_bulkSend(DEDUP_URL + "/mark", { marks: marks })
        .then((ok) => {
          if (ok) console.log("[DEDUP] " + marks.length + " mark(s) in 1 request");
          else { _markBuffer = _requeue(marks.concat(_markBuffer));
                 console.warn("[DEDUP] batch send failed, " + marks.length + " requeued"); }
        }));
    }
    Promise.all(jobs).catch(() => {}).then(() => { _bulkInFlight = false; });
  }

  function _bulkFlushSoon(delay) {
    const d = typeof delay === "number" ? delay : BULK_FLUSH_DELAY_MS;
    if (!_bulkFirstPendingAt) _bulkFirstPendingAt = Date.now();
    if (_bulkTimer) clearTimeout(_bulkTimer);
    const waited = Date.now() - _bulkFirstPendingAt;
    const eff = Math.max(0, Math.min(d, BULK_MAX_WAIT_MS - waited));
    _bulkTimer = setTimeout(() => { _bulkTimer = null; _bulkFlush(); }, eff);
  }

  function _bulkFlushNow() {
    if (_bulkTimer) { clearTimeout(_bulkTimer); _bulkTimer = null; }
    _bulkFlush();
  }

  try {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") _bulkFlushNow();
    });
    window.addEventListener("pagehide", function () { _bulkFlushNow(); });
  } catch (_) {}

  function _statsRecord(applicant, action, status, category) {
    if (_serverOff()) return;
    try {
      const me = _modIdentity();
      _statsBuffer.push({
        mod: me.name,
        modId: me.id,
        applicant: applicant || null,
        action: action || null,
        category: category || null,
        status: status || "unknown",
      });
      if (_statsBuffer.length > BULK_MAX_BUFFER) {
        _statsBuffer = _statsBuffer.slice(-BULK_MAX_BUFFER);
      }
      _bulkFlushSoon();
    } catch (_) {}
  }

  const _intended = new Map();
  function _intendedValueFor(action) {
    return action === "approve" ? "approve" : "reject";
  }

  function _gateDecision(problems, unconfirmedBans, openWork) {
    if (openWork > 0) return "hold";
    if (problems && problems.length) return "hold";
    return "save";
  }

  function _notifyFor(action) {
    return !(action === "ban" || action === "ban-female-alt");
  }
  function _findNotifyBox(message) {
    const boxes = message.querySelectorAll('input[type="checkbox"]');
    for (const b of boxes) {
      if (/^notify\[/i.test(b.name || "")) return b;
      const lab = b.closest("label");
      if (lab && /notify user if action was taken/i.test(lab.textContent || "")) return b;
    }
    return null;
  }
  function _setNotify(message, on) {
    const b = _findNotifyBox(message);
    if (!b) {
      console.warn("[NOTIFY] checkbox not found");
      return false;
    }
    if (b.checked !== on) {
      try { _ownClick(b); } catch (_) {}
      if (b.checked !== on) {
        b.checked = on;
        b.dispatchEvent(new Event("input", { bubbles: true }));
        b.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return b.checked === on;
  }

  function _preSubmitCheck(skipIds) {
    _assertReasonGuards();
    const btn = document.querySelector(
      '.formSubmitRow-controls button[type="submit"]'
    );
    const form = btn ? btn.closest("form") : null;
    let fd = null;
    try { fd = form ? new FormData(form) : null; } catch (_) {}
    const problems = [];
    const unconfirmedBans = [];
    const badRows = [];

    _intended.forEach((want, message) => {
      const who = want.user || "?";

      if (skipIds && want.user && skipIds.indexOf(String(want.user)) !== -1) return;

      if (want.isBan && want.status !== "done") {
        unconfirmedBans.push(who + ": Ban-Status = " +
          (want.status === null || want.status === undefined
            ? "still running" : want.status));
      }

      const radio = (want.user
        ? document.querySelector('input[name="queue[user][' + want.user + ']"]:checked')
        : null) ||
        message.querySelector('input[type="radio"][name^="queue[user]["]:checked');
      const val = radio ? radio.value : "";

      if (typeof want.notify === "boolean") {
        const nb = _findNotifyBox(message);
        if (nb && nb.checked !== want.notify) {
          _setNotify(message, want.notify);
          if (nb.checked !== want.notify) {
            problems.push(who + ": Notify is " + (nb.checked ? "on" : "off") +
              " instead of " + (want.notify ? "on" : "off"));
          }
        }
      }

      if (val !== want.radioValue) {
        problems.push(who + ": Radio is \"" + (val || "empty") +
          "\" instead of \"" + want.radioValue + "\"");
      } else if (want.radioValue === "reject" && want.reasonKey) {
        const inp = _findReasonInput(message, want.user);
        if (!inp) {
          problems.push(who + ": reason field not found");
        } else if (inp.disabled) {
          problems.push(who + ": reason field is DISABLED (will not be sent)");
        } else if (!inp.value.trim()) {
          problems.push(who + ": reason is empty");
        } else if (fd && want.user &&
                   !fd.has("reason[user][" + want.user + "]")) {
          problems.push(who + ": reason missing in FormData POST");
        }
      }

      if (problems.some((p) => p.startsWith(who + ":"))) {
        badRows.push(message);
        if (want.ui) { try { want.ui.exec("err", "will NOT be saved like this"); } catch (_) {} }
      }
    });

    if (problems.length) {
      console.warn("[SUBCHECK] " + problems.length +
        " problem(s) immediately before saving:\n  " + problems.join("\n  "));
    }
    if (unconfirmedBans.length) {
      console.warn("[SUBCHECK] " + unconfirmedBans.length +
        " ban(s) NOT confirmed:\n  " + unconfirmedBans.join("\n  "));
    }
    if (!problems.length && !unconfirmedBans.length && _intended.size) {
      console.log("[SUBCHECK] All " + _intended.size +
        " tracked row(s) complete (radio set, reason in POST, " +
        "bans confirmed).");
    }
    return { problems: problems, unconfirmedBans: unconfirmedBans, badRows: badRows };
  }

  function _userFacingRejectText(action, reasonKey, extra) {
    if (action === "reject") return REJECTION_TEMPLATES[reasonKey] || null;
    if (action === "ban-alt" && extra && extra.mainName) {
      return "You already own a account @" + extra.mainName;
    }
    if (action === "ban-alt-generic") {
      return (extra && extra.additionalComment) || "Banned alt account";
    }
    if (action === "ban-female-alt") {
      return (extra && extra.additionalComment) || "Banned alt account";
    }
    if (action === "ban-deleted-not-waited") {
      return (extra && extra.rejectReason) || null;
    }
    return null;
  }

  function _applyRejectText(message, text, tag) {
    const rejectRadio = message.querySelector(
      'input[type="radio"][value="reject"]',
    );
    if (!rejectRadio) {
      console.warn("[AUTO] no reject radio found");
      return false;
    }
    const uid = _userIdFromMessage(message);
    if (!_setRadio(rejectRadio)) {
      console.warn("[AUTO] could not set reject radio (" + tag + ")");
      return false;
    }
    _activateDependency(rejectRadio);
    const who = () =>
      (message.querySelector(".message-userDetails a.username")?.textContent || "?");
    const tryOnce = () => {
      const targetInput = _findReasonInput(message, uid);
      if (!targetInput) return false;
      _activateDependency(rejectRadio);
      _registerReasonGuard(uid, targetInput, text);
      return !targetInput.disabled && targetInput.value === text;
    };
    if (tryOnce()) {
      console.log("[AUTO] Reject(" + tag + ") set for " + who());
      _syncQuickChips(message, text);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 300;
      const pollReason = setInterval(() => {
        attempts++;
        if (tryOnce()) {
          clearInterval(pollReason);
          console.log("[AUTO] Reject(" + tag + ") set for " + who());
          _syncQuickChips(message, text);
          resolve(true);
          return;
        }
        if (attempts >= maxAttempts) {
          clearInterval(pollReason);
          console.warn("[AUTO] Reject(" + tag +
            ") timeout — reason field not set after 15s");
          resolve(false);
        }
      }, 50);
    });
  }

  function executeReject(message, reasonKey) {
    if (!REJECTION_TEMPLATES[reasonKey]) {
      console.warn("[AUTO] unknown reasonKey: " + reasonKey);
      return false;
    }
    return _applyRejectText(message, REJECTION_TEMPLATES[reasonKey], reasonKey);
  }

  function _withSlash(path) {
    const p = String(path || "");
    return p.endsWith("/") ? p : p + "/";
  }

  function _formParams(form) {
    const p = new URLSearchParams();
    const els = form.querySelectorAll("input, select, textarea");
    for (const el of els) {
      if (!el.name || el.disabled) continue;
      const t = (el.type || "").toLowerCase();
      if (t === "submit" || t === "button" || t === "file" || t === "image" || t === "reset") continue;
      if ((t === "checkbox" || t === "radio") && !el.checked) continue;
      if (el.tagName === "SELECT") {
        for (const o of el.options) if (o.selected) p.append(el.name, o.value);
        continue;
      }
      p.append(el.name, el.tagName === "TEXTAREA" ? el.textContent : (el.value || ""));
    }
    return p;
  }

  async function _xfGet(url) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => { try { if (ctrl) ctrl.abort(); } catch (_) {} }, 20000);
    try {
      const r = await fetch(url, { credentials: "same-origin", cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined });
      return { status: r.status, text: await r.text() };
    } finally { clearTimeout(timer); }
  }

  async function _xfPost(url, params) {
    params.set("_xfResponseType", "json");
    params.set("_xfWithData", "1");
    params.set("_xfRequestUri", location.pathname + location.search);
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => { try { if (ctrl) ctrl.abort(); } catch (_) {} }, 30000);
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
        },
        body: params.toString(),
        signal: ctrl ? ctrl.signal : undefined,
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { status: r.status, json: json, text: text, redirected: r.redirected };
    } finally { clearTimeout(timer); }
  }

  function _xfErrorText(json) {
    try {
      const e = json && (json.errors || json.error || json.message);
      if (!e) return "";
      const parts = Array.isArray(e) ? e : (typeof e === "object" ? Object.values(e) : [e]);
      return parts.map((x) => String(x).replace(/<[^>]+>/g, "").trim())
        .filter(Boolean).join(" / ").slice(0, 200);
    } catch (_) { return ""; }
  }

  function _xfResult(res) {
    if (res.json) {
      if (res.json.status === "ok") return { status: "done" };
      return { status: "failed",
        error: _xfErrorText(res.json) || ("forum response HTTP " + res.status) };
    }
    if (res.status >= 400) return { status: "failed", error: "HTTP " + res.status };
    if (/blockMessage--error|formRow--error/.test(res.text || "")) {
      return { status: "failed", error: "form error" };
    }
    if (res.redirected) return { status: "done" };
    return { status: "unknown", error: "forum response unclear" };
  }

  const WARN_JOURNAL_KEY = "__xfWarnJournal";
  const WARN_JOURNAL_TTL = 3 * 24 * 60 * 60 * 1000;
  function _wjLoad() {
    try {
      const o = JSON.parse(localStorage.getItem(WARN_JOURNAL_KEY) || "{}") || {};
      const now = Date.now();
      Object.keys(o).forEach((k) => { if (!o[k] || now - o[k] > WARN_JOURNAL_TTL) delete o[k]; });
      return o;
    } catch (_) { return {}; }
  }
  function _wjKey(profileUrl, job) {
    const id = extractUserId(String(profileUrl)) || String(profileUrl);
    return (job.scope || "-") + "|" + id + ":" + job.warningId;
  }
  function _wjHas(profileUrl, job) { return !!_wjLoad()[_wjKey(profileUrl, job)]; }
  function _wjAdd(profileUrl, job) {
    try {
      const o = _wjLoad();
      o[_wjKey(profileUrl, job)] = Date.now();
      const keys = Object.keys(o);
      if (keys.length > 2000) {
        keys.sort((a, b) => o[a] - o[b]).slice(0, keys.length - 2000).forEach((k) => delete o[k]);
      }
      localStorage.setItem(WARN_JOURNAL_KEY, JSON.stringify(o));
    } catch (_) {}
  }

  async function _isBannedNow(profileUrl) {
    try {
      const url = new URL(_withSlash(profileUrl), location.href).href;
      const page = await _xfGet(url);
      if (page.status !== 200) return null;
      const doc = new DOMParser().parseFromString(page.text, "text/html");
      if (doc.documentElement.getAttribute("data-logged-in") === "false") return null;
      const head = doc.querySelector(".memberHeader");
      if (!head) return null;
      const titles = [...head.querySelectorAll(".userTitle, .userBanner")]
        .map((e) => (e.textContent || "").trim());
      if (titles.some((t) => /\bbanned\b/i.test(t))) return true;
      if (head.querySelector(".userBanner--banned, .username--banned")) return true;
      const nm = head.querySelector(".memberHeader-name .username") || head.querySelector(".username");
      const cls = nm ? [nm, ...nm.querySelectorAll("[class]")].map((x) => String(x.className || "")).join(" ") : "";
      if (/\busername--(style[56]|banned)\b/i.test(cls)) return true;
      const notes = [...doc.querySelectorAll(".memberHeader-banners, .p-body-main .blockMessage")]
        .map((e) => e.textContent || "").join(" ");
      if (/\b(has been|is|was) banned\b|\bbanned (until|permanently)\b/i.test(notes)) return true;
      return false;
    } catch (_) { return null; }
  }

  async function _xfWarn(profileUrl, job) {
    const name = (String(profileUrl).match(/\/members\/([^./]+)\./) || [])[1] ||
      ((String(profileUrl).match(/\/members\/(\d+)(?:[/?#]|$)/) || [])[1] ? "#" + extractUserId(profileUrl) : "?");
    const touched = _idOfUrl(_withSlash(String(profileUrl)));
    if (touched) _touchedIds.add(touched);

    if (_wjHas(profileUrl, job)) {
      console.log("[BAN] " + name + " warning " + job.warningId + " already went through — skipped");
      return { status: "done", skipped: true };
    }

    if (job.verifyFirst) {
      const b = await _isBannedNow(profileUrl);
      if (b === true) {
        console.log("[BAN] " + name + " is banned already — warning " + job.warningId + " not again");
        _wjAdd(profileUrl, job);
        if (touched) LMS.banned([touched], "queue");
        return { status: "done", skipped: true };
      }
      if (b === null) return { status: "unknown", error: name + ": ban state cannot be checked right now" };
    }
    let warnUrl;
    try { warnUrl = new URL(_withSlash(profileUrl) + "warn", location.href).href; }
    catch (_) { return { status: "failed", error: name + ": profile link broken" }; }
    let page;
    try { page = await _xfGet(warnUrl); }
    catch (e) { return { status: "failed", error: name + ": warn page not loaded" }; }
    if (page.status !== 200) {
      return { status: "failed", error: name + ": warn page HTTP " + page.status };
    }
    const doc = new DOMParser().parseFromString(page.text, "text/html");
    if (doc.documentElement.getAttribute("data-logged-in") === "false") {
      return { status: "failed", error: name + ": not logged in" };
    }
    const radio = doc.querySelector(
      'input[name="warning_definition_id"][value="' + job.warningId + '"]');
    const form = radio ? radio.closest("form") : null;
    if (!form) {

      const anyLevel = !!doc.querySelector('input[name="warning_definition_id"]');
      return { status: "failed", permanent: anyLevel,
        error: name + ": warning " + job.warningId + " not in form" };
    }
    let actionUrl;
    try { actionUrl = new URL(form.getAttribute("action") || warnUrl, warnUrl).href; }
    catch (_) { actionUrl = warnUrl; }

    const p = _formParams(form);
    p.set("warning_definition_id", String(job.warningId));

    const fill = await _xfWarnFill(actionUrl, form, job.warningId);
    Object.keys(fill).forEach((k) => {
      if (fill[k] === null) p.delete(k);
      else p.set(k, fill[k]);
    });

    const safe = LM_WARN_SAFE(form, p, fill, job.warningId);
    if (!safe.ok) {
      console.warn("[BAN] " + name + " warning " + job.warningId + " NOT sent: " + safe.why);
      return { status: "failed", error: name + ": " + safe.why };
    }
    p.set("filled_warning_definition_id", String(job.warningId));
    p.set("warning_definition_id", String(job.warningId));
    p.set("notes", job.notes || "");
    if (job.conversation) {
      p.set("start_conversation", "1");
      p.set("conversation_title", job.conversationTitle || "");
      p.set("conversation_message", job.conversationMessage || "");
      p.set("conversation_locked", "1");
    } else {
      ["start_conversation", "conversation_title", "conversation_message",
       "conversation_locked"].forEach((k) => p.delete(k));
    }

    if (WARN_FILL_PAUSE_MS) await new Promise((r) => setTimeout(r, WARN_FILL_PAUSE_MS));
    if (WARN_GAP_MS) await _warnGap();
    let res;
    try { res = await _xfPost(actionUrl, p); }
    catch (e) { return { status: "unknown", error: name + ": no response from forum" }; }
    finally { _lastWarnAt = Date.now(); }
    const out = _xfResult(res);
    if (out.status === "done") _wjAdd(profileUrl, job);

    if (out.status === "done" && String(job.warningId) === "14" && touched) LMS.banned([touched], "queue");

    if (out.status === "failed" &&
        /do not have permission|cannot be warned|not allowed to warn|may not warn/i.test(out.error || "")) {
      out.permanent = true;
    }
    if (out.error) out.error = name + ": " + out.error;
    console.log("[BAN] " + name + " warning " + job.warningId + " -> " + out.status +
      (out.error ? " (" + out.error + ")" : ""));
    return out;
  }

  const WARN_FILL_PAUSE_MS = 0;
  const WARN_GAP_MS = 0;
  let _lastWarnAt = 0;
  let _warnGapChain = Promise.resolve();
  function _warnGap() {
    const p = _warnGapChain.then(async () => {
      const wait = _lastWarnAt + WARN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      _lastWarnAt = Date.now();
    });
    _warnGapChain = p.catch(() => {});
    return p;
  }

  async function _xfWarnFill(actionUrl, form, id) {
    const out = {};
    const apply = (json) => {
      const fv = json && (json.formValues || (json.data && json.data.formValues) ||
        (json.json && json.json.formValues));
      if (!fv || typeof fv !== "object") return false;
      Object.keys(fv).forEach((sel) => {
        const m = String(sel).match(/name=["']?([^"'\]]+)["']?\]/);
        if (!m) return;
        const v = fv[sel];
        if (v === true) out[m[1]] = "1";
        else if (v === false || v === null || v === undefined) out[m[1]] = null;
        else out[m[1]] = String(v);
      });
      return true;
    };
    const base = () => {
      const q = new URLSearchParams();
      const tok = form.querySelector('input[name="_xfToken"]');
      if (tok) q.set("_xfToken", tok.value);
      q.set("fill", "1");
      q.set("warning_definition_id", String(id));
      return q;
    };
    try {
      const res = await _xfPost(actionUrl, base());
      if (apply(res.json)) return out;
    } catch (_) {}
    try {
      const q = base();
      q.set("_xfResponseType", "json");
      q.set("_xfWithData", "1");
      const sep = actionUrl.indexOf("?") === -1 ? "?" : "&";
      const r = await _xfGet(actionUrl + sep + q.toString());
      let json = null;
      try { json = JSON.parse(r.text); } catch (_) {}
      if (apply(json)) return out;
    } catch (_) {}
    console.warn("[BAN] could not fetch warning details — only setting the marker");
    return out;
  }

  const WARN_RETRY_WAITS = [2000, 5000];

  const _warnInflight = new Map();
  function _xfWarnRetry(profileUrl, job) {

    const who = extractUserId(String(profileUrl)) || normalizeProfileUrl(String(profileUrl));
    const k = (job.scope || "-") + "|" + who + ":" + job.warningId;
    if (_warnInflight.has(k)) {
      console.log("[BAN] warning " + job.warningId + " for " + who + " is already running — waiting for it");
      return _warnInflight.get(k);
    }
    const p = _xfWarnRetryRun(profileUrl, job);
    _warnInflight.set(k, p);
    p.then(() => _warnInflight.delete(k), () => _warnInflight.delete(k));
    return p;
  }
  async function _xfWarnRetryRun(profileUrl, job) {
    let last = null;
    for (let attempt = 0; attempt <= WARN_RETRY_WAITS.length; attempt++) {
      last = await _xfWarn(profileUrl, job);
      if (last.status === "unknown") {
        if ((await _isBannedNow(profileUrl)) === true) {
          _wjAdd(profileUrl, job);
          console.log("[BAN] unclear answer, but banned now -> the warning went through");
          return { status: "done", verified: true };
        }
        return last;
      }
      if (last.status !== "failed" || last.permanent) return last;
      if (attempt < WARN_RETRY_WAITS.length) {
        console.warn("[BAN] attempt " + (attempt + 1) + " failed (" + last.error +
          ") — retrying in " + (WARN_RETRY_WAITS[attempt] / 1000) + " s");
        await new Promise((r) => setTimeout(r, WARN_RETRY_WAITS[attempt]));
      }
    }
    return last;
  }

  async function _xfSetCustomTitle(profileUrl, title) {
    const editUrl = new URL(_withSlash(profileUrl) + "edit", location.href).href;
    const page = await _xfGet(editUrl);
    if (page.status !== 200) return { status: "failed", error: "edit page HTTP " + page.status };
    const doc = new DOMParser().parseFromString(page.text, "text/html");
    const input = doc.querySelector('input[name="user[custom_title]"]');
    const form = input ? input.closest("form") : null;
    if (!form) return { status: "failed", error: "custom title field not found" };
    const p = _formParams(form);
    p.set("user[custom_title]", title);
    const res = await _xfPost(new URL(form.getAttribute("action") || editUrl, editUrl).href, p);
    return _xfResult(res);
  }

  const _banVerifyFirst = new WeakSet();
  function _jobCtx(message) {
    return {
      scope: (message && _userIdFromMessage(message)) || "-",
      verifyFirst: !!(message && _banVerifyFirst.has(message)),
    };
  }

  async function _runWarnJobs(jobs, message) {
    const ctx = _jobCtx(message);
    const errs = [];
    let anyUnknown = false;
    let anyPermanent = false;
    let doneCount = 0;

    const results = await Promise.all(jobs.map((job) =>
      _xfWarnRetry(job.warnUrl, Object.assign({ conversation: true }, job, ctx))
        .catch((e) => ({ status: "unknown", error: "script error: " + (e && e.message) }))));
    for (const r of results) {
      if (r.status === "done") doneCount++;
      else {
        if (r.status === "unknown") anyUnknown = true;
        if (r.permanent) anyPermanent = true;
        errs.push(r.error || "error");
      }
    }
    if (!errs.length) return { status: "done" };

    return { status: anyUnknown ? "unknown" : "failed", permanent: anyPermanent && !anyUnknown,
      error: (doneCount ? doneCount + "/" + jobs.length + " warned; " : "") + errs.join("; ") };
  }

  async function executeBan(message) {
    const userLink = message.querySelector(".message-userDetails a.username");
    if (!userLink) return { status: "failed", error: "no profile link" };
    const profilePath = userLink.getAttribute("href");

    const rejectRadio = message.querySelector(
      'input[type="radio"][value="reject"]',
    );
    if (rejectRadio) {
      if (!_setRadio(rejectRadio)) {
        console.warn("[AUTO] could not set reject radio for ban");
      }
      _activateDependency(rejectRadio);
    }

    const r = await _xfWarnRetry(profilePath, Object.assign({ warningId: "14", notes: "Foid", conversation: false }, _jobCtx(message)));
    if (r.status === "done") {

      _pendingExecutions++;
      _pendingBanExec++;
      _xfSetCustomTitle(profilePath, "F-Banned")
        .then((t) => {
          if (t.status !== "done") console.warn("[BAN] custom title not set: " + (t.error || t.status));
        })
        .catch((e) => console.warn("[BAN] custom title error: " + (e && e.message)))
        .finally(() => {
          _pendingExecutions = Math.max(0, _pendingExecutions - 1);
          _pendingBanExec = Math.max(0, _pendingBanExec - 1);
          _dockRender();
        });
    }
    return r;
  }

  function executeApprove(message) {
    const approveRadio = message.querySelector(
      'input[type="radio"][value="approve"]',
    );
    if (!approveRadio) {
      console.warn("[AUTO] no approve radio found");
      return false;
    }
    if (!_setRadio(approveRadio)) {
      console.warn("[AUTO] could not set approve radio");
      return false;
    }
    console.log("[AUTO] approve radio set for " +
      (message.querySelector(".message-userDetails a.username")?.textContent || "?"));
    return true;
  }

  function executeRejectWithText(message, text) {
    return _applyRejectText(message, text, "custom");
  }

  function extractUserId(url) {

    const m = String(url || "").match(/\/members\/(?:[^/?#]*\.)?(\d+)(?:[/?#]|$)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function _isBannedAlt(a) { return !!(a && a.nameClass && /username--style[56]/i.test(a.nameClass)); }
  function _acctKey(url) { const id = extractUserId(url); return id != null ? "id:" + id : normalizeProfileUrl(url) || String(url || ""); }
  function _altBanPlan(approved) {
    const seen = new Set();
    const uniq = (approved || []).filter((a) => {
      const k = _acctKey(a && a.url);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const active = uniq.filter((a) => !_isBannedAlt(a));
    const list = active.length ? active : uniq;
    return { list: list, duplicates: (approved || []).length - uniq.length, banned: uniq.length - active.length };
  }

  function findOldestApproved(applicantUrl, applicantName, approvedAlts) {
    const candidates = [];
    approvedAlts.forEach((a) => {
      const id = extractUserId(a.url);
      if (id != null) candidates.push({ id, url: a.url, name: a.name });
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.id - b.id);
    return candidates[0];
  }

  function buildAltBan90Message(targetName, targetId, additionalComment) {
    return targetName + ",\n\n" +
      "You have a received a 90% warning from Moderation Staff for the post [url=https://looksmax.org/members/" + targetName + "." + targetId + "/]" + targetName + "[/url]:\n\n" +
      "[quote]" + targetName + "[/quote]\n\n" +
      "Additional comments: " + additionalComment + "\n\n" +
      "You can read the rules here:\n" +
      "https://looksmax.org/threads/rules-and-faq.1/\n\n" +
      "Note: \n" +
      "Warnings are added to your personal file. A 90% warning means an immediate 4 day ban, while additional warnings will mean a permanent ban when reaching 100%.\n\n" +
      "If you have any question, feel free to reply to this PM.";
  }

  function buildAltBan100Message(targetName, additionalComment) {
    return targetName + ",\n\n" +
      "You have been permanently banned by Moderation Staff.\n\n" +
      "Additional Comments: " + additionalComment + "\n\n" +
      "If you wish to appeal you may post in the \"Ban Appeal\" section and tag @Moderation Staff, he will be in charge of your appeal. Read the sticky AND the rules first, abuse won't be tolerated.\n\n" +
      "Thank you.";
  }

  function executeAltBan(message, mainUrl, mainName, mainId, approvedAlts,
                          applicantUrl, applicantName) {
    executeRejectWithText(message, "You already own a account @" + mainName);

    const jobs = [];

    if (approvedAlts.length === 1) {
      jobs.push({
        warnUrl: mainUrl,
        warningId: "13",
        conversationTitle: "90% Warning",
        notes: "Trying to create alt @" + applicantName,
        conversationMessage: buildAltBan90Message(
          mainName, mainId,
          "Trying to create an alt account @" + applicantName,
        ),
      });
      jobs.push({
        warnUrl: applicantUrl,
        warningId: "14",
        conversationTitle: "Ban",
        notes: "Trying to create alt @" + mainName,
        conversationMessage: buildAltBan100Message(
          applicantName,
          "Trying to create an alt account @" + mainName,
        ),
      });
    } else {
      approvedAlts.forEach((alt) => {
        jobs.push({
          warnUrl: alt.url,
          warningId: "14",
          conversationTitle: "Ban",
          notes: "Trying to create alt @" + mainName,
          conversationMessage: buildAltBan100Message(
            alt.name,
            "Trying to create an alt account @" + mainName,
          ),
        });
      });
      jobs.push({
        warnUrl: applicantUrl,
        warningId: "14",
        conversationTitle: "Ban",
        notes: "Trying to create alt @" + mainName,
        conversationMessage: buildAltBan100Message(
          applicantName,
          "Trying to create an alt account @" + mainName,
        ),
      });
    }

    console.log("[ALT-BAN] " + jobs.length + " warning(s), main: " + mainName);
    return _runWarnJobs(jobs, message);
  }

  function executeAltBanGeneric(message, extra) {
    executeRejectWithText(message, extra.additionalComment || "Banned alt account");

    const targets = [];
    if (extra.applicantUrl) {
      targets.push({ url: extra.applicantUrl, name: extra.applicantName });
    }
    (extra.allAlts || []).forEach((alt) => {
      const isBanned = !!(alt.nameClass && /username--style[56]/i.test(alt.nameClass));
      if (isBanned) return;
      targets.push({ url: alt.url, name: alt.name });
    });

    const jobs = targets.map((t) => ({
      warnUrl: t.url,
      warningId: "14",
      conversationTitle: extra.conversationTitle || "Ban",
      notes: extra.notes || "Banned alt account",
      conversationMessage: buildAltBan100Message(
        t.name,
        extra.additionalComment || "Banned alt account",
      ),
    }));

    if (!jobs.length) return { status: "failed", error: "no targets for the ban" };
    console.log("[ALT-BAN-GENERIC] " + jobs.length + " warning(s)");
    return _runWarnJobs(jobs, message);
  }

  function executeDeletedNotWaitedBan(message, extra) {
    executeRejectWithText(message, extra.rejectReason);

    const jobs = [{
      warnUrl: extra.applicantUrl,
      warningId: "14",
      conversationTitle: extra.conversationTitle || "Ban",
      notes: extra.notes || "Did not wait 3 months before making a new account",
      conversationMessage: buildAltBan100Message(
        extra.applicantName,
        extra.additionalComment || extra.rejectReason,
      ),
    }];

    console.log("[DELETED-NOT-WAITED] warning for applicant");
    return _runWarnJobs(jobs, message);
  }

  const altCache = new TtlMap(CACHE_TTL_MS);
  const deletionDateCache = new TtlMap(CACHE_TTL_MS);
  const _altListFailed = new Set();
  const _altListFailReason = new Map();

  const MOD_ROLE_KEY = "__xfModRole";
  const MOD_ROLES = {
    subadmin: {
      label: "Sub-Admin",
      canBan: true, canSeeAltGender: true, canAccessAltList: true,
    },
    moderator: {
      label: "Moderator",
      canBan: true, canSeeAltGender: true, canAccessAltList: true,
    },
    submod: {
      label: "Sub-Moderator",
      canBan: false, canSeeAltGender: false, canAccessAltList: false,
    },
    approvalmod: {
      label: "Approval Moderator",
      canBan: false, canSeeAltGender: false, canAccessAltList: false,
    },
  };
  function _getModRole() {
    let r = null;
    try { r = localStorage.getItem(MOD_ROLE_KEY); } catch (_) {}
    return MOD_ROLES[r] ? r : "moderator";
  }
  function _roleCfg() { return MOD_ROLES[_getModRole()]; }
  function _roleCanBan() { return _roleCfg().canBan; }
  function _roleCanSeeAltGender() { return _roleCfg().canSeeAltGender; }
  function _roleCanAccessAltList() { return _roleCfg().canAccessAltList; }

  const ZEROGPT_PROXY_URL = LM_SERVER + "/check";

  const AI_DECIDE_URL = LM_SERVER + "/decide";
  const AUTO_EXECUTE = true;

  const CASCADE_MAX_CONCURRENT = 40;
  const CHECK_BATCH_SIZE = 24;
  let _cascadeActive = 0;
  const _cascadeWaiters = [];

  const SAVE_DELAY_MS = 30;
  const SAVE_COUNTDOWN_S = 0;
  const SAVE_LOOP_KEY = "__xfSaveLastIds";
  let _saveCancelled = false;

  let AUTO_REFRESH_IDLE_MS = 2 * 60 * 1000;
  try {
    const o = Number(localStorage.getItem("__xfAutoRefreshMs"));
    if (o >= 1000) AUTO_REFRESH_IDLE_MS = o;
  } catch (_) {}
  let _lastUserActivity = Date.now();
  let _userTouchedForm = false;
  let _idleRefreshTimer = null;
  try {
    ["touchstart", "mousedown", "keydown", "wheel"].forEach((ev) =>
      document.addEventListener(ev, (e) => {
        if (e.isTrusted) _lastUserActivity = Date.now();
      }, { passive: true, capture: true }));
    document.addEventListener("change", (e) => {
      const n = (e.target && e.target.name) || "";
      if (e.isTrusted && !_ownInput && /^(queue|reason|notify)\[/.test(n)) {

        const row = e.target.closest && e.target.closest(".message");
        if (row && _isForeignRow(row)) { _foreignTouched(row); return; }
        _userTouchedForm = true;
        try { _dockRender(); } catch (_) {}
      }
    }, true);
    document.addEventListener("input", (e) => {
      const n = (e.target && e.target.name) || "";
      if (e.isTrusted && !_ownInput && /^reason\[/.test(n) && !_inForeignRow(e.target)) _userTouchedForm = true;
    }, true);
  } catch (_) {}

  let _idleRefreshWait = 0;
  function _scheduleIdleRefresh(ms) {

    const waitMs = ms ? Math.min(ms, AUTO_REFRESH_IDLE_MS) : AUTO_REFRESH_IDLE_MS;

    if (_idleRefreshTimer) {
      if (waitMs >= _idleRefreshWait) return Math.round(_idleRefreshWait / 60000 * 10) / 10;
      clearTimeout(_idleRefreshTimer);
      _idleRefreshTimer = null;
    }
    _idleRefreshWait = waitMs;
    const mins = Math.round(waitMs / 60000 * 10) / 10;
    const check = () => {
      _idleRefreshTimer = null;
      if (!_roundFlag() || _saveCancelled) return;
      if (_userTouchedForm) {
        _saveMsg("You changed something yourself — please save manually.", "info");
        return;
      }
      const idle = Date.now() - _lastUserActivity;
      if (idle < waitMs) {
        _idleRefreshTimer = setTimeout(check, waitMs - idle + 250);
        return;
      }

      if (_pauseState()) { _enterPause("Nothing left to save"); return; }

      if (_foreignSaving || _foreignHoldsReload("Reload")) { _idleRefreshTimer = setTimeout(check, 4000); return; }
      console.log("[SAVE] nothing to do — reloading for new applications");
      _saveMsg("Reloading for new applications …", "info");
      location.reload();
    };
    _idleRefreshTimer = setTimeout(check, waitMs);
    return mins;
  }

  let _manualSave = false;
  function _roundFlag() { return false; }

  const PAUSE_KEY = "__lmqPause";
  function _pauseState() {
    try { return sessionStorage.getItem(PAUSE_KEY) || ""; } catch (_) { return ""; }
  }
  function _pauseSet(v) {
    try { if (v) sessionStorage.setItem(PAUSE_KEY, v); else sessionStorage.removeItem(PAUSE_KEY); } catch (_) {}
  }
  function _isPaused() { return _pauseState() === "paused"; }
  function _enterPause(why) {
    _pauseSet("paused");
    if (_idleRefreshTimer) { clearTimeout(_idleRefreshTimer); _idleRefreshTimer = null; }
    try { _wakeDrop(); } catch (_) {}
    console.log("[PAUSE] paused after the round (" + why + ") — tap Continue for the next one");
    _dockMsg("Paused" + (why ? " · " + why : ""), "paused");
  }
  function _pauseToggle() {
    const s = _pauseState();
    if (s === "paused") { _pauseContinue(); return; }
    _pauseSet(s === "armed" ? null : "armed");
    if (_dock.kind === "paused") _dockMsg("", "");
    _dock.sig = "";
    _dockRender();
  }
  function _pauseContinue() {
    _pauseSet(null);
    console.log("[PAUSE] continue — fresh round");
    _dockMsg("Starting the next round …", "info");
    location.reload();
  }
  const SAVE_MAX_WAIT_MS = 10 * 60 * 1000;
  const SAVE_BUTTON_WAIT_MS = 30000;
  const SAVE_CHECK_MS = 10000;
  let _pendingCascades = 0;
  let _saveScheduled = false;
  let _pendingExecutions = 0;

  const EXEC_MAX_CONCURRENT = 8;
  let _execActive = 0;
  const _execWaiters = [];
  function _execAcquire() {
    if (_execActive < EXEC_MAX_CONCURRENT) {
      _execActive++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      _execWaiters.push(() => { _execActive++; resolve(); });
    });
  }
  function _execRelease() {
    _execActive = Math.max(0, _execActive - 1);
    if (_execWaiters.length && _execActive < EXEC_MAX_CONCURRENT) {
      const next = _execWaiters.shift();
      if (next) next();
    }
  }

  const BAN_MAX_CONCURRENT = 3;
  let _banActive = 0;
  const _banWaiters = [];
  function _banAcquire() {
    if (_banActive < BAN_MAX_CONCURRENT) {
      _banActive++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      _banWaiters.push(() => { _banActive++; resolve(); });
    });
  }
  function _banRelease() {
    _banActive = Math.max(0, _banActive - 1);
    if (_banWaiters.length && _banActive < BAN_MAX_CONCURRENT) {
      const next = _banWaiters.shift();
      if (next) next();
    }
  }

  function _cascadeAcquire() {
    _pendingCascades++;
    if (_dock.msg && (_dock.kind === "info" || _dock.kind === "refresh")) _dockMsg("", "");
    if (_cascadeActive < CASCADE_MAX_CONCURRENT) {
      _cascadeActive++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      _cascadeWaiters.push(() => { _cascadeActive++; resolve(); });
    });
  }
  function _cascadeRelease() {
    _cascadeActive--;
    _pendingCascades = Math.max(0, _pendingCascades - 1);
    if (_cascadeWaiters.length && _cascadeActive < CASCADE_MAX_CONCURRENT) {
      const next = _cascadeWaiters.shift();
      if (next) next();
    }
    if (_pendingCascades === 0) {
      _maybeScheduleSave();
    }
  }

  function _maybeScheduleSave() {
    if (!_isQueuePage() || !IS_TOP) return;
    if (_saveInFlight) return;
    if (_isPaused()) return;
    if (!_tabActive()) return;
    if (_dualBusy) return;
    if (_foreignSaving) return;
    if (_awaitingReload) return;

    if ((!_roundFlag() && !_manualSave) || _saveCancelled || _saveScheduled) return;
    if (_pendingCascades > 0) return;
    let busy = false;
    try { busy = _hlRunning; } catch (_) { busy = true; }
    if (busy) return;
    _saveScheduled = true;
    console.log("[SAVE] all applications done — waiting for open bans, then saving" + (_manualSave ? " (your tap)" : ""));
    _saveWhenIdle().catch((e) => {
      console.error("[SAVE] error:", e);
    }).finally(() => {
      _saveScheduled = false;
      _manualSave = false;
      _dock.sig = "";
      _dockRender();
    });
  }

  function _saveMsg(text, kind) {
    _dockMsg(text, kind);
  }

  function _saveCountdown(n) {
    return new Promise((resolve) => {
      let left = SAVE_COUNTDOWN_S;
      const tick = () => {
        if (_saveCancelled || (!_roundFlag() && !_manualSave)) return resolve(false);
        if (left <= 0) return resolve(true);
        _saveMsg("Saving " + n + " decision" + (n === 1 ? "" : "s") +
          " in " + left + " s …", "countdown");
        left--;
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  const AI_MAX_CONCURRENT = CHECK_BATCH_SIZE;
  let _aiActive = 0;
  const _aiQueue = [];
  function _aiEnqueue(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        _aiActive++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            _aiActive--;
            if (_aiQueue.length) _aiQueue.shift()();
          });
      };
      if (_aiActive < AI_MAX_CONCURRENT) run();
      else _aiQueue.push(run);
    });
  }

  const PROCESSED_KEY = "__processedApps";
  const PROCESSED_TTL_MS = 60 * 60 * 1000;

  let _procRaw = null;
  let _procData = null;
  let _procPrunedAt = 0;
  function _loadProcessed() {
    try {
      const raw = localStorage.getItem(PROCESSED_KEY) || "{}";
      if (raw !== _procRaw || !_procData) {
        _procData = JSON.parse(raw) || {};
        _procRaw = raw;
      }
      const now = Date.now();
      if (now - _procPrunedAt > 30000) {
        _procPrunedAt = now;
        let changed = false;
        for (const k of Object.keys(_procData)) {
          if (now - _procData[k] > PROCESSED_TTL_MS) {
            delete _procData[k];
            try { localStorage.removeItem(PROCESSED_KEY + ":st:" + k); } catch (_) {}
            changed = true;
          }
        }
        if (changed) {
          _procRaw = JSON.stringify(_procData);
          localStorage.setItem(PROCESSED_KEY, _procRaw);
        }
      }
      return _procData;
    } catch (_) {
      return {};
    }
  }

  setTimeout(() => {
    try {
      const data = _loadProcessed();
      const pre = PROCESSED_KEY + ":st:";
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(pre) && !Object.prototype.hasOwnProperty.call(data, k.slice(pre.length))) {
          kill.push(k);
        }
      }
      kill.forEach((k) => localStorage.removeItem(k));
      if (kill.length) console.log("[DEDUP] cleaned up " + kill.length + " old status entries");
    } catch (_) {}
  }, 8000);

  async function _saveWhenIdle() {
    await _sleep(SAVE_DELAY_MS);

    if (_pendingCascades > 0 || _hlRunning || _saveInFlight) return;
    if (_awaitingReload) return;
    if (_dualBusy) return;

    const nonBan = () => Math.max(0, _pendingExecutions - _pendingBanExec);
    if (nonBan() > 0) {
      _saveMsg("Waiting for " + nonBan() + " running action" +
        (nonBan() === 1 ? "" : "s") + " …", "info");
    }
    const tw = Date.now();
    while (nonBan() > 0 && Date.now() - tw < SAVE_MAX_WAIT_MS) await _sleep(100);

    _applyPoisonHolds();
    const openWork = nonBan();
    if (openWork > 0) {
      console.warn("[SAVE] " + openWork + " operation(s) after " +
        (SAVE_MAX_WAIT_MS / 1000) + "s still open");
    }

    const checkDeadline = Date.now() + SAVE_CHECK_MS;
    let problems = [];
    let unconfirmed = [];
    let badRows = [];
    for (;;) {
      _assertReasonGuards();
      const res = _preSubmitCheck(_runningBanIds());
      problems = res.problems;
      unconfirmed = res.unconfirmedBans;
      badRows = res.badRows || [];
      if (!problems.length) break;
      if (Date.now() >= checkDeadline) break;
      await _sleep(300);
    }

    if (problems.length && !openWork && badRows.length && !_userTouchedForm) {
      const badIds = badRows.map((m) => _userIdFromMessage(m)).filter(Boolean);
      _poisonAdd(badIds, "form");
      badRows.forEach((m) => _holdRowForManual(m, _rowUi(m),
        "Not set the way the script intended — left out this round, checked again by itself.", "form-error"));
      console.warn("[SAVE] " + badRows.length + " row(s) not set as intended — left out, the rest is saved:\n  " +
        problems.join("\n  "));
      const again = _preSubmitCheck(_runningBanIds());
      problems = again.problems;
      unconfirmed = again.unconfirmedBans;
    }

    if (_gateDecision(problems, unconfirmed, openWork) === "hold") {
      const details = [];
      if (openWork > 0) details.push("Still running: " + openWork + " action(s)");
      if (problems.length) {
        details.push("Row(s) would not be saved correctly:");
        problems.forEach((x) => details.push("  • " + x));
      }
      _gateBanner("A decision is not set the way the script intended.", details);
      console.warn("[SAVE] PAUSED:\n  " + details.join("\n  "));
      return;
    }

    if (!_queueRows(document).some((m) => !_isForeignRow(m))) {
      const mins = _scheduleIdleRefresh();
      const fl = _foreignLeftText();
      _saveMsg((fl ? "No applications · " + fl + " left for you" : "Queue empty") +
        " · reload after " + (mins || 2) + " min idle", "refresh");
      return;
    }

    const deadline = Date.now() + SAVE_BUTTON_WAIT_MS;
    let saveBtn = null;
    while (Date.now() < deadline) {
      if (_pendingCascades > 0) {
        console.log("[SAVE] new cascades started (" + _pendingCascades +
          ") — save postponed");
        return;
      }

      saveBtn = _queueSaveButton(_queueForm());
      if (saveBtn) break;
      await _sleep(1000);
    }
    if (!saveBtn) {
      _gateBanner("The Save button was not found (" +
        (SAVE_BUTTON_WAIT_MS / 1000) + " s).", []);
      return;
    }

    if (!_actionableIds().filter((id) => _runningBanIds().indexOf(id) === -1).length &&
        _runningBanIds().length) {
      _saveMsg("Waiting for " + _runningBanIds().length + " ban(s) …", "info");
      await _waitForBans();
    }

    const ids = _actionableIds();

    if (!ids.length) {
      const tries = _retryLoad();
      const triesOf = (m) => ((tries[_userIdFromMessage(m) || ""] || {}).n || 0);
      const retryRows = [...document.querySelectorAll(".message[data-manual-kind]")]
        .filter((m) => MANUAL_TRANSIENT.indexOf(m.dataset.manualKind) !== -1 &&
          _userIdFromMessage(m) && triesOf(m) < MANUAL_MAX_RETRIES);
      if (retryRows.length) {
        const round = Math.max.apply(null, retryRows.map(triesOf)) + 1;
        retryRows.forEach((m) => {
          const id = _userIdFromMessage(m);
          tries[id] = { n: ((tries[id] || {}).n || 0) + 1, ts: Date.now() };
        });
        _retrySave(tries);

        const waitS = retryRows.some((m) => m.dataset.manualKind === "ban-retry")
          ? 8 * round : 1.5 * round;
        console.log("[SAVE] " + retryRows.length + " case(s) with lookup error — " +
          "retry " + round + "/" + MANUAL_MAX_RETRIES + " in " + waitS + " s");
        _saveMsg("Lookup error on " + retryRows.length + " — checking again (" +
          round + "/" + MANUAL_MAX_RETRIES + ") …", "info");
        await _sleep(waitS * 1000);
        _rerunTransientRows(retryRows);
        return;
      }
      const onlyRetry = _retryRows().length > 0;
      const quick = _retryRows().some((m) => ["ban-retry", "alt-lookup", "vpn", "ai"].indexOf(m.dataset.manualKind) !== -1);
      const mins = _scheduleIdleRefresh(quick ? 30000 : 0) || (quick ? 0.5 : 2);
      const after = mins < 1 ? Math.round(mins * 60) + " s" : mins + " min";
      _saveMsg(onlyRetry
        ? "Nothing to save right now · " + _retryRows().length + " retrying · reload after " + after + " idle"
        : "Nothing to save · reload after " + after + " idle", "refresh");
      return;
    }

    if (_foreignSaving || _saveInFlight) return;

    const last = _saveStateLoad();
    let attempt = 1;
    const drained = new Set();
    let othersSent = false;
    if (last && last.refused && !(last.jobIds || []).length) {

      if (ids.some((id) => last.ids.indexOf(id) !== -1)) {
        console.log("[SAVE] last save was refused by the forum — submitting again now");
        attempt = (last.attempt || 1) + 1;
      }
      _saveStateSet(null);
    } else if (last) {
      const again = ids.filter((id) => last.ids.indexOf(id) !== -1);
      if (again.length) {
        console.log("[SAVE] " + again.length + " from the last save still here — letting the forum finish");
        _saveInFlight = true;
        const r = await _waitForProcessing(again, last.jobIds || [], true, "Forum is finishing the last save");
        if (r.status === "done") {
          _saveStateSet(null);
          const rest = _actionableIds().filter((id) => again.indexOf(id) === -1);
          if (!rest.length) return _saveDone(again.length);

          again.forEach((id) => drained.add(id));
          othersSent = true;
          console.log("[SAVE] last save finished — " + rest.length + " more on this page");
          _saveInFlight = false;
        } else {
          _saveInFlight = false;

          again.filter((id) => r.remaining.indexOf(id) === -1).forEach((id) => drained.add(id));
          attempt = (last.attempt || 1) + 1;
          if (attempt > 3) {
            _saveStateSet(null);
            _saveFailed(again, "The forum did not process " + r.remaining.length +
              " application(s) after " + (attempt - 1) + " tries.");
            return;
          }
        }
      }
    }

    if (!(await _saveCountdown(ids.length))) return;

    _assertReasonGuards();
    const banIds = _runningBanIds();
    const finalCheck = _preSubmitCheck(banIds);
    if (_gateDecision(finalCheck.problems, finalCheck.unconfirmedBans, nonBan()) === "hold") {
      _gateBanner("The state changed right before saving.",
        finalCheck.problems.concat(finalCheck.unconfirmedBans));
      return;
    }
    if (_pendingCascades > 0 || _hlRunning || _saveInFlight) {
      _saveMsg("New applications loaded — waiting …", "info");
      return;
    }

    if (!_tabActive()) return;
    if (_foreignSaving) return;
    _gateBannerClear();
    _roundChecked();
    _saveInFlight = true;
    const now = _actionableIds().filter((id) => !drained.has(id));
    const idsA = now.filter((id) => banIds.indexOf(id) === -1);
    console.log("[SAVE] gate clean — saving " + idsA.length + " decision(s) now" +
      (banIds.length ? ", " + banIds.length + " ban row(s) right after their ban" : "") +
      ", attempt " + attempt);

    let total = drained.size;
    if (idsA.length) {
      if (!banIds.length) _stopReasonGuards();
      const ra = await _submitAndWait(saveBtn, idsA, attempt, !othersSent);
      if (ra !== "done") { _saveInFlight = false; return; }
      total += idsA.length;
    }

    if (_runningBanIds().length || _pendingBanExec > 0) {
      _saveMsg("Saved " + total + " ✓ · waiting for " +
        Math.max(_runningBanIds().length, 1) + " ban(s) …", "saving");
      await _waitForBans();
    }
    const idsB = _actionableIds().filter((id) => idsA.indexOf(id) === -1 && !drained.has(id));
    if (idsB.length) {
      _assertReasonGuards();
      const checkB = _preSubmitCheck([]);
      if (_gateDecision(checkB.problems, checkB.unconfirmedBans, 0) === "hold") {
        _gateBanner(total + " decision(s) were saved, but a ban row is not set as intended.",
          checkB.problems);
        _saveInFlight = false;
        return;
      }
      _stopReasonGuards();
      const rb = await _submitAndWait(saveBtn, idsB, 1, !idsA.length && !othersSent);
      if (rb !== "done") { _saveInFlight = false; return; }
      total += idsB.length;
    }
    return _saveDone(total);
  }

  let _saveInFlight = false;
  let _pendingBanExec = 0;

  function _actionableIds() {
    return [...document.querySelectorAll('input[type="radio"][name^="queue[user]["]:checked')]
      .filter((r) => (r.value === "approve" || r.value === "reject") && !_inForeignRow(r))
      .map((r) => _userIdFromRadio(r)).filter(Boolean);
  }

  function _runningBanIds() {
    const out = [];
    _intended.forEach((want) => {
      if (want.isBan && (want.status === null || want.status === undefined) && want.user) {
        out.push(String(want.user));
      }
    });
    return out;
  }
  async function _waitForBans() {
    const t0 = Date.now();
    while ((_runningBanIds().length || _pendingBanExec > 0) && Date.now() - t0 < SAVE_MAX_WAIT_MS) {
      await _sleep(100);
    }
  }

  const MANUAL_LABELS = {
    "alt-lookup": "alt lookup failed",
    "vpn": "VPN check failed",
    "ai": "AI check failed",
    "ai-paused": "AI check paused (free quota / key)",
    "pending-alt": "alt pending (accept only one)",
    "banned-alt": "banned alt",
    "ban": "ban failed",
    "ban-retry": "ban not through yet",
    "ban-wait": "ban still running",
    "save-error": "forum refused saving",
    "save-refused": "cannot be saved",
    "form-error": "not set as intended",
    "no-text": "no application text",
    "offtopic": "no looksmax topic",
    "role": "no permission",
    "other": "other",
  };

  const MANUAL_TRANSIENT = ["alt-lookup", "vpn", "ai", "ban-retry"];

  const AUTO_KINDS = ["alt-lookup", "vpn", "ai", "ban-retry", "ban-wait", "save-error", "form-error"];
  function _isAutoKind(k) { return AUTO_KINDS.indexOf(k) !== -1; }
  function _manualRows() {
    return [...document.querySelectorAll(".message[data-manual-kind]")]
      .filter((m) => !_isAutoKind(m.dataset.manualKind));
  }
  function _retryRows() {
    return [...document.querySelectorAll(".message[data-manual-kind]")]
      .filter((m) => _isAutoKind(m.dataset.manualKind));
  }
  const MANUAL_MAX_RETRIES = 2;
  const MANUAL_RETRY_KEY = "__xfManualRetries";
  function _retryLoad() {
    try {
      const o = JSON.parse(sessionStorage.getItem(MANUAL_RETRY_KEY) || "{}") || {};
      const now = Date.now();
      Object.keys(o).forEach((k) => { if (!o[k] || now - o[k].ts > 10 * 60 * 1000) delete o[k]; });
      return o;
    } catch (_) { return {}; }
  }
  function _retrySave(o) {
    try { sessionStorage.setItem(MANUAL_RETRY_KEY, JSON.stringify(o)); } catch (_) {}
  }

  function _manualKindOf(summary) {
    const s = String(summary || "");
    if (/Alt list could not be loaded|could not be verified|alt lookup/i.test(s)) return "alt-lookup";
    if (/VPN check failed/i.test(s)) return "vpn";
    if (/AI check paused/i.test(s)) return "ai-paused";
    if (/ZeroGPT unavailable|AI check unavailable|AI score missing/i.test(s)) return "ai";
    if (/pending alt/i.test(s)) return "pending-alt";
    if (/banned alt/i.test(s)) return "banned-alt";
    if (/No application text/i.test(s)) return "no-text";
    if (/no looksmax topic/i.test(s)) return "offtopic";
    if (/no ban permission|not visible for/i.test(s)) return "role";
    return "other";
  }

  function _kindSummary(rows) {
    const counts = {};
    rows.forEach((m) => {
      const k = m.dataset.manualKind;
      counts[k] = (counts[k] || 0) + 1;
    });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])
      .map((k) => counts[k] + "× " + (MANUAL_LABELS[k] || k)).join(", ");
  }
  function _manualSummary() {
    const rows = _manualRows();
    return rows.length ? rows.length + " MANUAL: " + _kindSummary(rows) : "";
  }

  function _rerunTransientRows(rows) {
    rows.forEach((m) => {

      try { _dedupPrefetched.delete(_dedupKeyForMessage(m)); } catch (_) {}
      m.querySelectorAll(".alt-accounts-box").forEach((b) => b.remove());
      _dockDone(m, false);
      ["autoReject", "decisionChecked", "altChecked", "altListFailed",
       "altListFailReason", "altLogUnparsed", "manualKind"].forEach((k) => { delete m.dataset[k]; });
    });
    _altListFailed.clear();
    Object.keys(ipCache).forEach((ip) => {
      if (ipCache[ip] === null) { delete ipCache[ip]; _vpnPrefetched.delete(ip); }
    });
    _vpnApiProblem = null;
    _guardedHighlight();
  }

  function _queueForm() {
    const r = document.querySelector('input[type="radio"][name^="queue[user]["]');
    return (r && r.closest("form")) ||
      document.querySelector('form[action*="approval-queue/process"]');
  }
  function _queueSaveButton(form) {
    if (!form) return null;
    const btns = [...form.querySelectorAll('button[type="submit"], input[type="submit"]')]
      .filter((b) => !b.closest(".xf-report-panel"));

    return btns.find((b) => /\b(save|speichern)\b/i.test(b.textContent || b.value || "")) ||
      btns[btns.length - 1] || null;
  }

  const SAVE_STATE_KEY = "__lmqSaveState";
  const SAVE_STALL_MS = 45000;
  const SAVE_MAX_MS = 8 * 60 * 1000;
  const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function _saveStateLoad() {
    try {
      const o = JSON.parse(sessionStorage.getItem(SAVE_STATE_KEY) || "null");
      return o && Array.isArray(o.ids) && Date.now() - o.ts < 15 * 60 * 1000 ? o : null;
    } catch (_) { return null; }
  }
  function _saveStateSet(o) {
    try {
      if (o) sessionStorage.setItem(SAVE_STATE_KEY, JSON.stringify(o));
      else sessionStorage.removeItem(SAVE_STATE_KEY);
    } catch (_) {}
  }

  try {
    localStorage.removeItem("__xfSaveMethod");
    sessionStorage.removeItem(SAVE_LOOP_KEY);
    sessionStorage.removeItem(SAVE_LOOP_KEY + ":err");
    sessionStorage.removeItem(SAVE_LOOP_KEY + ":diag");
  } catch (_) {}

  function _xfTokenValue() {
    const inp = document.querySelector('input[name="_xfToken"]');
    if (inp && inp.value) return inp.value;
    return document.documentElement.getAttribute("data-csrf") || "";
  }

  function _jobIdsFrom(json) {
    const out = [];
    const walk = (v, depth) => {
      if (v === null || v === undefined || depth > 3) return;
      if (Array.isArray(v)) {
        v.forEach((x) => {
          if (typeof x === "number" || /^\d+$/.test(String(x))) out.push(String(x));
          else walk(x, depth + 1);
        });
      } else if (typeof v === "object") {
        Object.keys(v).forEach((k) => { if (!/message|title|text/i.test(k)) walk(v[k], depth + 1); });
      }
    };
    try { walk(json && (json.job || (json.data && json.data.job)), 0); } catch (_) {}
    return [...new Set(out)];
  }

  async function _runJobOnce(jobIds) {
    const p = new URLSearchParams();
    p.set("_xfResponseType", "json");
    const tok = _xfTokenValue();
    if (tok) p.set("_xfToken", tok);
    (jobIds || []).forEach((id) => p.append("only_ids[]", id));
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => { try { if (ctrl) ctrl.abort(); } catch (_) {} }, 25000);
    try {
      const r = await fetch(location.origin + "/job.php", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
        },
        body: p.toString(),
        signal: ctrl ? ctrl.signal : undefined,
      });
      let j = null;
      try { j = JSON.parse(await r.text()); } catch (_) {}
      return { ok: r.ok, more: j && typeof j.more !== "undefined" ? !!j.more : null };
    } catch (_) {
      return { ok: false, more: null };
    } finally {
      clearTimeout(timer);
    }
  }

  const SNAP_PARSE_EVERY_MS = 3500;
  let _snapParsedAt = 0;
  async function _fetchQueueText(url) {
    try {
      const r = await _xfGet(new URL(url, location.origin).href);
      if (r.status !== 200) return null;
      const t = r.text || "";
      const tag = (t.match(/<html\b[^>]*>/i) || [""])[0];
      if (/\bdata-logged-in\s*=\s*["']?false/i.test(tag)) return null;
      if (/\bdata-template\s*=\s*["']?(login|error|no_permission|login_form)["'\s>]/i.test(tag)) return null;
      if (!/name="queue\[/.test(t) && !/class="[^"]*\b(block-body|blockMessage)\b/.test(t)) return null;
      return t;
    } catch (_) { return null; }
  }
  const _inQueueText = (t, id) => t.indexOf('name="queue[user][' + id + ']"') !== -1;
  async function _queueSnapshot(ids, verify) {
    try {

      const otherUrls = _dualOtherUrls();
      const texts = await Promise.all([_fetchQueueText(location.href), ...otherUrls.map(_fetchQueueText)]);
      const txt = texts[0];
      const otx = new Map(otherUrls.map((u, i) => [u, texts[i + 1]]));
      if (!txt) return { still: null, doc: null };
      _queueLeftFromText(txt);
      const inOther = (id, has) => {
        if (!_dualIds.has(id)) return false;
        const src = otx.get(_dualSrc.get(id));
        return !src || has(src, id);
      };
      let still = ids.filter((id) => _inQueueText(txt, id) || inOther(id, _inQueueText));
      const now = Date.now();
      if (!verify && still.length && now - _snapParsedAt < SNAP_PARSE_EVERY_MS) {
        return { still: still, doc: true, docs: [], verified: false };
      }

      _snapParsedAt = now;
      const parse = (t) => new DOMParser().parseFromString(t, "text/html");
      const doc = parse(txt);
      if (!_queueDocOk(doc)) return { still: null, doc: null };
      const others = new Map();
      otx.forEach((t, u) => {
        if (!t) return;
        const d = parse(t);
        if (_queueDocOk(d)) others.set(u, d);
      });
      const inDoc = (d, id) => !!d.querySelector('input[name="queue[user][' + id + ']"]');
      still = ids.filter((id) => inDoc(doc, id) ||
        (_dualIds.has(id) && (() => { const d = others.get(_dualSrc.get(id)); return !d || inDoc(d, id); })()));
      _lastSnap = { doc: doc, others: others, t: now };
      return { still: still, doc: doc, docs: [doc, ...others.values()], verified: true };
    } catch (_) {
      return { still: null, doc: null };
    }
  }

  function _saveProgress(done, total, prefix) {
    _dock.prog = { done: done, total: total };
    _saveMsg((prefix || "Forum is saving") + " · " + done + " / " + total + " …", "saving");
  }

  async function _waitForProcessing(ids, jobIds, driveJobs, prefix) {
    const total = ids.length;
    let remaining = ids.slice();
    let lastProgressAt = Date.now();
    const start = Date.now();
    let finished = null;
    let kick = null;
    const wake = () => { if (kick) { const k = kick; kick = null; k(); } };
    const nap = (ms) => new Promise((r) => { kick = r; setTimeout(r, ms); });
    _saveProgress(0, total, prefix);

    let doneAt = 0;
    let busyAt = 0;
    if (driveJobs) {
      (async () => {
        let round = 0;
        while (!finished && Date.now() - start < SAVE_MAX_MS) {
          round++;

          const useIds = jobIds.length > 0 && round % 2 === 1;
          const jr = await _runJobOnce(useIds ? jobIds : null);
          if (finished) break;
          if (useIds || !jobIds.length) {
            if (jr.more === false) doneAt = Date.now();
            else if (jr.more === true) busyAt = Date.now();
          }
          if (jr.more === false) wake();
          if (jr.more !== true) await _sleep(700);
        }
      })();
    }
    let calm = 0;
    let seenN = remaining.length;
    while (!finished) {
      await nap(calm > 2 ? 2500 : 1500);
      const snapAt = Date.now();
      const doneSeen = doneAt;

      const snap = await _queueSnapshot(remaining, calm >= 1 || (driveJobs && doneSeen > 0 && doneSeen > busyAt));
      (snap.docs || []).forEach((d) => _prewarmFromDoc(d, ids));
      if (snap.still) {
        if (snap.still.length < seenN) { lastProgressAt = Date.now(); calm = 0; } else calm++;
        seenN = snap.still.length;

        if (snap.verified) remaining = snap.still;
        _saveProgress(total - snap.still.length, total, prefix);
        if (snap.verified && !remaining.length) { finished = "done"; break; }

        if (snap.verified && driveJobs && doneSeen > 0 && doneSeen > busyAt && doneSeen <= snapAt &&
            Date.now() - lastProgressAt > 2000) {
          console.log("[SAVE] job finished, " + remaining.length + " still waiting — submitting them again");
          finished = "idle";
          break;
        }
      }
      if (Date.now() - lastProgressAt > SAVE_STALL_MS || Date.now() - start > SAVE_MAX_MS) {
        finished = "stalled";
      }
    }
    return { status: finished, remaining: remaining };
  }

  async function _saveDone(total) {
    _dock.prog = { done: total, total: total };
    let _today = null;
    try { _today = _todayCount(total); } catch (_) {}
    let _rt = null;
    try { _rt = _roundFinish(total); } catch (_) {}
    try {
      const d = _dock.el;
      if (d) { d.classList.remove("is-flash"); void d.offsetWidth; d.classList.add("is-flash"); }
    } catch (_) {}
    _saveMsg("Saved ✓ " + total + (_rt ? " in " + _fmtDur(_rt.ms) : "") +
      (_today ? " · " + _today.saved.toLocaleString("en-US") + " today" : "") +
      (_pauseState() ? " — pausing …" : " — loading next applications …"), "saving");
    const t0 = Date.now();
    while (_pendingExecutions > 0 && Date.now() - t0 < SAVE_MAX_WAIT_MS) await _sleep(100);
    _saveStateSet(null);
    try { _zgCacheSaveNow(); } catch (_) {}
    try { _vpnCacheSaveNow(); } catch (_) {}
    _bulkFlushNow();
    _saveInFlight = false;

    if (_pauseState()) { _enterPause(total + " saved ✓"); return; }
    console.log("[SAVE] saved and verified — next page");
    return _nextPage();
  }

  let _lastSnap = null;
  let _swapCount = 0;
  const SWAP_RELOAD_EVERY = 12;
  function _rowsParent(root) {

    const rows = _queueRows(root);
    if (!rows.length) return null;
    const p = rows[0].parentElement;
    for (const r of rows) if (r.parentElement !== p) return null;
    return p;
  }

  function _invalidateTouched(ids) {
    if (!ids.size) return 0;
    let n = 0;
    [userStateCache, deletionDateCache, _mpCache].forEach((c) => {
      [...c.keys()].forEach((k) => { if (ids.has(_idOfUrl(k))) { c.delete(k); n++; } });
    });
    [...altCache.entries()].forEach(([k, e]) => {
      const list = e && Array.isArray(e.v) ? e.v : [];
      if (ids.has(_idOfUrl(k)) || list.some((a) => a && ids.has(_idOfUrl(a.url)))) {
        altCache.delete(k);
        n++;
      }
    });
    return n;
  }
  async function _nextPage() {
    try {

      if (_swapCount >= SWAP_RELOAD_EVERY && !_foreignPending().length) throw new Error("periodic reload");

      document.querySelectorAll(".message").forEach((m) => {
        if (_isForeignRow(m)) return;
        const id = _userIdFromMessage(m);
        if (id) _touchedIds.add(id);
      });

      if (_prewarmAltJobs.size) {
        const settled = await Promise.race([
          Promise.all([..._prewarmAltJobs]).then(() => true),
          _sleep(2500).then(() => false),
        ]);
        if (!settled) throw new Error("next-page alt checks still running");
      }
      const dropped = _invalidateTouched(_touchedIds);
      _touchedIds.clear();
      if (dropped) console.log("[QUEUE] " + dropped + " cached lookup(s) of changed accounts dropped");
      let doc = _lastSnap && Date.now() - _lastSnap.t < 4000 ? _lastSnap.doc : null;
      const otherDocs = doc ? (_lastSnap.others || null) : null;
      if (!doc) {
        const r = await _xfGet(location.href);
        if (r.status !== 200) throw new Error("HTTP " + r.status);
        doc = new DOMParser().parseFromString(r.text, "text/html");
      }
      _lastSnap = null;
      if (doc.documentElement.getAttribute("data-logged-in") === "false") throw new Error("logged out");
      const newParent = _rowsParent(doc);
      const curParent = _rowsParent(document);

      const hasApps = !!doc.querySelector('input[type="radio"][name^="queue[user]["]');
      const hasRows = !!doc.querySelector('input[type="radio"][name^="queue["]');
      if (!newParent || !curParent || !(hasApps || (hasRows && _dualOtherUrls().length > 1))) {
        throw new Error("no rows to swap");
      }

      const tok = doc.querySelector('input[name="_xfToken"]');
      if (tok) document.querySelectorAll('input[name="_xfToken"]').forEach((i) => { i.value = tok.value; });
      _queueLeftFromDoc(doc, true);

      const keep = new Map();
      _foreignPending().forEach((row) => { const k = _foreignKey(row); if (k) keep.set(k, row); });
      _resetPageState();
      const nodes = [...newParent.childNodes].map((n) => document.adoptNode(n));
      nodes.forEach((n) => { if (n.nodeType === 1 && n.matches(".message")) n.dataset.lmqSwapped = "1"; });
      let kept = 0;
      if (keep.size) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (n.nodeType !== 1 || !n.matches(".message")) continue;
          const k = _foreignKey(n);
          if (k && keep.has(k)) { nodes[i] = keep.get(k); keep.delete(k); kept++; }
        }
      }
      curParent.replaceChildren(...nodes);
      _syncDeps(curParent);
      _foreignCacheReset();
      if (kept) console.log("[QUEUE] " + kept + " ban appeal(s) with your pick kept through the swap");
      if (keep.size) {
        console.log("[QUEUE] " + keep.size + " ban appeal(s) you had picked are no longer on the page — nothing sent");
        const gone = keep.size;
        setTimeout(() => _dockMsg(gone === 1
          ? "A ban appeal you had picked is no longer in the queue (handled by someone else) — nothing was sent."
          : gone + " ban appeals you had picked are no longer in the queue — nothing was sent.", "info"), 300);
      }
      _swapCount++;
      window.scrollTo(0, 0);
      console.log("[QUEUE] next page swapped in (" + _swapCount + ")");
      _dualMerge(otherDocs);
      _guardedHighlight();
    } catch (e) {
      console.log("[QUEUE] full reload (" + ((e && e.message) || "swap failed") + ")");

      _reloadWhenFree(() => location.replace(location.href), "Next round");
    }
  }

  function _resetPageState() {
    _pageEpoch++;
    _roundT0 = Date.now();
    _roundCheckedAt = 0;
    _intended.clear();
    _dualIds.clear();
    _dualSrc.clear();
    _stopReasonGuards();
    messagesMap.clear();
    _dedupPrefetched.clear();
    _altListFailed.clear();
    _altListFailReason.clear();
    Object.keys(ipCache).forEach((ip) => {
      if (ipCache[ip] === null) { delete ipCache[ip]; _vpnPrefetched.delete(ip); }
    });
    _banConfirmQueue.length = 0;
    _userTouchedForm = false;
    _foreignCacheReset();
    _dock.rows.clear();
    _dock.done.clear();
    _dock.prog = null;
    _dockMsg("", "");
    _gateBannerClear();
  }

  function _syncDeps(scope) {
    scope.querySelectorAll('input[type="radio"][name^="queue["]').forEach((r) => {
      const li = r.closest("li");
      const dep = li && li.querySelector(".inputChoices-dependencies");
      if (!dep) return;
      dep.classList.toggle("is-disabled", !r.checked);
      dep.querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = !r.checked; });
    });
  }
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || t.type !== "radio" || !/^queue\[/.test(t.name || "")) return;
    const m = t.closest(".message");
    if (m && m.dataset.lmqSwapped) _syncDeps(m);
  }, true);

  function _hideForumBusyOverlay() {
    try {
      document.querySelectorAll(".overlay-container.is-active").forEach((o) => {
        if (/approval queue|processing|verarbeit|freischalt/i.test(o.textContent || "")) {
          o.classList.remove("is-active");
          o.style.display = "none";
        }
      });
      if (!document.querySelector(".overlay-container.is-active")) {
        document.documentElement.classList.remove("is-modalOpen", "is-modalOverlayOpen");
        document.body.classList.remove("is-modalOpen", "is-modalOverlayOpen");
      }
    } catch (_) {}
  }
  function _saveFailed(ids, text, diag) {
    _hideForumBusyOverlay();
    try {
      const el = _notice("xfSaveGateBanner", "err", "Saving is stuck");
      if (!el) return;
      _noticeBody(el, text +
        " Your selections are still set — nothing is lost. Tap “Try again”.", diag, [
        { label: "Try again", primary: true, run: () => { _saveStateSet(null); location.reload(); } },
        { label: "Use the forum's Save button", run: () => {
          const b = _queueSaveButton(_queueForm());
          if (b) { _stopReasonGuards(); _withForeignOff(() => b.click()); }
        } },
      ]);
      _dockMsg("Saving is stuck — tap for details", "hold");
      _autoRecover("Saving is stuck");
    } catch (_) {}
  }

  function _paramsFor(form, ids, withOthers) {
    const fd = new FormData(form);
    const p = new URLSearchParams();
    const foreign = _foreignNames();
    for (const [k, v] of fd.entries()) {
      if (typeof v !== "string") continue;
      if (foreign.has(k)) continue;
      const m = k.match(/^(queue|reason|notify)\[user\]\[(\d+)\]$/);
      if (m) { if (ids.indexOf(m[2]) === -1) continue; }
      else if (/^(queue|reason|notify)\[/.test(k)) continue;
      p.append(k, v);
    }
    return p;
  }

  const JOB_MODE_KEY = "__lmqJobMode";
  const MAX_PARTS = 6;
  const MIN_PART = 2;
  const LEFTOVER_QUIET_MS = 10000;
  function _jobMode() { try { return localStorage.getItem(JOB_MODE_KEY) || ""; } catch (_) { return ""; } }
  function _setJobMode(m) { try { localStorage.setItem(JOB_MODE_KEY, m); } catch (_) {} }

  function _splitParts(ids) {
    if (ids.length < MIN_PART * 2 || _jobMode() === "single") return [ids.slice()];
    const size = Math.max(MIN_PART, Math.ceil(ids.length / MAX_PARTS));
    const parts = [];
    for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
    return parts;
  }

  function _isServerError(t) {
    return /ran into some problems|try again later|\boops\b|internal server|server error|HTTP 5\d\d/i.test(t || "");
  }

  const POISON_KEY = "__lmqSavePoison";
  const POISON_HOLD_MS = 10 * 60 * 1000;
  const POISON_MAX = 3;
  function _poisonLoad() {
    try {
      const o = JSON.parse(sessionStorage.getItem(POISON_KEY) || "{}") || {};
      const now = Date.now();
      Object.keys(o).forEach((k) => { if (!o[k] || now - o[k].ts > 6 * 60 * 60 * 1000) delete o[k]; });
      return o;
    } catch (_) { return {}; }
  }
  function _poisonAdd(ids, why) {
    try {
      const o = _poisonLoad();
      ids.forEach((id) => {
        o[id] = { n: ((o[id] && o[id].n) || 0) + 1, ts: Date.now(), why: why || "server" };
      });
      sessionStorage.setItem(POISON_KEY, JSON.stringify(o));
    } catch (_) {}
  }
  function _applyPoisonHolds() {
    const o = _poisonLoad();
    if (!Object.keys(o).length) return 0;
    let n = 0;
    document.querySelectorAll('input[type="radio"][name^="queue[user]["]:checked').forEach((r) => {
      if (r.value !== "approve" && r.value !== "reject") return;
      const id = _userIdFromRadio(r);
      const e = id && o[id];
      if (!e) return;
      const form = e.why === "form";
      const manual = e.n >= POISON_MAX;

      if (!manual && (form || Date.now() - e.ts >= POISON_HOLD_MS)) return;
      const m = r.closest(".message");
      if (!m) return;
      n++;
      _holdRowForManual(m, _rowUi(m), manual
        ? (form
          ? "This application could not be set the way the script intended (" + e.n + "×) — please decide it yourself."
          : "The forum refuses to save this application (server error, " + e.n + "×) — please handle it in the forum.")
        : "The forum refused to save this application (server error) — everything else was saved, this one is tried again in a few minutes.",
        manual ? "save-refused" : "save-error");
    });
    return n;
  }

  async function _postPart(form, ids, withOthers) {
    let params;
    try { params = _paramsFor(form, ids, withOthers); } catch (_) { return { status: "unclear", jobIds: [], error: "form" }; }
    try {
      const actionUrl = new URL(form.getAttribute("action") || location.href, location.href).href;
      const res = await _xfPost(actionUrl, params);
      const out = _xfResult(res);
      if (out.status === "failed") return { status: "refused", jobIds: [], error: out.error };
      return { status: "ok", jobIds: _jobIdsFrom(res.json), error: "" };
    } catch (e) {
      return { status: "unclear", jobIds: [], error: "no response (" + ((e && e.message) || "network") + ")" };
    }
  }

  async function _submitAndWait(saveBtn, ids, attempt, withOthers) {
    const st = { ids: ids, ts: Date.now(), attempt: attempt, method: "fetch" };
    _saveStateSet(st);
    const form = _queueForm() || (saveBtn && saveBtn.closest("form"));
    if (!form || typeof fetch !== "function" || attempt >= 3) {
      await _waitForBans();
      return _clickSave(saveBtn, ids);
    }

    const total = ids.length;
    const start = Date.now();
    let remaining = ids.slice();
    let lastProgressAt = Date.now();
    let finished = null;
    let others = withOthers;
    const jobs = new Map();
    let genericDriver = false;
    let resubmits = 0;
    let lastResubmitAt = 0;
    let kick = null;
    const wake = () => { if (kick) { const k = kick; kick = null; k(); } };
    const nap = (ms) => new Promise((r) => { kick = r; setTimeout(r, ms); });

    let lastDoneAt = 0;
    let lastSubmitAt = 0;
    let genDoneAt = 0;
    let genBusyAt = 0;
    const drive = (jobId) => {
      const j = jobId ? jobs.get(jobId) : null;
      if (j) { j.done = false; j.epoch = (j.epoch || 0) + 1; if (j.running) return; j.running = true; }
      (async () => {
        while (!finished && Date.now() - start < SAVE_MAX_MS) {
          const ep = j ? j.epoch : 0;
          const jr = await _runJobOnce(jobId ? [jobId] : null);
          if (finished) break;
          if (j && jr.more === false) {

            if (j.epoch === ep) { j.done = true; lastDoneAt = Date.now(); wake(); break; }
            continue;
          }
          if (!jobId && jr.more === false) { genDoneAt = Date.now(); wake(); }
          if (!jobId && jr.more === true) genBusyAt = Date.now();
          if (jr.more !== true) await _sleep(400);
        }
        if (j) j.running = false;
      })();
    };

    const poison = [];
    let anyAccepted = false;
    const isolate = async (partIds, firstRefusal) => {
      const out = { status: "ok", jobIds: [], error: "" };
      const found = [];
      let lastRefusal = firstRefusal;
      if (partIds.length === 1) found.push(partIds[0]);
      else {
        const half = (a) => [a.slice(0, Math.ceil(a.length / 2)), a.slice(Math.ceil(a.length / 2))];
        const queue = half(partIds);
        let ok = 0, failsInRow = 0;
        while (queue.length) {
          const g = queue.shift();
          lastSubmitAt = Date.now();
          const r = await _postPart(form, g, false);
          if (r.status !== "refused") {
            ok++; failsInRow = 0; anyAccepted = true;
            r.jobIds.forEach((j) => out.jobIds.push(j));
            continue;
          }
          if (!_isServerError(r.error)) return r;
          lastRefusal = r;

          if (!ok && ++failsInRow >= 6) return r;
          if (g.length === 1) found.push(g[0]);
          else queue.unshift(...half(g));
        }
      }

      if (found.length && !anyAccepted) return lastRefusal;
      found.forEach((id) => poison.push(id));
      return out;
    };
    const holdPoison = () => {
      if (!poison.length) return;
      remaining = remaining.filter((id) => poison.indexOf(id) === -1);
      st.ids = st.ids.filter((id) => poison.indexOf(id) === -1);
      _saveStateSet(st);
      _poisonAdd(poison);
      console.warn("[SAVE] the forum refuses " + poison.length + " application(s) with a server error (" +
        poison.join(", ") + ") — everything else is saved");
      _applyPoisonHolds();
    };

    const submit = async (partIds) => {

      const withO = others;
      others = false;
      lastSubmitAt = Date.now();
      let r = await _postPart(form, partIds, withO);
      if (r.status !== "refused") anyAccepted = true;
      if (r.status === "refused" && _isServerError(r.error) && partIds.length) {
        console.warn("[SAVE] forum error on a part (" + r.error + ") — finding the broken application");
        _saveMsg("Forum error on one application — saving the rest …", "saving");

        await _sleep(300);
        r = await isolate(partIds, r);

        holdPoison();
      }
      if (r.status === "refused") {
        console.warn("[SAVE] forum refused: " + r.error);
        if ((attempt || 1) < 2 && !jobs.size) {
          _saveStateSet(Object.assign(st, { refused: r.error }));
          _saveMsg("Forum refused the save — reloading with a fresh token …", "info");
          setTimeout(() => location.replace(location.href), 800);
        } else {
          _saveFailed(ids, "The forum refused the save: " + r.error + ".");
        }
        finished = "failed";
        return false;
      }
      r.jobIds.forEach((j) => {
        if (!jobs.has(j)) jobs.set(j, { done: false, running: false });
        drive(j);
      });

      if (jobs.size) _saveStateSet(Object.assign(st, { jobIds: [...jobs.keys()] }));
      if (!r.jobIds.length && !genericDriver) { genericDriver = true; drive(null); }
      return r;
    };

    const parts = _splitParts(ids);
    _saveProgress(0, total, "Submitting");
    let pending = parts.slice();
    let sentParts = 0;
    if (pending.length > 1 && !_jobMode()) {

      const a = await submit(pending.shift());
      if (!a) return "failed";
      const b = await submit(pending.shift());
      if (!b) return "failed";
      sentParts = 2;
      const ja = a.jobIds[0], jb = b.jobIds[0];
      if (ja && jb && ja !== jb) { _setJobMode("parallel"); console.log("[SAVE] forum runs separate jobs -> parallel saving"); }
      else if (ja && jb && ja === jb) { _setJobMode("single"); console.log("[SAVE] forum reuses one job -> one part at a time"); }
    }
    if (_jobMode() === "single") {

      if (!sentParts && pending.length) {
        const r = await submit(pending.shift());
        if (!r) return "failed";
        sentParts = 1;
      }
    } else if (pending.length) {
      const rs = await Promise.all(pending.map((part) => submit(part)));
      if (rs.some((r) => r === false)) return "failed";
      const firstIds = rs.map((r) => r.jobIds[0]).filter(Boolean);
      if (firstIds.length > 1 && firstIds.every((j) => j === firstIds[0])) {
        _setJobMode("single");
        console.log("[SAVE] forum now reuses one job -> one part at a time from now on");
      }
      sentParts += pending.length;
      pending = [];
    }
    console.log("[SAVE] submitted " + total + " decision(s), " + sentParts + " part(s)" +
      (jobs.size ? ", forum job(s) " + [...jobs.keys()].join(",") : ""));
    _saveProgress(0, total);

    let calm = 0;
    let seenN = remaining.length;
    while (!finished) {
      await nap(calm > 3 ? 2000 : 1000);
      if (finished) break;

      const jobsDoneSeen = jobs.size > 0 && [...jobs.values()].every((j) => j.done);
      const doneSeen = lastDoneAt;
      const genSeen = genDoneAt;

      const snap = await _queueSnapshot(remaining,
        calm >= 1 || jobsDoneSeen || (genericDriver && genSeen > lastSubmitAt));
      (snap.docs || []).forEach((d) => _prewarmFromDoc(d, ids));
      if (snap.still) {
        if (snap.still.length < seenN) { lastProgressAt = Date.now(); calm = 0; } else calm++;
        seenN = snap.still.length;

        if (snap.verified) remaining = snap.still;
        _saveProgress(total - snap.still.length, total);
        if (snap.verified && !remaining.length) { finished = "done"; break; }
      }
      if (finished) break;

      const genIdle = !genericDriver || (genSeen > lastSubmitAt && genSeen > genBusyAt);
      const allJobsDone = genIdle && (jobs.size > 0
        ? jobsDoneSeen && doneSeen > lastSubmitAt
        : genericDriver);
      const longQuiet = Date.now() - Math.max(lastProgressAt, lastResubmitAt) > 2 * LEFTOVER_QUIET_MS;
      if (snap.still && snap.verified && (allJobsDone || longQuiet) && remaining.length && resubmits < 3) {
        const left = remaining.slice();
        pending = [];
        resubmits++;
        console.log("[SAVE] " + left.length + " left after the job — submitting them again (" + resubmits + ")");
        const r = await submit(left);
        if (!r) return "failed";

        lastResubmitAt = Date.now();
        calm = 0;
        continue;
      }
      if (Date.now() - lastProgressAt > SAVE_STALL_MS || Date.now() - start > SAVE_MAX_MS) finished = "stalled";
    }
    if (finished === "done") return "done";
    if (finished === "failed") return "failed";

    console.warn("[SAVE] no progress for " + (SAVE_STALL_MS / 1000) + " s — " +
      remaining.length + " left, using the forum's Save button");
    await _waitForBans();
    return _clickSave(saveBtn, remaining.length ? remaining : ids);
  }

  function _clickSave(saveBtn, ids) {
    _saveStateSet({ ids: ids, ts: Date.now(), attempt: 3, method: "click" });
    _markQueueResume();
    _stopReasonGuards();
    _saveProgress(0, ids.length, "Forum is saving");
    _withForeignOff(() => saveBtn.click());
    return _watchClickSave(ids);
  }
  async function _watchClickSave(ids) {
    const r = await _waitForProcessing(ids, [], false, "Forum is saving");
    if (r.status === "done") {

      await _sleep(3000);
      return "done";
    }
    let err = "";
    try {
      const box = document.querySelector(
        ".overlay-container.is-active .blockMessage--error, .blockMessage--error, .formRow--error");
      err = box ? (box.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) : "";
    } catch (_) {}
    _saveFailed(ids, "The forum has not processed " + r.remaining.length + " of " + ids.length +
      " decisions for " + Math.round(SAVE_STALL_MS / 1000) + " s.", err ? "Forum: " + err : "");
    return "failed";
  }

  const _prewarmSeen = new Set();
  const _prewarmAltSeen = new Set();
  const _prewarmAltJobs = new Set();
  const _prewarmJobs = new Set();
  function _prewarmFromDoc(doc, skipIds) {
    try {
      const ips = [];
      const texts = [];
      doc.querySelectorAll(".message").forEach((m) => {
        const radio = m.querySelector('input[type="radio"][name^="queue[user]["]');
        const id = _userIdFromRadio(radio);
        if (!id || skipIds.indexOf(id) !== -1 || _prewarmSeen.has(id)) return;
        _prewarmSeen.add(id);
        if (_isFemaleRow(m)) return;
        const ip = _prefetchIpFromMessage(m);
        if (ip) ips.push(ip);
        const rf = m.querySelector('dl[data-field="why_join"] dd');
        const text = rf ? rf.textContent.trim() : "";
        if (!text) return;
        const wc = text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
        if (wc < 5) return;
        const span = m.querySelector('a.username span[class*="username--style"]');
        if (span && [...span.classList].some((c) => /^username--style[56]/i.test(c))) return;
        texts.push({ ip: ip, text: text });
      });

      if (_roleCanAccessAltList()) {
        doc.querySelectorAll(".message").forEach((m) => {
          const radio = m.querySelector('input[type="radio"][name^="queue[user]["]');
          const id = _userIdFromRadio(radio);
          if (!id || skipIds.indexOf(id) !== -1 || _prewarmAltSeen.has(id) || !_prefetchIsAlt(m)) return;
          _prewarmAltSeen.add(id);
          const url = getAltProfileUrlFromLog(m);
          if (!url) return;
          const job = fetchAltAccounts(url).then((accs) =>
            Promise.all((accs || []).map((acc) => fetchUserState(acc.url).catch(() => null))))
            .catch(() => null);
          _prewarmAltJobs.add(job);
          job.then(() => _prewarmAltJobs.delete(job));
        });
      }
      if (!ips.length && !texts.length) return;
      const p = _vpnBatch(ips).then(() => {
        if (!OWN_ZEROGPT_KEY && !SAPLING_KEY) return null;
        return Promise.all(texts
          .filter((t) => !t.ip || ipCache[t.ip] === false)
          .map((t) => checkAiWithZeroGpt(t.text).catch(() => null)));
      }).catch(() => null);
      _prewarmJobs.add(p);
      p.then(() => _prewarmJobs.delete(p));
      console.log("[PREFETCH] next page: " + ips.length + " IP(s), " + texts.length + " text(s)");
    } catch (_) {}
  }

  function _appId(message, cascadeUsername) {
    const reasonField = message.querySelector('dl[data-field="why_join"] dd');
    let text = "";
    try { text = (reasonField?.textContent || "").trim().slice(0, 200); } catch (_) {}
    const name = cascadeUsername || "?";
    let h = 5381;
    const s = name + "|" + text;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  function _decidePendingBan(liveState, markupBanned) {
    if (markupBanned) return "done";
    const live = String(liveState || "").toLowerCase();
    if (live && /ban|disabled|suspended|spam|moderat|locked/.test(live)) return "done";
    return "resume";
  }

  const BAN_RESUME_OWN_MS = (() => {
    try {
      const v = Number(localStorage.getItem("__lmqBanResumeOwnMs"));
      return v >= 1000 && v < 45000 ? v : 45000;
    } catch (_) { return 45000; }
  })();
  const BAN_RESUME_FOREIGN_MS = 10 * 60 * 1000;
  const BAN_SEEN_KEY = "__lmqBanSeen";
  function _banSeenAt(key) {
    try {
      const o = JSON.parse(localStorage.getItem(BAN_SEEN_KEY) || "{}") || {};
      const now = Date.now();
      Object.keys(o).forEach((k) => { if (!o[k] || now - o[k] > 3 * 60 * 60 * 1000) delete o[k]; });
      if (!o[key]) o[key] = now;
      localStorage.setItem(BAN_SEEN_KEY, JSON.stringify(o));
      return o[key];
    } catch (_) { return Date.now(); }
  }

  async function _banResumeDecision(message, user, dedup, flags, action) {
    const key = _appId(message, user);
    let d = dedup || { processed: false };
    if (d.processed && d.status === "done") return { verdict: "done", dedup: d };
    const locTs = _localGet(key);
    const loc = locTs ? _localStatus(key) : null;

    if (loc === "failed" || loc === "gaveup") {
      d = { processed: true, status: loc, action: d.action || null, source: "local" };
    }
    if (!d.processed) return { verdict: "fresh", dedup: d };
    const st = d.status;
    if (st === "gaveup") return { verdict: "gaveup", dedup: d };
    if (st === "failed") {
      if (d.source !== "local") return { verdict: "fresh", dedup: d };

      const old = Date.now() - (locTs || 0) > 5 * 60 * 1000;
      return { verdict: "resume", verify: old, dedup: d,
        why: "own ban failed — again" + (old ? ", profile checked first" : "") };
    }
    if (st !== "pending" && st !== "unknown") return { verdict: "other", dedup: d };

    const pa = String(d.action || "");
    if (pa && !/^\s*ban/i.test(pa)) return { verdict: "other", dedup: d };
    const own = !!locTs && (loc === "pending" || loc === "unknown");
    const age = Date.now() - (own ? locTs : _banSeenAt(key));
    const need = own ? BAN_RESUME_OWN_MS : BAN_RESUME_FOREIGN_MS;
    if (age >= need) {
      return { verdict: "resume", verify: true, dedup: d,
        why: (own ? "own" : "other device's") + " ban " +
          (st === "pending" ? "interrupted" : "unclear") + " — continued, profile checked first" };
    }

    if (action === "ban") {
      let banned = !!(flags && flags.isApplicantBanned);
      if (!banned) {
        const al = message.querySelector(".message-userDetails a.username, a.username");
        if (al) banned = (await _isBannedNow(al.getAttribute("href"))) === true;
      }
      if (banned) {
        markProcessed(message, user, "done", "ban");
        return { verdict: "done", why: "banned already",
          dedup: { processed: true, status: "done", action: "ban", source: "check" } };
      }
    }
    const left = Math.max(1000, need - age);
    return { verdict: "wait", waitMs: left, dedup: d,
      text: (own ? "Ban was still running" : "Another mod's ban is still running") +
        " — checks again by itself in " + Math.ceil(left / 1000) + " s." };
  }

  function _scheduleRowRecheck(message, ms) {
    const epoch = _pageEpoch;
    setTimeout(() => {
      if (epoch !== _pageEpoch || !message.isConnected || _saveInFlight) return;
      if (!_isAutoKind(message.dataset.manualKind || "")) return;
      console.log("[AUTO] checking a held application again by itself");
      _rerunTransientRows([message]);
    }, Math.max(500, ms) + 300);
  }

  function _dedupBlocksExecution(dedup, action) {
    if (!dedup || !dedup.processed) return false;
    if (dedup.status === "failed") return false;
    if (dedup.status === "unknown") return true;
    const m = String(dedup.action || "").match(/^\s*([A-Za-z][A-Za-z-]*)/);
    const stored = m ? m[1] : "";
    if (!stored) return true;
    if (/^ban/i.test(stored)) return true;
    if (stored === action) return true;
    return false;
  }

  const SERVER_BASE = AI_DECIDE_URL.replace(/\/decide$/, "");
  const DEDUP_URL = SERVER_BASE + "/processed";

  function _localGet(key) {
    try {
      const data = _loadProcessed();
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    } catch (_) { return null; }
  }
  function _localStatus(key) {
    try { return localStorage.getItem(PROCESSED_KEY + ":st:" + key) || "done"; }
    catch (_) { return "done"; }
  }
  function _localPut(key, status) {
    try {
      const data = _loadProcessed();
      data[key] = Date.now();
      _procRaw = JSON.stringify(data);
      localStorage.setItem(PROCESSED_KEY, _procRaw);
      localStorage.setItem(PROCESSED_KEY + ":st:" + key, status || "done");
    } catch (_) {}
  }
  function _localDedup(key) {
    const ts = _localGet(key);
    return ts
      ? { processed: true, status: _localStatus(key), source: "local" }
      : { processed: false, status: null, source: "local" };
  }

  const _dedupPrefetched = new Map();

  function _dedupKeyForMessage(message) {
    const el = message.querySelector(
      ".message-userDetails a.username, a.username",
    );
    return _appId(message, el ? el.textContent : null);
  }

  async function _dedupBatchPrefetch(messages) {
    const keys = [];
    for (const message of messages) {
      if (message.dataset.decisionChecked) continue;
      const k = _dedupKeyForMessage(message);
      if (k && !_dedupPrefetched.has(k)) { keys.push(k); _dedupPrefetched.set(k, null); }
    }
    if (!keys.length) return;

    if (_dedupServerDown()) {
      keys.forEach((k) => _dedupPrefetched.set(k, Promise.resolve(_localDedup(k))));
      return;
    }

    const batch = new Promise((resolve) => {
      let settled = false;
      const fin = (v) => {
        if (settled) return;
        settled = true;
        if (v === null) _markDedupServerDown();
        else _dedupServerOk();
        resolve(v);
      };
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: DEDUP_URL + "/batch",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": ZEROGPT_API_KEY,
          },
          data: JSON.stringify({ keys: keys }),
          timeout: 2500,
          onload(res) {
            try {
              const d = JSON.parse(res.responseText);
              if (res.status === 200 && d && d.results) return fin(d.results);
            } catch (_) {}
            fin(null);
          },
          onerror() { fin(null); },
          ontimeout() { fin(null); },
        });
      } catch (_) { fin(null); }
    });

    keys.forEach((k) => {
      _dedupPrefetched.set(k, batch.then((results) => {
        const r = results && results[k];
        if (r && typeof r.processed === "boolean") {
          return {
            processed: r.processed,
            status: r.processed ? (r.status || "done") : null,
            action: r.processed ? (r.action || null) : null,
            source: "server-batch",
          };
        }
        return _localDedup(k);
      }));
    });

    const results = await batch;
    console.log("[PREFETCH] dedup: " + keys.length + " key(s) in 1 request" +
      (results ? "" : " (server unreachable -> local)"));
  }

  function _parseStoredAction(stored) {
    if (!stored) return null;
    const m = String(stored).match(
      /^\s*([A-Za-z][A-Za-z-]*)\s*(?:\(([^)]*)\))?/);
    if (!m) return null;
    const action = m[1];
    let reasonKey = m[2] ? m[2].trim() : null;
    if (reasonKey && /^angefordert$/i.test(reasonKey)) reasonKey = null;
    if (!reasonKey) reasonKey = null;
    const allowed = ["reject", "ban"];
    if (allowed.indexOf(action) === -1) return null;
    return { action: action, reasonKey: reasonKey };
  }

  function wasRecentlyProcessed(message, cascadeUsername) {
    const key = _appId(message, cascadeUsername);
    const pre = _dedupPrefetched.get(key);
    if (pre) return pre;
    if (_dedupServerDown()) return Promise.resolve(_localDedup(key));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const fallback = () => finish(_localDedup(key));
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url: DEDUP_URL + "/" + encodeURIComponent(key),
          headers: { "X-Api-Key": ZEROGPT_API_KEY },
          timeout: 2500,
          onload(res) {
            try {
              const d = JSON.parse(res.responseText);
              if (res.status === 200 && typeof d.processed === "boolean") {
                return finish({
                  processed: d.processed,
                  status: d.processed ? (d.status || "done") : null,
                  action: d.processed
                    ? (d.action || (d.entry && d.entry.action) || null)
                    : null,
                  source: "server",
                });
              }
            } catch (_) {}
            fallback();
          },
          onerror() { fallback(); },
          ontimeout() { fallback(); },
        });
      } catch (_) { fallback(); }
    });
  }

  function markProcessed(message, cascadeUsername, status, action) {
    const key = _appId(message, cascadeUsername);
    const st = status || "done";
    _localPut(key, st);
    if (_serverOff()) return;
    try {
      _markBuffer.push({
        key: key,
        status: st,
        user: cascadeUsername || "",
        action: action || "",
      });
      if (_markBuffer.length > BULK_MAX_BUFFER) {
        _markBuffer = _markBuffer.slice(-BULK_MAX_BUFFER);
      }
      _bulkFlushSoon();
    } catch (_) {}
  }

  const BAN_RETRY_MAX = 6;
  const BAN_ATTEMPTS_KEY = "__xfBanAttempts";
  function _banAttemptsLoad() {
    try {
      const o = JSON.parse(localStorage.getItem(BAN_ATTEMPTS_KEY) || "{}") || {};
      const now = Date.now();
      Object.keys(o).forEach((k) => { if (!o[k] || now - o[k].ts > 3 * 60 * 60 * 1000) delete o[k]; });
      return o;
    } catch (_) { return {}; }
  }
  function _banAttemptBump(key) {
    const o = _banAttemptsLoad();
    const n = ((o[key] && o[key].n) || 0) + 1;
    o[key] = { n: n, ts: Date.now() };
    try { localStorage.setItem(BAN_ATTEMPTS_KEY, JSON.stringify(o)); } catch (_) {}
    return n;
  }
  function _banAttemptClear(key) {
    try {
      const o = _banAttemptsLoad();
      if (o[key]) { delete o[key]; localStorage.setItem(BAN_ATTEMPTS_KEY, JSON.stringify(o)); }
    } catch (_) {}
  }

  function _holdRowForManual(message, ui, text, kind) {
    try {
      const uid = _userIdFromMessage(message);
      if (uid) _reasonGuards.delete(String(uid));
      const radios = message.querySelectorAll('input[type="radio"][name^="queue[user]["]');
      let nothing = null;
      radios.forEach((r) => { if (r.value === "") nothing = r; });
      if (nothing) _setRadio(nothing);
      radios.forEach((r) => {
        if (r !== nothing && r.checked) {
          r.checked = false;
          r.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      const inp = _findReasonInput(message, uid);
      if (inp) _setNativeValue(inp, "");
      _intended.delete(message);
      const k = kind || "ban";
      _markManual(message, k);
      if (ui) {
        if (_isAutoKind(k)) {
          ui.verdict("run", "Retrying", text);
          ui.exec("wait", "tries again by itself");
        } else {
          ui.verdict("man", "Manual", text);
          ui.exec("err", k === "ban" ? "ban failed" : "needs you");
        }
      }
    } catch (e) {
      console.error("[AUTO] hold row failed:", e);
    }
  }

  function _finalizeExecution(ui, message, cascadeUsername, action,
                              reasonKey, status, banError, banPermanent) {
    const label = action + (reasonKey ? " (" + reasonKey + ")" : "");
    const who = cascadeUsername || "?";
    if (/^ban/.test(action) && status !== "done") {

      try {
        _statsRecord(cascadeUsername, action, status, _statCategory(action, reasonKey, ""));
      } catch (_) {}
      const key = _appId(message, cascadeUsername);
      const n = _banAttemptBump(key);
      const giveUp = !!banPermanent || n >= BAN_RETRY_MAX;
      let txt;
      if (giveUp) {
        markProcessed(message, cascadeUsername, "gaveup", label);
        txt = "Ban failed" + (banPermanent ? "" : " after " + n + " tries") +
          (banError ? " (" + banError + ")" : "") + " — stays in the queue, please ban by hand.";
        _holdRowForManual(message, ui, txt, "ban");
      } else {

        if (status === "failed") _localPut(key, "failed");
        else markProcessed(message, cascadeUsername, "unknown", label);
        txt = "Ban not through yet" + (banError ? " (" + banError + ")" : "") +
          " — tries again by itself (" + n + "/" + BAN_RETRY_MAX + ").";
        _holdRowForManual(message, ui, txt, "ban-retry");
      }
      console.warn("[AUTO] " + who + " -> " + label + ": " + txt);
      return;
    }
    let statCategory = null;
    try {
      const intent = _intended.get(message);
      if (intent) {
        intent.status = status;
        statCategory = intent.category || null;
      }
    } catch (_) {}
    try {
      _statsRecord(cascadeUsername, action, status,
        statCategory || _statCategory(action, reasonKey, ""));
    } catch (_) {}
    const setBadge = (state, text) => {
      try { if (ui) ui.exec(state, text); } catch (_) {}
    };
    try {
      if (status === "done") {
        markProcessed(message, cascadeUsername, "done", label);
        setBadge("ok", /^ban/.test(action) ? "✓ ban done" : "✓ set");
        console.log("[AUTO] confirmed: " + who + " -> " + label);
        if (/^ban/.test(action)) {
          _banAttemptClear(_appId(message, cascadeUsername));

          try {
            const link = message.querySelector(".message-userDetails a.username, a.username");
            const url = link ? normalizeProfileUrl(link.getAttribute("href")) : null;
            const list = _banCheckLoad();
            const rest = list.filter((e) => e.url !== url);
            if (rest.length !== list.length) { _banCheckSave(rest); _renderBanCheckPanel(); }
          } catch (_) {}
        }
        return;
      }
      if (status === "failed") {
        setBadge("err", "not executed — retry possible");
        console.warn("[AUTO] failed: " + who + " -> " + label +
          " (not marked as done)");
        return;
      }
      markProcessed(message, cascadeUsername, "unknown", label);
      setBadge("warn", "unconfirmed — check manually");
      console.warn("[AUTO] unconfirmed: " + who + " -> " + label +
        " (execution not verifiable)");
    } catch (e) {
      console.error("[AUTO] finalization failed:", e);
    }
  }

  const BAN_CONFIRM_REQUIRED = false;
  const _banConfirmQueue = [];
  let _banConfirmBtn = null;

  function _openBanEntries() {
    return _banConfirmQueue.filter((e) =>
      !e.done && (!e.message || e.message.isConnected));
  }

  function _updateBanConfirmButton() {
    try {
      const n = _openBanEntries().length;
      if (!_banConfirmBtn) {
        if (!n || !document.body) return;
        _banConfirmBtn = document.createElement("button");
        _banConfirmBtn.type = "button";
        _banConfirmBtn.id = "xfBanConfirmBtn";
        _banConfirmBtn.className = "lmq-btn lmq-btn--danger";
        _banConfirmBtn.addEventListener("click", (e) => {
          e.preventDefault();
          _runConfirmedBans();
        });
        document.body.appendChild(_banConfirmBtn);
      }
      _banConfirmBtn.textContent =
        n === 1 ? "Run 1 ban" : "Run " + n + " bans";
      _banConfirmBtn.style.display = n ? "" : "none";
    } catch (_) {}
  }

  function _queueBanForConfirmation(entry) {
    entry.done = false;
    entry.runOnce = () => {
      if (entry.done) return;
      entry.done = true;
      const i = _banConfirmQueue.indexOf(entry);
      if (i !== -1) _banConfirmQueue.splice(i, 1);
      try { if (entry.rowBtn) entry.rowBtn.remove(); } catch (_) {}
      _updateBanConfirmButton();
      try { entry.run(); }
      catch (e) { console.error("[BAN-CONFIRM] start failed:", e); }
    };
    try {
      if (entry.container) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "lmq-btn lmq-btn--danger lmq-btn--sm xf-ban-confirm-row";
        b.style.marginTop = "8px";
        b.textContent = "Run ban";
        b.addEventListener("click", (e) => {
          e.preventDefault();
          if (!window.confirm("Run ban?\n\n" +
            entry.who + " → " + entry.label)) return;
          entry.runOnce();
        });
        entry.container.appendChild(b);
        entry.rowBtn = b;
      }
    } catch (_) {}
    _banConfirmQueue.push(entry);
    _updateBanConfirmButton();
  }

  function _runConfirmedBans() {
    const open = _openBanEntries();
    if (!open.length) { _updateBanConfirmButton(); return; }
    const list = open.map((e) => "• " + e.who + " → " + e.label).join("\n");
    if (!window.confirm("Run " + open.length + " ban(s) now?\n\n" + list)) {
      return;
    }
    open.forEach((e) => e.runOnce());
  }

  const AUDIT_KEY = "__aiAuditLog";
  let _auditBuf = [];
  let _auditTimer = 0;
  function _auditFlush() {
    if (_auditTimer) { clearTimeout(_auditTimer); _auditTimer = 0; }
    if (!_auditBuf.length) return;
    const add = _auditBuf;
    _auditBuf = [];
    try {
      const list = (JSON.parse(localStorage.getItem(AUDIT_KEY) || "[]") || []).concat(add);
      localStorage.setItem(AUDIT_KEY, JSON.stringify(list.slice(-200)));
    } catch (_) {}
  }
  function pushAudit(entry) {
    _auditBuf.push(entry);
    if (!_auditTimer) _auditTimer = setTimeout(_auditFlush, 1500);
  }
  try {
    window.addEventListener("pagehide", _auditFlush);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") _auditFlush(); });
  } catch (_) {}
  window.__aiAudit = function () {
    try {
      return (JSON.parse(localStorage.getItem(AUDIT_KEY) || "[]") || []).concat(_auditBuf).slice(-200);
    } catch (_) {
      return _auditBuf.slice();
    }
  };

  const DECIDE_TIMEOUT_MS = 6000;
  const DECIDE_DOWN_KEY = "__xfDecideDownUntil";
  const DECIDE_DOWN_MS = 12 * 60 * 60 * 1000;
  let _decideDown = null;
  try {
    const until = Number(localStorage.getItem(DECIDE_DOWN_KEY) || 0);
    if (until > Date.now()) _decideDown = "offline (remembered)";
  } catch (_) {}
  function _markDecideDown(why) {
    if (_decideDown) return;
    _decideDown = why;
    try {
      localStorage.setItem(DECIDE_DOWN_KEY, String(Date.now() + DECIDE_DOWN_MS));
    } catch (_) {}
    console.warn("[ON-TOPIC] Server offline (" + why +
      ") — local check takes over for 12 hours");
  }

  const TOPIC_TO_MANUAL = false;
  const _OT_STRONG = [

    /looks? ?max/, /\b(?!cli)\w*maxx?ing\b/, /\baesthetic/, /\bbest version\b/,
    /\blook(ing)? (better|good|great|attractive)\b/, /\bmy looks\b/, /\bmogg?(ing|ed|er|s)?\b/, /\bpsl\b/,
    /\bascen(d|ding|sion)\b/, /\bjaw/, /\bmew(ing)?\b/, /skin ?care/,
    /glow ?up/, /appearance/, /attractive/, /self[- ]?improv/,
    /black ?pill/, /\b(soft|hard)max/, /lookism/, /canthal/, /maxilla/,
    /bone ?smash/, /\bfacial\b/, /\bphysique\b/, /\bgood ?looking\b/,
  ];
  const _OT_WEAK = [
    /\bface\b/, /\bskin\b/, /\bhair(line)?\b/, /\bheight\b/, /\bgym\b/,
    /\bmuscles?\b/, /\bbody\b/, /\bfat\b/, /\bweight\b/, /\bgroom/,
    /\bstyle\b/, /\bfashion\b/, /\bteeth\b/, /\bnose\b/, /\beyes?\b/,
    /\bposture\b/, /\bchin\b/, /\bcheek/, /\bacne\b/, /\bbeard\b/,
    /\bgenetic/, /\bframe\b/, /\bshoulders?\b/, /\bsurgery\b/,
    /\bchad/, /\bconfiden/, /\bugly\b/, /\bhandsome\b/, /\blooks\b/,
    /\bimprove (my|myself|me)\b/, /\bbetter version\b/, /\bdiet\b/,
    /\bworkout\b/, /\blifting\b/, /\bbodyfat\b/, /\bpretty\b/,
    /\bdating\b/, /\bgirls?\b/, /\bwomen\b/, /\binsecur/, /\bself[- ]?esteem\b/,
    /\blean\b/, /\bbulk/,
  ];
  function _localOnTopic(text) {
    const raw = String(text || "");
    const t = raw.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ").trim();
    const words = t.split(" ").filter(Boolean);
    let troll = null;
    if (/([a-z])\1{9,}/i.test(raw)) troll = "repeated characters";
    else if (words.some((w) => w.length > 25)) troll = "keyboard mash";
    else if (words.length >= 10 &&
             new Set(words).size / words.length < 0.35) troll = "repeated words";
    else if (/\b(porn|nudes?|onlyfans|cum|hentai)\b/.test(t)) troll = "explicit words";
    const hits = [];
    _OT_STRONG.forEach((re) => { const m = t.match(re); if (m) hits.push(m[0]); });
    const strong = hits.length;
    _OT_WEAK.forEach((re) => { const m = t.match(re); if (m) hits.push(m[0]); });
    const onTopic = strong >= 1 || hits.length >= 2;
    return { onTopic: onTopic, troll: troll, hits: hits };
  }

  function checkDecisionWithAI(applicationData) {

    if (OWN_ZEROGPT_KEY || SAPLING_KEY || _serverOff()) return Promise.reject(new Error("skipped"));
    if (_decideDown) {
      return Promise.reject(new Error("server offline (" + _decideDown + ")"));
    }
    return _aiEnqueue(
      () =>
        new Promise((resolve, reject) => {
          if (_decideDown) {
            return reject(new Error("server offline (" + _decideDown + ")"));
          }
          const fail = (why) => { _markDecideDown(why); reject(new Error(why)); };
          GM_xmlhttpRequest({
            method: "POST",
            url: AI_DECIDE_URL,
            headers: {
              "Content-Type": "application/json",
              "X-Api-Key": ZEROGPT_API_KEY,
            },
            data: JSON.stringify(applicationData),
            onload: function (res) {
              let data = null;
              try { data = JSON.parse(res.responseText); } catch (_) {}
              if (res.status !== 200 || !data) {
                return fail((data && data.error) || ("HTTP " + res.status));
              }
              if (data.action !== "approve" && data.action !== "reject") {
                return reject(new Error("unexpected answer"));
              }
              resolve(data);
            },
            onerror: function () {
              fail("not reachable");
            },
            ontimeout: function () {
              fail("no answer after " + (DECIDE_TIMEOUT_MS / 1000) + "s");
            },
            timeout: DECIDE_TIMEOUT_MS,
          });
        }),
    );
  }

  let _zgActive = 0;
  const _zgQueue = [];
  function _zgEnqueue(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        _zgActive++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            _zgActive--;
            if (_zgQueue.length) _zgQueue.shift()();
          });
      };
      if (_zgActive < CHECK_BATCH_SIZE) run();
      else _zgQueue.push(run);
    });
  }

  const ZG_CACHE_KEY = "__zgScoreCacheV1";
  const ZG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const ZG_CACHE_MAX = 3000;
  let _zgCache = null;
  let _zgCacheTimer = null;
  const _zgInflight = new Map();
  function _zgCacheLoad() {
    if (_zgCache) return _zgCache;
    try { _zgCache = JSON.parse(localStorage.getItem(ZG_CACHE_KEY) || "{}") || {}; }
    catch (_) { _zgCache = {}; }
    return _zgCache;
  }
  function _zgCacheSaveSoon() {
    if (_zgCacheTimer) return;
    _zgCacheTimer = setTimeout(_zgCacheSaveNow, 150);
  }
  try {

    window.addEventListener("pagehide", () => { if (_zgCacheTimer) _zgCacheSaveNow(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && _zgCacheTimer) _zgCacheSaveNow();
    });

    document.addEventListener("submit", () => { if (_zgCacheTimer) _zgCacheSaveNow(); }, true);
  } catch (_) {}
  function _zgCacheSaveNow() {
    if (_zgCacheTimer) clearTimeout(_zgCacheTimer);
    _zgCacheTimer = null;
    try {
      const c = _zgCacheLoad();
      const now = Date.now();
      const keys = Object.keys(c).filter((k) => {
        if (!c[k] || now - c[k].ts > ZG_CACHE_TTL_MS) { delete c[k]; return false; }
        return true;
      });
      if (keys.length > ZG_CACHE_MAX) {
        keys.sort((a, b) => c[a].ts - c[b].ts);
        keys.slice(0, keys.length - ZG_CACHE_MAX).forEach((k) => { delete c[k]; });
      }
      localStorage.setItem(ZG_CACHE_KEY, JSON.stringify(c));
    } catch (_) {}
  }
  function _zgHash(text) {
    const s = String(text || "").trim();
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ":" + h;
  }

  function checkAiWithZeroGpt(text) {
    const c = _zgCacheLoad();
    const k = (SAPLING_KEY ? "sp:" : "") + _zgHash(text);
    const e = c[k];
    if (e && Date.now() - e.ts < ZG_CACHE_TTL_MS && Number.isFinite(e.p)) {
      return Promise.resolve({ percentage: e.p, summary: null, cached: true });
    }
    if (_zgInflight.has(k)) return _zgInflight.get(k);
    const p = _zgEnqueue(() => _zgCheckRaw(text)).then((r) => {
      const v = r ? Number(r.percentage) : NaN;
      if (r && r.percentage !== null && r.percentage !== undefined &&
          Number.isFinite(v)) {
        c[r.via === "ZeroGPT" ? _zgHash(text) : k] = { p: v, ts: Date.now() };
        _zgCacheSaveSoon();
        LMS.svc("zerogpt", true);
      } else {
        LMS.svc("zerogpt", false, "no score in the answer");
      }
      return r;
    }, (e) => {
      LMS.svc("zerogpt", false, e && e.message);
      throw e;
    });
    _zgInflight.set(k, p);
    p.finally(() => _zgInflight.delete(k)).catch(() => {});
    return p;
  }

  const ZEROGPT_DIRECT_URL = "https://api.zerogpt.com/api/detect/detectText";

  function _zgDirectOnce(text) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle = null;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        fn(arg);
      };
      const watchdog = setTimeout(() => {
        try { if (handle && handle.abort) handle.abort(); } catch (_) {}
        const e = new Error("ZeroGPT timed out (watchdog)");
        e.retry = false;
        done(reject, e);
      }, _zgWatchdogMs());
      try {
        handle = GM_xmlhttpRequest({
          method: "POST",
          url: ZEROGPT_DIRECT_URL,
          headers: {
            "Content-Type": "application/json",
            "ApiKey": OWN_ZEROGPT_KEY,
          },
          data: JSON.stringify({ input_text: text }),
          timeout: 60000,
          onload(res) {
            let d = null;
            try { d = JSON.parse(res.responseText); } catch (_) {}
            if (!d) {
              const e = new Error("ZeroGPT: unreadable response (HTTP " + res.status + ")");
              e.retry = res.status === 429 || res.status >= 500;
              return done(reject, e);
            }
            const inner = d.data && typeof d.data === "object" ? d.data : {};
            const raw = inner.fakePercentage !== undefined
              ? inner.fakePercentage
              : inner.fake_percentage;
            const pct = Number(raw);
            const ok = res.status === 200 && d.success !== false &&
              raw !== null && raw !== undefined && raw !== "" &&
              Number.isFinite(pct) && pct >= 0 && pct <= 100;
            if (!ok) {
              console.warn("[AI Check] ZeroGPT response:",
                String(res.responseText || "").slice(0, 300));
              const msg = d.message || d.error || inner.message ||
                (res.status === 200
                  ? "unexpected response (no fakePercentage)"
                  : "HTTP " + res.status);
              const e = new Error("ZeroGPT: " + msg);
              e.retry = res.status === 429 || res.status >= 500;
              return done(reject, e);
            }
            console.log("[AI Check] ZeroGPT direct: " + pct + "%");
            done(resolve, { percentage: Math.round(pct * 10) / 10,
                            summary: inner.feedback || null });
          },
          onerror() {
            const e = new Error("ZeroGPT not reachable");
            e.retry = true;
            done(reject, e);
          },
          ontimeout() {
            const e = new Error("ZeroGPT timed out");
            e.retry = true;
            done(reject, e);
          },
        });
      } catch (err) {
        const e = new Error("ZeroGPT request could not start: " + (err && err.message));
        e.retry = false;
        done(reject, e);
      }
    });
  }

  async function _zgDirect(text) {
    try {
      return await _zgDirectOnce(text);
    } catch (e) {
      if (!e.retry) throw e;
      await new Promise((r) => setTimeout(r, 2000));
      return _zgDirectOnce(text);
    }
  }

  const SAPLING_URL = "https://api.sapling.ai/api/v1/aidetect";
  const SP_MAX_CHARS = 1500;
  const SP_BATCH = 10, SP_WAIT_MS = 60, SP_MAX_INFLIGHT = 3;
  const SP_USAGE_KEY = "saplingUsageV1", SP_PAUSE_KEY = "saplingPauseV1";
  const SP_FREE_MONTH = 250000;
  const _spQ = [];
  let _spTimer = 0, _spInflight = 0;
  function _spMonth() { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1); }
  function _spUsage() {
    try {
      const u = JSON.parse(GM_getValue(SP_USAGE_KEY, "") || "null");
      if (u && u.m === _spMonth()) return u;
    } catch (_) {}
    return { m: _spMonth(), c: 0, n: 0 };
  }
  function _spCount(chars, n) {
    const u = _spUsage();
    u.c += chars;
    u.n += n;
    try { GM_setValue(SP_USAGE_KEY, JSON.stringify(u)); } catch (_) {}
  }
  function _spUsageText() {
    const u = _spUsage();
    const k = (n) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
    return "Sapling · " + k(u.c) + " of " + k(SP_FREE_MONTH) + " characters this month (this device)";
  }
  function _spPause(ms, why) {
    try { GM_setValue(SP_PAUSE_KEY, JSON.stringify({ until: Date.now() + ms, why: why })); } catch (_) {}
  }
  function _spPaused() {
    try {
      const p = JSON.parse(GM_getValue(SP_PAUSE_KEY, "") || "null");
      if (p && p.until > Date.now()) return p;
    } catch (_) {}
    return null;
  }
  function _spPrep(text) { return String(text || "").replace(/\s+/g, " ").trim().slice(0, SP_MAX_CHARS); }

  function _spRequestOnce(texts) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle = null;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        fn(arg);
      };
      const watchdog = setTimeout(() => {
        try { if (handle && handle.abort) handle.abort(); } catch (_) {}
        const e = new Error("Sapling timed out (watchdog)");
        e.retry = false;
        done(reject, e);
      }, _zgWatchdogMs() + (texts.length > 1 ? 4000 : 0));

      const body = texts.length === 1
        ? { key: SAPLING_KEY, text: texts[0], sent_scores: false }
        : { key: SAPLING_KEY, texts: texts, sent_scores: false };
      try {
        handle = GM_xmlhttpRequest({
          method: "POST",
          url: SAPLING_URL,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify(body),
          timeout: 60000,
          onload(res) {
            let d = null;
            try { d = JSON.parse(res.responseText); } catch (_) {}
            if (res.status === 200 && d) {
              const list = texts.length === 1 ? [d] : (Array.isArray(d.results) ? d.results : null);
              const sc = list && list.length === texts.length ? list.map((r) => Number(r && r.score)) : null;
              if (sc && sc.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
                _spCount(texts.reduce((a, t) => a + t.length, 0), texts.length);
                return done(resolve, sc.map((v) => Math.round(v * 1000) / 10));
              }
              console.warn("[AI Check] Sapling response:", String(res.responseText || "").slice(0, 300));
              const e = new Error("Sapling: unexpected response (no score)");
              e.retry = false;
              e.split = texts.length > 1;
              return done(reject, e);
            }
            const msg = (d && (d.msg || d.message || d.error)) || "HTTP " + res.status;
            const e = new Error("Sapling: " + msg);
            e.retry = false;

            const quotaText = /limit|quota|exceed|credit|insufficient/i.test(String(msg));
            if (res.status === 429 || (quotaText && res.status !== 401)) {

              const monthly = /month/i.test(String(msg)) || _spUsage().c >= SP_FREE_MONTH * 0.95;
              const ra = d ? Number(d.retry_after) : NaN;
              const ms = monthly ? 6 * 3600e3
                : Number.isFinite(ra) && ra > 0 && ra < 3600 ? Math.max(30e3, ra * 1000) : 60 * 60e3;
              const why = monthly ? "free monthly quota used up" : "free daily quota used up";
              _spPause(ms, why);
              e.message = "Sapling: " + why;
              e.paused = true;
            } else if (res.status === 401 || res.status === 403) {
              _spPause(10 * 60e3, "key not accepted");
              e.message = "Sapling: key not accepted (HTTP " + res.status + ")";
              e.paused = true;
            } else if (res.status === 400) {

              if (/unexpected error/i.test(String(msg))) e.retry = true;
              e.split = texts.length > 1;
            } else if (res.status >= 500) {
              e.retry = true;
            }
            done(reject, e);
          },
          onerror() {
            const e = new Error("Sapling not reachable");
            e.retry = true;
            done(reject, e);
          },
          ontimeout() {
            const e = new Error("Sapling timed out");
            e.retry = true;
            done(reject, e);
          },
        });
      } catch (err) {
        const e = new Error("Sapling request could not start: " + (err && err.message));
        e.retry = false;
        done(reject, e);
      }
    });
  }
  async function _spRequest(texts) {
    try {
      return await _spRequestOnce(texts);
    } catch (e) {
      if (!e.retry) throw e;
      await _sleep(1500);
      return _spRequestOnce(texts);
    }
  }
  function _spFlush() {
    clearTimeout(_spTimer);
    _spTimer = 0;

    const pz = _spQ.length ? _spPaused() : null;
    if (pz) {
      const e = new Error("Sapling " + pz.why);
      e.retry = false;
      e.paused = true;
      _spQ.splice(0).forEach((j) => j.reject(e));
      return;
    }
    while (_spQ.length && _spInflight < SP_MAX_INFLIGHT) {
      const batch = _spQ.splice(0, SP_BATCH);
      _spInflight++;
      _spRequest(batch.map((j) => j.text))
        .then((pcts) => batch.forEach((j, i) => j.resolve({ percentage: pcts[i], summary: null })),
          (e) => {
            if (!e.split) { batch.forEach((j) => j.reject(e)); return; }

            batch.forEach((j) => _spRequest([j.text]).then(
              (p) => j.resolve({ percentage: p[0], summary: null }), (e2) => j.reject(e2)));
          })
        .finally(() => { _spInflight--; if (_spQ.length) _spFlush(); });
    }
  }
  function _spCheck(text) {
    return new Promise((resolve, reject) => {
      const pz = _spPaused();
      if (pz) {
        const mins = Math.max(1, Math.round((pz.until - Date.now()) / 60000));
        const e = new Error("Sapling " + pz.why + ", next try in " +
          (mins >= 90 ? Math.round(mins / 60) + " h" : mins + " min"));
        e.retry = false;
        e.paused = true;
        return reject(e);
      }
      const t = _spPrep(text);
      if (!t) { const e = new Error("Sapling: empty text"); e.retry = false; return reject(e); }
      _spQ.push({ text: t, resolve: resolve, reject: reject });
      if (_spQ.length >= SP_BATCH) _spFlush();
      else if (!_spTimer) _spTimer = setTimeout(_spFlush, SP_WAIT_MS);
    });
  }

  function _zgFallback(text, why) {
    const head = (why || "Sapling paused").replace(/^Sapling[: ]+/i, "Sapling: ");
    if (!OWN_ZEROGPT_KEY) {
      const e = new Error(head + " · no ZeroGPT key to take over (userscript menu → “Set own ZeroGPT key”)");
      e.retry = false;
      return Promise.reject(e);
    }
    return _zgDirect(text).then(
      (r) => (r ? Object.assign({}, r, { via: "ZeroGPT" }) : r),
      (e) => {
        const e2 = new Error(head + " · ZeroGPT: " + String((e && e.message) || "error").replace(/^ZeroGPT[: ]+/i, ""));
        e2.retry = !!(e && e.retry);
        throw e2;
      });
  }
  function _zgCheckRaw(text) {
    if (SAPLING_KEY) {
      const pz = _spPaused();
      if (pz) return _zgFallback(text, "Sapling " + pz.why);
      return _spCheck(text).catch((e) => {
        if (e && e.paused) return _zgFallback(text, e.message);
        throw e;
      });
    }
    if (OWN_ZEROGPT_KEY) return _zgDirect(text);
    if (!_serverOff()) return _zgServer(text);
    const e = new Error("No AI key — set a Sapling or ZeroGPT key in the userscript menu");
    e.retry = false;
    return Promise.reject(e);
  }
  function _zgServer(text) {
    return new Promise((resolve, reject) => {
      console.log(
        "[AI Check] Sending text to VPS proxy:",
        text.substring(0, 100) + "...",
      );
      GM_xmlhttpRequest({
        method: "POST",
        url: ZEROGPT_PROXY_URL,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": ZEROGPT_API_KEY,
        },
        data: JSON.stringify({ text }),
        onload: function (res) {
          try {
            const data = JSON.parse(res.responseText);
            if (res.status !== 200) {
              reject(new Error(data.error || "Server returned " + res.status));
            } else {
              console.log("[AI Check] Result from VPS:", data);
              resolve({ percentage: data.percentage, summary: data.raw });
            }
          } catch (e) {
            reject(new Error("Failed to parse response: " + e.message));
          }
        },
        onerror: function () {
          reject(new Error("Failed to reach VPS proxy"));
        },
        ontimeout: function () {
          reject(new Error("VPS proxy request timed out"));
        },
        timeout: 120000,
      });
    });
  }

  function logError(context, error, extra = {}) {
    console.group(`[UserScript Error] ${context}`);
    console.error("Error:", error);
    console.error("Stack:", error?.stack);
    console.error("Timestamp:", new Date().toISOString());
    console.error("URL:", window.location.href);
    console.error("Extra:", extra);

    console.groupEnd();
  }

  const LMQ_CSS = `
:root{
  --lmq-gold:#e0cd9e;--lmq-gold-2:#f4e7c8;--lmq-gold-dim:rgba(224,205,158,.34);--lmq-gold-faint:rgba(224,205,158,.10);
  --lmq-ink:#0b0b0d;--lmq-s1:#111114;--lmq-s2:#18181c;--lmq-s3:#202026;--lmq-line:rgba(255,255,255,.08);
  --lmq-text:#ece8de;--lmq-muted:#9c978b;
  --lmq-ok:#4cc98a;--lmq-rej:#ff9474;--lmq-ban:#ff5466;--lmq-man:#ffb648;--lmq-info:#8fb6ff;
  --lmq-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.lmq-exec[hidden],.lmq-sum[hidden],.lmq-flags[hidden],.lmq-alts[hidden],.lmq-dock-btn[hidden],.lmq-notice[hidden]{display:none!important}
/* layout fixes from 3.x */
.message-inner{display:flex}
.message-cell{min-width:0}
.message-cell--main{min-width:0;overflow-wrap:anywhere;word-break:break-word}
.message-cell--main :is(img,video,iframe,table,pre){max-width:100%}
/* 4.7: every application is its own layout island: a card changing inside
   one row no longer makes the browser re-check the whole page (measured on a
   replica queue: ~18 % less main-thread work per round). No paint
   containment, so nothing inside a row is ever cut off. */
.message[data-auto-reject]:not(.message .message){contain:layout style}
/* 4.7: 16 px -> the iPhone no longer zooms in when you type a reason */
.message input[name^="reason["],.xf-report-panel textarea{font-size:16px!important}

/* left highlight */
.message.xf-hl{margin:10px 0;border-radius:12px;border-left:3px solid var(--xf-hl-accent,transparent)}
.message.xf-hl .message-cell{background-color:var(--xf-hl-bg,transparent)}
.message[data-manual-kind]{box-shadow:inset 0 0 0 1px rgba(255,182,72,.35)}
.message[data-manual-kind="alt-lookup"],.message[data-manual-kind="vpn"],.message[data-manual-kind="ai"],.message[data-manual-kind="ban-retry"],.message[data-manual-kind="ban-wait"],.message[data-manual-kind="save-error"],.message[data-manual-kind="form-error"]{box-shadow:inset 0 0 0 1px rgba(120,170,255,.35)}

/* tone colors */
.lmq-tone{--t:var(--lmq-gold);--tb:rgba(224,205,158,.10);--tl:rgba(224,205,158,.32)}
.lmq-tone[data-tone=ok]{--t:var(--lmq-ok);--tb:rgba(76,201,138,.12);--tl:rgba(76,201,138,.38)}
.lmq-tone[data-tone=rej]{--t:var(--lmq-rej);--tb:rgba(255,148,116,.12);--tl:rgba(255,148,116,.38)}
.lmq-tone[data-tone=ban]{--t:var(--lmq-ban);--tb:rgba(255,84,102,.13);--tl:rgba(255,84,102,.42)}
.lmq-tone[data-tone=man]{--t:var(--lmq-man);--tb:rgba(255,182,72,.11);--tl:rgba(255,182,72,.40)}
.lmq-tone[data-tone=err]{--t:var(--lmq-ban);--tb:rgba(255,84,102,.10);--tl:rgba(255,84,102,.45)}
.lmq-tone[data-tone=warn]{--t:var(--lmq-man);--tb:rgba(255,182,72,.08);--tl:rgba(255,182,72,.38)}
.lmq-tone[data-tone=mute]{--t:var(--lmq-muted);--tb:rgba(255,255,255,.04);--tl:var(--lmq-line)}

/* decision card */
.lmq-card{margin-top:12px;padding:10px 12px 8px;border-radius:12px;background:linear-gradient(180deg,#141417 0%,#0f0f12 100%);
  border:1px solid var(--lmq-line);border-left:3px solid var(--t);color:var(--lmq-text);font:12.5px/1.45 var(--lmq-font);text-align:left}
.lmq-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.lmq-verdict{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;border-radius:999px;background:var(--tb);border:1px solid var(--tl);
  color:var(--t);font-weight:800;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
.lmq-dot{width:7px;height:7px;border-radius:50%;background:var(--t);flex:0 0 auto}
.lmq-exec{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;
  background:rgba(255,255,255,.05);border:1px solid var(--lmq-line);color:var(--lmq-muted)}
.lmq-exec[data-s=ok]{color:var(--lmq-ok);border-color:rgba(76,201,138,.35);background:rgba(76,201,138,.08)}
.lmq-exec[data-s=run],.lmq-exec[data-s=wait]{color:var(--lmq-gold-2);border-color:var(--lmq-gold-dim);background:var(--lmq-gold-faint)}
.lmq-exec[data-s=warn]{color:var(--lmq-man);border-color:rgba(255,182,72,.4);background:rgba(255,182,72,.08)}
.lmq-exec[data-s=err]{color:#ff8d99;border-color:rgba(255,84,102,.45);background:rgba(255,84,102,.10)}
.lmq-sum{margin-top:7px;color:#cfcabd;font-size:12.5px}
.lmq-acts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.lmq-act{-webkit-appearance:none;appearance:none;min-height:46px;border-radius:12px;font:800 14px/1 var(--lmq-font);letter-spacing:.02em;cursor:pointer;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform .12s ease,background .15s ease,box-shadow .15s ease;white-space:pre}
.lmq-act:active{transform:scale(.97)}
.lmq-act--ok{color:#9ff0c4;background:rgba(76,201,138,.10);border:1px solid rgba(76,201,138,.45)}
.lmq-act--rej{color:#ffc0ad;background:rgba(255,148,116,.10);border:1px solid rgba(255,148,116,.45)}
.lmq-act--ok.is-on{color:#06210f;background:linear-gradient(180deg,#6fe0a6,#3fb57a);border-color:#8ff0bd;box-shadow:0 6px 18px rgba(76,201,138,.28)}
.lmq-act--rej.is-on{color:#2a0d05;background:linear-gradient(180deg,#ffb39b,#f0805f);border-color:#ffc4b2;box-shadow:0 6px 18px rgba(255,148,116,.26)}
.lmq-flags{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.lmq-flag{font-size:11px;font-weight:600;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.05);border:1px solid var(--lmq-line);color:#d3cec2}
.lmq-flag[data-type=ban],.lmq-flag[data-type=female-alt]{background:rgba(255,84,102,.12);border-color:rgba(255,84,102,.35);color:#ff9aa5}
.lmq-flag[data-type=reject],.lmq-flag[data-type=wait-fail]{background:rgba(255,148,116,.11);border-color:rgba(255,148,116,.32);color:#ffb39c}
.lmq-flag[data-type=check],.lmq-flag[data-type=pending-alt]{background:rgba(255,182,72,.10);border-color:rgba(255,182,72,.32);color:#ffcd80}
.lmq-flag[data-type=wait-ok]{background:rgba(76,201,138,.10);border-color:rgba(76,201,138,.3);color:#86dcb0}
.lmq-sec{margin:10px 0 4px;font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:rgba(224,205,158,.75)}
.lmq-alt{padding:5px 0;border-top:1px solid var(--lmq-line)}
.lmq-alt:first-child{border-top:0}
.lmq-alt-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.lmq-alt-row a{font-weight:700}
.lmq-alt-row .lm-det{margin-left:auto}
.lmq-st{font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:5px;border:1px solid var(--lmq-line);color:var(--lmq-muted)}
.lmq-st[data-s=approved]{color:#ff8d99;border-color:rgba(255,84,102,.4);background:rgba(255,84,102,.08)}
.lmq-st[data-s=disabled]{color:#ffc06b;border-color:rgba(255,182,72,.38)}
.lmq-st[data-s=pending]{color:#ffd28a;border-color:rgba(255,182,72,.3)}
.lmq-st[data-s=rejected]{color:#7fe0ad;border-color:rgba(76,201,138,.32)}
.lmq-sub{font-size:11.5px;color:var(--lmq-muted);margin-top:2px}
.lmq-sub b[data-s=ok]{color:var(--lmq-ok)}
.lmq-sub b[data-s=bad]{color:#ff8d99}
.lmq-none{color:var(--lmq-muted);font-style:italic}
.lmq-log{margin-top:8px;border-top:1px solid var(--lmq-line);padding-top:6px}
.lmq-log>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--lmq-muted);
  -webkit-user-select:none;user-select:none;touch-action:manipulation;padding:2px 0}
.lmq-log>summary::-webkit-details-marker{display:none}
.lmq-log>summary::before{content:"";width:0;height:0;border-left:5px solid var(--lmq-muted);border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .15s}
.lmq-log[open]>summary::before{transform:rotate(90deg)}
.lmq-n{font-variant-numeric:tabular-nums;opacity:.7}
.lmq-log-body{margin-top:4px;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.28);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#aaa59a}
.lmq-ln[data-tone=ok]{color:#7fd6a6}.lmq-ln[data-tone=rej]{color:#ffad95}.lmq-ln[data-tone=ban]{color:#ff8d99}
.lmq-ln[data-tone=man]{color:#ffcd80}.lmq-ln[data-tone=err]{color:#ff8d99}.lmq-ln[data-tone=step]{color:var(--lmq-gold-2);margin-top:3px}
.lmq-ln[data-tone=mute]{opacity:.7}

/* Buttons */
.lmq-btn{-webkit-appearance:none;appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:7px 13px;
  border-radius:10px;border:1px solid var(--lmq-line);background:var(--lmq-s2);color:var(--lmq-text);font:600 12.5px/1.2 var(--lmq-font);
  cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform .1s,background .15s,border-color .15s}
.lmq-btn:active{transform:scale(.97)}
.lmq-btn[disabled]{opacity:.6;cursor:default}
.lmq-btn--gold{background:linear-gradient(180deg,#f3e6c6,#b09d73);border-color:#f1e2bf;color:#161104}
.lmq-btn--danger{background:rgba(255,84,102,.13);border-color:rgba(255,84,102,.45);color:#ffb3bb}
.lmq-btn--ghost{background:transparent}
.lmq-btn--sm{min-height:28px;padding:4px 10px;font-size:12px;border-radius:8px}
.lmq-btn[data-state=ok]{background:rgba(76,201,138,.14);border-color:rgba(76,201,138,.45);color:#9be7bf}
.lmq-btn[data-state=warn]{background:rgba(255,182,72,.12);border-color:rgba(255,182,72,.45);color:#ffd28a}
.lmq-btn[data-state=gold]{background:linear-gradient(180deg,#f3e6c6,#b09d73);border-color:#f1e2bf;color:#161104}
.message-cell--extra .xf-report-btn,.message-cell--extra .foid-ban-btn{margin-top:10px;margin-right:6px}

/* quick rejects */
.lmq-qr{list-style:none;margin:12px 0 2px;padding:10px 0 0;border-top:1px dashed var(--lmq-line)}
.lmq-qr-t{font:800 10px/1 var(--lmq-font);letter-spacing:.09em;text-transform:uppercase;color:rgba(224,205,158,.75);margin-bottom:8px}
.lmq-qr-list{display:flex;flex-wrap:wrap;gap:6px}
.lmq-chip{-webkit-appearance:none;appearance:none;border:1px solid var(--lmq-line);background:var(--lmq-s2);color:#d9d4c8;border-radius:999px;
  padding:7px 12px;font:600 12px/1.1 var(--lmq-font);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  transition:transform .1s,background .15s,border-color .15s,color .15s}
.lmq-chip:active{transform:scale(.96)}
.lmq-chip.is-on{background:rgba(255,148,116,.15);border-color:rgba(255,148,116,.55);color:var(--lmq-rej)}

/* log links */
.lmq-loglink{color:var(--lmq-gold-2)!important;text-decoration:underline;text-decoration-color:rgba(224,205,158,.45);text-underline-offset:2px}

/* Report-Panel */
.xf-report-panel{padding:12px 14px;border-top:1px solid var(--lmq-line);background:var(--lmq-s1);font-family:var(--lmq-font)}
.xf-report-panel .lmq-rp-t{margin-bottom:6px;font-size:12.5px;color:var(--lmq-muted)}
.xf-report-panel textarea{width:100%;box-sizing:border-box;border-radius:10px}
.xf-report-panel .lmq-rp-row{margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.xf-report-status{font-size:12px}
.xf-report-status[data-s=ok]{color:var(--lmq-ok)}.xf-report-status[data-s=err]{color:#ff8d99}

/* notice cards on top */
#lmqNotices{display:grid;gap:8px;margin:0 0 10px}
#lmqNotices:empty{display:none}
.lmq-notice{border-radius:14px;padding:14px 16px;border:1px solid var(--lmq-line);border-left:3px solid var(--t);
  background:linear-gradient(180deg,#151518,#101013);color:var(--lmq-text);font:13.5px/1.5 var(--lmq-font)}
.lmq-notice-t{display:flex;align-items:center;gap:8px;font-weight:800;font-size:14.5px;color:var(--t);margin-bottom:6px}
.lmq-notice-t::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--t);flex:0 0 auto}
.lmq-notice-b{white-space:pre-wrap;color:#cfc9bc}
.lmq-notice-list{margin:6px 0 0;padding:0;list-style:none;display:grid;gap:4px}
.lmq-notice-list a{color:var(--lmq-gold-2);font-weight:700}
.lmq-notice-a{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}
.lmq-notice-d{margin-top:10px}
.lmq-notice-d>summary{cursor:pointer;font-size:11.5px;font-weight:700;color:var(--lmq-muted);list-style:none}
.lmq-notice-d>summary::-webkit-details-marker{display:none}
.lmq-notice-d>summary::after{content:" ▸"}
.lmq-notice-d[open]>summary::after{content:" ▾"}
.lmq-notice-d pre{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.35);white-space:pre-wrap;word-break:break-word;
  font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b9b3a6;max-height:180px;overflow:auto}

/* filter bar */
.xfcf-wrap{flex:1 1 100%;min-width:0;display:flex;flex-direction:column;gap:7px;background:var(--lmq-s1);border:1px solid rgba(224,205,158,.16);border-radius:14px;padding:9px 10px;box-shadow:0 8px 22px rgba(0,0,0,.22);box-sizing:border-box}
.xfcf{display:flex;flex-wrap:nowrap;align-items:center;gap:6px;list-style:none;margin:0;padding:1px 0;min-width:0;flex:1 1 auto;
  overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.xfcf::-webkit-scrollbar{display:none}
.xfcf>li{flex:0 0 auto}
.block-filterBar .filterBar{flex-wrap:wrap;row-gap:6px;align-items:center}
.block-filterBar .filterBar>.filterBar-filters:not(.xfcf){flex:0 1 auto;row-gap:6px}
.xfcf-label{color:rgba(244,231,200,.78);font:800 10px/1 var(--lmq-font);letter-spacing:.09em;text-transform:uppercase;margin:0 2px 0 0;white-space:nowrap;flex:0 0 auto;min-width:74px;box-sizing:border-box;position:sticky;left:0;z-index:2;background:var(--lmq-s1);align-self:stretch;display:flex;align-items:center;box-shadow:10px 0 8px -6px var(--lmq-s1)}
.xfcf-chip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;cursor:pointer;padding:5px 10px;border-radius:999px;background:var(--lmq-s2);
  border:1px solid var(--lmq-line);color:#d6d1c4;font:600 12px/16px var(--lmq-font);-webkit-user-select:none;user-select:none;
  text-decoration:none!important;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .15s,border-color .15s,color .15s}
.xfcf-chip:hover{border-color:rgba(255,255,255,.18);color:#fff}
.xfcf-chip.is-active{background:linear-gradient(180deg,#f8efda,#dcc89a);border-color:#f4e7c8;color:#161104;box-shadow:0 2px 10px rgba(224,205,158,.18)}
.xfcf-n{opacity:.6;font-size:11px;font-variant-numeric:tabular-nums}
.xfcf-chip.is-active .xfcf-n{opacity:.75}
.xfcf-chip.xfcf-manual.has-items{border-color:rgba(255,182,72,.42);color:var(--lmq-man)}
.xfcf-chip.xfcf-manual.is-active{background:rgba(255,182,72,.13);border-color:rgba(255,182,72,.6);color:#ffd28a}
.xfcf-clear{background:transparent;border-color:rgba(255,84,102,.35);color:#ff9aa5}
.xfcf-clear[hidden]{display:none}
.xfcf-sep{width:1px;height:18px;background:var(--lmq-line);margin:0 2px;flex:0 0 auto;align-self:center}
.xfcf-sort{background:var(--lmq-s1)}
select.xfcf-role{cursor:pointer;height:28px;padding:0 10px;color-scheme:dark}
/* 5.17: rank not chosen yet -> gold edge + "✓ That's my rank" */
select.xfcf-role.is-unset{border-color:rgba(231,211,163,.85)!important;box-shadow:0 0 0 3px rgba(231,211,163,.16)}
html body .xfcf-chip.xfcf-rank-ok{border-color:rgba(231,211,163,.6);background:rgba(231,211,163,.14);color:#f3e6c6;font-weight:750}
.lmq-api{display:inline-flex;align-items:center;gap:7px;margin:6px 0;padding:4px 10px;border-radius:999px;border:1px solid var(--tl);background:var(--tb);
  color:var(--t);font:700 11.5px/1.3 var(--lmq-font)}
.lmq-api::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--t)}

/* status dock */
#lmqDock{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 10px);z-index:80;width:min(560px,calc(100vw - 16px));
  transform:translate(-50%,calc(-1 * var(--lmq-dock-off,0px)));transition:transform .2s ease;
  background:linear-gradient(180deg,#141417,#0b0b0d);border:1px solid var(--lmq-gold-dim);border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.6);
  color:var(--lmq-text);font:600 13px/1.3 var(--lmq-font);overflow:hidden;-webkit-tap-highlight-color:transparent}
#lmqDock[data-tone=err]{border-color:rgba(255,84,102,.6)}
/* 4.7: short gold glow when a round is saved (opacity only -> stays smooth) */
#lmqDock::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;
  box-shadow:inset 0 0 0 1px #f4e7c8,inset 0 0 26px rgba(224,205,158,.42)}
#lmqDock.is-flash::before{animation:lmq-flash 1.1s ease-out}
@keyframes lmq-flash{18%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){#lmqDock.is-flash::before{animation:none}}
.lmq-dock-row{display:flex;align-items:center;gap:8px;padding:8px 8px 9px 12px;min-height:44px;box-sizing:border-box}
.lmq-brand{flex:0 0 auto;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;background:linear-gradient(145deg,#f4e7c8,#b09d73);
  color:#141004;font:900 11px/1 var(--lmq-font)}
.lmq-dock-txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;color:var(--t,var(--lmq-text));font-size:12.5px;line-height:1.25}
.lmq-dock-main{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.lmq-dock-sub{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--lmq-muted);font-size:11px;font-weight:600;
  font-variant-numeric:tabular-nums;letter-spacing:.01em}
.lmq-dock-sub[hidden]{display:none}
#lmqDock[data-tone=mute] .lmq-dock-txt{color:#cfcabd}
.lmq-dock-btn{flex:0 0 auto;-webkit-appearance:none;appearance:none;border:1px solid var(--lmq-line);background:var(--lmq-s2);color:var(--lmq-text);
  border-radius:10px;min-height:30px;padding:0 10px;font:700 12px/1 var(--lmq-font);cursor:pointer;touch-action:manipulation}
.lmq-dock-btn--stop{background:rgba(255,84,102,.16);border-color:rgba(255,84,102,.5);color:#ffb3bb}
.lmq-dock-btn--man{background:rgba(255,182,72,.12);border-color:rgba(255,182,72,.45);color:#ffd28a}
.lmq-dock-btn--go,.lmq-dock-btn--save{background:linear-gradient(180deg,#f3e6c6,#b09d73);border-color:#f1e2bf;color:#161104}
.lmq-dock-btn--more{width:30px;padding:0;color:var(--lmq-muted)}
.lmq-dock-btn--more::before{content:"";display:inline-block;width:7px;height:7px;border-right:2px solid currentColor;border-top:2px solid currentColor;transform:translateY(2px) rotate(-45deg);transition:transform .15s}
#lmqDock.is-open .lmq-dock-btn--more::before{transform:translateY(-2px) rotate(135deg)}
.lmq-bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.06);overflow:hidden}
.lmq-bar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;opacity:0;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(255,250,238,.75),transparent);transform:translateX(-110%)}
#lmqDock[data-kind=saving] .lmq-bar::after{opacity:1;animation:lmq-sweep 1.25s linear infinite}
@keyframes lmq-sweep{to{transform:translateX(260%)}}
@media (prefers-reduced-motion:reduce){#lmqDock[data-kind=saving] .lmq-bar::after{animation:none;opacity:0}#lmqDock,.lmq-bar>i{transition:none}}
.lmq-bar>i{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(var(--p,0));background:linear-gradient(90deg,#b09d73,#f4e7c8);transition:transform .3s ease}
.lmq-dock-more{display:none;padding:2px 12px 12px;border-top:1px solid var(--lmq-line);font-weight:500;font-size:12.5px;color:#d1ccc0;
  max-height:min(62vh,560px);overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.lmq-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:10px 0 6px}
.lmq-stat{padding:9px 4px 8px;border-radius:11px;text-align:center;min-width:0;
  background:linear-gradient(180deg,rgba(224,205,158,.13),rgba(224,205,158,.05));border:1px solid rgba(224,205,158,.24)}
.lmq-stat b{display:block;font:800 16px/1.1 var(--lmq-font);color:var(--lmq-gold-2);font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lmq-stat span{display:block;margin-top:4px;font:800 9px/1 var(--lmq-font);letter-spacing:.09em;text-transform:uppercase;color:var(--lmq-muted)}
.lmq-kv[hidden]{display:none}
#lmqDock.is-open .lmq-dock-more{display:block}
.lmq-kv{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--lmq-line)}
/* 4.15: grouped details — small white-gold heading, rows in a soft box */
.lmq-kvg{margin:10px 0 0;padding:2px 10px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05)}
.lmq-kvg .lmq-kv:last-child{border-bottom:0}
.lmq-kvh{display:flex;align-items:center;gap:8px;margin:8px 0 2px;font:800 9.5px/1 var(--lmq-font);letter-spacing:.12em;text-transform:uppercase;color:rgba(244,231,200,.82)}
.lmq-kvh::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(224,205,158,.28),transparent)}
.lmq-kv span:first-child{color:var(--lmq-muted);white-space:nowrap}
.lmq-kv span:last-child{text-align:right}
.lmq-dock-acts{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 6px}
#xfBanConfirmBtn{position:fixed;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 70px);z-index:9999}
/* 4.13: ban appeals (and everything else that is not an application): hands off */
.lmq-hands{display:flex;flex-direction:column;gap:2px;margin-top:10px;padding:8px 11px 8px 22px;position:relative;border-radius:11px;
  border:1px dashed rgba(224,205,158,.45);background:rgba(224,205,158,.06);color:#cfc6a8;font:600 12px/1.35 var(--lmq-font);text-align:left}
.lmq-hands::before{content:"";position:absolute;left:10px;top:13px;width:6px;height:6px;border-radius:50%;background:var(--lmq-gold)}
.lmq-hands b{color:var(--lmq-gold-2);font-weight:800;letter-spacing:.06em;text-transform:uppercase;font-size:10.5px}
.lmq-hands span{color:#a9a392;font-weight:500}
.lmq-hands:not([data-s=mine])[data-k=names]::before,.lmq-hands:not([data-s=mine])[data-k=badges]::before{background:#cfd6e6}
.lmq-hands:not([data-s=mine])[data-k=posts]::before,.lmq-hands:not([data-s=mine])[data-k=threads]::before,.lmq-hands:not([data-s=mine])[data-k=other]::before{background:#9d9789}
.lmq-hands[data-s=mine]{border-style:solid;border-color:rgba(143,182,255,.55);background:rgba(143,182,255,.08)}
.lmq-hands[data-s=mine]::before{background:var(--lmq-info)}
.lmq-hands[data-s=mine] b{color:#cddcff}
/* 4.15: filter rows Filter · Posted · Queue — ban appeals and time chips */
.xfcf-chip.is-zero:not(.is-active){opacity:.45}
.xfcf-chip.xfcf-appeal{border-style:dashed;border-color:rgba(224,205,158,.40)}
.xfcf-chip.xfcf-appeal.is-active{border-style:solid}
.xfcf-chip.xfcf-time .xfcf-n{opacity:.55}
.xfcf>li[hidden],.xfcf[hidden]{display:none!important}
.xfcf-chip.xfcf-appeal:not(.has-items):not(.is-active){opacity:.45}
.xfcf-wrap .xfcf + .xfcf{padding-top:7px;border-top:1px solid rgba(255,255,255,.05)}
.lmq-dock-btn--appeal{background:rgba(143,182,255,.16);border-color:rgba(143,182,255,.55);color:#d6e2ff}
.lmq-dock-btn--appeal[disabled]{opacity:.6}
/* 5.13: the queue panel at the top — status + Save, details and filters in ONE card */
#lmqPanel{position:relative;margin:8px 0 12px;border-radius:18px;overflow:hidden;font-family:var(--lmq-font);color:var(--lmq-text)}
#lmqPanel #lmqDock.is-top{position:relative;left:auto;bottom:auto;transform:none;width:auto;z-index:auto;border:0;border-radius:0;
  background:transparent;box-shadow:none;overflow:visible}
#lmqPanel #lmqDock.is-top .lmq-dock-row{flex-wrap:wrap;gap:8px;min-height:58px;padding:12px 12px 12px 14px}
#lmqPanel #lmqDock.is-top .lmq-dock-txt{flex:1 1 150px}
#lmqPanel .lmq-brand{width:32px;height:32px;border-radius:10px;font-size:12.5px}
#lmqPanel .lmq-dock-main{font-size:14.5px;font-weight:750;color:#f6f2e9}
#lmqPanel .lmq-dock-sub{font-size:11.5px}
#lmqPanel .lmq-dock-btn{min-height:36px;padding:0 13px;border-radius:12px;font-size:13px}
#lmqPanel .lmq-dock-btn--more{width:36px;padding:0}
#lmqPanel .lmq-bar{position:relative;height:3px}
#lmqPanel .lmq-dock-more{border-top:1px solid rgba(255,255,255,.09);max-height:none}
#lmqPanel .lmq-api{margin:0 14px 10px}
#lmqPanel .lmq-api[data-tone=ok],#lmqPanel .lmq-api[data-tone=mute]{display:none}
#lmqPanel .xfcf-wrap{gap:9px;margin:0;padding:11px 12px 13px 14px;border:0;border-top:1px solid rgba(255,255,255,.09);border-radius:0;background:transparent;box-shadow:none}
#lmqPanel .xfcf-label{background:#141418;box-shadow:10px 0 8px -6px #141418}
.lmq-dock-btn--apf{background:rgba(143,182,255,.16);border-color:rgba(143,182,255,.55);color:#d6e2ff}
/* options with something in them first; empty ones at the end of the row */
.xfcf>li.xfcf-label:first-child{order:-3}
#lmqPanel #lmqDock.is-top:not([data-tone=run]) .lmq-bar{opacity:.35}
#lmqPanel .lmq-btn[hidden]{display:none!important}
.xfcf>li:has(>.xfcf-clear){order:-2}
.xfcf>li:has(>.xfcf-chip.is-zero:not(.is-active)){order:2}
/* 5.14: status on top, all buttons in ONE row under it (Save always first) */
#lmqPanel #lmqDock.is-top .lmq-dock-txt{flex:1 1 0;order:0}
#lmqPanel #lmqDock.is-top .lmq-brand,#lmqPanel #lmqDock.is-top .lmq-dock-btn--more{order:0}
#lmqPanel #lmqDock.is-top .lmq-dock-row::after{content:"";order:1;flex:0 0 100%;height:0}
#lmqPanel #lmqDock.is-top .lmq-dock-btn--save,#lmqPanel #lmqDock.is-top .lmq-dock-btn--appeal{order:2}
#lmqPanel #lmqDock.is-top .lmq-dock-btn--man{order:3}
#lmqPanel #lmqDock.is-top .lmq-dock-btn--apf{order:4}
#lmqPanel #lmqDock.is-top .lmq-dock-btn--go{order:5}
#lmqPanel #lmqDock.is-top .lmq-dock-btn--stop{order:6;margin-left:auto}
#lmqPanel .lmq-dock-btn--save{min-width:92px}
#lmqPanel .lmq-dock-btn--psave.is-idle{background:rgba(255,255,255,.05);border-color:rgba(224,205,158,.32);color:rgba(244,231,200,.62);font-weight:700}
#lmqPanel a.lmq-dock-btn{display:inline-flex;align-items:center;justify-content:center;text-decoration:none!important;box-sizing:border-box}
#lmqPanel .lmq-dock-btn[hidden]{display:none!important}
#lmqPanel .xfcf-label{background:transparent;box-shadow:none}
/* 5.14: the forum's own Save bar no longer sticks to the bottom of the screen —
   it stays at the end of the list (Save is in the panel at the top) */
form[action*="approval-queue"] .formSubmitRow--sticky,form[action*="approval-queue"] .formSubmitRow.is-sticky,
form[action*="approval-queue"] .formSubmitRow--sticky .formSubmitRow-main,form[action*="approval-queue"] .formSubmitRow.is-sticky .formSubmitRow-main,
form[action*="approval-queue"] .formSubmitRow--sticky .formSubmitRow-bar,form[action*="approval-queue"] .formSubmitRow.is-sticky .formSubmitRow-bar{
  position:static!important;top:auto!important;bottom:auto!important;left:auto!important;right:auto!important;transform:none!important;box-shadow:none!important}
form[action*="approval-queue"] .formSubmitRow-placeholder{display:none!important}
`;
  (function _lmqInjectStyles() {

    if (!_isQueuePage() || document.getElementById("lmq-style")) return;
    const st = document.createElement("style");
    st.id = "lmq-style";
    st.textContent = LMQ_CSS;
    (document.head || document.documentElement).appendChild(st);
  })();

  function _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  const _HEX_TONE = {
    "#3ccf6e": "ok", "#8ecf9a": "ok", "#ff9a8c": "rej", "#ff5a6a": "ban",
    "#ffd080": "man", "#ff6b6b": "err", "#c0b0ff": "step", "#888": "mute",
  };

  function _noticeHost() {
    let host = document.getElementById("lmqNotices");
    if (host && host.isConnected) return host;
    if (!document.body) return null;
    host = _el("div");
    host.id = "lmqNotices";
    const form = _queueForm();
    const pc = document.querySelector(".p-body-pageContent");
    if (form && form.parentNode) form.parentNode.insertBefore(host, form);
    else if (pc) pc.insertBefore(host, pc.firstChild);
    else document.body.insertBefore(host, document.body.firstChild);
    return host;
  }
  function _notice(id, tone, title) {
    const host = _noticeHost();
    if (!host) return null;
    let el = document.getElementById(id);
    if (!el) {
      el = _el("div", "lmq-notice lmq-tone");
      el.id = id;
      host.appendChild(el);
    }
    el.dataset.tone = tone;
    el.hidden = false;
    el.textContent = "";
    el.appendChild(_el("div", "lmq-notice-t", title));
    return el;
  }

  function _noticeBody(el, text, details, actions) {
    el.appendChild(_el("div", "lmq-notice-b", text));
    if (actions && actions.length) {
      const row = _el("div", "lmq-notice-a");
      actions.forEach((a) => {
        const b = _el("button", "lmq-btn lmq-btn--sm" + (a.primary ? " lmq-btn--gold" : ""), a.label);
        b.type = "button";
        b.addEventListener("click", (e) => { e.preventDefault(); try { a.run(); } catch (_) {} });
        row.appendChild(b);
      });
      el.appendChild(row);
    }
    if (details) {
      const d = _el("details", "lmq-notice-d");
      d.append(_el("summary", null, "Details"), _el("pre", null, details));
      el.appendChild(d);
    }
  }

  function _qPanelHost() {
    if (!document.body) return null;
    let p = _qPanelHost.el || document.getElementById("lmqPanel");
    if (p && p.isConnected) return (_qPanelHost.el = p);
    if (!p) {
      p = document.createElement("div");
      p.id = "lmqPanel";
      p.className = "lmq-panel";
    }
    const fb = document.querySelector(".block-filterBar");
    const form = _queueForm();
    const anchor = (fb && (fb.closest(".block") || fb)) || (form && (form.closest(".block") || form)) || null;
    const pc = document.querySelector(".p-body-pageContent");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(p, anchor);
    else if (pc) pc.insertBefore(p, pc.firstChild);
    else document.body.insertBefore(p, document.body.firstChild);
    return (_qPanelHost.el = p);
  }

  function _chipLabel(t) {
    const s = String(t || "").toLowerCase().replace(/\b(vpn|ai|ip)\b/g, (m) => m.toUpperCase());
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const DOCK_OPEN_KEY = "__lmqDockOpen";
  const _dock = { el: null, msg: "", kind: "", rows: new Set(), done: new Set(), raf: 0, saveRow: null, io: null, off: -1, sig: "", prog: null };

  function _dockBuild() {
    if (_dock.el || !document.body || !_isQueuePage() || !IS_TOP) return _dock.el;
    const d = _el("div", "lmq-tone");
    d.id = "lmqDock";
    d.setAttribute("role", "status");
    const row = _el("div", "lmq-dock-row");
    const brand = _el("span", "lmq-brand", "LM");

    const txt = _el("div", "lmq-dock-txt");
    const main = _el("span", "lmq-dock-main");
    const sub = _el("small", "lmq-dock-sub");
    sub.hidden = true;
    txt.append(main, sub);
    const man = _el("button", "lmq-dock-btn lmq-dock-btn--man");
    man.type = "button";
    man.hidden = true;
    man.title = "Jump to the next MANUAL case";
    const go = _el("button", "lmq-dock-btn lmq-dock-btn--go", "Continue");
    go.type = "button";
    go.hidden = true;

    const save = _el("button", "lmq-dock-btn lmq-dock-btn--save", "Save");
    save.type = "button";
    save.hidden = true;

    const fsave = _el("button", "lmq-dock-btn lmq-dock-btn--appeal", "Save appeal");
    fsave.type = "button";
    fsave.hidden = true;

    const msave = _el("button", "lmq-dock-btn lmq-dock-btn--save", "Save");
    msave.type = "button";
    msave.hidden = true;
    const stop = _el("button", "lmq-dock-btn lmq-dock-btn--stop", "Stop");
    stop.type = "button";
    stop.hidden = true;
    const more = _el("button", "lmq-dock-btn lmq-dock-btn--more");
    more.type = "button";
    more.setAttribute("aria-label", "Details");

    const apf = _el("button", "lmq-dock-btn lmq-dock-btn--apf");
    apf.type = "button";
    apf.hidden = true;
    apf.addEventListener("click", (e) => {
      e.preventDefault();
      activeFilters.add("APPEALS");
      if (window.__updateFilterDisplay) window.__updateFilterDisplay();
      _dock.sig = "";
      _dockRender();
    });

    const psave = _el("button", "lmq-dock-btn lmq-dock-btn--save lmq-dock-btn--psave", "Save");
    psave.type = "button";
    psave.hidden = true;
    psave.addEventListener("click", (e) => {
      e.preventDefault();
      const why = psave.dataset.why || "Nothing to save right now";
      _setTxt(psave, why);
      clearTimeout(psave._t);
      psave._t = setTimeout(() => { _setTxt(psave, "Save"); }, 1800);
    });

    const apj = _el("a", "lmq-dock-btn lmq-dock-btn--apf lmq-dock-btn--apj", "Ban appeals →");
    apj.href = "/approval-queue/";
    apj.hidden = true;
    row.append(brand, txt, man, apf, apj, fsave, msave, save, psave, go, stop, more);
    const bar = _el("div", "lmq-bar");
    bar.appendChild(_el("i"));
    const panel = _el("div", "lmq-dock-more");
    d.append(row, bar, panel);

    const host = _qPanelHost();
    if (host) { d.classList.add("is-top"); host.insertBefore(d, host.firstChild); }
    else document.body.appendChild(d);
    _dock.el = d;
    _dock.apf = apf; _dock.apj = apj; _dock.psave = psave;
    _dock.txt = txt; _dock.main = main; _dock.sub = sub;
    _dock.man = man; _dock.go = go; _dock.stop = stop; _dock.more = more; _dock.save = save; _dock.fsave = fsave; _dock.msave = msave;
    _dock.panel = panel; _dock.bar = bar.firstChild;

    stop.addEventListener("click", (e) => {
      e.preventDefault();
      _saveCancelled = true;
      _saveMsg("Stopped — save manually.", "info");
    });
    go.addEventListener("click", (e) => { e.preventDefault(); _pauseContinue(); });
    save.addEventListener("click", (e) => {
      e.preventDefault();
      const b = _queueSaveButton(_queueForm());
      if (!b) { _saveMsg("Save button not found — scroll down and save.", "info"); return; }
      save.disabled = true;
      _setTxt(save, "Saving …");
      _withForeignOff(() => b.click());
    });
    fsave.addEventListener("click", (e) => {
      e.preventDefault();
      if (fsave.disabled) return;
      fsave.disabled = true;
      _setTxt(fsave, "Saving …");
      _foreignSave().finally(() => { fsave.disabled = false; _dock.sig = ""; _dockRender(); });
    });
    msave.addEventListener("click", (e) => {
      e.preventDefault();
      if (msave.disabled) return;
      msave.disabled = true;
      _setTxt(msave, "Saving …");
      _manualSave = true;
      _saveCancelled = false;
      _maybeScheduleSave();
      setTimeout(() => { msave.disabled = false; _dock.sig = ""; _dockRender(); }, 1200);
    });
    man.addEventListener("click", (e) => { e.preventDefault(); _scrollToNextManual(); });
    more.addEventListener("click", (e) => {
      e.preventDefault();
      const open = !d.classList.contains("is-open");
      d.classList.toggle("is-open", open);
      try { localStorage.setItem(DOCK_OPEN_KEY, open ? "1" : "0"); } catch (_) {}
      _dock.sig = "";
      _dockPaint();
    });
    txt.addEventListener("click", () => {
      if (_dock.kind === "hold") {
        const n = document.getElementById("xfSaveGateBanner");
        if (n) n.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    try { if (localStorage.getItem(DOCK_OPEN_KEY) === "1") d.classList.add("is-open"); } catch (_) {}

    _dockWatchSaveRow();
    let rz = 0;
    window.addEventListener("resize", () => {
      clearTimeout(rz);
      rz = setTimeout(() => _dockWatchSaveRow(true), 200);
    }, { passive: true });
    return d;
  }

  function _dockWatchSaveRow(force) {
    if (_dock.el && _dock.el.classList.contains("is-top")) return;
    const b = _queueSaveButton(_queueForm());
    const row = b ? (b.closest(".formSubmitRow-main, .formSubmitRow") || b.parentElement) : null;
    if (!row || (row === _dock.saveRow && !force)) return;
    _dock.saveRow = row;
    if (_dock.io) { try { _dock.io.disconnect(); } catch (_) {} }
    if (typeof IntersectionObserver !== "function") return;
    const th = [];
    for (let i = 0; i <= 20; i++) th.push(i / 20);
    _dock.io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const r = e.boundingClientRect;
      const off = e.isIntersecting && r.bottom > vh * 0.5 ? Math.max(0, Math.round(vh - r.top)) : 0;
      _dockSetOff(off);
    }, { threshold: th });
    _dock.io.observe(row);
  }
  function _dockSetOff(off) {
    if (!_dock.el || _dock.off === off) return;
    _dock.off = off;
    _dock.el.style.setProperty("--lmq-dock-off", off + "px");
  }

  function _dockRender() {
    if (_dock.raf || !_isQueuePage() || !IS_TOP) return;
    _dock.raf = setTimeout(() => {
      requestAnimationFrame(() => { _dock.raf = 0; _dockPaint(); });
    }, 140);
  }
  function _dockMsg(text, kind) {
    _dock.msg = text || "";
    _dock.kind = kind || "info";
    if (_dock.kind !== "saving") _dock.prog = null;
    _dockRender();
  }
  function _dockTrack(message) { _dock.rows.add(message); _dockRender(); }
  function _dockDone(message, yes) {
    if (yes) _dock.done.add(message); else _dock.done.delete(message);
    _dockRender();
  }

  let _titleSig = "";
  function _titleState(manual, busy, left) {
    if (!IS_TOP) return;
    const pre = _dock.kind === "paused" ? "⏸ " : manual ? "(" + manual + " manual) " : busy && left > 0 ? "… " + left + " left · " : "";
    if (pre === _titleSig) return;

    let base = document.title;
    for (let i = 0; i < 4; i++) base = base.replace(/^\s*(\(\d+ manual\)|⏸|… \d+ left ·)\s*/, "");
    _titleSig = pre;
    document.title = (pre + base).trim() || pre.trim();
  }

  function _dockCounts() {
    let total = 0, done = 0;
    _dock.rows.forEach((m) => {
      if (!m.isConnected) { _dock.rows.delete(m); _dock.done.delete(m); return; }
      total++;
      if (_dock.done.has(m)) done++;
    });
    const manual = _manualRows().length;
    const retry = _retryRows().length;
    return { total, done, manual, retry };
  }

  const _setTxt = (el, v) => { v = String(v); if (el.textContent !== v) el.textContent = v; };

  function _dockPaint() {
    _flushFilterCounts();
    const d = _dockBuild();
    if (!d) return;

    if (d.classList.contains("is-top")) {
      const host = _qPanelHost();
      if (host && d.parentNode !== host) host.insertBefore(d, host.firstChild);
      const fl = document.getElementById("lmqFilters") || (_qPanelHost.rows || null);
      if (fl) { _qPanelHost.rows = fl; if (host && fl.parentNode !== host) host.appendChild(fl); }
    }
    const c = _dockCounts();

    LMS.queueBusy(c.done < c.total || _pendingExecutions > 0 || _dock.kind === "saving");
    let tone = "run", text;
    if (_dock.msg) {
      text = _dock.msg;
      tone = _dock.kind === "countdown" || _dock.kind === "saving" || _dock.kind === "paused" ? "run"
        : _dock.kind === "hold" ? "err" : "mute";
    } else if (!c.total) {
      const fl = _foreignLeftText();
      text = "No applications on this page" + (fl ? " · " + fl + " left for you" : "");
      tone = "mute";
    } else if (c.done < c.total) {
      text = "Checking " + c.done + " / " + c.total + " …";
    } else if (_pendingExecutions > 0) {
      text = "Executing … (" + _pendingExecutions + " open)";
    } else {
      const decided = c.total - c.manual - c.retry;
      text = c.manual
        ? "Done · " + decided + " decided" + (c.retry ? ", " + c.retry + " retrying" : "") + ", the rest is yours"
        : c.retry
          ? "Done · " + decided + " decided, " + c.retry + " retrying by itself"
          : "Done ✓ · all " + c.total + " decided";
      tone = c.manual ? "man" : "ok";
    }
    const pz = _pauseState();
    let subText = _dockSubText();
    if (pz === "armed") subText = "⏸ pauses after this round" + (subText ? " · " + subText : "");
    const open = d.classList.contains("is-open");
    const busyNow = c.done < c.total || _pendingExecutions > 0 || _dock.kind === "saving";

    LMS.status("queue", { manual: c.manual, busy: busyNow ? 1 : 0, paused: _dock.kind === "paused" ? 1 : 0 });
    _titleState(c.manual, busyNow, c.total - c.done);
    const wantSave = _userTouchedForm && !busyNow && _dock.kind !== "paused";

    const fsc = _foreignScan();
    const fN = fsc.picked.length;
    const fLabel = !fN ? "" : _foreignSaving ? (_foreignWaiting ? "After save …" : "Saving …")
      : fsc.pickedAppeals === fN ? (fN === 1 ? "Save appeal" : "Save " + fN + " appeals")
      : (fN === 1 ? "Save choice" : "Save " + fN + " choices");

    const mReady = !_roundFlag() && !_userTouchedForm && !busyNow && _dock.kind !== "paused" && !_saveInFlight &&
      !_awaitingReload && !_foreignSaving && !_hlRunning && !_saveScheduled && !_manualSave;
    const mN = mReady ? _actionableIds().length : 0;
    const nAp = !c.total && !activeFilters.has("APPEALS") ? (fsc.kinds.APPEALS || 0) : 0;

    const isTop = d.classList.contains("is-top");
    const realSave = wantSave || !!mN || !!fN;
    const pWhy = !isTop || realSave ? ""
      : _dock.kind === "saving" || _saveInFlight ? "Saving …"
      : busyNow ? "Still checking …"
      : _dock.kind === "paused" ? "Paused — tap Continue"
      : _dock.kind === "countdown" ? "Saving in a moment"
      : c.manual ? "Decide the MANUAL case first"
      : "Nothing to save right now";

    const apJump = isTop && !fsc.rows.length && !busyNow && !realSave && _dock.kind !== "saving" &&
      /[?&]content_type=user\b/.test(location.search) && (_qLeft === null || _qLeft > c.total);
    const sig = [tone, text, subText, _dock.kind, c.manual, c.retry, c.done, c.total, open, pz, wantSave, fLabel, fsc.rows.length, mN, nAp,
      _dock.prog ? _dock.prog.done + "/" + _dock.prog.total : "", pWhy, apJump,
      open ? _pendingExecutions + "|" + activeFilters.has("MANUAL") + "|" + _roundFlag() + "|" + _qLeft : ""].join("|");
    if (sig === _dock.sig) return;
    _dock.sig = sig;
    if (d.dataset.tone !== tone) d.dataset.tone = tone;
    if (d.dataset.kind !== _dock.kind) d.dataset.kind = _dock.kind;
    _setTxt(_dock.main, text);
    _setTxt(_dock.sub, subText);
    if (_dock.sub.hidden !== !subText) _dock.sub.hidden = !subText;
    _dock.txt.style.cursor = _dock.kind === "hold" ? "pointer" : "";
    _dock.stop.hidden = !(_dock.kind === "countdown" || _dock.kind === "refresh");
    _dock.go.hidden = _dock.kind !== "paused";
    if (_dock.save.hidden !== !wantSave) _dock.save.hidden = !wantSave;
    if (_dock.fsave.hidden !== !fN) _dock.fsave.hidden = !fN;
    if (fN) _setTxt(_dock.fsave, fLabel);
    if (_dock.msave.hidden !== !mN) _dock.msave.hidden = !mN;
    if (mN && !_dock.msave.disabled) _setTxt(_dock.msave, "Save " + mN);
    _dock.man.hidden = !c.manual;
    if (c.manual) _setTxt(_dock.man, c.manual + " MANUAL ↓");
    if (_dock.apf.hidden !== !nAp) _dock.apf.hidden = !nAp;
    if (_dock.apj.hidden !== !apJump) _dock.apj.hidden = !apJump;
    if (_dock.psave.hidden !== !pWhy) _dock.psave.hidden = !pWhy;
    if (pWhy) { _dock.psave.dataset.why = pWhy; _dock.psave.classList.add("is-idle"); }
    if (nAp) _setTxt(_dock.apf, "Ban appeals " + nAp);
    if (_dock.more.getAttribute("aria-expanded") !== String(open)) _dock.more.setAttribute("aria-expanded", String(open));
    const prog = _dock.kind === "saving" && _dock.prog && _dock.prog.total ? _dock.prog : null;
    const p = prog ? prog.done / prog.total : c.total ? c.done / c.total : 0;
    _dock.bar.style.setProperty("--p", String(p));
    if (open) _dockPanel(c);
    if (!_dock.saveRow || !_dock.saveRow.isConnected) _dockWatchSaveRow();
  }

  const _DOCK_ROWS = [
    ["checked", "Checked"], ["today", "Today"], ["round", "Last round"], ["queue", "Queue"],
    ["dual", "Both ends"], ["appeals", "Content"], ["manual", "MANUAL"], ["retry", "Retrying"], ["svc", "Services"], ["aiuse", "AI check"], ["vpnapi", "VPN API"],
    ["vpnq", "VPN queries today"], ["screen", "Screen"], ["rank", "Rank"], ["ver", "Version"],
  ];
  const _DOCK_GROUPS = [
    ["This page", ["checked", "round", "manual", "retry", "appeals"]],
    ["Queue", ["today", "queue", "dual"]],
    ["System", ["svc", "aiuse", "vpnapi", "vpnq", "screen", "rank", "ver"]],
  ];
  const _DOCK_STATS = [["today", "Today"], ["rate", "Per hour"], ["left", "Left"], ["eta", "ETA"]];
  function _dockPanelBuild() {
    if (_dock.kv) return;
    const P = _dock.panel;
    P.textContent = "";

    _dock.stat = null;
    void _DOCK_STATS;

    const acts = _el("div", "lmq-dock-acts");
    P.appendChild(acts);
    _dock.kv = {};

    const lbl = Object.fromEntries(_DOCK_ROWS);
    _DOCK_GROUPS.forEach(([title, keys]) => {
      const g = _el("div", "lmq-kvg");
      g.appendChild(_el("div", "lmq-kvh", title));
      keys.forEach((key) => {
        const r = _el("div", "lmq-kv");
        const v = _el("span");
        r.append(_el("span", null, lbl[key]), v);
        g.appendChild(r);
        _dock.kv[key] = { row: r, v: v };
      });
      P.appendChild(g);
    });
    const mk = (cls, run) => {
      const b = _el("button", "lmq-btn lmq-btn--sm" + (cls ? " " + cls : ""));
      b.type = "button";
      b.addEventListener("click", (e) => { e.preventDefault(); run(); });
      acts.appendChild(b);
      return b;
    };
    _dock.btnPause = mk("", () => _pauseToggle());
    _dock.btnMan = mk("", () => {
      if (activeFilters.has("MANUAL")) activeFilters.delete("MANUAL");
      else { activeFilters.clear(); _timeFilter = ""; activeFilters.add("MANUAL"); }
      if (window.__updateFilterDisplay) window.__updateFilterDisplay();
      _dock.sig = "";
      _dockPaint();
    });
    _dock.btnWake = mk("", () => _wakeToggle());
    _dock.btnTop = mk("lmq-btn--ghost", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    _setTxt(_dock.btnTop, "Back to top ↑");
    _dock.btnTop.hidden = !!(_dock.el && _dock.el.classList.contains("is-top"));
  }

  function _svcText() {
    const st = LMS.svcRead();
    const ago = (t) => {
      const m = Math.round((Date.now() - t) / 60000);
      return m < 1 ? "now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago";
    };
    return [["zerogpt", _aiName()], ["proxycheck", "proxycheck"]].map(([k, n]) => {
      const e = st[k];
      if (!e) return n + " –";
      return n + (e.ok ? " ✓" : " ✗ " + ago(e.t));
    }).join(" · ");
  }
  function _dockPanel(c) {
    _dockPanelBuild();
    if (_dock.stat) {
      const f = (n) => Number(n).toLocaleString("en-US");
      const o = _todayLoad();
      const rate = _todayRate();
      _setTxt(_dock.stat.today, f(o.saved));
      _setTxt(_dock.stat.rate, rate ? f(Math.round(rate)) : "—");
      _setTxt(_dock.stat.left, _qLeft === null ? "—" : f(_qLeft));
      _setTxt(_dock.stat.eta, rate && _qLeft ? _fmtDur(_qLeft / rate * 3600000) : _qLeft === 0 ? "done" : "—");
    }
    const kv = (key, v) => {
      const e = _dock.kv[key];
      const hide = v === null || v === undefined;
      if (e.row.hidden !== hide) e.row.hidden = hide;
      if (!hide) _setTxt(e.v, v);
    };
    kv("checked", c.done + " / " + c.total + (_pendingExecutions ? " · " + _pendingExecutions + " running" : ""));
    kv("today", null);
    kv("round", _lastRoundText());
    kv("queue", _queueLeftText(false));
    kv("dual", _dualText());
    {

      const f = _foreignScan();

      const parts = FOREIGN_KINDS.filter(([k]) => k !== "SPAM" && f.kinds[k]).map(([k, , what]) => {
        const n = f.kinds[k];
        return n + " " + (k === "OTHER" ? "other" : what.toLowerCase()) + (n === 1 ? "" : "s");
      });
      kv("appeals", !f.rows.length ? null
        : parts.join(" · ") + " · never touched" + (f.picked.length ? " · " + f.picked.length + " picked by you" : ""));
    }
    const ms = _manualSummary();
    kv("manual", ms ? ms.replace(/^\d+ MANUAL: /, "") : "none");
    kv("retry", _kindSummary(_retryRows()) || "none");
    kv("svc", _svcText());
    const api = document.getElementById("xfVpnApiStatus");
    kv("vpnapi", api ? api.textContent : null);
    kv("vpnq", _pcUsage() + " on this device · free plan 1000/day");
    kv("screen", _wakeText());
    kv("rank", _roleCfg().label);
    kv("ver", "v" + LM_VERSIONS.suite + (SAPLING_KEY ? " · AI check: Sapling (free)" : OWN_ZEROGPT_KEY ? " · own ZeroGPT key" : ""));
    kv("aiuse", SAPLING_KEY ? (() => {
      const pz = _spPaused();
      return _spUsageText().replace(" (this device)", "") + (pz ? " · paused: " + pz.why : "");
    })() : null);
    const state = (b, s) => { if ((b.dataset.state || "") !== (s || "")) { if (s) b.dataset.state = s; else delete b.dataset.state; } };
    const pz = _pauseState();
    _setTxt(_dock.btnPause, pz === "paused" ? "Continue ▶" : "Pause after this round: " + (pz === "armed" ? "ON" : "OFF"));
    state(_dock.btnPause, pz === "paused" ? "gold" : pz === "armed" ? "warn" : "");
    _setTxt(_dock.btnMan, activeFilters.has("MANUAL") ? "Show all" : "Show MANUAL only");
    _setTxt(_dock.btnWake, "Keep screen on: " + (_wakeOn() ? "ON" : "OFF"));
    state(_dock.btnWake, _wakeOn() && _wake ? "ok" : _wakeOn() ? "warn" : "");
  }

  function _navOffset() {
    try {
      const nav = document.querySelector(".p-navSticky");
      if (nav) {
        const r = nav.getBoundingClientRect();
        const pos = getComputedStyle(nav).position;
        if ((pos === "sticky" || pos === "fixed") && r.top <= 1 && r.bottom > 0 && r.bottom < 220) return r.bottom + 8;
      }
    } catch (_) {}
    return 12;
  }
  function _scrollToRow(el) {
    const goTo = () => {
      const top = el.getBoundingClientRect().top + window.scrollY - _navOffset();
      window.scrollTo(0, Math.max(0, Math.round(top)));
    };
    goTo();
    let n = 0;
    const fix = () => {
      if (!el.isConnected || n++ >= 5) return;
      const off = el.getBoundingClientRect().top - _navOffset();
      if (Math.abs(off) <= 3) return;
      goTo();
      requestAnimationFrame(fix);
    };
    requestAnimationFrame(() => requestAnimationFrame(fix));
  }
  function _scrollToNextManual() {
    const rows = _manualRows()
      .filter((m) => m.style.display !== "none");
    if (!rows.length) return;
    const navH = _navOffset();
    let target = rows.find((m) => m.getBoundingClientRect().top > navH + 8);
    if (!target) target = rows[0];
    _scrollToRow(target);
  }

  let _filterDirty = false;
  function _markManual(message, kind) {
    if (kind) message.dataset.manualKind = kind;
    else delete message.dataset.manualKind;
    _filterDirty = true;
    _dockRender();
  }

  let _fcRaf = 0, _fdRaf = 0;
  function _filterCountsSoon() {
    if (_fcRaf) return;
    _fcRaf = requestAnimationFrame(() => {
      _fcRaf = 0;
      try { if (window.__updateFilterCounts) window.__updateFilterCounts(); } catch (_) {}
    });
  }
  function _filterDisplaySoon() {
    if (_fdRaf) return;
    _fdRaf = requestAnimationFrame(() => {
      _fdRaf = 0;
      try { if (window.__updateFilterDisplay) window.__updateFilterDisplay(); } catch (_) {}
    });
  }
  function _flushFilterCounts() {
    if (!_filterDirty) return;
    _filterDirty = false;
    try {

      if (_filtersOn() && window.__updateFilterDisplay) window.__updateFilterDisplay();
      else if (window.__updateFilterCounts) window.__updateFilterCounts();
    } catch (_) {}
  }

  const TODAY_KEY = "__lmqToday";
  const TODAY_GAP_MS = 15 * 60 * 1000;
  let _roundStart = Date.now();
  function _todayDay() {
    const d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function _todayLoad() {
    try {
      const o = JSON.parse(localStorage.getItem(TODAY_KEY) || "null");
      if (o && o.d === _todayDay()) return o;
    } catch (_) {}
    return { d: _todayDay(), saved: 0, approve: 0, reject: 0, ban: 0, rounds: 0, busy: 0 };
  }
  function _todayCount(total) {
    const o = _todayLoad();
    let approve = 0, reject = 0, ban = 0;
    document.querySelectorAll('input[type="radio"][name^="queue[user]["]:checked').forEach((r) => {
      if (r.value === "approve") approve++;
      else if (r.value === "reject") reject++;
    });
    _intended.forEach((v) => { if (v && v.isBan && v.status === "done") ban++; });
    const now = Date.now();
    const spent = now - _roundStart;
    if (spent > 0 && spent < TODAY_GAP_MS) o.busy += spent;
    _roundStart = now;
    o.saved += total || 0;
    o.approve += approve;
    o.reject += reject;
    o.ban += ban;
    o.rounds++;
    try { localStorage.setItem(TODAY_KEY, JSON.stringify(o)); } catch (_) {}
    return o;
  }
  function _todayText() {
    const o = _todayLoad();
    if (!o.saved) return "nothing saved yet";
    const f = (n) => Number(n).toLocaleString("en-US");
    const h = o.busy / 3600000;
    return f(o.saved) + " saved · " + f(o.approve) + " approved · " + f(o.reject) + " rejected" +
      (o.ban ? " (" + f(o.ban) + " banned)" : "") + " · " + o.rounds + " round" + (o.rounds === 1 ? "" : "s") +
      (h >= 0.05 ? " · ~" + f(Math.round(o.saved / h)) + "/h" : "");
  }

  function _todayRate() {
    const o = _todayLoad();
    const h = o.busy / 3600000;
    return o.saved && h >= 0.05 ? o.saved / h : null;
  }
  function _fmtDur(ms) {
    if (ms < 9950) return (Math.max(0, ms) / 1000).toFixed(1) + " s";
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + " s";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60), r = m % 60;
    return h + " h" + (r ? " " + r + " min" : "");
  }

  const ROUND_KEY = "__lmqLastRound";
  let _roundT0 = Date.now();
  let _roundCheckedAt = 0;
  function _roundChecked() { if (!_roundCheckedAt) _roundCheckedAt = Date.now(); }
  function _roundFinish(total) {
    const now = Date.now();
    const checked = _roundCheckedAt || now;
    const r = { n: total, ms: now - _roundT0, checks: Math.max(0, checked - _roundT0), save: Math.max(0, now - checked), at: now };
    try { sessionStorage.setItem(ROUND_KEY, JSON.stringify(r)); } catch (_) {}
    console.log("[ROUND] " + total + " saved in " + _fmtDur(r.ms) + " (checks " + _fmtDur(r.checks) +
      ", saving " + _fmtDur(r.save) + ")");
    return r;
  }
  function _lastRoundText() {
    let r = null;
    try { r = JSON.parse(sessionStorage.getItem(ROUND_KEY) || "null"); } catch (_) {}
    if (!r || !r.n) return "—";
    return r.n.toLocaleString("en-US") + " saved in " + _fmtDur(r.ms) +
      " (checks " + _fmtDur(r.checks) + " · saving " + _fmtDur(r.save) + ")";
  }

  let _qLeft = null;
  const _QBADGE_SEL = 'a[href*="approval-queue"][data-badge], .badgeContainer[href*="approval-queue"]';
  function _badgeNum(el) {
    const v = el && el.getAttribute("data-badge");
    if (v === null || v === undefined) return null;
    const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : (String(v).trim() === "" ? 0 : null);
  }
  function _queueLeftFromDoc(doc, syncPage) {
    try {
      let n = null;
      for (const el of doc.querySelectorAll(_QBADGE_SEL)) { n = _badgeNum(el); if (n !== null) break; }
      if (n === null) return;
      _queueLeftSet(n, syncPage && doc !== document);
    } catch (_) {}
  }

  function _queueLeftFromText(t) {
    try {
      const head = t.length > 250000 ? t.slice(0, 250000) : t;
      const re = /<a\b[^>]*\bhref="[^"]*approval-queue[^"]*"[^>]*>/gi;
      let m, n = null;
      while ((m = re.exec(head))) {
        const b = m[0].match(/\bdata-badge="([^"]*)"/i);
        if (!b) continue;
        const x = parseInt(b[1].replace(/[^\d]/g, ""), 10);
        n = Number.isFinite(x) ? x : (b[1].trim() === "" ? 0 : null);
        if (n !== null) break;
      }
      if (n !== null) _queueLeftSet(n, true);
    } catch (_) {}
  }
  function _queueLeftSet(n, syncPage) {
    const changed = n !== _qLeft;
    _qLeft = n;
    if (syncPage) {
      document.querySelectorAll(_QBADGE_SEL).forEach((el) => {
        const txt = n.toLocaleString("en-US");
        if (el.getAttribute("data-badge") !== txt) el.setAttribute("data-badge", txt);
        if (el.classList.contains("badgeContainer")) el.classList.toggle("badgeContainer--highlighted", n > 0);
      });
    }
    if (changed) { _dock.sig = ""; _dockRender(); }
  }
  function _queueLeftText(short) {
    if (_qLeft === null) return short ? "" : "not shown by the forum";
    const f = (x) => Number(x).toLocaleString("en-US");

    if (short) return f(_qLeft) + " in queue";
    return f(_qLeft) + " waiting (all kinds)";
  }

  function _dockSubText() {

    const parts = [];
    const q = _queueLeftText(true);
    if (q) parts.push(q);
    return parts.join(" · ");
  }

  const WAKE_KEY = "__lmqWakeLock";
  let _wake = null;
  let _wakeErr = "";
  let _wakeBusy = false;
  function _wakeOn() {
    try { return localStorage.getItem(WAKE_KEY) !== "off"; } catch (_) { return true; }
  }
  async function _wakeGet() {
    if (_wake || _wakeBusy || !_wakeOn() || !IS_TOP || !_isQueuePage() || _isPaused()) return;
    if (document.visibilityState !== "visible") return;
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== "function") {
      _wakeErr = "not supported by this browser";
      return;
    }
    _wakeBusy = true;
    try {
      const lock = await navigator.wakeLock.request("screen");
      _wake = lock;
      _wakeErr = "";
      lock.addEventListener("release", () => {
        if (_wake === lock) _wake = null;
        _dock.sig = "";
        _dockRender();
      });
      console.log("[SCREEN] kept on while the queue is open");
    } catch (e) {
      _wake = null;
      _wakeErr = (e && (e.name === "NotAllowedError" ? "not allowed right now — tap the page" : e.name)) || "refused";
    } finally {
      _wakeBusy = false;
    }
    _dock.sig = "";
    _dockRender();
  }
  function _wakeDrop() {
    const l = _wake;
    _wake = null;
    try { if (l) l.release(); } catch (_) {}
  }
  function _wakeToggle() {
    const on = !_wakeOn();
    try { localStorage.setItem(WAKE_KEY, on ? "on" : "off"); } catch (_) {}
    if (on) _wakeGet(); else _wakeDrop();
    _dock.sig = "";
    _dockRender();
  }
  function _wakeText() {
    if (!_wakeOn()) return "normal (keep-on is off)";
    if (_isPaused()) return "normal while paused";
    if (_wake) return "kept on while the queue is open";
    return "can't keep it on" + (_wakeErr ? " (" + _wakeErr + ")" : "");
  }
  if (IS_TOP && _isQueuePage()) {
    try {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") _wakeGet();
      });

      document.addEventListener("pointerdown", () => { if (!_wake) _wakeGet(); }, { capture: true, passive: true });
      _wakeGet();
    } catch (_) {}
  }

  const _rowUis = new WeakMap();
  function _rowUi(message) {
    let ui = _rowUis.get(message);
    if (ui && ui.root.isConnected) return ui;
    const userCell = message.querySelector(".message-cell--user");
    if (!userCell) return null;
    ui = _buildRowUi();
    ui.msg = message;
    userCell.appendChild(ui.root);
    _rowUis.set(message, ui);
    return ui;
  }

  const _NO_ACTS = new Set(["ban", "role"]);
  function _actsBuild(api, root, sum) {
    const acts = _el("div", "lmq-acts");
    acts.hidden = true;
    const ok = _el("button", "lmq-act lmq-act--ok", "✓  Approve");
    const rej = _el("button", "lmq-act lmq-act--rej", "✕  Reject");
    ok.type = rej.type = "button";
    acts.append(ok, rej);
    sum.after(acts);
    const radio = (v) => api.msg && api.msg.querySelector('input[type="radio"][name^="queue[user]["][value="' + v + '"]');
    const paint = () => {
      const a = radio("approve"), r = radio("reject");
      ok.classList.toggle("is-on", !!(a && a.checked));
      rej.classList.toggle("is-on", !!(r && r.checked));
    };
    const pick = (v) => {
      const r = radio(v);
      if (!r) return;
      _userTouchedForm = true;
      _setRadio(r);
      if (v === "reject") {
        _activateDependency(r);

        const qr = api.msg.querySelector(".lmq-qr") || r.closest("li");
        if (qr) setTimeout(() => qr.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
      }
      paint();
      _dock.sig = "";
      _dockRender();
    };
    ok.addEventListener("click", (e) => { e.preventDefault(); pick("approve"); });
    rej.addEventListener("click", (e) => { e.preventDefault(); pick("reject"); });
    let bound = false;
    return (tone) => {
      const show = tone === "man" && api.msg && !_NO_ACTS.has(api.msg.dataset.manualKind || "") &&
        !!radio("approve") && !!radio("reject");
      acts.hidden = !show;
      if (show && !bound) { bound = true; api.msg.addEventListener("change", paint); }
      if (show) paint();
    };
  }

  function _buildRowUi() {
    const root = _el("div", "alt-accounts-box lmq-card lmq-tone");
    root.dataset.tone = "run";
    const head = _el("div", "lmq-head");
    const verdict = _el("span", "lmq-verdict");
    const vtxt = _el("b", null, "Checking …");
    verdict.append(_el("i", "lmq-dot"), vtxt);
    const exec = _el("span", "lmq-exec");
    exec.hidden = true;
    head.append(verdict, exec);
    const sum = _el("div", "lmq-sum");
    sum.hidden = true;
    const flags = _el("div", "lmq-flags");
    flags.hidden = true;
    const alts = _el("div", "lmq-alts");
    alts.hidden = true;
    const altList = _el("div", "lmq-alt-list");
    alts.append(_el("div", "lmq-sec", "Alt-Accounts"), altList);
    const log = _el("details", "lmq-log");
    const logS = _el("summary", null, "Check log");
    const logN = _el("span", "lmq-n");
    logS.appendChild(logN);
    const logB = _el("div", "lmq-log-body");
    log.append(logS, logB);
    root.append(head, sum, flags, alts, log);
    const flagSet = new Set();
    let nLog = 0;
    let acts = null;
    const api = {
      root: root,
      msg: null,
      verdict(tone, label, summary) {
        root.dataset.tone = tone;
        vtxt.textContent = label;
        if (summary !== undefined && summary !== null) {
          sum.textContent = summary;
          sum.hidden = !summary;
        }
        if (tone === "man" && !acts) acts = _actsBuild(api, root, sum);
        if (acts) acts(tone);
      },
      exec(state, text) {
        if (!state) { exec.hidden = true; return; }
        exec.dataset.s = state;
        exec.textContent = text;
        exec.hidden = false;
      },
      flag(label, type) {
        if (flagSet.has(label)) return;
        flagSet.add(label);
        const f = _el("span", "lmq-flag", label);
        f.dataset.type = type;
        flags.appendChild(f);
        flags.hidden = false;
      },
      log(text, tone) {
        const l = _el("div", "lmq-ln", text);
        if (tone) l.dataset.tone = tone;
        logB.appendChild(l);
        logN.textContent = "· " + (++nLog);
      },
      altList() { alts.hidden = false; return altList; },
    };
    return api;
  }

  (function insertDirectFilterMenu() {

    if (!_isQueuePage()) return;
    const panelHost = _qPanelHost();
    if (!panelHost) return;

    const apiStatus = _el("div", "lmq-api lmq-tone", "VPN API: checking …");
    apiStatus.id = "xfVpnApiStatus";
    apiStatus.dataset.tone = "mute";
    panelHost.appendChild(apiStatus);

    async function checkFirstIP() {

      if (document.readyState === "loading") {
        await new Promise((r) =>
          document.addEventListener("DOMContentLoaded", r, { once: true }));
      }
      await new Promise((r) => setTimeout(r, 0));

      const appRow = _queueRows(document).find((m) => !_isForeignRow(m) && m.querySelector("ul.listPlain li a[href]"));
      const firstIPLink = appRow ? appRow.querySelector("ul.listPlain li a[href]") : null;
      if (!firstIPLink) {
        apiStatus.textContent = "VPN API: no IP yet";
        apiStatus.dataset.tone = "mute";
        return;
      }
      const ipText = firstIPLink.textContent.trim();
      const ipMatch = ipText.match(
        /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/,
      );
      if (!ipMatch) {
        apiStatus.textContent = "VPN API: invalid IP";
        apiStatus.dataset.tone = "warn";
        return;
      }

      let res = null;
      let pre = null;
      try { pre = _vpnPrefetched.get(ipText); } catch (_) {}
      try { res = await (pre || checkVPN(ipText)); } catch (_) {}
      if ((res === true || res === false) && !_vpnApiProblem) {
        apiStatus.textContent = "VPN API OK";
        apiStatus.dataset.tone = "ok";
      } else if (res === null && !_vpnApiProblem) {
        apiStatus.textContent =
          "VPN API KEY INVALID — VPN detection is not working";
        apiStatus.dataset.tone = "err";
        apiStatus.classList.add("api-key-invalid");
      }
      _dockRender();
    }

    const nativeFilterBar = (() => {
      const bar = [...document.querySelectorAll(".block-filterBar")].find(
        (b) => b.querySelector(".filterBar-menuTrigger"),
      );
      return bar ? bar.querySelector(".filterBar") : null;
    })();

    const menuBody = document.createElement("ul");
    menuBody.className = "filterBar-filters xfcf";

    const cfLabel = document.createElement("li");
    cfLabel.className = "xfcf-label";
    cfLabel.textContent = "Apps";
    menuBody.appendChild(cfLabel);

    const cfClearLi = document.createElement("li");
    const cfClearBtn = document.createElement("a");
    cfClearBtn.href = "#";
    cfClearBtn.className = "xfcf-chip xfcf-clear";
    cfClearBtn.textContent = "clear all";
    cfClearBtn.hidden = true;
    cfClearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      activeFilters.clear();
      _timeFilter = "";
      window.__updateFilterDisplay();
    });
    cfClearLi.appendChild(cfClearBtn);
    menuBody.appendChild(cfClearLi);

    const _cfChips = new Map();
    filters.forEach((f) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.className = "xfcf-chip";
      a.dataset.tag = f;
      const nameSpan = document.createElement("span");
      nameSpan.textContent = _chipLabel(f);
      const nSpan = document.createElement("span");
      nSpan.className = "xfcf-n";
      nSpan.textContent = "0";
      a.appendChild(nameSpan);
      a.appendChild(nSpan);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (activeFilters.has(f)) activeFilters.delete(f);
        else activeFilters.add(f);
        window.__updateFilterDisplay();
        _chipInView(a);
      });
      li.appendChild(a);
      menuBody.appendChild(li);
      _cfChips.set(f, { a, n: nSpan });
    });

    {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.className = "xfcf-chip xfcf-manual";
      a.dataset.tag = "MANUAL";
      const nameSpan = _el("span", null, "Manual");
      const nSpan = _el("span", "xfcf-n", "0");
      a.append(nameSpan, nSpan);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (activeFilters.has("MANUAL")) activeFilters.delete("MANUAL");
        else activeFilters.add("MANUAL");
        window.__updateFilterDisplay();
        _dockRender();
        _chipInView(a);
      });
      li.appendChild(a);
      menuBody.appendChild(li);
      _cfChips.set("MANUAL", { a, n: nSpan });
    }

    const KIND_KEY = "__lmqKinds";
    let _kindRestored = false;
    function _kindSave() {
      if (!_kindRestored) return;
      try {
        const on = FOREIGN_KINDS.map(([t]) => t).filter((t) => activeFilters.has(t));
        if (on.length) sessionStorage.setItem(KIND_KEY, on.join(","));
        else sessionStorage.removeItem(KIND_KEY);
      } catch (_) {}
    }
    function _kindRestore() {
      _kindRestored = true;
      let saved = "";
      try { saved = sessionStorage.getItem(KIND_KEY) || ""; } catch (_) {}
      const tags = saved.split(",").filter((t) => FOREIGN_KINDS.some(([k]) => k === t));
      if (!tags.length) return;
      tags.forEach((t) => activeFilters.add(t));
      console.log("[QUEUE] content filter kept: " + tags.join(", "));
      requestAnimationFrame(() => { try { window.__updateFilterDisplay(); } catch (_) {} });
    }

    const kindBody = document.createElement("ul");
    kindBody.className = "filterBar-filters xfcf xfcf--kind";
    kindBody.appendChild(_el("li", "xfcf-label", "Content"));
    FOREIGN_KINDS.forEach(([tag, label]) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.className = "xfcf-chip xfcf-appeal xfcf-k-" + tag.toLowerCase();
      a.dataset.tag = tag;
      a.append(_el("span", null, _chipLabel(label)), _el("span", "xfcf-n", "0"));
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (activeFilters.has(tag)) activeFilters.delete(tag);
        else activeFilters.add(tag);
        window.__updateFilterDisplay();
        _chipInView(a);
      });
      li.appendChild(a);
      kindBody.appendChild(li);
      _cfChips.set(tag, { a, n: a.lastChild, li });
    });

    const TIME_CHIPS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "2–7 days"], ["older", "Older"]];
    const timeBody = document.createElement("ul");
    timeBody.className = "filterBar-filters xfcf xfcf--time";
    timeBody.appendChild(_el("li", "xfcf-label", "Posted"));
    const _timeChips = new Map();
    TIME_CHIPS.forEach(([key, label]) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.className = "xfcf-chip xfcf-time";
      a.dataset.time = key;
      a.append(_el("span", null, label), _el("span", "xfcf-n", "0"));
      a.addEventListener("click", (e) => {
        e.preventDefault();
        _timeFilter = _timeFilter === key ? "" : key;
        window.__updateFilterDisplay();
        _chipInView(a);
      });
      li.appendChild(a);
      timeBody.appendChild(li);
      _timeChips.set(key, { a, n: a.lastChild });
    });

    const ctlBody = document.createElement("ul");
    ctlBody.className = "filterBar-filters xfcf xfcf--ctl";
    const ctlLabel = document.createElement("li");
    ctlLabel.className = "xfcf-label";
    ctlLabel.textContent = "Queue";
    ctlBody.appendChild(ctlLabel);

    const _sortBtns = [];
    [["Start Ascending", QUEUE_ASC_URL],
     ["Start Descending", QUEUE_DESC_URL]].forEach((pair) => {
      const label = pair[0], url = pair[1];
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = url;
      a.className = "xfcf-chip xfcf-sort";
      a.dataset.sortUrl = url;
      a.textContent = label;
      a.title = label + " — " + url;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        try { localStorage.setItem(QUEUE_SORT_KEY, url); } catch (_) {}
        console.log("[QUEUE] starting sorted view: " + url);
        location.href = url;
      });
      li.appendChild(a);
      ctlBody.appendChild(li);
      _sortBtns.push(a);
    });

    const _curSearch = location.search || "";
    _sortBtns.forEach((b) => {
      const q = _sortedSearchOf(b.dataset.sortUrl);
      b.classList.toggle("is-active", !!q && q === _curSearch);
    });

    const roleSep = document.createElement("li");
    roleSep.className = "xfcf-sep";
    ctlBody.appendChild(roleSep);
    const roleLbl = document.createElement("li");
    roleLbl.className = "xfcf-label";
    roleLbl.textContent = "Rank";
    ctlBody.appendChild(roleLbl);
    const roleLi = document.createElement("li");
    const roleSel = document.createElement("select");
    roleSel.className = "xfcf-chip xfcf-role";
    roleSel.title = "Your forum rank — determines what is executed " +
      "automatically. Stays until you change it here.";
    Object.keys(MOD_ROLES).forEach((k) => {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = MOD_ROLES[k].label;
      roleSel.appendChild(opt);
    });
    roleSel.value = _getModRole();
    roleSel.addEventListener("change", () => {
      try { localStorage.setItem(MOD_ROLE_KEY, roleSel.value); } catch (_) {}
      console.log("[ROLE] mod rank set: " +
        MOD_ROLES[roleSel.value].label + " — reloading queue…");
      location.reload();
    });
    roleLi.appendChild(roleSel);
    ctlBody.appendChild(roleLi);

    let rankSet = false;
    try { rankSet = !!localStorage.getItem(MOD_ROLE_KEY); } catch (_) { rankSet = true; }
    if (!rankSet) {
      roleSel.classList.add("is-unset");
      const okLi = document.createElement("li");
      const ok = document.createElement("a");
      ok.href = "#";
      ok.className = "xfcf-chip xfcf-rank-ok";
      ok.textContent = "✓ That's my rank";
      ok.title = "Keeps " + MOD_ROLES[roleSel.value].label + " as your rank (change it any time here)";
      ok.addEventListener("click", (e) => {
        e.preventDefault();
        try { localStorage.setItem(MOD_ROLE_KEY, roleSel.value); } catch (_) {}
        roleSel.classList.remove("is-unset");
        okLi.remove();
      });
      okLi.appendChild(ok);
      ctlBody.appendChild(okLi);
    }

    console.log("[ROLE] active mod rank: " + MOD_ROLES[_getModRole()].label +
      " (ban=" + _roleCanBan() +
      ", altGender=" + _roleCanSeeAltGender() +
      ", altList=" + _roleCanAccessAltList() + ")");

    const rows = document.createElement("div");
    rows.className = "xfcf-wrap";
    rows.id = "lmqFilters";
    rows.append(menuBody, kindBody, timeBody, ctlBody);
    panelHost.appendChild(rows);
    void nativeFilterBar;
    console.log("[FILTER] bar ready: " + filters.length + " filters, " +
      _sortBtns.length + " sort buttons, native=" + !!nativeFilterBar);

    const _passApp = (labels, message) => {
      if (!activeFilters.size) return true;
      if (activeFilters.has("NORMAL") && labels.includes("NORMAL")) return true;
      if (labels.some((l) => activeFilters.has(l))) return true;
      return activeFilters.has("MANUAL") && !!message.dataset.manualKind && !_isAutoKind(message.dataset.manualKind);
    };
    const _passForeign = (m) => !activeFilters.size || _foreignKinds(m).some((k) => activeFilters.has(k));
    const _passTime = (m) => !_timeFilter || _timeBucket(_rowTime(m)) === _timeFilter;

    window.__updateFilterCounts = function () {
      let anyActive = !!_timeFilter;
      filters.forEach((f) => {
        const count = [...messagesMap.values()].filter((labels) =>
          labels.includes(f),
        ).length;
        const chip = _cfChips.get(f);
        if (!chip) return;
        const txt = String(count);
        if (chip.n.textContent !== txt) chip.n.textContent = txt;
        const on = activeFilters.has(f);
        if (on) anyActive = true;
        chip.a.classList.toggle("is-active", on);
        chip.a.classList.toggle("is-zero", !count && !on);
      });
      const man = _cfChips.get("MANUAL");
      if (man) {
        const nMan = _manualRows().length;
        const txt = String(nMan);
        if (man.n.textContent !== txt) man.n.textContent = txt;
        man.a.classList.toggle("has-items", nMan > 0);
        const on = activeFilters.has("MANUAL");
        if (on) anyActive = true;
        man.a.classList.toggle("is-active", on);
        man.a.classList.toggle("is-zero", !nMan && !on);
      }

      const fs = _foreignScan();
      if (!_kindRestored && fs.rows.length) _kindRestore();
      const kindHide = !fs.rows.length && !FOREIGN_KINDS.some(([t]) => activeFilters.has(t));
      if (kindBody.hidden !== kindHide) kindBody.hidden = kindHide;
      FOREIGN_KINDS.forEach(([tag]) => {
        const chip = _cfChips.get(tag);
        if (!chip) return;
        const n = fs.kinds[tag] || 0;
        const txt = String(n);
        if (chip.n.textContent !== txt) chip.n.textContent = txt;
        const on = activeFilters.has(tag);
        if (on) anyActive = true;
        chip.a.classList.toggle("is-active", on);
        chip.a.classList.toggle("has-items", n > 0);
        const hideIt = tag !== "APPEALS" && !n && !on;
        if (chip.li.hidden !== hideIt) chip.li.hidden = hideIt;
      });

      const per = { today: 0, yesterday: 0, week: 0, older: 0 };
      messagesMap.forEach((labels, m) => {
        if (!m.isConnected || !_passApp(labels, m)) return;
        const b = _timeBucket(_rowTime(m));
        if (b) per[b]++;
      });
      fs.rows.forEach((m) => {
        if (!_passForeign(m)) return;
        const b = _timeBucket(_rowTime(m));
        if (b) per[b]++;
      });
      _timeChips.forEach((chip, key) => {
        const txt = String(per[key]);
        if (chip.n.textContent !== txt) chip.n.textContent = txt;
        chip.a.classList.toggle("is-active", _timeFilter === key);
        chip.a.classList.toggle("is-zero", !per[key] && _timeFilter !== key);
      });
      const hide = !anyActive;
      if (cfClearBtn.hidden !== hide) cfClearBtn.hidden = hide;
      if (cfClearLi.hidden !== hide) cfClearLi.hidden = hide;
    };

    window.__updateFilterDisplay = function () {
      _kindSave();
      messagesMap.forEach((labels, message, map) => {
        if (!message.isConnected) {
          map.delete(message);
          return;
        }
        const disp = _passApp(labels, message) && _passTime(message) ? "" : "none";
        if (message.style.display !== disp) message.style.display = disp;
      });

      try {
        _foreignScan().rows.forEach((m) => {
          const disp = _foreignPicked(m) || (_passForeign(m) && _passTime(m)) ? "" : "none";
          if (m.style.display !== disp) m.style.display = disp;
        });
      } catch (_) {}
      window.__updateFilterCounts();
    };

    checkFirstIP();
  })();

  const _vpnInflight = new Map();
  const _vpnBatchInflight = new Map();

  const VPN_CACHE_KEY = "__vpnResultCacheV1";
  const VPN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const VPN_CACHE_MAX = 3000;
  let _vpnCacheStore = null;
  let _vpnCacheSaveTimer = null;

  function _loadVpnCache() {
    try {
      const now = Date.now();
      const raw = JSON.parse(localStorage.getItem(VPN_CACHE_KEY) || "{}");
      const keep = {};
      Object.keys(raw).forEach((ip) => {
        const e = raw[ip];
        if (!e || typeof e.ts !== "number") return;
        if (now - e.ts > VPN_CACHE_TTL_MS) return;
        if (typeof e.v !== "boolean") return;
        keep[ip] = e;
        ipCache[ip] = e.v;
      });
      return keep;
    } catch (_) { return {}; }
  }

  function _saveVpnCacheSoon() {
    if (_vpnCacheSaveTimer) return;
    _vpnCacheSaveTimer = setTimeout(_vpnCacheSaveNow, 800);
  }
  function _vpnCacheSaveNow() {
    if (_vpnCacheSaveTimer) { clearTimeout(_vpnCacheSaveTimer); _vpnCacheSaveTimer = null; }
    {
      try {
        const store = _vpnCacheStore || {};
        const ips = Object.keys(store);
        if (ips.length > VPN_CACHE_MAX) {
          ips.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0));
          ips.slice(0, ips.length - VPN_CACHE_MAX).forEach((k) => { delete store[k]; });
        }
        localStorage.setItem(VPN_CACHE_KEY, JSON.stringify(store));
      } catch (_) {}
    }
  }
  try { window.addEventListener("pagehide", () => { if (_vpnCacheSaveTimer) _vpnCacheSaveNow(); }); } catch (_) {}

  function _vpnCachePut(ip, isVpn) {
    if (typeof isVpn !== "boolean") return;
    LMS.svc("proxycheck", true);
    if (!_vpnCacheStore) _vpnCacheStore = _loadVpnCache();
    _vpnCacheStore[ip] = { v: isVpn, ts: Date.now() };
    _saveVpnCacheSoon();
  }

  (function _initVpnCache() {
    _vpnCacheStore = _loadVpnCache();
    const n = Object.keys(_vpnCacheStore).length;
    if (n) console.log("[VPN] loaded " + n + " cached result(s) (7-day cache)");
  })();

  const PC_USAGE_KEY = "__lmqPcUsage";
  function _pcDay() { return new Date().toISOString().slice(0, 10); }
  function _pcUsage() {
    try {
      const o = JSON.parse(localStorage.getItem(PC_USAGE_KEY) || "null");
      return o && o.day === _pcDay() ? o.n || 0 : 0;
    } catch (_) { return 0; }
  }
  function _pcCount(n) {
    try { localStorage.setItem(PC_USAGE_KEY, JSON.stringify({ day: _pcDay(), n: _pcUsage() + n })); } catch (_) {}
  }

  const VPN_WATCHDOG_MS = 12000;

  function checkVPN(ip) {
    if (ipCache[ip] !== undefined) return Promise.resolve(ipCache[ip]);
    if (_vpnInflight.has(ip)) return _vpnInflight.get(ip);

    if (_vpnBatchInflight.has(ip)) return _vpnBatchInflight.get(ip).then(() => checkVPN(ip));
    const _p = new Promise((res0) => {
      let settled = false;
      let wd = null;
      const resolve = (v) => {
        if (settled) return;
        settled = true;
        if (wd) clearTimeout(wd);
        res0(v);
      };
      const watch = (ms) => {
        if (wd) clearTimeout(wd);
        wd = setTimeout(() => {
          if (settled) return;
          _vpnStatusNote("no answer (" + Math.round(ms / 1000) + " s)", true);
          ipCache[ip] = null;
          resolve(null);
        }, ms);
      };

      let tries = 0;
      function again(why) {
        if (settled) return false;
        if (tries >= 2) return false;
        console.log("[VPN] " + why + " — asking proxycheck once more");
        setTimeout(() => { if (!settled) send(); }, 700);
        return true;
      }
      function send() {
      tries++;
      watch(tries === 1 ? VPN_WATCHDOG_MS : 10000);
      _pcCount(1);
      try { GM_xmlhttpRequest({
        method: "GET",
        url: `https://proxycheck.io/v2/${ip}?key=${API_KEY}&vpn=1&risk=1`,
        timeout: tries === 1 ? 10000 : 8000,
        onload(res) {
          let data;
          try {
            data = JSON.parse(res.responseText);
          } catch (_) {
            _vpnStatusNote("response not readable", true);
            ipCache[ip] = null;
            return resolve(null);
          }
          const status = data && data.status
            ? String(data.status).toLowerCase()
            : "";
          let entry = data ? data[ip] : null;

          if (!entry && data && typeof data === "object") {
            const rows = Object.keys(data).filter((k) => data[k] && typeof data[k] === "object" &&
              typeof data[k].proxy !== "undefined");
            if (rows.length === 1) entry = data[rows[0]];
          }

          if (status === "denied" || status === "error") {
            _vpnStatusNote("proxycheck status=" + status +
              (data && data.message ? " (" + data.message + ")" : ""), true);
            ipCache[ip] = null;
            return resolve(null);
          }
          if (!entry || typeof entry.proxy === "undefined") {
            _vpnStatusNote("no usable data" +
              (status === "warning" ? " (quota low/exhausted)" : ""), true);
            ipCache[ip] = null;
            return resolve(null);
          }
          if (status && status !== "ok") {
            _vpnStatusNote("proxycheck status=" + status +
              (data && data.message ? " (" + data.message + ")" : ""), false);
          }
          const isVPN = !!(entry.proxy === "yes" ||
            (entry.vpn && entry.vpn === "yes"));
          ipCache[ip] = isVPN;
          _vpnCachePut(ip, isVPN);
          resolve(isVPN);
        },
        onerror() {
          if (again("network error")) return;
          _vpnStatusNote("network error", true);
          ipCache[ip] = null;
          resolve(null);
        },
        ontimeout() {
          if (again("timeout")) return;
          _vpnStatusNote("Timeout", true);
          ipCache[ip] = null;
          resolve(null);
        },
      }); } catch (_) {
        _vpnStatusNote("request could not start", true);
        ipCache[ip] = null;
        resolve(null);
      }
      }
      send();
    });
    _vpnInflight.set(ip, _p);
    _p.finally(() => _vpnInflight.delete(ip));
    return _p;
  }

  let _vpnApiProblem = null;
  function _vpnStatusNote(msg, hard) {
    if (hard) _vpnApiProblem = msg;
    LMS.svc("proxycheck", !hard, msg);
    try {
      const el = document.getElementById("xfVpnApiStatus");
      if (el) {
        el.textContent = (hard ? "VPN check failed — " : "VPN check notice — ") + msg;
        el.dataset.tone = hard ? "err" : "warn";
        if (hard) el.classList.add("api-key-invalid");
      }
    } catch (_) {}
    console.warn("[VPN] " + (hard ? "problem" : "notice") + ": " + msg);
  }

  const _normUrlMemo = new Map();
  function normalizeProfileUrl(url) {
    if (!url) return null;
    const k = String(url);
    let v = _normUrlMemo.get(k);
    if (v !== undefined) return v;
    try { v = new URL(k, document.baseURI).href.split("#")[0]; }
    catch (_) {
      const a = document.createElement("a");
      a.href = k;
      v = a.href.split("#")[0];
    }
    if (_normUrlMemo.size > 4000) _normUrlMemo.clear();
    _normUrlMemo.set(k, v);
    return v;
  }

  function buildMultipleAccountListUrl(profileUrl) {
    const normalized = normalizeProfileUrl(profileUrl);
    if (!normalized) return null;
    if (normalized.includes("/multiple-account-list")) return normalized;
    return normalized.endsWith("/")
      ? normalized + "multiple-account-list/"
      : normalized + "/multiple-account-list/";
  }

  function getAltProfileUrlFromLog(message) {
    const listPlain = message.querySelector("ul.listPlain");
    if (listPlain) {
      const items = listPlain.querySelectorAll("li");
      for (const li of items) {
        if (/Multiple account/i.test(li.textContent)) {
          const link = li.querySelector('a[href*="/members/"]');
          if (link) return normalizeProfileUrl(link.getAttribute("href"));
        }
      }
      const anyLink = listPlain.querySelector('a[href*="/members/"]');
      if (
        anyLink &&
        /Multiple account/i.test(anyLink.closest("li")?.textContent || "")
      ) {
        return normalizeProfileUrl(anyLink.getAttribute("href"));
      }
    }

    const userLink = message.querySelector(
      ".message-userDetails a.username, a.username",
    );
    if (userLink) return normalizeProfileUrl(userLink.getAttribute("href"));

    return null;
  }

  function _parseAltsFromApplicationLog(message, applicantProfileUrl) {
    const out = [];
    const seen = new Set();
    try {
      const listPlain = message.querySelector("ul.listPlain");
      if (!listPlain) return out;
      const lis = listPlain.querySelectorAll("li");
      for (const li of lis) {
        const txt = li.textContent || "";
        if (!/Multiple account|Shared IP with rejected users/i.test(txt)) {
          continue;
        }
        const links = li.querySelectorAll('a[href*="/members/"]');
        for (const link of links) {
          const url = normalizeProfileUrl(link.getAttribute("href"));
          if (!url) continue;
          if (applicantProfileUrl && url === applicantProfileUrl) continue;
          if (seen.has(url)) continue;
          const nameSpan = link.querySelector("span") || link;
          const name = (nameSpan.textContent || "").trim();
          if (!name) continue;
          seen.add(url);
          out.push({ name, url, status: "Unknown", nameClass: "" });
        }
      }
    } catch (_) {}
    return out;
  }

  function parseStatusFromRowText(text) {
    if (/Approved/i.test(text)) return "Approved";
    if (/Rejected/i.test(text)) return "Rejected";
    if (/Pending/i.test(text)) return "Pending";
    if (/Awaiting approval/i.test(text)) return "Pending";
    if (/Moderating/i.test(text)) return "Moderating";
    return "Pending";
  }

  function parseStatusFromRow(row) {
    const statusEl = row.querySelector(
      ".dataList-cell--status, .structItem-status, .status",
    );
    if (statusEl) return parseStatusFromRowText(statusEl.textContent || "");
    return parseStatusFromRowText(row.textContent || "");
  }

  function getUsernameStyleClassFromRow(row, link) {
    const inLink = link.querySelector('span[class*="username--style"]');
    const inRow = row.querySelector('span[class*="username--style"]');
    const el = inLink || inRow;
    if (!el) return null;
    const cls = [...el.classList].find((c) => c.startsWith("username--style"));
    return cls || null;
  }

  function extractAltAccountsFromDoc(doc, excludeProfileUrl) {
    const paneRoot = doc.querySelector(".js-memberTabPanes") || doc;

    const blocks = [...paneRoot.querySelectorAll(".block")];
    let targetBlock = null;
    for (const b of blocks) {
      const counter = b.querySelector(".block-footer-counter");
      if (counter && /Matched/i.test(counter.textContent)) {
        targetBlock = b;
        break;
      }
    }

    const searchRoot = targetBlock || paneRoot;
    const rows = searchRoot.querySelectorAll(
      "tr, .dataList-row, .structItem, li",
    );

    const results = [];

    rows.forEach((row) => {
      if (!row.textContent.toLowerCase().includes("cookie")) return;

      const link = row.querySelector('a[href*="/members/"]');
      if (!link) return;

      if (
        link.closest("nav") ||
        link.closest(".p-nav") ||
        link.closest(".p-navEl")
      ) {
        return;
      }

      const url = normalizeProfileUrl(link.getAttribute("href"));
      if (!url) return;
      if (excludeProfileUrl && url === excludeProfileUrl) return;

      const nameSpan = link.querySelector("span") || link;
      const name = (nameSpan.textContent || "").trim();
      if (!name) return;

      const status = parseStatusFromRow(row);
      const nameClass = getUsernameStyleClassFromRow(row, link);

      const det = ["Cookie"];
      {

        const parts = [];
        const tw = row.ownerDocument.createTreeWalker(row, 4);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!link.contains(n)) parts.push(n.nodeValue);
        if (/\bip\b|ip[\s-]*address/i.test(LM_SPLIT(parts.join(" ")))) det.push("IP");
      }

      const key = _acctKey(url);
      const dup = results.find((r) => _acctKey(r.url) === key);
      if (dup) {
        if (det.indexOf("IP") !== -1 && dup.det.indexOf("IP") === -1) dup.det.push("IP");
        if (nameClass && /username--style[56]/i.test(nameClass)) dup.nameClass = nameClass;
        return;
      }
      results.push({
        name,
        url,
        status,
        nameClass,
        det,
      });
    });

    const unique = new Map();
    results.forEach((item) => {
      if (!unique.has(item.url)) unique.set(item.url, item);
    });
    return [...unique.values()];
  }

  const _altInflight = new Map();
  function fetchAltAccounts(profileUrl) {
    const _norm = normalizeProfileUrl(profileUrl);
    if (!_norm) return Promise.resolve([]);
    if (altCache.has(_norm)) return Promise.resolve(altCache.get(_norm));
    if (_altInflight.has(_norm)) return _altInflight.get(_norm);
    const _altP = new Promise((resolve) => {
      const normalized = _norm;

      const url = buildMultipleAccountListUrl(normalized);
      if (!url) return resolve([]);

      const fail = (why) => {
        _altListFailed.add(normalized);
        _altListFailReason.set(normalized, why);
        console.warn("[ALT-LIST] " + why + " for " + normalized +
          " — not cached, cascade treats alt check as incomplete");
        resolve([]);
      };

      const attempt = (left, delay) => {
        const retry = (why) => {
          if (left > 0) {
            console.log("[ALT-LIST] " + why + " — retrying in " + delay + " ms");
            return setTimeout(() => attempt(left - 1, delay * 2), delay);
          }
          fail(why);
        };
        _lmRequest({
          method: "GET",
          url,
          timeout: 15000,
          onload(res) {
            if (res.status !== 200) {
              if (res.status === 403 || res.status === 404) return fail("HTTP " + res.status);
              return retry("HTTP " + res.status);
            }
            try {
              const parser = new DOMParser();
              const doc = parser.parseFromString(res.responseText, "text/html");

              const root = doc.documentElement;
              const loggedIn = root ? root.getAttribute("data-logged-in") : null;
              const tpl = root ? (root.getAttribute("data-template") || "") : "";
              if (loggedIn === "false") return fail("not logged in");
              if (/^(login|error|no_permission)$/i.test(tpl)) return fail("page: " + tpl);
              const accounts = extractAltAccountsFromDoc(doc, null);
              altCache.set(normalized, accounts);
              _altListFailed.delete(normalized);
              resolve(accounts);
            } catch {
              retry("parse error");
            }
          },
          onerror() { retry("network error"); },
          ontimeout() { retry("timeout"); },
        });
      };
      attempt(2, 700);
    });
    _altInflight.set(_norm, _altP);
    _altP.finally(() => _altInflight.delete(_norm));
    return _altP;
  }

  function _dedupInflight(map, cache, raw) {
    return function (profileUrl, diag) {
      const key = normalizeProfileUrl(profileUrl);
      if (!key) return Promise.resolve(null);
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      let p = map.get(key);
      if (!p) {
        const d = {};
        p = Promise.resolve(raw(key, d)).then((v) => ({ v: v, tmp: !!d.temporary }));
        map.set(key, p);
        p.finally(() => map.delete(key));
      }
      return p.then((r) => {
        if (r.tmp && diag) diag.temporary = true;
        return r.v;
      });
    };
  }

  const fetchGenderFromProfile =
    _dedupInflight(new Map(), genderCache, _fetchGenderRaw);
  const fetchUserState =
    _dedupInflight(new Map(), userStateCache, _fetchUserStateRaw);
  const fetchDeletionDate =
    _dedupInflight(new Map(), deletionDateCache, _fetchDeletionDateFast);

  function _fetchGenderRaw(profileUrl, diag) {
    return new Promise((resolve) => {
      const normalized = normalizeProfileUrl(profileUrl);
      if (!normalized) return resolve(null);
      if (genderCache.has(normalized)) {
        return resolve(genderCache.get(normalized));
      }

      const editUrl = normalized.endsWith("/")
        ? normalized + "edit"
        : normalized + "/edit";

      const finish = (gender, definitive, source) => {
        if (definitive) {
          genderCache.set(normalized, gender);
          if (gender && String(gender).toLowerCase() === "female") {
            console.log("[GENDER] female detected: " + normalized +
              " (source: " + source + ")");
          }
        } else {
          if (diag) diag.temporary = true;
          console.warn("[GENDER] lookup incomplete for " + normalized +
            " — not cached, will retry");
        }
        resolve(gender);
      };

      const tryProfile = (retriesLeft) => {
        _lmRequest({
          method: "GET",
          url: normalized,
          onload(res) {
            if (res.status === 404 || res.status === 403 || res.status === 410) {
              return finish(null, true, "gone");
            }
            if (res.status !== 200) {
              if (retriesLeft > 0) return tryProfile(retriesLeft - 1);
              return finish(null, false);
            }
            try {
              const doc = new DOMParser().parseFromString(
                res.responseText, "text/html");
              const dd = doc.querySelector('dl[data-field="male_female"] dd');
              if (dd) {
                const v = dd.textContent.trim();
                return finish(v || null, true, "profile");
              }
              if (retriesLeft > 0) return tryProfile(retriesLeft - 1);
              return finish(null, false);
            } catch {
              if (retriesLeft > 0) return tryProfile(retriesLeft - 1);
              finish(null, false);
            }
          },
          onerror() {
            if (retriesLeft > 0) return tryProfile(retriesLeft - 1);
            finish(null, false);
          },
          ontimeout() {
            if (retriesLeft > 0) return tryProfile(retriesLeft - 1);
            finish(null, false);
          },
        });
      };

      const tryEdit = (retriesLeft) => {
        _lmRequest({
          method: "GET",
          url: editUrl,
          onload(res) {
            if (res.status === 404 || res.status === 403 || res.status === 410) {
              return tryProfile(1);
            }
            if (res.status !== 200) {
              if (retriesLeft > 0) return tryEdit(retriesLeft - 1);
              return tryProfile(1);
            }
            try {
              const doc = new DOMParser().parseFromString(
                res.responseText, "text/html");
              const radio = doc.querySelector(
                'dl[data-field="male_female"] input[type="radio"][checked]');
              if (radio && radio.value) {
                return finish(radio.value, true, "edit");
              }
              return tryProfile(1);
            } catch {
              if (retriesLeft > 0) return tryEdit(retriesLeft - 1);
              tryProfile(1);
            }
          },
          onerror() {
            if (retriesLeft > 0) return tryEdit(retriesLeft - 1);
            tryProfile(1);
          },
          ontimeout() {
            if (retriesLeft > 0) return tryEdit(retriesLeft - 1);
            tryProfile(1);
          },
        });
      };

      tryEdit(1);
    });
  }

  const _mpCache = new TtlMap(CACHE_TTL_MS);
  function _mpPage(url, fresh) {
    if (!fresh && _mpCache.has(url)) return _mpCache.get(url);
    const p = new Promise((resolve) => {
      _lmRequest({
        method: "GET",
        url: url,
        timeout: 15000,
        onload(res) {
          if (res.status !== 200) return resolve({ kind: "load", status: res.status, doc: null });
          let doc = null;
          try { doc = new DOMParser().parseFromString(res.responseText, "text/html"); } catch (_) {}
          resolve({ kind: "load", status: 200, doc: doc });
        },
        onerror() { resolve({ kind: "error" }); },
        ontimeout() { resolve({ kind: "timeout" }); },
      });
    });
    _mpCache.set(url, p);
    p.then((r) => {
      if (!(r.kind === "load" && r.status === 200 && r.doc) && _mpCache.get(url) === p) {
        _mpCache.delete(url);
      }
    });
    return p;
  }
  function _mpUrlFor(profileUrl) {
    const m = String(profileUrl || "").match(/\/members\/([^./]+)\.(\d+)/i);

    const bare = m ? null : String(profileUrl || "").match(/\/members\/(\d+)(?:[/?#]|$)/i);
    if (!m && !bare) return null;
    try {
      return new URL(profileUrl, location.href).origin + "/moderatorpanel/user/" +
        (m ? m[1] + "." + m[2] : bare[1]) + "/";
    }
    catch (_) { return null; }
  }

  function _fetchUserStateRaw(profileUrl, diag) {
    return new Promise((resolve) => {
      const normalized = normalizeProfileUrl(profileUrl);
      if (!normalized) return resolve(null);
      if (userStateCache.has(normalized)) {
        return resolve(userStateCache.get(normalized));
      }

      const mcpUrl = _mpUrlFor(normalized);
      if (!mcpUrl) {
        userStateCache.set(normalized, null);
        return resolve(null);
      }

      const failTransient = () => {
        if (diag) diag.temporary = true;
        console.warn("[USER-STATE] lookup incomplete for " + normalized +
          " — not cached, will retry");
        resolve(null);
      };

      const attempt = (retriesLeft, fresh) => {
        const retry = () => {
          if (retriesLeft > 0) return setTimeout(() => attempt(retriesLeft - 1, true), 700);
          failTransient();
        };
        _mpPage(mcpUrl, fresh).then((r) => {
          if (r.kind !== "load") return retry();
          if (r.status === 404 || r.status === 403 || r.status === 410) {
            userStateCache.set(normalized, null);
            resolve(null);
            return;
          }
          if (r.status !== 200 || !r.doc) return retry();
          try {
            const blurbs = r.doc.querySelectorAll(".memberHeader-blurb");
            let stateDd = null;
            for (const blurb of blurbs) {
              const dt = blurb.querySelector("dt");
              if (dt && /User state/i.test(dt.textContent)) {
                stateDd = blurb.querySelector("dd");
                break;
              }
            }
            if (!stateDd) return retry();
            const state = stateDd.textContent.trim();
            userStateCache.set(normalized, state);
            resolve(state);
          } catch (_) {
            retry();
          }
        });
      };
      attempt(1, false);
    });
  }

  function _deletionTsFromDoc(doc) {
    const rowGroups = doc.querySelectorAll(".dataList-rowGroup");
    for (const group of rowGroups) {
      const rows = group.querySelectorAll(".dataList-row");
      for (const row of rows) {
        const cells = row.querySelectorAll(".dataList-cell");
        if (cells.length >= 3) {
          const fieldName = cells[0].textContent.trim();
          const newValue = cells[2].textContent.trim();
          if (/username/i.test(fieldName) && /Deleted member/i.test(newValue)) {
            const subSection = group.querySelector(".dataList-row--subSection time");
            const ts = subSection ? subSection.getAttribute("data-time") : null;
            if (ts) return parseInt(ts, 10) * 1000;
          }
        }
      }
    }
    return null;
  }

  function _getHtml(url) {
    return new Promise((resolve) => {
      try {
        _lmRequest({
          method: "GET",
          url: url,
          timeout: 10000,
          onload(res) { resolve(res.status === 200 ? res.responseText : null); },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      } catch (_) { resolve(null); }
    });
  }

  async function _fetchDeletionDateFast(profileUrl) {
    let sawChangeLog = false;
    try {
      const base = _mpUrlFor(profileUrl);
      if (base) {
        const origin = new URL(profileUrl).origin;
        const r = await _mpPage(base, false);
        const doc = r.kind === "load" && r.status === 200 ? r.doc : null;
        if (doc) {
          let ts = _deletionTsFromDoc(doc);
          if (ts) { deletionDateCache.set(profileUrl, ts); return ts; }
          const tab = doc.querySelector(
            'a[href$="#change-log"][data-href], [aria-controls*="change-log"][data-href]');
          const tabHref = tab ? tab.getAttribute("data-href") : null;
          if (tabHref) {
            const html2 = await _getHtml(new URL(tabHref, origin).href);
            if (html2) {
              const doc2 = new DOMParser().parseFromString(html2, "text/html");
              ts = _deletionTsFromDoc(doc2);
              if (ts) { deletionDateCache.set(profileUrl, ts); return ts; }
              if (doc2.querySelector(".dataList-rowGroup")) sawChangeLog = true;
            }
          } else if (doc.querySelector(".dataList-rowGroup")) {
            sawChangeLog = true;
          }
        }
      }
    } catch (_) {}
    if (sawChangeLog) {

      deletionDateCache.set(profileUrl, null);
      return null;
    }
    return _fetchDeletionDateIframe(profileUrl);
  }

  function _fetchDeletionDateIframe(profileUrl) {
    return new Promise((resolve) => {
      const normalized = normalizeProfileUrl(profileUrl);
      if (!normalized) return resolve(null);
      if (deletionDateCache.has(normalized)) {
        return resolve(deletionDateCache.get(normalized));
      }

      const match = normalized.match(/\/members\/([^\./]+)\.(\d+)/i);
      if (!match) {
        deletionDateCache.set(normalized, null);
        return resolve(null);
      }
      const userName = match[1];
      const userId = match[2];
      const origin = new URL(normalized).origin;
      const mcpUrl = `${origin}/moderatorpanel/user/${userName}.${userId}/#change-log`;

      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.sandbox = "allow-scripts allow-same-origin allow-forms";
      document.body.appendChild(iframe);

      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        setTimeout(() => {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 1000);
      };

      iframe.onload = () => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow.document;

          const changeLogTab = doc.querySelector('a[href$="#change-log"]');
          if (changeLogTab) {
            changeLogTab.click();
          }

          let attempts = 0;
          const maxAttempts = 60;
          const poll = setInterval(() => {
            attempts++;
            try {
              const currentDoc =
                iframe.contentDocument || iframe.contentWindow.document;
              const rowGroups =
                currentDoc.querySelectorAll(".dataList-rowGroup");

              if (rowGroups.length > 0 || attempts >= maxAttempts) {
                clearInterval(poll);

                let deletionTimestamp = null;
                for (const group of rowGroups) {
                  const rows = group.querySelectorAll(".dataList-row");
                  for (const row of rows) {
                    const cells = row.querySelectorAll(".dataList-cell");
                    if (cells.length >= 3) {
                      const fieldName = cells[0].textContent.trim();
                      const newValue = cells[2].textContent.trim();
                      if (
                        /username/i.test(fieldName) &&
                        /Deleted member/i.test(newValue)
                      ) {
                        const subSection = group.querySelector(
                          ".dataList-row--subSection time",
                        );
                        if (subSection) {
                          const ts = subSection.getAttribute("data-time");
                          if (ts) deletionTimestamp = parseInt(ts, 10) * 1000;
                        }
                        break;
                      }
                    }
                  }
                  if (deletionTimestamp) break;
                }

                deletionDateCache.set(normalized, deletionTimestamp);
                cleanup();
                resolve(deletionTimestamp);
              }
            } catch (e) {
              clearInterval(poll);
              deletionDateCache.set(normalized, null);
              cleanup();
              resolve(null);
            }
          }, 300);
        } catch (e) {
          deletionDateCache.set(normalized, null);
          cleanup();
          resolve(null);
        }
      };

      iframe.onerror = () => {
        deletionDateCache.set(normalized, null);
        cleanup();
        resolve(null);
      };

      iframe.src = mcpUrl;
    });
  }

  async function renderAltAccounts(message, accounts, excludeProfileUrl) {
    const ui = _rowUi(message);
    if (!ui) return;
    const box = ui.altList();

    const filtered = (accounts || []).filter((acc) => {
      if (!excludeProfileUrl) return true;
      return acc.url !== excludeProfileUrl;
    });

    box.textContent = "";
    if (!filtered || filtered.length === 0) {
      box.appendChild(_el("div", "lmq-none", "None found"));
      return;
    }
    for (const acc of filtered) {
      const itemContainer = _el("div", "lmq-alt alt-account-container");
      const item = _el("div", "lmq-alt-row alt-item");
      const a = _el("a");
      a.href = acc.url;
      a.target = "_blank";
      a.rel = "noopener";
      if (acc.nameClass) a.appendChild(_el("span", acc.nameClass, acc.name));
      else a.textContent = acc.name;
      const status = _el("span", "lmq-st", "loading …");
      status.dataset.s = "loading";
      status.dataset.profileUrl = acc.url;
      item.append(a, status);
      const detPill = acc.det && LM_DET.pill(acc.det);
      if (detPill) item.appendChild(detPill);
      itemContainer.appendChild(item);
      box.appendChild(itemContainer);

      const _stateP = _roleCanAccessAltList()
        ? fetchUserState(acc.url)
        : Promise.resolve(null);
      _stateP.then((state) => {
        if (!_roleCanAccessAltList()) {
          status.textContent = "no access";
          status.dataset.s = "unknown";
          return;
        }
        if (!state) {
          status.textContent = "unknown";
          status.dataset.s = "unknown";
          return;
        }
        let displayState = state;
        let s2 = "pending";
        if (state === "Valid") {
          displayState = "Approved";
          s2 = "approved";
          const labels = messagesMap.get(message);
          if (labels && !labels.includes("APPROVED ALT")) {
            labels.push("APPROVED ALT");
            const altIdx = labels.indexOf("OTHER ALT");
            if (altIdx !== -1) labels.splice(altIdx, 1);
            _filterDisplaySoon();
          }
        } else if (/disabled/i.test(state)) {
          displayState = "Disabled";
          s2 = "disabled";
          fetchDeletionDate(acc.url).then((deletionTs) => {
            const prevDate = itemContainer.querySelector(".deletion-date");
            if (prevDate) prevDate.remove();
            const delRow = _el("div", "lmq-sub deletion-date", "Deleted: ");
            const bubble = _el("b");
            if (deletionTs) {
              const diffDays = Math.floor((Date.now() - deletionTs) / (1000 * 60 * 60 * 24));
              if (diffDays >= 90) {
                bubble.dataset.s = "ok";
                bubble.textContent = diffDays + " days ago (≥ 90)";
              } else {
                bubble.dataset.s = "bad";
                bubble.textContent = diffDays + " days ago (" + (90 - diffDays) + " days left)";
              }
            } else {
              bubble.dataset.s = "bad";
              bubble.textContent = "no deletion date found";
            }
            delRow.appendChild(bubble);
            itemContainer.appendChild(delRow);
          });
        } else if (/pending/i.test(state) || /awaiting/i.test(state) || /moderat/i.test(state)) {
          displayState = "Pending";
        } else if (/rejected/i.test(state)) {
          displayState = "Rejected";
          s2 = "rejected";
        }
        status.textContent = displayState;
        status.dataset.s = s2;
      });

      if (!ALT_GENDER_CHECK) continue;

      const genderRow = _el("div", "lmq-sub gender-row", "Gender: ");
      const genderValue = _el("b", "gender-value", "loading …");
      genderValue.dataset.profileUrl = acc.url;
      genderRow.appendChild(genderValue);
      itemContainer.appendChild(genderRow);
      if (!_roleCanSeeAltGender()) {
        genderValue.textContent = "hidden (no permission)";
      } else {
        fetchGenderFromProfile(acc.url).then((gender) => {
          genderValue.textContent = gender || "not found";
          if (gender && /female/i.test(gender)) genderValue.dataset.s = "bad";
        });
      }
    }
  }

  function _collectStylesheets() {
    const out = [];
    try {
      const links = document.querySelectorAll('link[rel="stylesheet"][href]');
      for (let i = 0; i < links.length; i++) {
        try {
          const u = new URL(links[i].getAttribute("href"), location.href).href;
          if (/^https?:/.test(u) && out.indexOf(u) === -1) out.push(u);
        } catch (_) {}
      }
    } catch (_) {}
    return out.slice(0, 10);
  }

  function _captureApplicationHtml(message) {
    let node = message;
    try {
      node = message.closest(".block-container") || message;
    } catch (_) {}
    let clone = null;
    try { clone = node.cloneNode(true); } catch (_) { return ""; }

    try {
      const oImgs = node.querySelectorAll("img");
      const cImgs = clone.querySelectorAll("img");
      const cv = document.createElement("canvas");
      const ctx = cv.getContext("2d");
      for (let i = 0; i < oImgs.length && i < cImgs.length; i++) {
        const src = oImgs[i];
        try {
          if (!src.complete || !src.naturalWidth || !src.naturalHeight) continue;
          cv.width = src.naturalWidth;
          cv.height = src.naturalHeight;
          ctx.clearRect(0, 0, cv.width, cv.height);
          ctx.drawImage(src, 0, 0);
          const isPng = /\.png($|\?)/i.test(src.currentSrc || src.src || "");
          const data = isPng ? cv.toDataURL("image/png")
                             : cv.toDataURL("image/jpeg", 0.85);
          if (data && data.length > 200) cImgs[i].setAttribute("src", data);
        } catch (_) {}
      }
    } catch (_) {}

    const kill = [
      ".xf-report-box", ".xf-report-panel", ".xf-report-btn", "#xfStatsPanel",
      ".xf-ban-confirm-row", ".lmq-qr", ".foid-ban-btn",
    ];
    kill.forEach((sel) => {
      try {
        const els = clone.querySelectorAll(sel);
        for (let i = 0; i < els.length; i++) els[i].remove();
      } catch (_) {}
    });

    try {
      ["data-xf-hl", "data-xf-report-added", "data-auto-reject",
       "data-alt-checked", "data-decision-checked",
       "data-alt-list-failed",
       "data-alt-log-unparsed"].forEach((attr) => {
        const els = clone.querySelectorAll("[" + attr + "]");
        for (let i = 0; i < els.length; i++) els[i].removeAttribute(attr);
      });
    } catch (_) {}

    const liveChecked = new Map();
    try {
      const key = (el) => (el.name || "") + "|" + (el.value || "") + "|" + el.type;
      node.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((el) => {
        if (!liveChecked.has(key(el))) liveChecked.set(key(el), el.checked);
      });
      clone.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((el) => {
        if (liveChecked.get(key(el))) el.setAttribute("checked", "checked");
        else el.removeAttribute("checked");
      });
    } catch (_) {}

    try {
      const keyOf = (el) => (el.name || "") + "|" + (el.value || "") + "|" + el.type;
      const deps = clone.querySelectorAll("ul.inputChoices-dependencies");
      for (let i = 0; i < deps.length; i++) {
        const dep = deps[i];
        const li = dep.closest("li");
        const radio = li ? li.querySelector('input[type="radio"]') : null;
        const active = !!(radio && liveChecked.get(keyOf(radio)));
        if (active) dep.classList.remove("is-disabled");
        else dep.classList.add("is-disabled");
        const fields = dep.querySelectorAll("input, textarea, select");
        for (let k = 0; k < fields.length; k++) {
          fields[k].disabled = !active;
          if (active) fields[k].classList.remove("is-disabled");
          else fields[k].classList.add("is-disabled");
        }
      }
    } catch (_) {}

    try {
      clone.querySelectorAll("details.lmq-log").forEach((d) => d.setAttribute("open", ""));
      const st = document.createElement("style");
      st.textContent = LMQ_CSS;
      clone.insertBefore(st, clone.firstChild);
    } catch (_) {}

    return clone.outerHTML || "";
  }

  function _injectReportButton(message) {
    const removed = true;
    if (removed || _serverOff()) return;
    if (message.getAttribute("data-xf-report-added") === "1") return;
    const cell = message.querySelector(".message-cell--extra") ||
      message.querySelector(".message-cell--main");
    if (!cell) return;
    message.setAttribute("data-xf-report-added", "1");

    const host = message.closest(".block-body") || message.parentNode || cell;

    const btn = _el("button", "lmq-btn lmq-btn--ghost lmq-btn--sm xf-report-btn", "Report");
    btn.type = "button";

    const panel = _el("div", "xf-report-panel");
    panel.style.display = "none";

    const label = _el("div", "lmq-rp-t", "Why are you reporting this application?");

    const ta = document.createElement("textarea");
    ta.className = "input";
    ta.rows = 3;
    ta.placeholder = "e.g. detector said notLm, but this is a shared-IP alt";

    const row = _el("div", "lmq-rp-row");

    const send = _el("button", "lmq-btn lmq-btn--gold lmq-btn--sm xf-report-send", "Send report");
    send.type = "button";

    const cancel = _el("button", "lmq-btn lmq-btn--sm xf-report-cancel", "Cancel");
    cancel.type = "button";

    const status = _el("span", "xf-report-status");

    row.appendChild(send);
    row.appendChild(cancel);
    row.appendChild(status);
    panel.appendChild(label);
    panel.appendChild(ta);
    panel.appendChild(row);

    cell.appendChild(btn);
    host.appendChild(panel);

    btn.addEventListener("click", () => {
      const open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
      if (open) ta.focus();
    });
    cancel.addEventListener("click", () => {
      panel.style.display = "none";
      status.textContent = "";
    });

    send.addEventListener("click", () => {
      const reason = (ta.value || "").trim();
      if (!reason) {
        status.textContent = "Please enter a reason.";
        status.dataset.s = "err";
        return;
      }
      const applicantLink = message.querySelector(".message-userDetails a.username");
      const applicant = applicantLink ? (applicantLink.textContent || "").trim() : null;
      const html = _captureApplicationHtml(message);
      if (!html) {
        status.textContent = "Could not capture the HTML.";
        status.dataset.s = "err";
        return;
      }
      send.disabled = true;
      status.dataset.s = "";
      status.textContent = "Sending…";
      const _tPost = Date.now();
      const _kb = Math.round(html.length / 1024);
      GM_xmlhttpRequest({
        method: "POST",
        url: SERVER_BASE + "/report",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": ZEROGPT_API_KEY,
        },
        data: JSON.stringify({
          mod: _modIdentity().name,
          applicant: applicant,
          reason: reason,
          html: html,
          stylesheets: _collectStylesheets(),
        }),
        timeout: 20000,
        onload(res) {
          send.disabled = false;
          let ok = false;
          try { ok = res.status === 200 && JSON.parse(res.responseText).ok === true; } catch (_) {}
          console.log("[REPORT] sent in " + (Date.now() - _tPost) + "ms (" +
            _kb + " KB, http " + res.status + ")");
          if (ok) {
            status.dataset.s = "ok";
            status.textContent = "Report sent — thank you.";
            ta.value = "";
            setTimeout(() => { panel.style.display = "none"; }, 300);
          } else {
            status.dataset.s = "err";
            status.textContent = "Server returned " + res.status + ".";
          }
        },
        onerror() {
          send.disabled = false;
          status.dataset.s = "err";
          status.textContent = "Server not reachable.";
        },
        ontimeout() {
          send.disabled = false;
          status.dataset.s = "err";
          status.textContent = "Timeout while sending.";
        },
      });
    });
  }

  function addDecisionHelper(
    message,
    applicantFlags,
    altAccounts,
    excludeUrl,
    reasonText,
  ) {
    const ui = _rowUi(message);
    if (!ui) return;

    try { _injectReportButton(message); } catch (_) {}

    function addFlag(label, type) {
      ui.flag(label, type);
    }

    if (applicantFlags) {
      if (applicantFlags.isApplicantBanned) addFlag("Banned", "ban");
      if (applicantFlags.isFemale) addFlag("Female", "ban");
      if (applicantFlags.isTooShort) addFlag("Too Short", "reject");
      if (applicantFlags.isVpnProxy) addFlag("VPN Detected", "reject");
      if (applicantFlags.isVpnUnknown) addFlag("VPN?", "reject");
    }
    if (!ALT_GENDER_CHECK) ui.log("Decision Cascade v" + SCRIPT_VERSION + " (alt gender off)", "mute");

    const cascadeUsername =
      (message.querySelector(".message-userDetails a.username, a.username") ||
        {}).textContent || null;

    let cascadeDone = false;

    function cascadeLogStep(text, color) {
      ui.log(text, _HEX_TONE[color] || (color ? "mute" : ""));
    }

    async function cascadeFinish(action, reasonKey, summary, extra) {
      if (cascadeDone) return;
      cascadeDone = true;
      _dockDone(message, true);

      if (/^ban/.test(action) && !_roleCanBan()) {
        console.log("[ROLE] " + action + " SKIPPED — rank '" +
          _roleCfg().label + "' has no ban permission (" +
          (cascadeUsername || "?") + ") → row stays in the queue");
        action = "manual";
        reasonKey = null;
        summary = "BAN skipped (" + _roleCfg().label +
          " has no ban permission) — left in queue for staff: " + summary;
      }

      _markManual(message, action === "manual" ? _manualKindOf(summary) : null);

      const labelMap = {
        "ban-alt": "ALT-BAN",
        "ban-alt-generic": "ALT-BAN-UNAPPROVED",
        "ban-female-alt": "FEMALE-ALT-BAN",
        "ban-deleted-not-waited": "BAN-DELETED-NOT-WAITED",
      };
      const label = labelMap[action] || action.toUpperCase();
      const tone = action === "approve" ? "ok" : action === "reject" ? "rej" :
        action === "manual" ? "man" : /^ban/.test(action) ? "ban" : "mute";
      ui.verdict(tone, label + (reasonKey ? " · " + reasonKey : ""), summary);

      pushAudit({
        ts: Date.now(),
        username: cascadeUsername,
        action,
        reason_key: reasonKey,
        reasoning: summary,
        source: "cascade",
      });
      if (action === "ban" || action === "ban-alt" ||
          action === "ban-alt-generic" || action === "ban-female-alt" ||
          action === "ban-deleted-not-waited") {
        addFlag("Cascade: " + label, "ban");
      } else if (action === "reject") {
        addFlag("Cascade: REJECT" +
          (reasonKey ? " (" + reasonKey + ")" : ""), "reject");
      }

      if (AUTO_EXECUTE && action !== "manual") {
        let dedup = await wasRecentlyProcessed(message, cascadeUsername);

        let _resumePendingBan = false;
        if (/^ban/.test(action)) {
          const rs = await _banResumeDecision(message, cascadeUsername, dedup, applicantFlags, action);
          dedup = rs.dedup;
          if (rs.verdict !== "fresh") {
            console.log("[BAN-RESUME] " + (cascadeUsername || "?") + ": " + action + " -> " +
              rs.verdict + (rs.why ? " (" + rs.why + ")" : ""));
          }
          if (rs.verdict === "resume") {
            _resumePendingBan = true;
            if (rs.verify) _banVerifyFirst.add(message);
          } else if (rs.verdict === "wait") {
            _holdRowForManual(message, ui, rs.text, "ban-wait");
            _scheduleRowRecheck(message, rs.waitMs);
            return;
          } else if (rs.verdict === "gaveup") {
            _markManual(message, "ban");
            ui.verdict("man", "Manual", "Ban failed after several automatic tries — please ban by hand.");
            ui.exec("err", "ban failed");
            return;
          }
        }

        if (_dedupBlocksExecution(dedup, action) && !_resumePendingBan) {
          console.log("[CASCADE] already processed: " + (cascadeUsername || "?") +
            " (status=" + dedup.status + ", source=" + dedup.source +
            ") → form action only, no re-ban");

          if (/^ban/.test(action) && dedup.status !== "done") {
            _markManual(message, "ban");
            ui.verdict("man", "Manual", "Earlier ban not confirmed — " +
              "check the profile whether banned, then decide manually.");
            ui.exec("warn", "Dedup");
            return;
          }
          if (dedup.status === "pending") ui.exec("wait", "Dedup · already running, no second ban");
          else if (dedup.status === "unknown") ui.exec("warn", "Dedup · unconfirmed — check");
          else ui.exec("ok", "Dedup · selection only");

          const _selText = action === "approve" ? null : _userFacingRejectText(action, reasonKey, extra);
          try {
            _intended.set(message, {
              radioValue: _intendedValueFor(action),
              action: action,
              isBan: false,
              reasonKey: _selText ? (reasonKey || "custom") : null,
              user: _userIdFromMessage(message),
              ui: ui,
              status: null,
              category: _statCategory(action, reasonKey, summary, extra),
              notify: _notifyFor(action),
            });
          } catch (_) {}
          _pendingExecutions++;
          setTimeout(async () => {
            await _execAcquire();
            try {
              _setNotify(message, _notifyFor(action));
              if (action === "approve") {
                executeApprove(message);
              } else {
                if (_selText) {
                  await executeRejectWithText(message, _selText);
                } else {
                  const rr = message.querySelector(
                    'input[type="radio"][value="reject"]'
                  );
                  if (rr && _setRadio(rr)) _activateDependency(rr);
                }
              }
            } catch (e) {
              console.error("[AUTO] Dedup radio error:", e);
            } finally {
              _execRelease();
              _pendingExecutions = Math.max(0, _pendingExecutions - 1);
              _dockRender();
              _maybeScheduleSave();
            }
          }, 0);
          return;
        }
        if (dedup.processed && dedup.status !== "failed") {
          console.log("[CASCADE] Stored '" + (dedup.action || "?") + "' (" +
            dedup.status + ") superseded by fresh '" + action +
            "' — executing fresh verdict for " + (cascadeUsername || "?"));
        }

        const _isBanAction = /^ban/.test(action);
        try {
          _intended.set(message, {
            radioValue: _intendedValueFor(action),
            action: action,
            isBan: _isBanAction,
            reasonKey: reasonKey || null,
            user: _userIdFromMessage(message),
            ui: ui,
            status: null,
            category: _statCategory(action, reasonKey, summary, extra),
            notify: _notifyFor(action),
          });
        } catch (_) {}

        const _startExecution = () => {

          if (_isBanAction && !_tabActive()) {
            _holdRowForManual(message, ui, "Another tab works on the queue now — no ban from this tab.", "ban-wait");
            return;
          }
          console.log("[CASCADE] AUTO_EXECUTE for " + (cascadeUsername || "?") +
            " -> " + action + "/" + (reasonKey || "-"));
          try { _setNotify(message, _notifyFor(action)); } catch (_) {}
          ui.exec("run", _isBanAction ? "ban running …" : "setting …");
          try {

            markProcessed(message, cascadeUsername, "pending",
              action + " (angefordert)");
            console.log("[DEDUP] reserved (pending): " +
              (cascadeUsername || "?") + " -> " + action);
          } catch (e) {
            console.warn("[DEDUP] reservation failed: " + e.message);
          }

          setTimeout(async () => {
            let status = "unknown";
            let handled = false;
            let banError = null;
            let banPermanent = false;
            _pendingExecutions++;
            if (_isBanAction) _pendingBanExec++;
            if (_isBanAction) await _banAcquire();
            else await _execAcquire();
            let notHere = false;
            try {
              if (_isBanAction && !_tabActive()) {

                notHere = true;
              } else if (action === "ban" || action === "ban-alt" ||
                  action === "ban-alt-generic" || action === "ban-female-alt" ||
                  action === "ban-deleted-not-waited") {
                let r;
                if (action === "ban") {
                  r = await executeBan(message);
                } else if (action === "ban-alt" && extra) {
                  r = await executeAltBan(message, extra.mainUrl, extra.mainName,
                    extra.mainId, extra.approvedAlts,
                    extra.applicantUrl, extra.applicantName);
                } else if (action === "ban-alt-generic" && extra) {
                  r = await executeAltBanGeneric(message, extra);
                } else if (action === "ban-female-alt" && extra) {
                  r = await executeAltBanGeneric(message, extra);
                } else if (action === "ban-deleted-not-waited" && extra) {
                  r = await executeDeletedNotWaitedBan(message, extra);
                } else {
                  r = { status: "failed", error: action + " without data" };
                }
                status = (r && r.status) || "unknown";
                banError = (r && r.error) || null;
                banPermanent = !!(r && r.permanent);
                handled = true;
              } else if (action === "reject" && reasonKey) {
                status = (await executeReject(message, reasonKey))
                  ? "done" : "failed";
                handled = true;
              } else if (action === "approve") {
                status = (await executeApprove(message)) ? "done" : "failed";
                handled = true;
              }
            } catch (e) {
              console.error("[AUTO] Execution error:", e);

              status = _isBanAction ? "unknown" : "failed";
              banError = banError || ("script error: " + (e && e.message));
              handled = true;
            }
            try {
              if (notHere) {
                _holdRowForManual(message, ui, "Another tab works on the queue now — no ban from this tab.", "ban-wait");
              } else if (handled) {
                _finalizeExecution(ui, message, cascadeUsername, action,
                  reasonKey, status, banError, banPermanent);
              } else {
                console.warn("[AUTO] unhandled action: " + action +
                  " — nothing executed");
              }
            } finally {
              _pendingExecutions--;
              if (_isBanAction) _pendingBanExec = Math.max(0, _pendingBanExec - 1);
              if (_isBanAction) _banRelease();
              else _execRelease();
              _bulkFlushSoon(200);
              _dockRender();
            }
          }, 0);
        };

        if (BAN_CONFIRM_REQUIRED && _isBanAction) {
          ui.exec("wait", "waiting for ban confirmation");
          console.log("[BAN-CONFIRM] waiting for confirmation: " +
            (cascadeUsername || "?") + " -> " + label);
          _queueBanForConfirmation({
            who: cascadeUsername || "?",
            label: label,
            message: message,
            container: ui.root,
            run: _startExecution,
          });
          return;
        }
        _startExecution();
      }
    }

    (async () => {
      await _cascadeAcquire();
      try {
      if (AUTO_EXECUTE) {
        try {
          const _pre = await wasRecentlyProcessed(message, cascadeUsername);
          if (_pre && _pre.processed && _pre.action) {
            const _pa = _parseStoredAction(_pre.action);
            const _skip =
              (_pre.status === "done" && _pa) ||
              (_pre.status === "pending" && _pa && _pa.action === "reject");
            if (_skip) {
              console.log("[CASCADE] EARLY: " + (cascadeUsername || "?") +
                " already " +
                (_pre.status === "pending" ? "reserved" : "done") +
                " (" + _pre.action + ") -> checks skipped");
              cascadeLogStep("Already handled — checks skipped.", "#8ecf9a");
              return cascadeFinish(_pa.action, _pa.reasonKey,
                "already handled");
            }
          }
        } catch (_) { }
      }
      cascadeLogStep("Step 0: Checking alt account states...");

      const _selfId = excludeUrl ? extractUserId(excludeUrl) : null;
      const filteredAlts = (altAccounts || []).filter((acc) => {
        if (excludeUrl && normalizeProfileUrl(acc.url) === excludeUrl) return false;
        if (_selfId != null && extractUserId(acc.url) === _selfId) return false;
        return true;
      });

      let approvedAltsList = [];
      let bannedAlt = null;
      let pendingAlt = null;
      const pendingAltsList = [];
      let femaleAltAcc = null;
      let disabledWaitedAlts = [];
      let disabledNotWaitedAlts = [];
      let bannedUnapprovedAlts = [];
      let altLookupsIncomplete = 0;
      let altStatesUnknown = 0;

      if (!_roleCanAccessAltList() &&
          (filteredAlts.length > 0 || message.dataset.altLogUnparsed === "1")) {
        const _logNames = filteredAlts.map((a) => a.name).join(", ") ||
          "(name not extractable from log)";
        filteredAlts.forEach((a) => {
          addFlag("Alt in application log: " + a.name, "ban");
        });
        cascadeLogStep("  Alt in application log: " + _logNames +
          " → MANUAL (rank '" + _roleCfg().label +
          "' cannot see alt status)", "#ffd080");
        return cascadeFinish("manual", null,
          "Alt account(s) in application log (" + _logNames +
          ") — alt status not visible for " + _roleCfg().label +
          ", manual review required");
      }

      if (filteredAlts.length > 0) {
        await Promise.all(
          filteredAlts.map(async (acc) => {
            const isBanned = !!(acc.nameClass && /username--style[56]/i.test(acc.nameClass));
            if (isBanned) {
              addFlag(`Banned alt: ${acc.name}`, "ban");
              bannedAlt = bannedAlt || acc.name;
            }
            const gDiag = {};
            if (ALT_GENDER_CHECK && _roleCanSeeAltGender()) {
              try {
                const gender = await fetchGenderFromProfile(acc.url, gDiag);
                if (gender && gender.toLowerCase() === "female") {
                  addFlag(`Female alt: ${acc.name}`, "female-alt");
                  if (!femaleAltAcc) {
                    femaleAltAcc = Object.assign({}, acc, { isBanned: isBanned });
                  }
                }
              } catch (_) {}
              if (gDiag.temporary) {
                altLookupsIncomplete++;
                addFlag(`Gender unknown: ${acc.name}`, "check");
              }
            }
            const sDiag = {};
            let state = null;
            try { state = await fetchUserState(acc.url, sDiag); } catch (_) {}
            if (sDiag.temporary) {
              altLookupsIncomplete++;
              altStatesUnknown++;
              addFlag(`State unknown: ${acc.name}`, "check");
            }

            if (!state) {
              if (!sDiag.temporary) {
                altLookupsIncomplete++;
                altStatesUnknown++;
                addFlag(`State unknown: ${acc.name}`, "check");
              }
              return;
            }

            if (state === "Valid") {
              addFlag(`Approved alt: ${acc.name}`, "ban");
              approvedAltsList.push(acc);
            } else if (/disabled/i.test(state)) {
              addFlag(`Disabled alt: ${acc.name}`, "check");
              let deletionTs = null;
              try { deletionTs = await fetchDeletionDate(acc.url); } catch (_) {}
              if (deletionTs) {
                const diffDays = Math.floor(
                  (Date.now() - deletionTs) / (1000 * 60 * 60 * 24),
                );
                if (diffDays >= 90) {
                  addFlag(`${acc.name}: Did wait 3 months`, "wait-ok");
                  disabledWaitedAlts.push(acc);
                } else {
                  addFlag(`${acc.name}: Did not wait 3 months`, "wait-fail");
                  disabledNotWaitedAlts.push(acc);
                }
              } else {

                altLookupsIncomplete++;
                addFlag(`${acc.name}: no deletion date found`, "check");
              }
            } else if (
              /pending/i.test(state) ||
              /awaiting/i.test(state) ||
              /moderat/i.test(state)
            ) {
              addFlag(`Pending alt: ${acc.name}`, "pending-alt");
              if (isBanned) bannedUnapprovedAlts.push(acc);
              else {
                pendingAlt = pendingAlt || acc.name;
                pendingAltsList.push(acc);
              }
            } else {
              if (isBanned) bannedUnapprovedAlts.push(acc);
            }
          }),
        );
      }
      if (filteredAlts.length === 0) {
        cascadeLogStep("  No alt accounts to check.");
      } else {
        cascadeLogStep("  " + filteredAlts.length + " alt(s) checked.");
      }
      if (message.dataset.altListFailed === "1") {
        altLookupsIncomplete++;
        addFlag("Alt list lookup failed", "check");
        cascadeLogStep("  Alt list lookup FAILED (" +
          (message.dataset.altListFailReason || "unknown") + ") — incomplete.", "#ffd080");
      }
      if (altLookupsIncomplete > 0) {
        cascadeLogStep("  " + altLookupsIncomplete +
          " incomplete alt lookup(s) — fail-safe guard armed.", "#ffd080");
      }

      cascadeLogStep("Step 1: Rule checks...");
      if (applicantFlags && applicantFlags.isApplicantBanned) {
        addFlag("Banned", "ban");
      }

      if (applicantFlags && applicantFlags.isFemale) {
        cascadeLogStep("  Female applicant → BAN", "#ff5a6a");
        return cascadeFinish("ban", null, "Female (male-only forum)",
          { category: "female" });
      }
      if (femaleAltAcc) {
        const _modReason = femaleAltAcc.isBanned
          ? "Banned female alt account"
          : "Female alt account";
        const _userReason = "Banned alt account";
        const applicantLink = message.querySelector(".message-userDetails a.username, a.username");
        const applicantName = applicantLink?.textContent || null;
        const applicantUrl = applicantLink ? normalizeProfileUrl(applicantLink.getAttribute("href")) : null;
        cascadeLogStep("  Female alt: " + femaleAltAcc.name +
          (femaleAltAcc.isBanned ? " (banned)" : " (UNBANNED → banned too)") +
          " → FEMALE-ALT-BAN 100%", "#ff5a6a");
        return cascadeFinish("ban-female-alt", null,
          _modReason + ": " + femaleAltAcc.name, {
            category: "female-alt",
            applicantUrl: applicantUrl,
            applicantName: applicantName,
            allAlts: [femaleAltAcc],
            notes: _userReason,
            conversationTitle: "Ban",
            additionalComment: _userReason,
          });
      }

      if (altStatesUnknown > 0 &&
          (approvedAltsList.length || bannedUnapprovedAlts.length || disabledNotWaitedAlts.length)) {
        cascadeLogStep("  " + altStatesUnknown + " alt state(s) unknown → no alt ban on an incomplete " +
          "picture → retried (fail-safe)", "#ffd080");
        return cascadeFinish("manual", null,
          "Alt status could not be verified (" + altStatesUnknown +
          " unknown) — alt ban held back, retried by itself");
      }
      if (approvedAltsList.length > 0) {
        const applicantLink = message.querySelector(".message-userDetails a.username, a.username");
        const applicantName = applicantLink?.textContent || null;
        const applicantUrl = applicantLink ? normalizeProfileUrl(applicantLink.getAttribute("href")) : null;

        const _plan = _altBanPlan(approvedAltsList);
        if (_plan.duplicates || _plan.banned) {
          cascadeLogStep("  " + (_plan.duplicates ? _plan.duplicates + " duplicate row(s) " : "") +
            (_plan.duplicates && _plan.banned ? "+ " : "") +
            (_plan.banned ? _plan.banned + " already banned account(s) " : "") +
            "not counted as active accounts", "#c0b0ff");
        }
        approvedAltsList = _plan.list;
        const main = findOldestApproved(applicantUrl, applicantName, approvedAltsList);
        if (!main) {
          cascadeLogStep("  approved alts but no main findable → MANUAL", "#ffd080");
          return cascadeFinish("manual", null, "Has approved alt but no main identifiable");
        }
        const fallLabel = approvedAltsList.length === 1
          ? "case 1 (1 alt → main 90%, applicant 100%)"
          : "case 2 (" + (approvedAltsList.length + 1) + " accounts → all 100%)";
        cascadeLogStep("  Approved alt(s) → ALT-BAN, Main: " + main.name + " (ID " + main.id + ") — " + fallLabel, "#ff5a6a");
        return cascadeFinish("ban-alt", null, "Has approved alt account — Main: " + main.name, {
          mainUrl: main.url,
          mainName: main.name,
          mainId: main.id,
          approvedAlts: approvedAltsList,
          applicantUrl: applicantUrl,
          applicantName: applicantName,
        });
      }
      if (bannedUnapprovedAlts.length > 0) {
        const applicantLink = message.querySelector(".message-userDetails a.username, a.username");
        const applicantName = applicantLink?.textContent || null;
        const applicantUrl = applicantLink ? normalizeProfileUrl(applicantLink.getAttribute("href")) : null;
        cascadeLogStep("  banned unapproved alt → ALT-BAN-UNAPPROVED (applicant + all unapproved+unbanned)", "#ff5a6a");
        return cascadeFinish("ban-alt-generic", null, "Has banned unapproved alt account", {
          applicantUrl: applicantUrl,
          applicantName: applicantName,
          allAlts: filteredAlts,
          notes: "Banned alt account",
          conversationTitle: "Ban",
          additionalComment: "Banned alt account",
        });
      }
      if (disabledNotWaitedAlts.length > 0) {
        const applicantLink = message.querySelector(".message-userDetails a.username, a.username");
        const applicantName = applicantLink?.textContent || null;
        const applicantUrl = applicantLink ? normalizeProfileUrl(applicantLink.getAttribute("href")) : null;
        const waitMsg = "You must wait three months after deleting your account before signing up again. Please reapply once the waiting period has passed.";
        cascadeLogStep("  Disabled alt + did not wait 3 months → applicant 100% Ban", "#ff5a6a");
        return cascadeFinish("ban-deleted-not-waited", null, "Disabled alt did not wait 3 months", {
          applicantUrl: applicantUrl,
          applicantName: applicantName,
          rejectReason: waitMsg,
          notes: "Did not wait 3 months before making a new account",
          conversationTitle: "Ban",
          additionalComment: waitMsg,
        });
      }
      if (disabledWaitedAlts.length > 0) {
        cascadeLogStep("  disabled alt + DID wait 3 months → continue normally", "#3ccf6e");
      }
      if (altLookupsIncomplete > 0) {
        cascadeLogStep("  " + altLookupsIncomplete +
          " alt lookup(s) incomplete → MANUAL (fail-safe)", "#ffd080");
        return cascadeFinish("manual", null,
          (message.dataset.altListFailed === "1"
            ? "Alt list could not be loaded"
            : "Alt status" + (ALT_GENDER_CHECK ? "/gender" : "") +
              "/deletion date could not be verified") +
          " — manual review");
      }
      if (bannedAlt) {
        cascadeLogStep("  banned alt: " + bannedAlt + " → MANUAL (not auto-executed)", "#ffd080");
        return cascadeFinish("manual", null, "Has banned alt account — manual review");
      }

      if (pendingAltsList.length) {
        const myLink = message.querySelector(".message-userDetails a.username, a.username");
        const myId = myLink ? extractUserId(normalizeProfileUrl(myLink.getAttribute("href"))) : null;
        const altIds = pendingAltsList.map((a) => extractUserId(a.url));
        if (myId == null || altIds.some((id) => id == null)) {
          cascadeLogStep("  pending alt: " + pendingAlt + " → MANUAL (user ID not readable)", "#ffd080");
          return cascadeFinish("manual", null,
            "Has pending alt account (" + pendingAlt + ") — accept only one, manual review");
        }
        const older = pendingAltsList
          .filter((a) => extractUserId(a.url) < myId)
          .sort((a, b) => extractUserId(a.url) - extractUserId(b.url));
        if (older.length) {
          cascadeLogStep("  pending alt " + older[0].name + " is older → this account " +
            "is the duplicate → REJECT (duplicate)", "#ff9a8c");
          return cascadeFinish("reject", "duplicate",
            "Duplicate account — older pending account @" + older[0].name + " is kept");
        }
        cascadeLogStep("  pending alt(s) " + pendingAltsList.map((a) => a.name).join(", ") +
          " are newer → this (oldest) account is checked normally", "#3ccf6e");
      }
      if (applicantFlags && applicantFlags.isVpnUnknown) {
        cascadeLogStep("  VPN check failed → MANUAL (do not guess)", "#ffd080");
        return cascadeFinish("manual", null,
          "VPN check failed — manual review" +
          (_vpnApiProblem ? " (" + _vpnApiProblem + ")" : ""));
      }
      if (applicantFlags && applicantFlags.isVpnProxy) {
        cascadeLogStep("  VPN detected → REJECT (vpn)", "#ff9a8c");
        return cascadeFinish("reject", "vpn", "VPN/proxy detected");
      }
      if (applicantFlags && applicantFlags.isTooShort) {
        cascadeLogStep("  Too short (<5 words) → REJECT (tooShort)", "#ff9a8c");
        return cascadeFinish("reject", "tooShort", "Application too short");
      }
      cascadeLogStep("  No hard rule matched.");

      if (!reasonText) {
        cascadeLogStep("Step 2: No application text found → MANUAL (fail-safe).", "#ffd080");
        return cascadeFinish("manual", null,
          "No application text found — manual review");
      }

      cascadeLogStep("Step 2: AI score (" + _aiName() + ")...", "#c0b0ff");
      const MAX_AI_RETRIES = 1;
      let aiResult = null;
      let aiError = null;
      for (let attempt = 1; attempt <= MAX_AI_RETRIES; attempt++) {
        try {
          cascadeLogStep("  Attempt " + attempt + "/" + MAX_AI_RETRIES + "...");
          aiResult = await checkAiWithZeroGpt(reasonText);
          break;
        } catch (err) {
          aiError = err;
          cascadeLogStep("  Attempt " + attempt + " failed: " + err.message, "#ff6b6b");
          if (attempt < MAX_AI_RETRIES) {
            const wait = attempt * 5000;
            cascadeLogStep("  Waiting " + (wait / 1000) + "s before retry...");
            await new Promise((r) => setTimeout(r, wait));
          }
        }
      }

      if (!aiResult) {
        cascadeLogStep("  " + _aiName() + " unavailable after " + MAX_AI_RETRIES + " attempts.", "#ff6b6b");

        return cascadeFinish(
          "manual",
          null,
          (aiError && aiError.paused ? "AI check paused (" : "AI check unavailable (") +
            (aiError ? aiError.message : "unknown") + ") — manual review",
        );
      }

      const pct = Number(aiResult.percentage);

      if (aiResult.percentage === null || aiResult.percentage === undefined ||
          !Number.isFinite(pct)) {
        cascadeLogStep("  AI Score missing in response → MANUAL", "#ff6b6b");
        return cascadeFinish("manual", null,
          "AI score missing — manual review");
      }
      cascadeLogStep("  AI Score: " + pct + "%" +
        (aiResult.cached ? " (cached)" : aiResult.via ? " (" + aiResult.via + ")" : SAPLING_KEY ? " (Sapling)" : OWN_ZEROGPT_KEY ? " (own key)" : ""),
        pct >= 50 ? "#ff9a8c" : "#3ccf6e");
      if (pct >= 50) {
        return cascadeFinish("reject", "ai", "AI score " + pct + "% (≥50%)");
      }

      cascadeLogStep("Step 3: On-topic check...", "#c0b0ff");
      const payload = {
        applicationText: reasonText,
        zerogptScore: pct,
        gender: "male",
        vpnFlag: false,
        ipShared: false,
        username: cascadeUsername,
        alts: [],
        recentlyDeleted: false,
      };
      try {
        const decision = await checkDecisionWithAI(payload);
        const conf = Math.round((decision.confidence || 0) * 100);
        cascadeLogStep(
          "  On-topic: " + decision.action +
            (decision.reason_key ? "/" + decision.reason_key : "") +
            " (" + conf + "%)",
          decision.action === "reject" ? "#ff9a8c" : "#3ccf6e",
        );
        if (decision.action === "reject") {
          if (decision.reason_key === "deleted") {
            return cascadeFinish(
              "manual",
              null,
              "Account previously deleted — manual review",
            );
          }
          return cascadeFinish(
            "reject",
            decision.reason_key || "notLm",
            decision.reasoning || "Off-topic/troll",
          );
        }
        return cascadeFinish("approve", null, decision.reasoning || "On-topic, genuine");
      } catch (err) {
        if (err.message !== "skipped") {
          cascadeLogStep("  Server: " + err.message + " → local check", "#888");
        }

        const lc = _localOnTopic(reasonText);
        if (lc.troll) {
          cascadeLogStep("  Local: spam/troll (" + lc.troll + ") → REJECT (troll)", "#ff9a8c");
          return cascadeFinish("reject", "troll",
            "AI " + pct + "%, spam/troll pattern (" + lc.troll + ")");
        }

        const uniq = lc.hits.filter((h, i, all) => all.indexOf(h) === i &&
          !all.some((o) => o !== h && o.length > h.length && o.indexOf(h) !== -1));
        if (TOPIC_TO_MANUAL && !uniq.length) {
          cascadeLogStep("  Local: no looksmax word in the text → MANUAL", "#ffd080");
          return cascadeFinish("manual", null,
            "AI " + pct + "%, no looksmax topic — not one topic word found, read it yourself");
        }
        const shown = uniq.slice(0, 4).join(", ");
        cascadeLogStep("  Local: no spam → APPROVE" + (shown ? " (" + shown + ")" : ""), "#3ccf6e");
        return cascadeFinish("approve", null, "AI " + pct + "%, no spam" + (shown ? " (" + shown + ")" : ""));
      }
      } finally {
        _cascadeRelease();
      }
    })();
  }

  const _PREFETCH_IP_RE =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  function _prefetchIpFromMessage(message) {
    const listPlain = message.querySelector("ul.listPlain");
    if (!listPlain) return null;
    const firstLink = listPlain.querySelector("li a[href]");
    if (!firstLink) return null;
    const ipText = firstLink.textContent.trim();
    return _PREFETCH_IP_RE.test(ipText) ? ipText : null;
  }
  function _isFemaleRow(message) {
    const g = message.querySelector('dl[data-field="male_female"] dd');
    return !!(g && g.textContent.trim().toLowerCase() === "female");
  }
  function _prefetchIsAlt(message) {
    const dataCells = message.querySelectorAll(".dataList-cell");
    for (const cell of dataCells) {
      if (/(Moderating|Multiple account|Rejected user)/i.test(cell.textContent)) {
        return true;
      }
    }
    return false;
  }
  const _vpnPrefetched = new Map();

  function _vpnBatch(ips) {
    const waits = [];
    const todo = [];
    [...new Set(ips)].forEach((ip) => {
      if (ipCache[ip] !== undefined) return;
      const f = _vpnBatchInflight.get(ip) || _vpnInflight.get(ip);
      if (f) { if (waits.indexOf(f) === -1) waits.push(f); } else todo.push(ip);
    });
    if (todo.length < 2) return Promise.all(waits).then(() => {});
    const p = new Promise((res0) => {
      let settled = false;
      const resolve = () => { if (!settled) { settled = true; res0(); } };

      setTimeout(resolve, VPN_WATCHDOG_MS);
      _pcCount(todo.length);
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: `https://proxycheck.io/v2/?key=${API_KEY}&vpn=1&risk=1`,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          data: "ips=" + encodeURIComponent(todo.join(",")),
          timeout: 10000,
          onload(res) {
            try {
              const data = JSON.parse(res.responseText);
              const st = String((data && data.status) || "").toLowerCase();
              if (st !== "denied" && st !== "error") {
                let n = 0;
                todo.forEach((ip) => {
                  const e = data[ip];
                  if (e && typeof e.proxy !== "undefined") {
                    const v = !!(e.proxy === "yes" || e.vpn === "yes");
                    ipCache[ip] = v;
                    _vpnCachePut(ip, v);
                    n++;
                  }
                });
                console.log("[VPN] batch lookup: " + n + "/" + todo.length +
                  " IPs in 1 request");
              }
            } catch (_) {}
            resolve();
          },
          onerror() { resolve(); },
          ontimeout() { resolve(); },
        });
      } catch (_) { resolve(); }
    });
    todo.forEach((ip) => _vpnBatchInflight.set(ip, p));
    p.then(() => todo.forEach((ip) => { if (_vpnBatchInflight.get(ip) === p) _vpnBatchInflight.delete(ip); }));
    return Promise.all([p].concat(waits)).then(() => {});
  }

  async function _prefetchRemoteChecks(messages) {
    const ipJobs = new Map();
    const altJobs = new Map();
    for (const message of messages) {
      if (message.dataset.decisionChecked) continue;
      const ip = _isFemaleRow(message) ? null : _prefetchIpFromMessage(message);
      if (ip && !ipJobs.has(ip)) {
        ipJobs.set(ip, () => {
          let p = _vpnPrefetched.get(ip);
          if (!p) {
            p = checkVPN(ip);
            _vpnPrefetched.set(ip, p);
          }
          return p;
        });
      }
      if (_roleCanAccessAltList() && _prefetchIsAlt(message)) {
        const url = getAltProfileUrlFromLog(message);
        if (url && !altJobs.has(url)) {
          altJobs.set(url, () => fetchAltAccounts(url));
        }
      }
    }

    const ipList = [...ipJobs.keys()];
    const vpnBatchP = _vpnBatch(ipList);
    ipList.forEach((ip) => {
      if (!_vpnPrefetched.has(ip)) {
        _vpnPrefetched.set(ip, vpnBatchP.then(() => checkVPN(ip)));
      }
    });
    const jobs = [...altJobs.values()];
    const dedupP = _dedupBatchPrefetch(messages).catch(() => {});
    if (!jobs.length) { await Promise.all([dedupP, vpnBatchP]); return; }
    console.log("[PREFETCH] " + ipJobs.size + " IP(s) collected, " +
      altJobs.size + " alt profile(s) in parallel (max " + CHECK_BATCH_SIZE + ")");
    let idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const job = jobs[idx++];
        try { await job(); } catch (_) {}
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CHECK_BATCH_SIZE, jobs.length) }, worker)
    );
    await Promise.all([dedupP, vpnBatchP]);
    console.log("[PREFETCH] done: " + _vpnPrefetched.size +
      " IP results prefetched");
  }

  const QUICK_REJECTS = [
    { label: "AI", key: "ai" },
    { label: "Not LM", key: "notLm" },
    { label: "Troll", key: "troll" },
    { label: "Deleted", key: "deleted" },
    { label: "VPN", key: "vpn" },
    { label: "Too short", key: "tooShort" },
    { label: "Duplicate", key: "duplicate" },
  ];
  function _syncQuickChips(message, text) {
    message.querySelectorAll(".lmq-chip[data-key]").forEach((c) => {
      c.classList.toggle("is-on", !!text && REJECTION_TEMPLATES[c.dataset.key] === text);
    });
  }
  function _injectQuickRejects(message, rejectRadio) {
    const parentUl = rejectRadio.closest("ul.inputChoices");
    if (!parentUl || parentUl.querySelector(".lmq-qr")) return;
    const li = _el("li", "lmq-qr custom-rejections-header");
    li.appendChild(_el("div", "lmq-qr-t", "Quick reject"));
    const list = _el("div", "lmq-qr-list");
    QUICK_REJECTS.forEach((r) => {
      const b = _el("button",
        "lmq-chip custom-reject-item" + (r.key === "ai" ? " custom-ai-reject" : ""), r.label);
      b.type = "button";
      b.dataset.key = r.key;
      b.title = REJECTION_TEMPLATES[r.key];
      b.addEventListener("click", (e) => {
        e.preventDefault();
        const sX = window.scrollX;
        const sY = window.scrollY;

        _userTouchedForm = true;
        if (!_setRadio(rejectRadio)) {
          console.warn("[AUTO] could not set reject radio (custom UI)");
        }
        _activateDependency(rejectRadio);
        const uid = _userIdFromMessage(message);
        const text = REJECTION_TEMPLATES[r.key];
        _syncQuickChips(message, text);
        let attempts = 0;
        const step = () => {
          attempts++;
          const targetInput = _findReasonInput(message, uid);
          if (targetInput) {
            _activateDependency(rejectRadio);
            _registerReasonGuard(uid, targetInput, text);
            if (!targetInput.disabled && targetInput.value === text) {
              window.scrollTo(sX, sY);
              return;
            }
          }
          if (attempts >= 20) { window.scrollTo(sX, sY); return; }
          setTimeout(step, 100);
        };
        step();
      });
      list.appendChild(b);
    });
    li.appendChild(list);
    parentUl.appendChild(li);

    parentUl.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t.type === "radio" && /^queue\[/.test(t.name || "") && t.checked && t.value !== "reject") {
        _syncQuickChips(message, null);
      }
    });
  }

  const HL_STYLES = {
    female: ["rgba(255,111,177,0.09)", "#ff6fb1"],
    vpn: ["rgba(77,163,255,0.08)", "#4da3ff"],
    short: ["rgba(255,122,80,0.08)", "#ff7a50"],
    alt: ["rgba(224,205,158,0.08)", "#e0cd9e"],
  };

  const _yieldTask = (() => {
    try {
      const ch = new MessageChannel();
      const q = [];
      ch.port1.onmessage = () => { const r = q.shift(); if (r) r(); };
      return () => new Promise((r) => { q.push(r); ch.port2.postMessage(0); });
    } catch (_) {
      return () => new Promise((r) => setTimeout(r, 0));
    }
  })();

  async function highlightApplications() {

    const messages = [];
    document.querySelectorAll('.message:not([data-auto-reject="1"])').forEach((m) => {
      if (_isForeignRow(m)) { if (!m.querySelector(".lmq-hands")) _markForeign(m); return; }
      messages.push(m);
    });
    _prefetchRemoteChecks(messages).catch(() => {});

    const _processOne = async (message) => {
      message.dataset.autoReject = "1";
      await _yieldTask();
      try {

      const attribution = message.querySelector(
        ".message-attribution-opposite",
      );
      if (attribution) {
        const type = attribution.textContent.trim();
        if (
          /Verification badge request/i.test(type) ||
          /^Post$/i.test(type) ||
          /^Thread$/i.test(type) ||
          /Username Change/i.test(type)
        ) {
          messagesMap.set(message, ["NORMAL"]);
          return;
        }
      }

      const labels = [];

      const genderField = message.querySelector(
        'dl[data-field="male_female"] dd',
      );
      const reasonField = message.querySelector('dl[data-field="why_join"] dd');
      const dataCells = message.querySelectorAll(".dataList-cell");

      let isFemale = false;
      let isTooShort = false;
      let isAlt = false;
      let isVpnProxy = false;
      let isVpnUnknown = false;
      let isApplicantBanned = false;

      const applicantLink = message.querySelector(
        ".message-userDetails a.username, a.username",
      );
      const applicantProfileUrl = normalizeProfileUrl(
        applicantLink ? applicantLink.getAttribute("href") : null,
      );

      if (applicantLink) {
        const span = applicantLink.querySelector(
          "span[class*=username--style]",
        );
        if (span) {
          const cls = [...span.classList].find((c) =>
            /^username--style[56]/i.test(c),
          );
          if (cls) {
            isApplicantBanned = true;
            labels.push("BANNED");
          }
        }
      }

      if (
        genderField &&
        genderField.textContent.trim().toLowerCase() === "female"
      ) {
        isFemale = true;
        labels.push("FEMALE");
      }

      if (reasonField) {
        const wc = reasonField.textContent
          .trim()
          .split(/\s+/)
          .filter((w) => /\p{L}/u.test(w)).length;
        if (wc < 5) {
          isTooShort = true;
          labels.push("TOO SHORT");
        }
      }

      dataCells.forEach((cell) => {
        if (
          /(Moderating|Multiple account|Rejected user)/i.test(cell.textContent)
        ) {
          isAlt = true;
          labels.push("OTHER ALT");
        }
      });

      let ip = null;
      let vpnP = null;
      const listPlain = message.querySelector("ul.listPlain");
      if (listPlain) {
        const firstLink = listPlain.querySelector("li a[href]");
        if (firstLink) {
          const ipText = firstLink.textContent.trim();
          const ipMatch = ipText.match(
            /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/,
          );
          if (ipMatch) {
            ip = ipText;
            firstLink.href = `https://ipinfo.io/${ip}`;
            firstLink.target = "_blank";

            if (!isFemale) vpnP = _vpnPrefetched.get(ip) || checkVPN(ip);
          }
        }
      }

      _dockTrack(message);
      _rowUi(message);

      const rejectRadio = message.querySelector(
        'input[type="radio"][value="reject"]',
      );
      if (rejectRadio) _injectQuickRejects(message, rejectRadio);

      if (isFemale) {
        const extraCell = message.querySelector(".message-cell--extra");
        if (extraCell && !extraCell.querySelector(".foid-ban-btn")) {
          const userLink = message.querySelector(
            ".message-userDetails a.username",
          );
          if (userLink) {
            const profilePath = userLink.getAttribute("href");
            const btn = _el("button", "lmq-btn lmq-btn--danger lmq-btn--sm foid-ban-btn", "Ban");
            btn.type = "button";
            btn.addEventListener("click", async (e) => {
              e.preventDefault();
              if (btn.disabled) return;
              btn.disabled = true;
              btn.textContent = "Banning …";
              try { _setNotify(message, false); } catch (_) {}
              let r;
              try {
                r = await _xfWarnRetry(profilePath, Object.assign({ warningId: "14", notes: "Foid", conversation: false }, _jobCtx(message)));
                if (r.status === "done") {
                  try { await _xfSetCustomTitle(profilePath, "F-Banned"); } catch (_) {}
                }
              } catch (err) {
                r = { status: "unknown", error: err && err.message };
              }
              if (r.status === "done") {
                btn.textContent = "Banned ✓";
                btn.dataset.state = "ok";
              } else {
                btn.textContent = "Ban " + (r.status === "failed" ? "failed" : "unclear") +
                  (r.error ? ": " + r.error : "");
                btn.dataset.state = "warn";
                if (r.status === "failed") btn.disabled = false;
              }
            });
            extraCell.appendChild(btn);
          }
        }
      }

      if (listPlain) {
        const logItems = listPlain.querySelectorAll("li");
        logItems.forEach((li) => {
          const usernameLink = li.querySelector('a[href*="/members/"]');
          if (usernameLink) usernameLink.classList.add("lmq-loglink");
          const rejectedMatch = li.textContent.match(
            /Shared IP with rejected users\s*\(([^)]+)\)/i,
          );
          if (rejectedMatch) {

            const users = rejectedMatch[1].split(",").map((u) => u.trim());
            li.textContent = "Shared IP with rejected users: ";
            users.forEach((u, i) => {
              if (i) li.appendChild(document.createTextNode(", "));
              const a = _el("a", "lmq-loglink", u);
              a.href = "https://looksmax.org/moderatorpanel/recent-registered/?username=" +
                encodeURIComponent(u);
              a.target = "_blank";
              a.rel = "noopener";
              li.appendChild(a);
            });
          }
        });
      }

      const paint = (withVpn) => {
        let hl = null;
        if (isFemale) hl = "female";
        else if (withVpn) hl = "vpn";
        else if (isTooShort) hl = "short";
        else if (isAlt) hl = "alt";

        if (hl) {
          message.classList.add("xf-hl");
          message.style.setProperty("--xf-hl-bg", HL_STYLES[hl][0]);
          message.style.setProperty("--xf-hl-accent", HL_STYLES[hl][1]);
          message.setAttribute("data-xf-hl", "1");
          message.dataset.lmqHl = hl;
        }
      };
      paint(false);
      messagesMap.set(message, labels.length ? labels.slice() : ["NORMAL"]);
      _filterCountsSoon();

      if (vpnP) {
        const vpnRes = await vpnP;
        isVpnProxy = vpnRes === true;
        isVpnUnknown = vpnRes === null;
        if (isVpnProxy) labels.push("VPN");
        if (isVpnUnknown) labels.push("VPN?");
      }
      await _yieldTask();

      if ((OWN_ZEROGPT_KEY || SAPLING_KEY) && !isFemale && !isTooShort &&
          !isVpnProxy && !isVpnUnknown && !isApplicantBanned) {
        try {
          const rf = message.querySelector('dl[data-field="why_join"] dd');
          const rt = rf ? rf.textContent.trim() : "";
          if (rt) checkAiWithZeroGpt(rt).catch(() => {});
        } catch (_) {}
      }

      if (labels.length === 0) labels.push("NORMAL");
      messagesMap.set(message, labels);
      if (isVpnProxy) paint(true);

      if (isAlt && !message.dataset.altChecked) {
        message.dataset.altChecked = "1";
        const altProfileUrl = getAltProfileUrlFromLog(message);
        if (altProfileUrl) {
          let accounts;
          if (_roleCanAccessAltList()) {
            accounts = await fetchAltAccounts(altProfileUrl);
            if (_altListFailed.has(altProfileUrl)) {
              message.dataset.altListFailed = "1";
              message.dataset.altListFailReason =
                _altListFailReason.get(altProfileUrl) || "unknown";
            } else {
              delete message.dataset.altListFailed;
            }
          } else {
            accounts = _parseAltsFromApplicationLog(message, applicantProfileUrl);
            if (accounts.length === 0) {
              message.dataset.altLogUnparsed = "1";
            } else {
              delete message.dataset.altLogUnparsed;
            }
          }
          renderAltAccounts(message, accounts, applicantProfileUrl);
          message.dataset.decisionChecked = "1";
          const reasonField = message.querySelector(
            'dl[data-field="why_join"] dd',
          );
          const reasonText = reasonField
            ? reasonField.textContent.trim()
            : null;

          addDecisionHelper(
            message,
            { isFemale, isTooShort, isVpnProxy, isVpnUnknown, isApplicantBanned },
            accounts,
            applicantProfileUrl,
            reasonText,
          );
        }
      }

      if (!message.dataset.decisionChecked) {
        message.dataset.decisionChecked = "1";
        const reasonField = message.querySelector(
          'dl[data-field="why_join"] dd',
        );
        const reasonText = reasonField ? reasonField.textContent.trim() : null;

        addDecisionHelper(
          message,
          { isFemale, isTooShort, isVpnProxy, isVpnUnknown, isApplicantBanned },
          null,
          null,
          reasonText,
        );
      }
      } catch (err) {
        logError("highlightApplications", err, { message });
      }
    };
    await Promise.all(Array.from(messages).map(_processOne));
    try {
      if (_filtersOn() && window.__updateFilterDisplay) window.__updateFilterDisplay();
      else if (window.__updateFilterCounts) window.__updateFilterCounts();
    } catch (_) {}
    _dockRender();
  }

  let _hlRunning = false;
  let _hlNeedsRerun = false;
  function _guardedHighlight() {
    if (_isPaused()) return;
    if (!_tabActive()) return;
    if (_hlRunning) {
      _hlNeedsRerun = true;
      return;
    }
    _hlRunning = true;
    Promise.resolve(highlightApplications())
      .catch((e) => console.error("[UserScript] highlight error", e))
      .finally(() => {
        _hlRunning = false;
        if (_hlNeedsRerun) {
          _hlNeedsRerun = false;
          _guardedHighlight();
        } else {

          _maybeScheduleSave();
        }
      });
  }

  function _hasNewMessages(mutations) {
    for (const m of mutations) {

      const t = m.target;
      if (t && t.nodeType === 1 && t.closest && t.closest(".message, #lmqDock, #lmqNotices")) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(".message") || n.querySelector(".message")) return true;
      }
    }
    return false;
  }
  if (_isQueuePage()) {
    _tabWatch();
    _queueLeftFromDoc(document, false);
    if (IS_TOP && _isPaused()) {
      console.log("[PAUSE] this tab is paused — tap Continue in the dock for the next round");
      _dockMsg("Paused — tap Continue for the next round", "paused");
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => { _dualMerge(); });
      document.addEventListener("DOMContentLoaded", _guardedHighlight);
      document.addEventListener("DOMContentLoaded", _renderBanCheckPanel);
      document.addEventListener("DOMContentLoaded", _dockRender);
    } else {
      _dualMerge();
      _guardedHighlight();
      _renderBanCheckPanel();
      _dockRender();
    }
    let _hlDebounce = null;
    const observer = new MutationObserver((mutations) => {
      if (!_hasNewMessages(mutations)) return;
      clearTimeout(_hlDebounce);
      _hlDebounce = setTimeout(_guardedHighlight, 40);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
}

function moduleReports() {
  'use strict';

  if (/^\/reports\/(\d+|closed)/.test(location.pathname)) return;

  const de = document.documentElement;
  if (de.hasAttribute('data-lrt-on') || document.getElementById('lrt-dock')) return;
  de.setAttribute('data-lrt-on', '9');

  const CATEGORIES = [
    { id: 'multi', label: 'Multi-Account', color: '#ffb648',
      test: t => /\bhas\s+\d+\s+multiple\s+accounts?$/i.test(t) },
    { id: 'convo', label: 'Conversations', color: '#8fb6ff',
      test: t => /^(conversation|direct message|unterhaltung|konversation|direktnachricht)\b/i.test(t) },
    { id: 'post',  label: 'Posts',         color: '#5cc8b4',
      test: t => /^(post|beitrag)\b/i.test(t) },

    { id: 'profile', label: 'Profile posts', color: '#c69cff', short: 'Profile',
      test: t => /^(profile[\s-]*post|comment on (a |the )?profile post|profilnachricht|pinnwand)/i.test(t) },
    { id: 'other', label: 'Other',         color: '#9c978b',
      test: () => true },
  ];
  const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

  const KEYWORDS = [
    { rule: 'Pedo',
      words: ['pedo', 'paedo', 'child porn', 'child abuse', 'child sexual abuse', 'child exploitation', 'csam',
              'molest', 'nonce', 'underage', 'sexualizing minors', 'sexualising minors', 'sexualizing kids',
              'sexualising kids', 'sexualizing children', 'sexualising children', 'grooming minors',
              'grooming kids', 'grooming children'] },
    { rule: 'Illegal threads',
      exact: ['er', 'gore', 'scat'],
      words: ['going er', 'elliot rodger', 'rodger', 'school shooting', 'mass shooting', 'shoot up', 'bomb threat',
              'terroris', 'gory', 'behead', 'dead bod', 'snuff', 'murder video', 'cartel video', 'coprophil',
              'feces', 'faeces', 'bestiality', 'zoophil', 'necrophil', 'animal abuse', 'animal cruelty'] },
    { rule: 'Gayposting',
      words: ['gay', 'homo', 'fag', 'queer', 'lgbt', 'femboy', 'twink'] },
    { rule: 'Spam/repfarm',
      exact: ['bot', 'bots'],
      words: ['spam', 'repfarm', 'rep farm', 'farming rep', 'repwhor', 'rep whor', 'copypasta', 'copy paste',
              'copy-paste', 'flood', 'advertis', 'self promo'] },
    { rule: 'Necrobump',
      words: ['necro', 'bump', 'old thread', 'dead thread', 'reviv', 'grave dig', 'gravedig'] },
  ];
  const reWord = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const KEYWORD_RULES = KEYWORDS.map(k => ({
    rule: k.rule,
    re: new RegExp([
      ...(k.words || []).map(w => '\\b' + reWord(w)),
      ...(k.exact || []).map(w => '\\b' + reWord(w) + '\\b'),
    ].join('|'), 'i'),
  }));

  const RULE_FILTERS = [
    { slug: 'spam',    label: 'Spam/repfarm' },
    { slug: 'necro',   label: 'Necrobump' },
    { slug: 'illegal', label: 'Illegal threads' },
    { slug: 'gay',     label: 'Gayposting' },
    { slug: 'pedo',    label: 'Pedo' },
    { slug: 'unclear', label: 'Unclear' },
  ];
  const slugOf = label => ({ 'Spam/repfarm': 'spam', 'Necrobump': 'necro', 'Illegal threads': 'illegal',
    'Gayposting': 'gay', 'Pedo': 'pedo', 'Alts': 'alts' })[label] || 'unclear';

  const ALT_FILTERS = [
    { slug: 'rejected', label: 'Only rejected', color: '#4cc98a' },
    { slug: 'deleted',  label: 'Deleted',       color: '#a99bd8' },
    { slug: 'active',   label: 'Active alt',    color: '#ffb648' },
    { slug: 'banned',   label: 'Banned alt',    color: '#ff5466' },
    { slug: 'foid',     label: 'Foid ban',      color: '#e486b8' },
    { slug: 'pending',  label: 'Awaiting',      color: '#8fb6ff' },
    { slug: 'other',    label: 'Unclear',       color: '#9c978b' },
  ];
  const ALT_VERDICT = {
    rejected: { icon: '✓', label: 'Only rejected alts', note: 'Every linked account was already rejected. Nothing to ban.' },
    active:   { icon: '!', label: 'Active alt',  note: 'A linked account is still active. Check it before closing.' },
    banned:   { icon: '✕', label: 'Banned alt',  note: 'Linked to a banned account. Possible ban evasion.' },
    pending:  { icon: '…', label: 'Alt awaiting approval', note: 'A linked account is still waiting in the approval queue.' },
    other:    { icon: '?', label: 'Unclear',     note: 'No alt status found. Open the details to check.' },
    deleted:  { icon: '–', label: 'Only deleted alts', note: 'Every linked account was deleted. Nothing to ban.' },
    foid:     { icon: '♀\uFE0E', label: 'Banned alt (foid)', note: 'The ban (its warning or ban reason) says “foid”. No other active or banned alt.' },
    loading:  { icon: '',  label: 'Checking alts', note: '' },
  };
  const ALT_STATE = { rejected: 'Rejected', banned: 'Banned', foid: 'Banned: foid', active: 'Active', pending: 'Awaiting', disabled: 'Disabled', deleted: 'Deleted' };
  const ALT_SEVERITY = { banned: 6, active: 5, pending: 4, other: 3, disabled: 2, rejected: 1, deleted: 0 };

  const REP_FILTERS = [
    { slug: 'pending',  label: 'Awaiting',  color: '#8fb6ff', text: 'awaiting approval' },
    { slug: 'rejected', label: 'Rejected',  color: '#4cc98a', text: 'rejected' },
    { slug: 'active',   label: 'Active',    color: '#ffb648', text: 'active' },
    { slug: 'banned',   label: 'Banned',    color: '#ff5466', text: 'banned' },
    { slug: 'disabled', label: 'Disabled',  color: '#9c978b', text: 'disabled', rare: true },
    { slug: 'unknown',  label: 'No status', color: '#6f6b62', text: 'without a status', rare: true },
  ];

  const MT_FILTERS = [
    { slug: 'both',   label: 'Cookie + IP', text: 'found by cookie + IP' },
    { slug: 'cookie', label: 'Cookie',      text: 'found by cookie (no IP)' },
    { slug: 'ip',     label: 'IP only',     text: 'found by IP only' },
    { slug: 'other',  label: 'Other',       text: 'found by fingerprint, device or email', rare: true },
    { slug: 'none',   label: 'No method',   text: 'without a detection method', rare: true },
  ];

  const BULK_VERDICT = { rejected: 'with only rejected alts', deleted: 'with only deleted alts', foid: 'with a foid-banned alt',
    banned: 'with a banned alt', active: 'with an active alt', pending: 'with an alt awaiting approval', all: '' };

  const FORUMS = [

    ['Best of the Best'],
    ['Looksmaxing'],
    ['Cosmetic Surgery', 'Looksmaxing'],
    ['Fitness & Health', 'Looksmaxing'],
    ['Looksmaxing Questions'],
    ['Moneymaking & Success'],
    ['Cryptocurrency', 'Moneymaking & Success'],
    ['Ratings'],
    ['Private Ratings', 'Ratings'],
    ['Offtopic'],

    ['Language-Specific Sections'],
    ['Spanish (Español)', 'Language-Specific Sections'],
    ['German (Deutsch)', 'Language-Specific Sections'],
    ['French (Français)', 'Language-Specific Sections'],
    ['Turkish (Türkçe)', 'Language-Specific Sections'],
    ['Russian (Русский)', 'Language-Specific Sections'],
    ['Other Languages'],
  ];

  const forumKey = name => {
    const s = String(name || '').toLowerCase();
    return s.replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '') || s.replace(/\s+/g, '');
  };
  const FORUM_INFO = new Map(FORUMS.map(([name, parent], i) => [forumKey(name), { name, parent: parent || '', rank: i }]));

  const LANG_FORUMS = new Set(['languagespecificsections', 'spanish', 'german', 'french', 'turkish', 'russian', 'otherlanguages']);
  const LANG_FORUM_RE = /espa[ñn]ol|spanish|deutsch|german|fran[çc]ais|french|t[üu]rk|русск|russian|other languages|language-specific/i;
  const NO_FORUM = '~none', FORUM_LOADING = '~loading';
  const FORUM_CATS = ['post', 'other'];
  const forumNames = new Map();

  function forumRank(k) {
    if (k === NO_FORUM) return 900;
    if (k === FORUM_LOADING) return 950;
    const info = FORUM_INFO.get(k);
    return info ? info.rank : 500;
  }
  const forumShort = k => forumNames.get(k) || (FORUM_INFO.get(k) || {}).name || k;
  function forumLabel(k) {
    if (k === NO_FORUM) return 'No forum';
    if (k === FORUM_LOADING) return 'Forum not known yet';

    return forumShort(k);
  }
  const compareForums = (a, b) => forumRank(a) - forumRank(b) || forumLabel(a).localeCompare(forumLabel(b));

  const VERSION = LM_VERSIONS.reports;
  const PARALLEL = 4;
  const TIMEOUT = 20000;
  const FILTER_KEY = 'lrc-filter';
  const MARKS_KEY = 'lrt-marks-v1';
  const OPENED_KEY = 'lrt-opened';
  const ALT_PARALLEL = 4;
  const ALT_KEY = 'lrt-alts-v1';
  const ALT_FILTER_KEY = 'lrt-alt-filter';
  const REP_FILTER_KEY = 'lrt-rep-filter';
  const MT_FILTER_KEY = 'lrt-mt-filter-v2';
  const FORUM_FILTER_KEY = 'lrt-forum-filter';
  const FORUM_CACHE_KEY = 'lrt-forums-v1';
  const ALT_TTL = 12 * 3600e3;
  const ALT_FRESH = 20 * 60e3;
  const ALT_V = 10;
  const FOID_REASON = 'Foid';
  const ROOT_SEL = '.p-body-pageContent, .p-body-content, .p-body-main';
  const SKIP_SEL = '.menu, .offCanvasMenu, .overlay-container, .p-nav, .p-navSticky, .p-header, .tooltip, ' +
                   '.lrc-bar, .lrc-head, .lrt-card, #lrt-dock';
  const CLOSED_RE = /resolved|rejected|closed|erledigt|abgelehnt|geschlossen/;
  const BTN = '.lrc-chip,.lrt-rchip,.lrt-achip,.lrt-b,.lrt-tool,.lrt-undo,.lrt-banbtn,.lrt-reset,.lrt-ftog,.lrt-search-x,.lrt-trchip';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const host = h => h.replace(/^www\./, '');
  const csrf = () =>
    (PAGE.XF && PAGE.XF.config && PAGE.XF.config.csrf) || de.getAttribute('data-csrf') || '';
  const setText = (el, v) => { v = String(v); if (el && el.textContent !== v) el.textContent = v; };
  const setAttr = (el, k, v) => { v = String(v); if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const button = (cls, text) => { const b = make('button', cls, text); b.type = 'button'; return b; };
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const activate = el => { try { if (PAGE.XF && PAGE.XF.activate) PAGE.XF.activate(el); } catch (_) {} };
  const log = e => { try { console.error('[Report Turbo]', e); } catch (_) {} };

  const isAvatar = el => !!(el && el.closest && el.closest('.avatar, .avatarWrapper'));

  const ownBar = () => document.querySelector('.lrc-bar[data-lrt-bar]');

  let root = null, mo = null;
  const reports = new Map();
  const byPreview = new Map();
  const queue = new Set();
  let loading = 0, sending = false;
  let catFilter = 'all', ruleFilter = 'all';

  const readMarks = () => { try { return JSON.parse(localStorage.getItem(MARKS_KEY)) || {}; } catch (_) { return {}; } };
  let marks = readMarks();
  const saveMarks = () => {
    try { localStorage.setItem(MARKS_KEY, JSON.stringify(marks)); } catch (_) {}
    try { todayActive(); } catch (_) {}
  };

  let altFilter = 'all', repFilter = 'all', mtFilter = 'all', altStarted = false, altLoading = 0;
  const altQueue = [];
  const altCache = (() => {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(ALT_KEY)) || {}; } catch (_) {}
    const now = Date.now();
    for (const k of Object.keys(c)) if (!c[k] || c[k].v !== ALT_V || now - c[k].t > ALT_TTL) delete c[k];
    return c;
  })();
  let altSaveTimer = 0;
  const saveAltsNow = () => {
    clearTimeout(altSaveTimer);
    altSaveTimer = 0;
    try { localStorage.setItem(ALT_KEY, JSON.stringify(altCache)); } catch (_) {}
  };
  const saveAltsSoon = () => { if (!altSaveTimer) altSaveTimer = setTimeout(saveAltsNow, 1500); };
  addEventListener('pagehide', () => { if (altSaveTimer) saveAltsNow(); if (forumSaveTimer) saveForumsNow(); });

  let forumFilter = 'all', ordSeq = 0;
  const forumCache = (() => {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(FORUM_CACHE_KEY)) || {}; } catch (_) {}
    const now = Date.now();
    for (const k of Object.keys(c)) if (!c[k] || now - c[k].t > 7 * 86400e3) delete c[k];
    return c;
  })();
  let forumSaveTimer = 0;
  const saveForumsNow = () => {
    clearTimeout(forumSaveTimer);
    forumSaveTimer = 0;
    try { localStorage.setItem(FORUM_CACHE_KEY, JSON.stringify(forumCache)); } catch (_) {}
  };
  const saveForumsSoon = () => { if (!forumSaveTimer) forumSaveTimer = setTimeout(saveForumsNow, 1500); };

  async function req(url, opts = {}) {
    const isGet = !opts.method || opts.method === 'GET';
    for (let i = 0; ; i++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT);
      let wait = 0;
      try {
        const res = await fetch(url, { credentials: 'same-origin', ...opts, signal: ctl.signal });
        if ((res.status === 429 || res.status === 503) && i < 3) {
          const after = parseFloat(res.headers.get('Retry-After'));
          wait = after > 0 ? Math.min(after, 30) * 1000 : 3000 * (i + 1);
        } else {
          return { ok: res.ok, status: res.status, text: await res.text() };
        }
      } catch (e) {
        if (!isGet || i >= 2) {
          throw new Error(e && e.name === 'AbortError' ? 'The forum took too long to answer' : 'Connection problem');
        }
        wait = 700 * (i + 1);
      } finally {
        clearTimeout(timer);
      }
      await sleep(wait);
    }
  }

  const parse = html => new DOMParser().parseFromString(html, 'text/html');

  async function fetchDoc(url) {
    const r = await req(url);
    if (!r.ok) throw new Error('Couldn\'t load report (' + r.status + ')');
    return parse(r.text);
  }

  function findForm(doc) {
    const r = doc && doc.querySelector('input[name="report_state"]');
    return r ? r.closest('form') : null;
  }

  function pairOf(doc, key) {
    const re = new RegExp('^\\s*' + key + ':?\\s*$', 'i');
    for (const dt of doc.querySelectorAll('dt')) {
      if (dt.closest('form') || !re.test(dt.textContent)) continue;
      const dd = dt.nextElementSibling;
      return dd ? dd.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    }
    return '';
  }

  const isClosed = doc => CLOSED_RE.test(pairOf(doc, 'status').toLowerCase());

  function forumOf(doc) {
    let v = pairOf(doc, 'forum');
    if (!v) {
      const scope = doc.querySelector('.p-body-pageContent') || doc.body;
      const a = scope && [...scope.querySelectorAll('a[href*="/forums/"]')].find(x =>
        !x.closest('.p-breadcrumbs, .p-nav, .menu, form, .bbWrapper, .tabs') && x.textContent.trim() &&
        /\/forums\/[^/?#]+\/?(?:[?#]|$)/.test(x.getAttribute('href') || ''));
      v = a ? a.textContent : '';
    }

    return String(v).split(/\s*[›»>]\s*/).pop().replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  const closedIds = new Set();
  const hiddenClosed = new Set();
  let closedChecked = false;
  const CLOSED_HEAD_RE = /\b(closed|resolved|rejected)\b|geschlossen|erledigt|abgelehnt/i;
  const HEAD_SEL = '.block-header, .block-minorHeader, .block-formSectionHeader, h2, h3, h4';
  let headCache = null;

  function listHeadings() {
    if (headCache) return headCache;
    headCache = [...root.querySelectorAll(HEAD_SEL)].filter(h =>
      !h.closest('a, button, .tabs, .tabs-tab, .menu, .p-nav, .p-title, .structItem, .lrc-bar, .lrc-head, .lrt-card') &&
      norm(h.textContent).length && norm(h.textContent).length <= 80);
    return headCache;
  }

  function underClosedHeading(box) {
    let last = null;
    for (const h of listHeadings()) {
      if (h.contains(box)) continue;
      if (h.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING) last = h; else break;
    }
    return !!last && CLOSED_HEAD_RE.test(norm(last.textContent));
  }

  function rowLooksClosed(box) {
    if (/\b(?:structItem--|is-)(?:closed|resolved|rejected)\b/i.test(String(box.className))) return true;
    if (underClosedHeading(box)) return true;

    const title = box.querySelector('.structItem-title');
    for (const el of box.querySelectorAll('span, li, dd, div, em, strong, b, i')) {
      if (el.children.length || (title && title.contains(el))) continue;
      const t = norm(el.textContent);
      if (t.length > 40) continue;
      if (/^(resolved|rejected|closed)$/i.test(t) || /^(resolved|rejected|closed) by\b/i.test(t) ||
          /^(?:status|state):?\s*(resolved|rejected|closed)$/i.test(t)) return true;
    }
    return false;
  }

  function hideClosedRow(box, id) {
    box.setAttribute('data-lrt-closed', '1');
    closedIds.add(id);
    hiddenClosed.add(id);
  }

  function dropClosed(it) {
    closedIds.add(it.id);
    if (!it.sent) hiddenClosed.add(it.id);
    closeLocally(it);
    marksChanged();
  }

  function hideEmptyClosedBlocks() {
    for (const box of root.querySelectorAll('[data-lrt-closed]')) {
      const blk = box.closest('.block');
      if (blk && root.contains(blk) && !blk.querySelector('[data-lrt-id], .lrc-bar')) blk.classList.add('lrt-hidden');
    }
  }

  async function loadClosedTab() {
    const tab = document.querySelector('a[href*="/reports/closed"]');
    let url = tab ? new URL(tab.getAttribute('href'), location.href).href : '';
    try {
      for (let page = 1; page <= 3 && url; page++) {
        const doc = await fetchDoc(url);
        const scope = doc.querySelector('.p-body-pageContent') || doc.querySelector('.p-body-main') || doc.body;
        let ids = 0, hit = 0;
        for (const a of scope.querySelectorAll('a[href*="/reports/"]')) {
          const m = (a.getAttribute('href') || '').match(/\/reports\/(\d+)\/?(?:[?#]|$)/);
          if (!m) continue;
          ids++;
          closedIds.add(m[1]);
          const it = reports.get(m[1]);
          if (it && !it.sent) { hit++; dropClosed(it); }
        }
        if (!ids || (page > 1 && !hit)) break;
        const next = doc.querySelector('a.pageNav-jump--next, a[rel="next"]');
        url = next ? new URL(next.getAttribute('href'), url).href : '';
      }
    } catch (e) { log(e); }
    closedChecked = true;
    hideEmptyClosedBlocks();
    renderSoon();
    pumpAlt();
  }

  async function freshForm(url) {
    const doc = await fetchDoc(url);
    const form = findForm(doc);
    if (!form || isClosed(doc)) {
      const e = new Error('Report is already closed');
      e.code = 'closed';
      throw e;
    }
    return { form, doc };
  }

  function formBody(form) {
    const body = new URLSearchParams();
    for (const el of form.querySelectorAll('input, textarea, select')) {
      const t = (el.type || '').toLowerCase();
      if (!el.name || el.disabled) continue;
      if (['submit', 'button', 'file', 'image', 'reset'].includes(t)) continue;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
      body.append(el.name, el.value);
    }
    return body;
  }

  async function submit(form, body, pageUrl) {
    if (!body.get('_xfToken')) body.set('_xfToken', csrf());
    body.set('_xfResponseType', 'json');
    const action = new URL(form.getAttribute('action') || pageUrl, pageUrl).href;
    const r = await req(action, { method: 'POST', body, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    let data = null;
    try { data = JSON.parse(r.text); } catch (_) {}
    if (!r.ok || !data || data.errors || (data.status !== 'ok' && !data.formValues)) {
      const errs = data && data.errors;
      throw new Error(errs ? [].concat(Array.isArray(errs) ? errs : Object.values(errs)).join(' ')
                           : 'Server answered ' + r.status);
    }
    return data;
  }

  function applyFormValues(form, values, extra) {
    if (!values || typeof values !== 'object') return;
    for (const [sel, val] of Object.entries(values)) {
      let els = [];
      try { els = [...form.querySelectorAll(sel)]; } catch (_) {}
      if (!els.length) {
        const m = /^(?:input|select|textarea)\[name=["']?([^"'\]]+)["']?\]$/.exec(sel);
        if (m && typeof val !== 'boolean' && val !== null && val !== undefined) extra.set(m[1], String(val));
        continue;
      }
      for (const el of els) {
        const t = (el.type || '').toLowerCase();
        if (t === 'checkbox' || t === 'radio') el.checked = !!val;
        else if ('value' in el) el.value = val === null || val === undefined ? '' : String(val);
      }
    }
  }

  async function post(form, state, pageUrl) {
    if (!form.querySelector('input[name="report_state"][value="' + state + '"]')) {
      throw new Error('Option "' + state + '" is missing in the form');
    }
    const body = formBody(form);
    body.delete('report_state');
    body.set('report_state', state);
    await submit(form, body, pageUrl);
  }

  let touching = false, touchAt = 0, lastScroll = 0, flushTimer = 0, nav;
  const later = new Map();

  addEventListener('scroll', () => { lastScroll = performance.now(); }, { passive: true });
  addEventListener('touchstart', () => { touching = true; touchAt = performance.now(); }, { passive: true, capture: true });
  const touchEnd = e => {
    if (e.touches && e.touches.length) return;
    touching = false;
    lastScroll = performance.now();
    if (later.size) flushSoon();
  };
  addEventListener('touchend', touchEnd, { passive: true, capture: true });
  addEventListener('touchcancel', touchEnd, { passive: true, capture: true });

  const userBusy = () => {
    const now = performance.now();
    return (touching && now - touchAt < 8000) || now - lastScroll < 150;
  };

  function viewTop() {
    if (nav === undefined) nav = document.querySelector('.p-navSticky');
    if (!nav || !nav.isConnected) return 0;
    const r = nav.getBoundingClientRect();
    if (!r.height || r.top > 1 || r.bottom <= 0) return 0;
    const pos = getComputedStyle(nav).position;
    return pos === 'sticky' || pos === 'fixed' ? r.bottom : 0;
  }

  function scrollByNow(dy) {
    if (Math.abs(dy) < 1) return;
    try { window.scrollBy({ top: dy, left: 0, behavior: 'instant' }); } catch (_) { window.scrollBy(0, dy); }
  }

  const ANCHOR_SEL = '.lrc-bar, .lrt-card';

  function anchorAt(vt, skip) {
    const x = Math.round(innerWidth / 2);
    for (let y = vt + 4; y < Math.min(innerHeight, vt + 160); y += 12) {
      const hit = document.elementFromPoint(x, y);
      const el = hit && hit.closest && hit.closest(ANCHOR_SEL);
      if (el && root.contains(el) && !skip.has(el)) {
        const r = el.getBoundingClientRect();
        if (r.height && r.bottom > vt + 1) return { el, top: r.top };
      }
    }
    for (const el of root.querySelectorAll(ANCHOR_SEL)) {
      if (skip.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height && r.bottom > vt + 1) return { el, top: r.top };
    }
    return null;
  }

  function keepStill(fn, els) {
    let a = null;
    if (root && window.scrollY >= 2) {
      const vt = viewTop();

      const skip = new Set();
      for (const e of els || []) {
        if (!e || !e.isConnected) continue;
        const r = e.getBoundingClientRect();
        if (!(r.height > 0 && r.top < vt)) continue;
        if (e.matches(ANCHOR_SEL)) skip.add(e);
        else for (const c of e.querySelectorAll(ANCHOR_SEL)) skip.add(c);
      }
      a = anchorAt(vt, skip);
    }
    try {
      fn();
    } finally {
      if (a && a.el.isConnected) {
        const r = a.el.getBoundingClientRect();
        if (r.height) scrollByNow(r.top - a.top);
      }
    }
  }

  function calm(el, key, fn) {
    later.delete(key);
    const r = el && el.isConnected ? el.getBoundingClientRect() : null;
    const shown = !!(r && r.height);
    if (r && (!shown || r.top >= innerHeight)) { fn(); return; }
    if (userBusy() && (touching || !shown || r.top < viewTop())) {
      later.set(key, { el, fn });
      flushSoon();
      return;
    }
    keepStill(fn, [el]);
  }

  function flushSoon() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      if (!later.size) return;
      if (userBusy()) { flushSoon(); return; }
      const jobs = [...later.values()];
      later.clear();
      keepStill(() => jobs.forEach(j => { try { j.fn(); } catch (e) { log(e); } }), jobs.map(j => j.el));
    }, 160);
  }

  function outermost(el, sel) {
    let hit = el.closest(sel);
    while (hit) {
      const up = hit.parentElement && hit.parentElement.closest(sel);
      if (!up || !root.contains(up)) break;
      hit = up;
    }
    return hit;
  }

  function titleOf(box, link) {
    const el = box.querySelector('.structItem-title') || link;
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function readInfo(box) {
    const text = (box.textContent || '').replace(/\s+/g, ' ');
    const names = [...box.querySelectorAll('.username, a[href*="/members/"]')]
      .filter(e => !isAvatar(e) && e.textContent.trim());
    const userEl = names.find(e => e.matches('.username')) || names[0];
    const timeEl = box.querySelector('time');
    const count = (text.match(/Reports?:\s*([\d,]+)/i) || [])[1];
    const timeMatch = text.match(/\b(Today|Yesterday|[A-Z][a-z]+day)\s+at\s+\d{1,2}:\d{2}\s*[AP]M\b|\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/);
    let userHref = '';
    if (userEl) {
      const l = userEl.closest('a[href*="/members/"]') || userEl.querySelector('a[href*="/members/"]');
      if (l) { try { userHref = new URL(l.getAttribute('href'), location.href).href; } catch (_) {} }
    }
    const userId = userEl ? (+userEl.getAttribute('data-user-id') || +((/\/members\/(?:[^/?#]*\.)?(\d+)/.exec(userHref) || [])[1]) || 0) : 0;
    return {
      userHref,
      userId,
      user: userEl ? userEl.textContent.trim() : '',
      time: timeEl ? timeEl.textContent.trim() : (timeMatch ? timeMatch[0] : ''),
      count: count ? parseInt(count.replace(/,/g, ''), 10) : 0,
    };
  }

  function skeleton() {
    const wrap = make('div', 'lrt-skels');
    wrap.setAttribute('aria-label', 'Loading report reason');
    const a = make('div', 'lrt-skel');
    a.append(make('i'), make('i'), make('i'));
    const b = make('div', 'lrt-skel lrt-skel-sm');
    b.append(make('i'), make('i'));
    wrap.append(a, b);
    return wrap;
  }

  function rememberOpen(it) { try { sessionStorage.setItem(OPENED_KEY, it.id); } catch (_) {} }

  function buildCard(it, title, info, cat) {
    const card = make('div', 'lrt-card' + (cat.id === 'multi' ? ' lrt-card--multi' : ''));

    const top = make('div', 'lrt-card-top');
    top.appendChild(make('span', 'lrt-tag', cat.label));
    if (info.count > 1) top.appendChild(make('span', 'lrt-count', info.count + ' reports'));
    if (info.time) top.appendChild(make('span', 'lrt-time', info.time));

    const link = make('a', 'lrt-title', title || 'Report');
    link.href = it.url;
    link.addEventListener('click', () => rememberOpen(it));
    card.append(top, link);

    const who = make('div', 'lrt-who');

    if (info.user && !(title || '').toLowerCase().startsWith(info.user.toLowerCase() + ' ')) {

      if (info.userHref && info.userId) {
        const u = make('a', 'lrt-user username', info.user);
        u.href = info.userHref;
        u.target = '_blank';
        u.rel = 'noopener';
        u.setAttribute('data-user-id', String(info.userId));
        who.appendChild(u);
      } else {
        who.appendChild(make('span', 'lrt-user', info.user));
      }
    }
    card.appendChild(who);

    if (cat.id === 'multi') {
      const alts = make('div', 'lrt-alts');
      alts.setAttribute('data-st', 'loading');

      const sk = make('div', 'lrt-alts-skel');
      sk.append(make('i'), make('i'), make('i'));
      alts.append(altHead(ALT_VERDICT.loading, null), sk);
      card.appendChild(alts);
    }

    const state = make('div', 'lrt-state');
    const undo = button('lrt-undo', 'Undo');
    undo.addEventListener('click', e => { stop(e); unmark(it); });
    state.append(make('span', 'lrt-state-text'), undo);

    const pv = make('div', 'lrt-prev');
    const body = make('div', 'lrt-body');
    body.appendChild(skeleton());
    const bar = make('div', 'lrt-bar');
    const open = make('a', 'lrt-b lrt-link', 'Open');
    open.href = it.url;
    open.addEventListener('click', () => rememberOpen(it));
    const rej = button('lrt-b lrt-rej', 'Reject');
    rej.dataset.a = 'rejected';
    const ok = button('lrt-b lrt-ok', 'Resolve');
    ok.dataset.a = 'resolved';
    rej.disabled = ok.disabled = true;
    bar.append(open, rej, ok);
    bar.addEventListener('click', e => {
      const b = e.target.closest('button[data-a]');
      if (!b || b.disabled) return;
      stop(e);
      mark(it, b.dataset.a);
    });
    pv.append(body, bar);

    card.append(state, pv);
    it.card = card;
    it.pv = pv;
    it.body = body;
    it.bar = bar;
    return card;
  }

  function scan() {
    headCache = null;
    let closedNow = 0;
    keepStill(() => {
      let added = 0;
      for (const a of root.querySelectorAll('a[href*="/reports/"]')) {
        if (a.closest(SKIP_SEL)) continue;
        let u;
        try { u = new URL(a.getAttribute('href'), location.href); } catch (_) { continue; }
        if (host(u.hostname) !== host(location.hostname)) continue;
        const m = u.pathname.match(/\/reports\/(\d+)\/?$/);
        if (!m) continue;
        const known = reports.get(m[1]);
        if (known && known.box.isConnected) continue;
        const box = outermost(a, '.structItem') || a.closest('li, .block-row');
        if (!box || box.hasAttribute('data-lrt-id') || box.hasAttribute('data-lrt-closed')) continue;
        if (closedIds.has(m[1]) || rowLooksClosed(box)) { hideClosedRow(box, m[1]); closedNow++; continue; }

        const title = titleOf(box, a);
        const cat = CATEGORIES.find(c => c.test(title)) || CAT.other;
        const info = readInfo(box);

        const it = { id: m[1], url: u.origin + u.pathname, title, box, cat: cat.id,
                     rule: '', slug: 'pending', canAct: false, forum: '',
                     queued: false, sent: false, fullSrc: '', fullBuilt: false,
                     alt: null, altQueued: false, altFailed: false, altStale: false, altTries: 0, raw: '',
                     loadFailed: false, userName: info.user, userHref: info.userHref };
        if (cat.id === 'multi') { it.rule = 'Alts'; it.slug = 'alts'; }
        box.setAttribute('data-lrt-id', it.id);
        box.setAttribute('data-lrt-ord', String(ordSeq++));
        box.setAttribute('data-lrc-cat', cat.id);
        box.setAttribute('data-lrt-rule', it.slug);
        if (cat.id !== 'multi') {
          const fc = forumCache[it.id];
          if (fc) setForum(it, fc.f, true);
          else box.setAttribute('data-lrt-forum', FORUM_LOADING);
        }
        box.classList.add('lrc-item', 'lrt-carded');
        box.prepend(buildCard(it, title, info, cat));

        if (cat.id === 'multi') {

          const c = altCache[it.id];
          if (c && c.title === title && c.d) {
            it.alt = c.d;
            it.altStale = Date.now() - c.t > ALT_FRESH;
            setAltAttrs(it);
            renderAltBox(it);
            if (it.altStale && altStarted) enqueueAlt(it);
          } else {
            setAltAttrs(it);
            if (altStarted) enqueueAlt(it);
          }
        }

        if (known) { io.unobserve(known.pv); byPreview.delete(known.pv); queue.delete(known); }
        reports.set(it.id, it);
        byPreview.set(it.pv, it);
        if (marks[it.id]) showMark(it, marks[it.id].s);
        io.observe(it.pv);
        added++;
      }
      if (added) regroup();
      if (closedNow) hideEmptyClosedBlocks();
    });
    if (mo) mo.takeRecords();
    if (altStarted) setTimeout(pumpAlt, 400);
    preloadForums();
    renderSoon();
  }

  function preloadForums() {
    let any = false;
    for (const it of reports.values()) {
      if (!FORUM_CATS.includes(it.cat) || it.sent || it.queued) continue;
      if (it.box.getAttribute('data-lrt-forum') !== FORUM_LOADING) continue;
      io.unobserve(it.pv);
      want(it);
      any = true;
    }
    if (any) pump();
  }

  function setForum(it, name, quiet) {
    name = name || '';
    const key = name ? forumKey(name) : NO_FORUM;
    if (name && !forumNames.has(key)) forumNames.set(key, name);
    it.forum = name;
    if (it.box.getAttribute('data-lrt-forum') === key) return;
    it.box.setAttribute('data-lrt-forum', key);
    if (!quiet && FORUM_CATS.includes(it.cat)) regroupSoon();
  }

  let regroupTimer = 0;
  function regroupSoon() {
    if (!regroupTimer) regroupTimer = setTimeout(runRegroup, 500);
  }
  function runRegroup() {
    regroupTimer = 0;
    if (userBusy()) { regroupTimer = setTimeout(runRegroup, 300); return; }
    keepStill(regroup);
    if (mo) mo.takeRecords();
    renderSoon();
  }

  function makeHead(cat, parent) {
    const h = document.createElement(/^(UL|OL)$/.test(parent.tagName) ? 'li' : 'div');
    h.className = 'lrc-head';
    h.setAttribute('data-lrc-cat', cat.id);
    h.append(make('span', '', cat.label), make('span', 'lrc-head-n'));
    return h;
  }

  function makeForumHead(catId, key, parent) {
    const h = document.createElement(/^(UL|OL)$/.test(parent.tagName) ? 'li' : 'div');
    h.className = 'lrc-head lrt-fhead';
    h.setAttribute('data-lrc-cat', catId);
    h.setAttribute('data-lrt-fkey', key);
    h.append(make('span', 'lrt-fhead-name'), make('span', 'lrc-head-n'));
    return h;
  }
  const headKey = h => h.getAttribute('data-lrc-cat') + (h.classList.contains('lrt-fhead') ? '|' + h.getAttribute('data-lrt-fkey') : '');
  const ordOf = b => +b.getAttribute('data-lrt-ord') || 0;

  function regroup() {
    const groups = new Map();
    for (const it of reports.values()) {
      if (!it.box.isConnected) continue;
      const p = it.box.parentElement;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(it.box);
    }
    for (const [p, boxes] of groups) {
      boxes.sort((a, b) => ordOf(a) - ordOf(b));
      const heads = new Map();
      for (const h of p.querySelectorAll(':scope > .lrc-head')) heads.set(headKey(h), h);
      const take = (k, mk) => { const h = heads.get(k) || mk(); heads.delete(k); return h; };
      const order = [];
      for (const cat of CATEGORIES) {
        const part = boxes.filter(b => b.getAttribute('data-lrc-cat') === cat.id);
        if (!part.length) continue;
        order.push(take(cat.id, () => makeHead(cat, p)));

        const keys = FORUM_CATS.includes(cat.id) ? part.map(b => b.getAttribute('data-lrt-forum') || FORUM_LOADING) : [];
        if (!keys.some(k => k !== NO_FORUM && k !== FORUM_LOADING)) { order.push(...part); continue; }
        const byKey = new Map();
        part.forEach((b, i) => { if (!byKey.has(keys[i])) byKey.set(keys[i], []); byKey.get(keys[i]).push(b); });
        for (const k of [...byKey.keys()].sort(compareForums)) {
          const h = take(cat.id + '|' + k, () => makeForumHead(cat.id, k, p));
          setText(h.querySelector('.lrt-fhead-name'), forumLabel(k));
          order.push(h, ...byKey.get(k));
        }
      }
      heads.forEach(h => h.remove());

      const now = [...p.children].filter(el => el.classList.contains('lrc-head') || el.hasAttribute('data-lrt-id'));
      if (now.length === order.length && now.every((el, i) => el === order[i])) continue;
      const spot = document.createComment('lrc');
      p.insertBefore(spot, now[0] || null);
      const frag = document.createDocumentFragment();
      order.forEach(el => frag.appendChild(el));
      spot.replaceWith(frag);
    }
    const first = groups.keys().next().value;
    if (first) ensureBar(first);
  }

  const PANEL_OPEN_KEY = 'lrt-panel-open';
  const VERDICT_TILES = [
    { slug: 'all',      icon: '∗', label: 'All',           hint: 'every verdict' },
    { slug: 'rejected', icon: '✓', label: 'Only rejected', hint: 'just resolve' },
    { slug: 'deleted',  icon: '–', label: 'Only deleted',  hint: 'just resolve' },
    { slug: 'foid',     icon: '♀\uFE0E', label: 'Foid ban', hint: 'ban + resolve' },
    { slug: 'active',   icon: '!', label: 'Active alt',    hint: 'check first' },
    { slug: 'banned',   icon: '✕', label: 'Banned alt',    hint: 'ban evasion?' },
    { slug: 'pending',  icon: '…', label: 'Alt in queue',  hint: 'still waiting' },
    { slug: 'other',    icon: '?', label: 'Unclear',       hint: 'open to check' },
  ];
  let searchQ = '';
  const hayCache = new WeakMap();
  function hayOf(it) {
    const key = (it.raw || '').length + '|' + (it.alt ? (it.alt.alts || []).length : -1) + '|' + (it.forum || '');
    const c = hayCache.get(it);
    if (c && c.k === key) return c.h;
    const parts = [it.title, it.userName, it.forum ? forumLabel(it.box.getAttribute('data-lrt-forum') || '') : '', it.rule, it.raw];
    if (it.alt) { parts.push(it.alt.meName); (it.alt.alts || []).forEach(x => parts.push(x.name)); }
    const h = parts.filter(Boolean).join(' \n ').toLowerCase();
    hayCache.set(it, { k: key, h });
    return h;
  }

  const matchesQ = it => !searchQ || searchQ.split(/\s+/).every(w => hayOf(it).includes(w));
  function applySearch() {
    setAttr(de, 'data-lrt-q', searchQ ? '1' : '');
    if (!searchQ) { for (const it of reports.values()) it.box.classList.remove('lrt-nomatch'); return; }
    for (const it of reports.values()) it.box.classList.toggle('lrt-nomatch', !matchesQ(it));
  }

  function passes(it) {
    if (catFilter !== 'all' && it.cat !== catFilter) return false;
    const multi = catFilter === 'multi';
    if (!multi && ruleFilter !== 'all' && it.slug !== ruleFilter) return false;
    if (!multi && forumFilter !== 'all' && it.box.getAttribute('data-lrt-forum') !== forumFilter) return false;
    if (multi) {
      if (altFilter !== 'all' && it.box.getAttribute('data-lrt-alt') !== altFilter) return false;
      if (repFilter !== 'all' && it.box.getAttribute('data-lrt-rep') !== repFilter) return false;
      if (mtFilter !== 'all' && it.box.getAttribute('data-lrt-mt') !== mtFilter) return false;
    }
    return matchesQ(it);
  }
  function activeFilters() {
    const multi = catFilter === 'multi';
    let n = 0;
    if (searchQ) n++;
    if (!multi && ruleFilter !== 'all') n++;
    if (!multi && forumFilter !== 'all') n++;
    if (multi) n += (altFilter !== 'all') + (repFilter !== 'all') + (mtFilter !== 'all');
    return n;
  }

  function clearOneFilter(f) {
    if (f === 'q') { resetSearchOnly(); return; }
    if (f === 'forum') forumFilter = 'all';
    else if (f === 'rule') ruleFilter = 'all';
    else if (f === 'alt') altFilter = 'all';
    else if (f === 'rep') repFilter = 'all';
    else if (f === 'mt') mtFilter = 'all';
    const key = { forum: FORUM_FILTER_KEY, alt: ALT_FILTER_KEY, rep: REP_FILTER_KEY, mt: MT_FILTER_KEY }[f];
    try { if (key) sessionStorage.setItem(key, 'all'); } catch (_) {}
    keepStill(() => { applyFilters(); updateCounts(); });
  }
  function resetSearchOnly() {
    const inp = document.querySelector('.lrt-search input');
    if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input')); }
  }

  function activeFilterPills() {
    const multi = catFilter === 'multi', out = [];
    const lab = (list, slug) => (list.find(x => x.slug === slug) || {}).label || slug;
    if (searchQ) out.push(['q', '“' + searchQ.slice(0, 18) + (searchQ.length > 18 ? '…' : '') + '”']);
    if (!multi && forumFilter !== 'all') out.push(['forum', forumShort(forumFilter)]);
    if (!multi && ruleFilter !== 'all') out.push(['rule', lab(RULE_FILTERS, ruleFilter)]);
    if (multi && altFilter !== 'all') out.push(['alt', lab(VERDICT_TILES, altFilter)]);
    if (multi && mtFilter !== 'all') out.push(['mt', lab(MT_FILTERS, mtFilter)]);
    if (multi && repFilter !== 'all') out.push(['rep', 'Account: ' + lab(REP_FILTERS, repFilter)]);
    return out;
  }
  function resetFilters() {
    ruleFilter = altFilter = repFilter = mtFilter = forumFilter = 'all';
    searchQ = '';
    const inp = document.querySelector('.lrt-search input');
    if (inp) { inp.value = ''; inp.parentElement.classList.remove('has-q'); }
    try {
      [ALT_FILTER_KEY, REP_FILTER_KEY, MT_FILTER_KEY, FORUM_FILTER_KEY].forEach(k => sessionStorage.setItem(k, 'all'));
    } catch (_) {}
    keepStill(() => { applySearch(); applyFilters(); updateCounts(); });
  }

  function ensureBar(firstList) {
    const existing = ownBar();
    if (existing && existing.isConnected) return;
    const bar = make('div', 'lrc-bar');
    bar.setAttribute('data-lrt-bar', VERSION);
    const refresh = () => keepStill(() => { applyFilters(); updateCounts(); });

    const hd = make('div', 'lrt-hd');
    const logo = make('span', 'lrt-logo', 'RT');
    const ht = make('div', 'lrt-hd-t');
    const htTitle = make('b', '', 'Report Center');
    htTitle.appendChild(make('span', 'lrt-hd-v', 'v' + LM_VERSIONS.suite));
    const htLine = make('div', 'lrt-hd-line');
    htLine.append(make('small', 'lrt-hd-sub', 'Loading reports …'), make('span', 'lrt-trrow-s'));
    ht.append(htTitle, htLine);

    const kpis = make('div', 'lrt-kpis');
    [['open', 'Open'], ['today', 'Today'], ['rate', 'Per hour'], ['eta', 'Time left']].forEach(([k, l]) => {
      const t = make('div', 'lrt-kpi');
      t.setAttribute('data-k', k);
      t.append(make('b', '', '–'), make('span', '', l));
      kpis.appendChild(t);
    });

    const chips = make('div', 'lrc-chips');
    chips.appendChild(make('span', 'lrc-ind'));
    for (const cat of [{ id: 'all', label: 'All' }, ...CATEGORIES]) {
      const b = button('lrc-chip');
      b.setAttribute('data-lrc-id', cat.id);
      b.setAttribute('aria-pressed', 'false');
      b.append(make('span', '', cat.id === 'convo' ? 'DMs' : cat.id === 'multi' ? 'Multi' : cat.short || cat.label), make('span', 'lrc-chip-n'));
      b.addEventListener('click', () => {
        catFilter = cat.id === 'all' || catFilter === cat.id ? 'all' : cat.id;
        try { localStorage.setItem(FILTER_KEY, catFilter); } catch (_) {}
        refresh();
      });
      chips.appendChild(b);
    }

    const search = make('div', 'lrt-search');
    const inp = make('input');
    inp.type = 'search';
    inp.placeholder = 'Search name, title or reason';
    inp.setAttribute('enterkeyhint', 'search');
    inp.setAttribute('autocapitalize', 'off');
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('spellcheck', 'false');
    const clr = button('lrt-search-x', '×');
    clr.setAttribute('aria-label', 'Clear search');
    let qTimer = 0;
    inp.addEventListener('input', () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        searchQ = inp.value.trim().toLowerCase().replace(/\s+/g, ' ');
        search.classList.toggle('has-q', !!searchQ);
        keepStill(() => { applySearch(); updateCounts(); });
        if (searchQ) loadAllReasons();
      }, 140);
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    clr.addEventListener('click', () => { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.focus(); });
    search.append(make('span', 'lrt-search-ico'), inp, clr);

    hd.append(logo, ht);

    const fb = make('div', 'lrt-fbody');
    const ftog = button('lrt-ftog');
    ftog.append(make('span', 'lrt-ftog-t', 'Filters'), make('span', 'lrt-ftog-n'), make('span', 'lrt-ftog-chev'));
    let open = true;
    try { open = localStorage.getItem(PANEL_OPEN_KEY) !== '0'; } catch (_) {}

    const ftogText = () => setText(ftog.querySelector('.lrt-ftog-t'), open ? 'Filters' : 'Show filters');
    bar.classList.toggle('is-collapsed', !open);
    ftog.setAttribute('aria-expanded', String(open));
    ftogText();
    ftog.addEventListener('click', () => {
      open = !open;
      ftogText();
      bar.classList.toggle('is-collapsed', !open);
      ftog.setAttribute('aria-expanded', String(open));
      try { localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0'); } catch (_) {}
      if (open) requestAnimationFrame(() => revealPressed(bar));
    });

    const fpills = make('div', 'lrt-fpills');
    fpills.addEventListener('click', e => {
      const b = e.target.closest('button[data-f]');
      if (!b) return;
      stop(e);
      clearOneFilter(b.dataset.f);
    });

    const sec = (title, cls) => {
      const s = make('div', 'lrt-sec ' + (cls || ''));
      s.appendChild(make('div', 'lrt-sec-t', title));
      return s;
    };

    const forums = make('div', 'lrt-forums');
    forums.hidden = true;
    forums.addEventListener('click', e => {
      const b = e.target.closest('button[data-lrt-fid]');
      if (!b) return;
      const k = b.getAttribute('data-lrt-fid');
      forumFilter = k === 'all' || forumFilter === k ? 'all' : k;
      try { sessionStorage.setItem(FORUM_FILTER_KEY, forumFilter); } catch (_) {}
      refresh();
    });
    const forumSec = sec('Forum', 'lrt-sec-forum');
    forumSec.appendChild(forums);

    const rules = make('div', 'lrt-rules');
    for (const r of [{ slug: 'all', label: 'All rules' }, ...RULE_FILTERS]) {
      const b = button('lrt-rchip');
      b.setAttribute('data-lrt-rid', r.slug);
      b.setAttribute('aria-pressed', 'false');
      b.append(make('span', '', r.label), make('span', 'lrt-rchip-n'));
      b.addEventListener('click', () => {
        ruleFilter = r.slug === 'all' || ruleFilter === r.slug ? 'all' : r.slug;
        refresh();
        if (ruleFilter !== 'all') loadAllReasons();
      });
      rules.appendChild(b);
    }
    const ruleSec = sec('Rule', 'lrt-sec-rule');
    ruleSec.append(rules, make('div', 'lrt-rule-status'));

    const alts = make('div', 'lrt-altrow');
    const altChips = make('div', 'lrt-altchips');
    for (const a of VERDICT_TILES) {
      const b = button('lrt-achip');
      b.setAttribute('data-lrt-aid', a.slug);
      b.setAttribute('aria-pressed', 'false');
      const tx = make('span', 'lrt-at');
      tx.append(make('strong', '', a.label), make('small', '', a.hint));
      b.append(make('i', 'lrt-ai', a.icon), tx, make('span', 'lrt-rchip-n'));
      b.addEventListener('click', () => {
        altFilter = a.slug === 'all' || altFilter === a.slug ? 'all' : a.slug;
        try { sessionStorage.setItem(ALT_FILTER_KEY, altFilter); } catch (_) {}
        refresh();
      });
      altChips.appendChild(b);
    }
    const subRow = (cls, list, attr, chipCls, get, set, key) => {
      const row = make('div', cls);
      for (const f of [{ slug: 'all', label: 'All' }, ...list]) {
        const b = button('lrt-rchip ' + chipCls);
        b.setAttribute(attr, f.slug);
        b.setAttribute('aria-pressed', 'false');
        if (f.rare) b.setAttribute('data-rare', '');
        b.append(make('span', '', f.label), make('span', 'lrt-rchip-n'));
        b.addEventListener('click', () => {
          set(f.slug === 'all' || get() === f.slug ? 'all' : f.slug);
          try { localStorage.setItem(key, get()); } catch (_) {}
          refresh();
        });
        row.appendChild(b);
      }
      return row;
    };
    const mtChips = subRow('lrt-mtchips', MT_FILTERS, 'data-lrt-mid', 'lrt-mchip',
      () => mtFilter, v => { mtFilter = v; }, MT_FILTER_KEY);
    const repChips = subRow('lrt-repchips', REP_FILTERS, 'data-lrt-pid', 'lrt-pchip',
      () => repFilter, v => { repFilter = v; }, REP_FILTER_KEY);
    const verdictSec = sec('Verdict', 'lrt-sec-verdict');
    verdictSec.appendChild(altChips);
    const mtSec = sec('Found by');
    mtSec.appendChild(mtChips);
    const repSec = sec('Account');
    repSec.title = 'Status of the reported account itself';
    repSec.appendChild(repChips);

    const bulk = make('div', 'lrt-altbulk');
    bulk.hidden = true;
    bulk.setAttribute('data-kind', 'rejected');
    const bulkRow = make('div', 'lrt-altbulk-row');
    const bulkBan = button('lrt-b lrt-banall', 'Perma-ban all (foid) + resolve');
    bulkBan.dataset.bulk = 'ban';
    const bulkRej = button('lrt-b lrt-rej', 'Reject all');
    bulkRej.dataset.bulk = 'rejected';
    const bulkOk = button('lrt-b lrt-ok', 'Resolve all');
    bulkOk.dataset.bulk = 'resolved';
    bulkRow.append(bulkRej, bulkOk);
    bulk.append(make('div', 'lrt-altbulk-text'), make('div', 'lrt-altbulk-warn'), bulkBan, bulkRow);
    bulk.addEventListener('click', e => {
      const b = e.target.closest('button[data-bulk]');
      if (!b || b.disabled || sending) return;
      stop(e);
      markAllHarmless(b.dataset.bulk);
    });
    const prog = make('div', 'lrt-alt-progress');
    prog.hidden = true;
    prog.appendChild(make('i'));

    alts.append(verdictSec, make('div', 'lrt-ahint'), mtSec, repSec, prog, make('div', 'lrt-alt-status'), bulk);

    fb.append(make('div', 'lrt-closed-note'), forumSec, ruleSec, alts);

    const sum = make('div', 'lrt-sum');
    const reset = button('lrt-reset', 'Reset filters');
    reset.addEventListener('click', resetFilters);
    sum.append(make('span', 'lrt-sum-t'), reset);

    bar.append(hd, chips, search, ftog, fpills, fb, sum, make('div', 'lrc-empty'));
    firstList.parentNode.insertBefore(bar, firstList);
    trStatusSoon();
  }

  function readFilter() {
    try { return localStorage.getItem(FILTER_KEY) || 'all'; } catch (_) { return 'all'; }
  }

  function countTo(el, to) {
    if (!el) return;
    const n = Number(to);
    const from = Number(el.dataset.v);
    if (!Number.isFinite(n) || !Number.isFinite(from) || from === n ||
        (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      el.dataset.v = Number.isFinite(n) ? String(n) : '';
      setText(el, to);
      return;
    }
    el.dataset.v = String(n);
    const t0 = performance.now(), dur = 420;
    const step = t => {
      if (el.dataset.v !== String(n)) return;
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(from + (n - from) * e));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function moveTabPill(bar) {
    const row = bar.querySelector('.lrc-chips');
    const ind = row && row.querySelector('.lrc-ind');
    const on = row && row.querySelector('.lrc-chip[aria-pressed="true"]:not([hidden])');
    if (!ind) return;
    if (!on) { ind.style.opacity = '0'; return; }
    const x = on.offsetLeft, w = on.offsetWidth;
    const sig = x + '|' + w;
    if (ind.dataset.sig === sig) return;
    const first = !ind.dataset.sig;
    ind.dataset.sig = sig;
    if (first) ind.style.transition = 'none';
    ind.style.opacity = '1';
    ind.style.width = w + 'px';
    ind.style.transform = 'translateX(' + x + 'px)';
    if (first) { void ind.offsetWidth; ind.style.transition = ''; }
  }

  function updateKpis(bar, open, checking) {
    const o = todayLoad();
    const rate = todayRate(o);
    const set = (k, v) => {
      const el = bar.querySelector('.lrt-kpi[data-k="' + k + '"] b');
      if (typeof v === 'number') countTo(el, v); else { if (el) el.dataset.v = ''; setText(el, v); }
    };
    set('open', open);
    set('today', o.n);
    set('rate', rate ? Math.round(rate) : '–');
    moveTabPill(bar);
    set('eta', rate && open ? fmtMin(open / rate * 60).replace(' min', 'm').replace(' h ', 'h ') : open ? '–' : '0');

    const sub = checking ? open + ' open · checking alts, ' + checking + ' left'
      : !open ? 'All caught up — nothing open'
      : open + ' open';
    setText(bar.querySelector('.lrt-hd-sub'), sub);
  }

  function applyFilters() {
    if (!CAT[catFilter]) catFilter = 'all';
    if (!ALT_FILTERS.some(a => a.slug === altFilter)) altFilter = 'all';
    if (!REP_FILTERS.some(a => a.slug === repFilter)) repFilter = 'all';
    if (!MT_FILTERS.some(a => a.slug === mtFilter)) mtFilter = 'all';
    const multi = catFilter === 'multi';
    setAttr(de, 'data-lrc-filter', catFilter);
    setAttr(de, 'data-lrt-rep-filter', multi ? repFilter : 'all');
    setAttr(de, 'data-lrt-mt-filter', multi ? mtFilter : 'all');

    setAttr(de, 'data-lrt-rule-filter', multi ? 'all' : ruleFilter);
    setAttr(de, 'data-lrt-alt-filter', multi ? altFilter : 'all');
    const forumOn = !multi && forumFilter !== 'all';
    setAttr(de, 'data-lrt-forum-filter', forumOn ? 'on' : 'all');
    setForumStyle(forumOn ? forumFilter : '');
    if (multi) startAltScan();
  }

  function setForumStyle(key) {
    let st = document.getElementById('lrt-forum-style');
    if (!st) { st = make('style'); st.id = 'lrt-forum-style'; (document.head || de).appendChild(st); }
    const css = key ? 'html[data-lrt-forum-filter="on"] [data-lrt-id]:not([data-lrt-forum="' +
      key.replace(/["\\]/g, '\\$&') + '"]){display:none !important}' : '';
    if (st.textContent !== css) st.textContent = css;
  }

  function updateCounts() {
    const left = {}, total = {}, perRule = {}, perForum = {}, fLeft = {}, fTotal = {};
    const ruleAny = {};
    let pending = 0, open = 0, shown = 0, checking = 0, markedShown = 0;
    for (const it of reports.values()) {
      if (it.sent || !it.box.isConnected) continue;
      total[it.cat] = (total[it.cat] || 0) + 1;
      const fk = it.cat + '|' + (it.box.getAttribute('data-lrt-forum') || '');
      fTotal[fk] = (fTotal[fk] || 0) + 1;
      if (it.cat !== 'multi' && (catFilter === 'all' || it.cat === catFilter)) ruleAny[it.slug] = 1;
      if (marks[it.id]) { if (passes(it)) markedShown++; continue; }
      open++;
      if (it.cat === 'multi' && it.box.getAttribute('data-lrt-alt') === 'checking') checking++;
      if (passes(it)) shown++;
      if (!matchesQ(it)) continue;
      left[it.cat] = (left[it.cat] || 0) + 1;
      left.all = (left.all || 0) + 1;
      fLeft[fk] = (fLeft[fk] || 0) + 1;
      if (it.cat !== 'multi' && (catFilter === 'all' || it.cat === catFilter)) {
        const k = it.box.getAttribute('data-lrt-forum');
        if (k && k !== NO_FORUM && k !== FORUM_LOADING) perForum[k] = (perForum[k] || 0) + 1;
      }
      if (catFilter !== 'all' && it.cat !== catFilter) continue;
      if (it.slug === 'pending') pending++;
      else perRule[it.slug] = (perRule[it.slug] || 0) + 1;
    }

    const bar = ownBar();
    if (bar) {
      for (const chip of bar.querySelectorAll('.lrc-chip')) {
        const id = chip.getAttribute('data-lrc-id');
        const n = left[id] || 0;
        countTo(chip.querySelector('.lrc-chip-n'), n);
        chip.classList.toggle('is-zero', !n);
        setAttr(chip, 'aria-pressed', id === catFilter);
        chip.hidden = (id === 'other' || id === 'profile') && !total[id] && id !== catFilter;
      }
      const ruleAll = Object.values(perRule).reduce((x, y) => x + y, 0);
      for (const chip of bar.querySelectorAll('.lrt-rules .lrt-rchip')) {
        const slug = chip.getAttribute('data-lrt-rid');
        const n = slug === 'all' ? ruleAll : perRule[slug] || 0;
        setText(chip.querySelector('.lrt-rchip-n'), n);
        chip.classList.toggle('is-zero', !n);
        setAttr(chip, 'aria-pressed', slug === ruleFilter);

        if (chip.hidden) chip.hidden = false;
        void ruleAny;
      }
      const empty = catFilter !== 'all' && !left[catFilter] && !searchQ;
      bar.classList.toggle('is-empty', empty);
      setText(bar.querySelector('.lrc-empty'), empty ? 'Nothing left to review in “' + CAT[catFilter].label + '”.' : '');

      const nf = activeFilters();
      const sumEl = bar.querySelector('.lrt-sum');
      bar.classList.toggle('has-filters', nf > 0);
      setText(sumEl.querySelector('.lrt-sum-t'), !nf ? '' : shown ? shown + ' of ' + open + ' open ' + (shown === 1 ? 'report matches' : 'reports match')
        : markedShown ? 'All ' + markedShown + ' here are marked — send them with the button below'
        : 'No open report matches' + (searchQ ? ' “' + searchQ + '”' : ' these filters'));
      sumEl.classList.toggle('is-none', !!nf && !shown && !markedShown);
      setText(bar.querySelector('.lrt-ftog-n'), nf ? String(nf) : '');
      updateFilterPills(bar);
      bar.setAttribute('data-cat', catFilter);
      updateKpis(bar, open, checking);
      updateForumChips(bar, perForum);
      let status = '';
      if (ruleFilter !== 'all' && catFilter !== 'multi') {
        if (pending) status = 'Checking reasons… ' + pending + ' left';
        else if (!perRule[ruleFilter]) status = 'No reports with this rule.';
      }
      if (!status && forumFilter !== 'all' && catFilter !== 'multi' && !perForum[forumFilter]) {
        status = 'Nothing left from “' + forumShort(forumFilter) + '”.';
      }
      setText(bar.querySelector('.lrt-rule-status'), status);
      if (openNow !== open) { openNow = open; if (dockMode === 'summary') renderDock(); }
      LMS.status('reports', { open, ready: Object.keys(marks).length, checking });
      const nClosed = hiddenClosed.size;
      setText(bar.querySelector('.lrt-closed-note'), nClosed ? nClosed + (nClosed === 1 ? ' closed report' : ' closed reports') + ' left out' : '');
      updateAltCounts(bar);
      revealPressed(bar);
    }

    for (const head of document.querySelectorAll('.lrc-head')) {
      const id = head.getAttribute('data-lrc-cat');
      const k = head.classList.contains('lrt-fhead') ? id + '|' + head.getAttribute('data-lrt-fkey') : '';
      setText(head.querySelector('.lrc-head-n'), ((k ? fLeft[k] : left[id]) || 0) + ' left');
      head.classList.toggle('lrc-gone', !(k ? fTotal[k] : total[id]));
    }
  }

  function revealPressed(bar) {
    for (const row of bar.querySelectorAll('.lrt-rules, .lrt-mtchips, .lrt-repchips, .lrt-forums, .lrt-altchips')) {
      const on = row.querySelector('[aria-pressed="true"]:not([hidden])');
      const key = on ? on.textContent.replace(/\d+$/, '') : '';
      if (row.dataset.on === key || !row.clientWidth) continue;
      row.dataset.on = key;
      if (!on) continue;
      const rr = row.getBoundingClientRect(), cr = on.getBoundingClientRect();
      if (cr.left < rr.left || cr.right > rr.right - 24) {
        const x = row.scrollLeft + cr.left - rr.left - 8;
        try { row.scrollTo({ left: x, behavior: reduceMotion() ? 'auto' : 'smooth' }); } catch (_) { row.scrollLeft = x; }
      }
    }
  }

  function updateFilterPills(bar) {
    const row = bar.querySelector('.lrt-fpills');
    if (!row) return;
    const list = activeFilterPills();
    const sig = list.map(p => p.join('=')).join('|');
    if (row.getAttribute('data-k') === sig) return;
    row.setAttribute('data-k', sig);
    row.replaceChildren(...list.map(([f, label]) => {
      const b = button('lrt-fpill');
      b.dataset.f = f;
      b.setAttribute('aria-label', 'Remove filter ' + label);
      b.append(make('span', '', label), make('i', '', '×'));
      return b;
    }));
  }

  function updateForumChips(bar, perForum) {
    const row = bar.querySelector('.lrt-forums');
    const keys = Object.keys(perForum);
    if (forumFilter !== 'all' && !keys.includes(forumFilter)) keys.push(forumFilter);
    keys.sort(compareForums);
    const sig = keys.join('|');
    if (row.getAttribute('data-k') !== sig) {
      row.setAttribute('data-k', sig);
      const allB = button('lrt-rchip lrt-fchip');
      allB.setAttribute('data-lrt-fid', 'all');
      allB.append(make('span', '', 'All forums'), make('span', 'lrt-rchip-n'));
      row.replaceChildren(allB, ...keys.map(k => {
        const b = button('lrt-rchip lrt-fchip');
        b.setAttribute('data-lrt-fid', k);
        b.append(make('span', '', forumShort(k)), make('span', 'lrt-rchip-n'));
        return b;
      }));
    }
    const fAll = Object.values(perForum).reduce((x, y) => x + y, 0);
    for (const b of row.querySelectorAll('.lrt-fchip')) {
      const k = b.getAttribute('data-lrt-fid');
      const n = k === 'all' ? fAll : perForum[k] || 0;
      setText(b.querySelector('.lrt-rchip-n'), n);
      b.classList.toggle('is-zero', !n);
      setAttr(b, 'aria-pressed', k === forumFilter);
    }
    const hide = !keys.length || catFilter === 'multi';
    if (row.hidden !== hide) row.hidden = hide;
    if (row.parentElement && row.parentElement.hidden !== hide) row.parentElement.hidden = hide;
  }

  function updateAltCounts(bar) {
    const perAlt = {}, perRep = {}, perMt = {};
    const anyAlt = {}, anyRep = {}, anyMt = {};
    let checking = 0, bulkN = 0, failed = 0, done = 0, shown = 0, risky = 0;
    const kind = bulkKind();
    for (const it of reports.values()) {
      if (it.cat !== 'multi' || it.sent || !it.box.isConnected) continue;
      const st = it.box.getAttribute('data-lrt-alt');
      if (st !== 'checking') {
        anyAlt[st] = 1;
        anyRep[it.box.getAttribute('data-lrt-rep')] = 1;
        anyMt[it.box.getAttribute('data-lrt-mt')] = 1;
      }
      if (bulkable(it, kind)) {
        bulkN++;
        if (['banned', 'active', 'pending'].includes(it.alt.status) &&
            !['rejected', 'banned'].includes(repKeyOf(it.alt))) risky++;
      }
      if (marks[it.id]) continue;
      if (it.altFailed && !it.alt) failed++;
      if (st === 'checking') { checking++; continue; }
      if (!matchesQ(it)) continue;
      done++;
      const rp = it.box.getAttribute('data-lrt-rep'), mt = it.box.getAttribute('data-lrt-mt');
      const okAlt = altFilter === 'all' || st === altFilter;
      const okRep = repFilter === 'all' || rp === repFilter;
      const okMt = mtFilter === 'all' || mt === mtFilter;
      if (okRep && okMt) perAlt[st] = (perAlt[st] || 0) + 1;
      if (okAlt && okMt) perRep[rp] = (perRep[rp] || 0) + 1;
      if (okAlt && okRep) perMt[mt] = (perMt[mt] || 0) + 1;
      if (okAlt && okRep && okMt) shown++;
    }
    const chipRow = (sel, attr, per, cur, any) => {
      const all = Object.values(per).reduce((x, y) => x + y, 0);
      for (const chip of bar.querySelectorAll(sel)) {
        const slug = chip.getAttribute(attr);
        const n = slug === 'all' ? all : per[slug] || 0;
        setText(chip.querySelector('.lrt-rchip-n'), n);
        chip.classList.toggle('is-zero', !n);
        setAttr(chip, 'aria-pressed', slug === cur);

        const hide = slug !== 'all' && slug !== cur && !n && chip.hasAttribute('data-rare') && !any[slug];
        if (chip.hidden !== hide) chip.hidden = hide;
      }
    };
    chipRow('.lrt-achip', 'data-lrt-aid', perAlt, altFilter, anyAlt);
    chipRow('.lrt-pchip', 'data-lrt-pid', perRep, repFilter, anyRep);
    chipRow('.lrt-mchip', 'data-lrt-mid', perMt, mtFilter, anyMt);
    {
      const t = altFilter !== 'all' && VERDICT_TILES.find(x => x.slug === altFilter);
      setText(bar.querySelector('.lrt-ahint'), t ? t.label + ' · ' + t.hint : '');
    }
    let stale = 0;
    for (const it of reports.values()) if (it.cat === 'multi' && it.altStale && !it.sent && !marks[it.id]) stale++;
    const parts = [];
    const slow = altPauseUntil > Date.now() ? ', the forum is slow, short pause' : '';
    if (altStarted && checking) parts.push('Checking alts: ' + checking + ' left' + slow);
    else if (altStarted && stale) parts.push('Refreshing ' + stale + ' older results' + slow);
    if (failed) parts.push(failed + ' couldn\'t be loaded (under Unclear)');
    if (filtersOn() && !shown && !checking) parts.push('No reports match these filters.');
    setText(bar.querySelector('.lrt-alt-status'), parts.join('. '));
    const fill = bar.querySelector('.lrt-alt-progress i');
    const prog = bar.querySelector('.lrt-alt-progress');
    prog.hidden = !(altStarted && checking);
    if (!prog.hidden) fill.style.width = Math.round(100 * done / (done + checking)) + '%';

    const bulk = bar.querySelector('.lrt-altbulk');
    setAttr(bulk, 'data-kind', kind);

    const hide = !bulkN || sending;
    if (bulk.hidden !== hide) bulk.hidden = hide;
    if (!hide) {
      const text = bulk.querySelector('.lrt-altbulk-text');
      const key = [kind, repFilter, mtFilter, bulkN, risky, checking ? '+' : ''].join('|');
      bulk.querySelector('[data-bulk="ban"]').hidden = kind !== 'foid';
      if (text.getAttribute('data-k') !== key) {
        text.setAttribute('data-k', key);
        text.replaceChildren(
          make('strong', '', bulkText(kind, bulkN)),
          make('small', '', checking ? 'More may show up while the check runs. You confirm before anything is sent.'
                                     : 'Marks them all in one tap. You confirm before anything is sent.'));
        setText(bulk.querySelector('.lrt-altbulk-warn'), risky
          ? 'Careful: ' + risky + (risky === 1 ? ' of them still has' : ' of them still have') +
            ' a banned, active or waiting alt, and the reported account isn\'t rejected or banned.'
          : '');
        setText(bulk.querySelector('[data-bulk="rejected"]'), 'Reject all ' + bulkN);
        const nBan = [...reports.values()].filter(it => bulkable(it, 'foid') && banTarget(it)).length;
        setText(bulk.querySelector('[data-bulk="ban"]'), 'Perma-ban all ' + nBan + ' (foid) + resolve');
        setText(bulk.querySelector('[data-bulk="resolved"]'), 'Resolve all ' + bulkN);
      }
    }
  }

  let bgTimer = 0;
  function renderLater() {
    if (!bgTimer) bgTimer = setTimeout(() => { bgTimer = 0; renderSoon(); }, 350);
  }

  let countsQueued = false;
  function renderSoon() {
    if (countsQueued) return;
    countsQueued = true;
    requestAnimationFrame(() => {
      countsQueued = false;
      calm(ownBar(), 'counts', updateCounts);
    });
  }

  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const it = byPreview.get(e.target);
      if (it) want(it);
    }
    pump();
  }, { rootMargin: '600px 0px 1600px 0px' });

  function want(it) {
    if (it.queued || it.sent) return;
    it.queued = true;
    queue.add(it);
  }

  function nextInLine() {
    const vt = viewTop(), vh = innerHeight;
    let best = null, bestD = Infinity;
    for (const it of queue) {
      const r = it.card.getBoundingClientRect();
      const d = !r.height ? 1e9
        : r.bottom <= vt ? (vt - r.bottom) * 2
        : r.top >= vh ? r.top - vh
        : r.top - 1e6;
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  function pump() {
    while (loading < PARALLEL && queue.size) {
      const it = nextInLine();
      queue.delete(it);
      loading++;
      loadPreview(it).catch(log).finally(() => { loading--; pump(); });
    }
  }

  function loadAllReasons() {
    for (const it of reports.values()) {
      if (it.sent || it.queued || it.cat === 'multi') continue;
      io.unobserve(it.pv);
      want(it);
    }
    pump();
  }

  function setRule(it, label, onPage) {
    it.rule = label || '';
    it.slug = slugOf(label);
    if (onPage) it.box.setAttribute('data-lrt-rule', it.slug);
  }

  async function loadPreview(it) {
    if (it.sent) return;
    let doc;
    try {
      doc = await fetchDoc(it.url);
    } catch (e) {
      it.loadFailed = true;
      it.altErr = e.message;
      if (it.cat !== 'multi') setRule(it, '');
      else if (altStarted && (!it.alt || it.altStale)) { enqueueAlt(it); pumpAlt(); }
      else if (!it.alt) altFailedAt(it);
      calm(it.card, 'fill' + it.id, () => showLoadError(it, e.message));
      renderSoon();
      return;
    }
    if (it.sent) return;

    if (isClosed(doc)) { dropClosed(it); return; }

    const form = findForm(doc);
    it.canAct = !!form;
    if (it.cat === 'multi') {
      resolveAlt(it, doc).catch(log);

      const entries = reasonEntries(doc);
      const main = doc.querySelector('.p-body-pageContent') || doc.body;
      it.raw = (entries.length ? entries.map(e => e.outerHTML).join('\n') : (main ? main.innerHTML : '')).slice(0, 40000);
    }
    if (it.cat !== 'multi') {
      setForum(it, forumOf(doc));
      forumCache[it.id] = { f: it.forum, t: Date.now() };
      saveForumsSoon();

      try { it.content = contentOf(doc); } catch (e) { log(e); it.content = null; }
    }
    const posts = pairOf(doc, 'posts');
    const reasons = extractReasons(doc);
    setRule(it, detectRule(it, reasons.map(r => r.querySelector('.lrt-reason-text').textContent).join(' ')));

    if (it.cat !== 'multi') {
      const main = doc.querySelector('.p-body-pageContent') || doc.querySelector('.p-body-main') || doc.body;
      clean(main, form);
      it.fullSrc = main.innerHTML;
    }

    calm(it.card, 'fill' + it.id, () => fillCard(it, reasons, posts));
    renderSoon();
  }

  function closeLocally(it) {
    if (it.sent) return;
    it.sent = true;
    queue.delete(it);
    if (marks[it.id]) { delete marks[it.id]; saveMarks(); }
    if (altCache[it.id]) { delete altCache[it.id]; saveAltsSoon(); }
    const hide = () => { it.box.classList.add('lrt-hidden'); it.card.classList.remove('is-leaving'); clearMark(it); };
    const r = it.card.getBoundingClientRect();
    const seen = r.height && r.bottom > viewTop() && r.top < innerHeight;
    if (seen && !reduceMotion()) {
      it.card.classList.add('is-leaving');
      setTimeout(() => calm(it.box, 'hide' + it.id, hide), 200);
    } else {
      calm(it.box, 'hide' + it.id, hide);
    }
  }

  function reasonEntries(doc) {
    const scope = doc.querySelector('.p-body-pageContent') || doc.body;
    if (!scope) return [];
    const skip = el => el.matches('form') || el.querySelector('form, textarea, input[name="report_state"]');

    let entries = [];
    const head = [...scope.querySelectorAll('.block-header, .block-minorHeader, h2, h3')]
      .find(h => /^\s*comments?\s*$/i.test(h.textContent));
    if (head) {
      const box = head.closest('.block-container') || head.parentElement;
      const list = box.querySelector('.block-body') || box;
      entries = [...list.children].filter(el => el !== head && !el.contains(head) && !skip(el) && el.textContent.trim());
    }

    if (!entries.length) {
      entries = [...scope.querySelectorAll('[id^="report-comment-"], article.message--simple')].filter(el => !skip(el));
    }
    return entries;
  }

  function extractReasons(doc) {
    const entries = reasonEntries(doc);
    const out = [];
    for (const entry of entries) {
      const who = entry.querySelector('.username, .message-name, .contentRow-header');
      const when = entry.querySelector('time');

      const clone = entry.cloneNode(true);
      const whoClone = clone.querySelector('.username, .message-name, .contentRow-header');
      if (whoClone) whoClone.remove();
      clone.querySelectorAll('.avatar, .contentRow-figure, .message-cell--user, .message-avatar, .message-userDetails, ' +
        '.message-userExtras, .message-attribution, .contentRow-extra, .message-footer, .reactionsBar, .actionBar, ' +
        'time, script, noscript').forEach(n => n.remove());
      if (!clone.textContent.trim()) continue;

      const card = make('div', 'lrt-reason');
      const text = make('div', 'lrt-reason-text');
      for (const n of [...clone.childNodes]) text.appendChild(document.importNode(n, true));
      const meta = make('div', 'lrt-reason-meta');
      const by = make('span');
      by.append('Reported by ', make('strong', '', who ? who.textContent.trim() : 'unknown user'));
      meta.appendChild(by);
      if (when) meta.appendChild(make('span', '', when.textContent.trim()));
      card.append(text, meta);
      out.push(card);
    }
    return out;
  }

  function readableText(el) {
    const d = el.ownerDocument;
    const c = el.cloneNode(true);
    c.querySelectorAll('script, style, noscript, .bbCodeBlock-expandLink, .bbCodeBlock-shrinkLink').forEach(n => n.remove());
    c.querySelectorAll('.bbMediaWrapper, .bbMediaJustifier, iframe, video').forEach(n => n.replaceWith(d.createTextNode(' [video] ')));
    c.querySelectorAll('img').forEach(n => n.replaceWith(d.createTextNode(
      n.classList.contains('smilie') || /^:.{1,12}:?$/.test(n.getAttribute('alt') || '') ? (n.getAttribute('alt') || '') : ' [image] ')));
    c.querySelectorAll('.bbCodeBlock--quote').forEach(q => {
      const who = q.querySelector('.bbCodeBlock-title');
      const body = q.querySelector('.bbCodeBlock-content') || q;
      const name = who ? norm(who.textContent).replace(/\s*said:?\s*(click to expand\.*)?$/i, '') : '';
      q.replaceWith(d.createTextNode('\n> ' + (name ? name + ': ' : '') + flatText(body).slice(0, 300) + '\n'));
    });
    c.querySelectorAll('br').forEach(b => b.replaceWith(d.createTextNode('\n')));
    c.querySelectorAll('p, div, li, h1, h2, h3, h4, tr, blockquote').forEach(b => b.appendChild(d.createTextNode('\n')));
    return (c.textContent || '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function contentOf(doc) {
    const scope = doc.querySelector('.p-body-pageContent') || doc.body;
    if (!scope) return null;
    const entries = reasonEntries(doc);
    const bb = [...scope.querySelectorAll('.bbWrapper')].find(el =>
      !entries.some(e => e.contains(el)) && !el.closest('form, .fr-box, .p-breadcrumbs, .p-title') && el.textContent.trim());
    if (!bb) return null;
    const text = readableText(bb);
    return text ? { text: text.slice(0, 6000) } : null;
  }
  function buildContent(it) {
    const box = make('div', 'lrt-content');
    box.appendChild(make('div', 'lrt-label', it.cat === 'convo' ? 'Reported message' : it.cat === 'post' ? 'Reported post'
      : it.cat === 'profile' ? 'Reported profile post' : 'Reported content'));
    box.appendChild(make('div', 'lrt-ctext', it.content.text));
    const t = it.content.text;
    if (t.length > 420 || (t.match(/\n/g) || []).length > 6) {
      box.classList.add('is-clamped');
      const more = button('lrt-tool lrt-more', 'Show all');
      more.addEventListener('click', e => {
        stop(e);
        const open = !box.classList.toggle('is-clamped');
        setText(more, open ? 'Show less' : 'Show all');
        more.classList.toggle('is-on', open);
      });
      box.appendChild(more);
    }
    it.contentBox = box;
    return box;
  }

  const trByEl = new WeakMap();
  const trIO = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      trIO.unobserve(e.target);
      const it = trByEl.get(e.target);
      if (it) translateCard(it, false);
    }
  }, { rootMargin: '200px 0px 900px 0px' });
  const isLangForum = it => LANG_FORUMS.has(it.box.getAttribute('data-lrt-forum') || '') || LANG_FORUM_RE.test(it.forum || '');
  function trJobs(it, force) {
    const jobs = [];
    if (it.content && it.content.text && it.contentBox) jobs.push({ host: it.contentBox, text: it.content.text.slice(0, 2500), main: true });
    for (const r of it.body.querySelectorAll('.lrt-reason')) {
      const el = r.querySelector('.lrt-reason-text');
      const t = el ? flatText(el) : '';
      if (t) jobs.push({ host: r, text: t.slice(0, 1200), main: false });
    }
    if (force) return jobs;
    const lang = isLangForum(it);
    const tgt = LM_TR.target() === 'EN' ? 'en' : 'de';
    return jobs.filter(j => {
      const g = LM_TR.guess(j.text);

      const clearlyEnglish = !g.foreign && g.words >= 6 && g.en / g.words >= 0.15;
      if (clearlyEnglish || (g.foreign && g.lang === tgt)) return false;
      return (lang && j.main) || g.foreign;
    });
  }
  function trWant(it) {
    if (it.cat === 'multi' || it.sent || LM_TR.target() === 'OFF' || !trJobs(it, false).length) return;
    trByEl.set(it.card, it);
    trIO.observe(it.card);
  }
  function clearTr(it) {
    it.card.querySelectorAll('.lrt-tr, .lrt-slang, .lrt-trnote').forEach(n => n.remove());
    it.trDone = false;
  }
  function trNoteNow(it, text, kind) {
    it.card.querySelectorAll('.lrt-trnote').forEach(n => n.remove());
    if (!text) return;
    const n = make('div', 'lrt-trnote', text);
    if (kind) n.setAttribute('data-k', kind);
    const host = it.contentBox || it.body;
    host.appendChild(n);
  }
  function trBox(r, tgt, small) {
    const b = make('div', 'lrt-tr' + (small ? ' lrt-tr--sm' : ''));
    const h = make('div', 'lrt-tr-h');
    h.append(make('span', 'lrt-tr-flag', (r.src || '?') + ' → ' + tgt),
      make('span', 'lrt-tr-from', LM_TR.langName(r.src) + ' · ' + r.via));
    b.append(h, make('div', 'lrt-tr-text', r.text));
    return b;
  }
  async function translateCard(it, force) {
    if (it.sent || it.trBusy || !it.card.isConnected) return;
    if (!force) return;
    const tgt = 'EN';
    const jobs = trJobs(it, force);
    if (!jobs.length) {
      if (force) calm(it.card, 'trn' + it.id, () => trNoteNow(it, 'Nothing to translate here.'));
      return;
    }
    it.trBusy = true;
    if (it.trBtn) setText(it.trBtn, 'Translating …');
    calm(it.card, 'trn' + it.id, () => trNoteNow(it, 'Translating …', 'run'));
    let res;
    try { res = await LM_TR.translate(jobs.map(j => j.text), tgt); }
    catch (e) { log(e); res = jobs.map(() => null); }
    it.trBusy = false;
    if (it.sent) return;
    calm(it.card, 'tr' + it.id, () => {
      clearTr(it);
      let shown = 0, failed = 0, same = 0;
      jobs.forEach((j, i) => {
        const r = res[i];
        if (!r) { failed++; return; }

        if (!r.text || r.src === tgt || (!force && r.src === 'EN')) { same++; return; }
        const anchor = j.main ? j.host.querySelector('.lrt-ctext') : j.host.querySelector('.lrt-reason-text');
        if (!anchor) return;
        anchor.after(trBox(r, tgt, !j.main));
        shown++;
      });
      const sl = shown ? LM_TR.slang(...jobs.map(j => j.text)) : [];
      if (sl.length) {
        const box = make('div', 'lrt-slang');
        box.appendChild(make('span', 'lrt-slang-t', 'Forum slang in it'));
        for (const s of sl) {
          const line = make('span');
          line.append(make('b', '', s.w), ' — ' + s.m);
          box.appendChild(line);
        }
        const host = it.contentBox || it.body.querySelector('.lrt-reason') || it.body;
        const more = host.querySelector(':scope > .lrt-more');
        if (more) more.before(box); else host.appendChild(box);
      }
      trNoteNow(it, failed && !shown ? 'Translation failed — tap “Translate” to try again.'
        : force && !shown && same ? 'Already English — nothing to translate.' : '',
        failed && !shown ? 'err' : '');
      it.trDone = shown > 0;
      if (it.trBtn) {
        setText(it.trBtn, shown ? 'Hide translation' : 'Translate');
        it.trBtn.classList.toggle('is-on', shown > 0);
      }
      trStatusSoon();
    });
  }
  function trButton(it) {
    const b = button('lrt-tool lrt-trbtn', 'Translate');
    b.addEventListener('click', e => {
      stop(e);
      if (it.trBusy) return;
      if (it.trDone) {
        calm(it.card, 'tr' + it.id, () => { clearTr(it); setText(b, 'Translate'); b.classList.remove('is-on'); });
      } else translateCard(it, true);
    });
    it.trBtn = b;
    return b;
  }

  let trStatusTimer = 0;
  function trStatusSoon() {
    if (trStatusTimer) return;
    trStatusTimer = setTimeout(async () => {
      trStatusTimer = 0;
      const el = document.querySelector('.lrt-trrow-s');
      if (!el) return;

      setText(el, '');
      el.title = '';
    }, 300);
  }

  function clean(rootEl, form) {
    rootEl.querySelectorAll('script, noscript, .p-breadcrumbs, .p-title, .p-description').forEach(n => n.remove());
    if (form && rootEl.contains(form)) {
      if (form.querySelector('.bbWrapper, article, .message')) {
        form.querySelectorAll('.formSubmitRow').forEach(n => n.remove());
        form.querySelectorAll('.formRow').forEach(n => {
          if (n.querySelector('input:not([type="hidden"]), textarea, select, .fr-box')) n.remove();
        });
      } else {
        form.remove();
      }
    }
    rootEl.querySelectorAll('.fr-box, textarea').forEach(n => n.remove());
  }

  function fillCard(it, reasons, posts) {
    if (it.sent) return;

    const who = it.card.querySelector(':scope > .lrt-who');
    if (who) {
      if (posts) who.appendChild(make('span', 'lrt-fact', posts + (posts.trim() === '1' ? ' post' : ' posts')));
      if (it.forum) {
        const f = make('span', 'lrt-fact lrt-forum', it.forum);
        if (!/off-?topic/i.test(it.forum)) { f.classList.add('is-away'); f.title = 'Not from Offtopic'; }
        who.appendChild(f);
      }
    }

    const full = make('div', 'lrt-full');

    const content = it.cat !== 'multi' && it.content ? [buildContent(it)] : [];
    if (reasons.length) {
      it.body.replaceChildren(...content,
        make('div', 'lrt-label', reasons.length > 1 ? 'Report reasons (' + reasons.length + ')' : 'Report reason'),
        ...reasons);
    } else if (it.cat === 'multi') {
      it.body.replaceChildren(make('div', 'lrt-msg', 'Couldn\'t find the report reason. Use “Open” to see the report.'));
    } else {

      it.body.replaceChildren(...content,
        make('div', 'lrt-label', 'Full report'),
        make('div', 'lrt-msg', 'Couldn\'t find the report reason, showing the full report.'));
      buildFull(it, full);
      full.classList.add('is-open');
    }

    if (it.cat === 'multi' && it.raw) {
      const tools = make('div', 'lrt-tools lrt-rawtools');
      const b = button('lrt-tool lrt-copyraw', 'Copy raw report');
      b.addEventListener('click', e => { stop(e); copyText(it.title + '\n' + it.url + '\n\n' + it.raw, b); });
      tools.appendChild(b);
      it.body.appendChild(tools);
    }

    const parts = [];
    if (it.cat === 'multi') parts.push(detailsButton(it));
    else {

      const tools = reasons.length ? fullButton(it, full) : make('div', 'lrt-tools');
      tools.appendChild(trButton(it));
      parts.push(tools, full);
    }
    it.bar.before(...parts);
    if (it.fullBuilt) activate(full);
    trWant(it);

    it.box.setAttribute('data-lrt-rule', it.slug);
    for (const b of it.bar.querySelectorAll('button')) b.disabled = !it.canAct;
    if (!it.canAct) it.pv.appendChild(make('div', 'lrt-err', 'No status form found. Use “Open” to handle this report.'));
  }

  function showLoadError(it, msg) {
    it.box.setAttribute('data-lrt-rule', it.slug);
    const box = make('div', 'lrt-loaderr');
    box.appendChild(make('div', 'lrt-msg', msg + '.'));
    const retry = button('lrt-tool', 'Try again');
    retry.addEventListener('click', e => {
      stop(e);
      it.body.replaceChildren(skeleton());
      if (it.cat !== 'multi') { it.slug = 'pending'; it.box.setAttribute('data-lrt-rule', 'pending'); }
      else if (!it.alt) { it.altFailed = false; it.altTries = 0; setAltAttrs(it); }
      it.loadFailed = false;
      it.queued = false;
      want(it);
      pump();
      renderSoon();
    });
    box.appendChild(retry);
    it.body.replaceChildren(box);
    if (it.cat === 'multi') setDetails(it, true);
  }

  function fullButton(it, full) {
    const tools = make('div', 'lrt-tools');
    const more = button('lrt-tool', 'Full report');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', e => {
      stop(e);
      const open = !full.classList.contains('is-open');
      const first = open && !it.fullBuilt;
      if (first) buildFull(it, full);
      full.classList.toggle('is-open', open);
      more.classList.toggle('is-on', open);
      more.setAttribute('aria-expanded', String(open));
      setText(more, open ? 'Hide full report' : 'Full report');
      if (first) activate(full);
    });
    tools.appendChild(more);
    return tools;
  }

  function detailsButton(it) {
    const tools = make('div', 'lrt-tools');
    const b = button('lrt-tool lrt-details', 'Report details');
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', e => { stop(e); setDetails(it, !it.card.classList.contains('is-details')); });
    tools.appendChild(b);
    it.detailsBtn = b;
    setDetails(it, it.card.classList.contains('is-details'));
    return tools;
  }

  function setDetails(it, open) {
    it.card.classList.toggle('is-details', open);
    const b = it.detailsBtn;
    if (!b) return;
    setText(b, open ? 'Hide report details' : 'Report details');
    b.setAttribute('aria-expanded', String(open));
    b.classList.toggle('is-on', open);
  }

  function buildFull(it, full) {
    const t = document.createElement('template');
    t.innerHTML = it.fullSrc || '';
    full.replaceChildren(t.content);
    if (!full.textContent.trim() && !full.querySelector('img, video, iframe')) {
      full.appendChild(make('div', 'lrt-msg', 'Nothing more to show for this report.'));
    }
    it.fullSrc = '';
    it.fullBuilt = true;
  }

  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {

      const ta = make('textarea');
      ta.value = text;
      ta.setAttribute('aria-hidden', 'true');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
      document.body.appendChild(ta);
      try { ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand('copy'); } catch (__) {}
      ta.remove();
    }
    const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    clearTimeout(btn.lrtTimer);
    btn.lrtTimer = setTimeout(() => { btn.textContent = label; }, 1600);
  }

  function detectRule(it, reasonText) {
    if (it.cat === 'multi') return 'Alts';
    const t = reasonText || '';
    for (const k of KEYWORD_RULES) if (k.re.test(t)) return k.rule;
    return '';
  }

  const MULTI_RE = /potential multiple account/i;

  const TITLE_USER_RE = /^(.+)\s+has\s+\d+\s+multiple\s+accounts?/i;
  const DELETED_RE = /^(unknown|deleted)\s+(user|member|account)\b/i;
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

  function flatText(el) {
    const parts = [];
    const w = (el.ownerDocument || document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.nodeValue);
    return norm(parts.join(' '));
  }

  function altClass(state) {
    const s = (state || '').toLowerCase();
    if (!s) return 'active';
    if (/delet/.test(s)) return 'deleted';
    if (/\bban|gesperrt/.test(s)) return 'banned';
    if (/reject|abgelehnt/.test(s)) return 'rejected';
    if (/disabl|deactiv|deaktiv/.test(s)) return 'disabled';
    if (/bounce|email invalid/.test(s)) return 'active';
    if (/moderat|await|approv|pending|wartet|email|confirm/.test(s)) return 'pending';
    if (/valid|active|aktiv/.test(s)) return 'active';
    return 'other';
  }

  function altMethods(text) {
    text = LM_SPLIT(text);
    const out = [];
    if (/cookie/i.test(text)) out.push('Cookie');
    if (/\bip\b|ip[\s-]*address/i.test(text)) out.push('IP');
    if (/fingerprint/i.test(text)) out.push('Fingerprint');
    if (/device/i.test(text)) out.push('Device');
    if (/e-?mail/i.test(text)) out.push('Email');
    return out;
  }

  function splitState(text) {
    const m = /^(.*?)\s+\(([^()]{1,40}(?:\([^()]*\))?)\)\s*$/.exec(norm(text));
    return m && m[1] ? [m[1], m[2]] : [norm(text), ''];
  }

  const unclearAlt = () => ({ status: 'other', alts: [], unknown: [], reopened: false });

  function parseAlts(doc, title) {
    if (!doc) return null;
    const entries = reasonEntries(doc);
    const textOf = els => els.map(flatText).join(' ');
    if (entries.length && MULTI_RE.test(textOf(entries))) return readAlts(doc, entries, title);
    const page = doc.body || doc.documentElement;
    if (page && MULTI_RE.test(textOf([page]))) return readAlts(doc, [page], title);
    return null;
  }

  function textBetween(el, next, box) {
    try {
      const r = (box.ownerDocument || document).createRange();
      r.setStartAfter(el);
      if (next) r.setEndBefore(next); else r.setEnd(box, box.childNodes.length);
      return norm(r.toString());
    } catch (_) { return ''; }
  }

  const STRUCK_SEL = 's, del, strike, [class*="banned" i], [style*="line-through"]';
  const struckCache = new Map();
  let probeHost = null;
  function isBannedEl(el) {
    if (!el || !el.querySelectorAll) return false;
    if (el.matches(STRUCK_SEL) || el.querySelector(STRUCK_SEL) || (el.closest && el.closest('s, del, strike'))) return true;
    const parts = [el, ...el.querySelectorAll('*')];
    const key = parts.map(e => e.tagName + '.' + String(e.className || '') + '.' + (e.getAttribute('style') || '')).join('|');
    if (struckCache.has(key)) return struckCache.get(key);
    let struck = false;
    try {
      if (!probeHost || !probeHost.isConnected) {
        probeHost = document.createElement('div');
        probeHost.setAttribute('aria-hidden', 'true');
        probeHost.style.cssText = 'position:absolute;left:-9999px;top:0;width:300px;visibility:hidden;pointer-events:none';
        (document.querySelector(ROOT_SEL) || document.body || document.documentElement).appendChild(probeHost);
      }
      const clone = document.importNode(el, true);
      probeHost.appendChild(clone);
      struck = [clone, ...clone.querySelectorAll('*')].some(e => {
        const cs = getComputedStyle(e);
        return /line-through/.test((cs.textDecorationLine || '') + ' ' + (cs.webkitTextDecorationLine || '') + ' ' + (cs.textDecoration || ''));
      });
      clone.remove();
    } catch (_) {}
    struckCache.set(key, struck);
    return struck;
  }

  const CARD_RE = /multiple account detection event/i;
  function bannedFromCards(doc) {
    const out = new Set();
    const top = doc.body || doc.documentElement;
    if (!top) return out;
    const isName = a => { const t = norm(a.textContent); return t && !isAvatar(a) && !/detection event|ignore for future/i.test(t); };
    const seen = new Set();
    const w = doc.createTreeWalker(top, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!CARD_RE.test(n.nodeValue)) continue;

      let el = n.parentElement, nameEl = null, up = 0;
      while (el && up++ < 8) {
        nameEl = [...el.querySelectorAll('.username, a[href*="members/"]')].find(isName) || null;
        if (nameEl) break;
        el = el.parentElement;
      }
      if (!nameEl || seen.has(el)) continue;
      seen.add(el);
      const name = splitState(nameEl.textContent)[0].toLowerCase();
      const rest = flatText(el).replace(norm(nameEl.textContent), ' ');
      if (isBannedEl(nameEl) || /\bbanned\b/i.test(rest)) out.add(name);
    }
    return out;
  }

  const STATE_RE = '\\(([^()]{1,40}(?:\\([^()]*\\))?)\\)';

  const FOLLOW_ALT = new RegExp('^(?:' + STATE_RE + '\\s*)?(?:Ignore for future events|Triggered detection)', 'i');
  const FOLLOW_SUBJ = new RegExp('^(?:' + STATE_RE + '\\s*)?has the following potential multiple', 'i');

  function readAlts(doc, scopes, title) {
    const all = scopes.map(flatText).join(' ');

    let m = TITLE_USER_RE.exec(norm(title));
    let reported = m ? m[1] : '';
    if (!reported) {
      const h = doc.querySelector('h1');
      m = h && TITLE_USER_RE.exec(norm(h.textContent));
      if (m) reported = m[1];
    }
    if (!reported) {
      m = /\bOn [A-Za-z ]{1,30}?, (.{1,60}?)(?: \([^)]{1,40}\))? has the following potential multiple/i.exec(all);
      if (m) reported = m[1];
    }
    const me = norm(reported).toLowerCase();
    const meStates = [];
    let meHref = '', meSeen = false;

    const found = new Map();
    const add = (name, state, methods, link) => {
      name = norm(name);
      const k = name.toLowerCase();
      if (!name) return;
      const banned = isBannedEl(link);
      if (k === me) {
        meSeen = true;
        if (state && !meStates.includes(state)) meStates.push(state);
        if (banned && !meStates.includes('Banned')) meStates.push('Banned');
        if (!meHref && link && /members\//.test(link.getAttribute('href') || '')) {
          try { meHref = new URL(link.getAttribute('href'), location.href).href; } catch (_) {}
        }
        return;
      }
      let a = found.get(k);
      if (!a) { a = { name, states: [], noState: false, methods: [], href: '', wasBanned: false }; found.set(k, a); }
      if (banned) {
        if (DELETED_RE.test(name)) a.wasBanned = true;
        else if (!a.states.includes('Banned')) a.states.push('Banned');
      }
      if (!a.href && link && /members\//.test(link.getAttribute('href') || '')) {
        try { a.href = new URL(link.getAttribute('href'), location.href).href; } catch (_) {}
      }
      if (DELETED_RE.test(name)) { if (!a.states.includes('Deleted')) a.states.push('Deleted'); }
      else if (state) { if (!a.states.includes(state)) a.states.push(state); }
      else a.noState = true;
      for (const x of methods || []) if (!a.methods.includes(x)) a.methods.push(x);
    };

    for (const sc of scopes) {

      const links = [...sc.querySelectorAll('a, .username')].filter(a => {
        if (a.tagName !== 'A' && (a.closest('a') || (a.parentElement && a.parentElement.closest('.username')))) return false;
        const t = norm(a.textContent);
        return t && !/ignore for future/i.test(t);
      });
      links.forEach((a, i) => {
        const seg = textBetween(a, links[i + 1], sc);
        const [name, inLink] = splitState(a.textContent);
        let f;
        if ((f = FOLLOW_ALT.exec(seg))) {
          const how = ((seg.match(/detection methods?\s*:?\s*(.*)$/i) || [])[1] || '').slice(0, 200);
          add(name, inLink || f[1] || '', altMethods(how), a);
        } else if ((f = FOLLOW_SUBJ.exec(seg))) {
          add(name, inLink || f[1] || '', [], a);
        }
      });

      for (const li of sc.querySelectorAll('li')) {
        if (li.querySelector('li')) continue;
        const t = flatText(li);
        if (!/detection method/i.test(t)) continue;
        if ([...li.querySelectorAll('a, .username')].some(a => links.includes(a))) continue;
        const head = norm(t.split(/\s*Ignore for future|\s*Triggered detection/i)[0]);
        const [name, state] = splitState(head);
        const how = (t.match(/detection methods?\s*:?\s*(.*)$/i) || [])[1] || '';
        const nameEl = li.querySelector('.username') ||
          [...li.querySelectorAll('span, b, strong, s, del, em')].find(e => splitState(e.textContent)[0] === name) || null;
        add(name, state, altMethods(how), nameEl);
      }
    }

    const nameElOf = name => {
      for (const sc of scopes) {
        const hit = [...sc.querySelectorAll('a, span, b, strong, s, del, em')]
          .find(e => splitState(e.textContent)[0] === name && !e.querySelector('a, span, b, strong, s, del, em'));
        if (hit) {

          let el = hit;
          while (el.parentElement && el.parentElement !== sc && splitState(el.parentElement.textContent)[0] === name) el = el.parentElement;
          return el;
        }
      }
      return null;
    };

    const SUBJ = new RegExp('\\bOn [A-Za-z][A-Za-z ]{0,30}?, (.{1,60}?)(?: ' + STATE_RE + ')? has the following potential multiple account', 'gi');
    while ((m = SUBJ.exec(all))) add(m[1], m[2] || '', [], nameElOf(norm(m[1])));
    const GONE = new RegExp('\\b(Unknown user \\d+|Deleted (?:member|user) \\d+)\\s*(?:' + STATE_RE + '\\s*)?(?=Ignore for future events|Triggered detection)', 'gi');
    while ((m = GONE.exec(all))) add(m[1], '', [], nameElOf(norm(m[1])));

    const bannedCards = bannedFromCards(doc);
    for (const [k, a] of found) {
      if (!bannedCards.has(k)) continue;
      if (DELETED_RE.test(a.name)) a.wasBanned = true;
      else if (!a.states.includes('Banned')) a.states.push('Banned');
    }
    if (bannedCards.has(me) && !meStates.includes('Banned')) meStates.push('Banned');

    const alts = [...found.values()].map(a => {
      const classes = a.states.map(altClass);
      if (a.noState) classes.push('active');
      const cls = classes.reduce((w, c) => (ALT_SEVERITY[c] ?? 3) > (ALT_SEVERITY[w] ?? -1) ? c : w, '') || 'active';
      return { name: a.name, href: a.href, cls, state: a.states[a.states.length - 1] || '', methods: a.methods, wasBanned: a.wasBanned };
    });

    return {
      status: verdictOf(alts),
      alts,
      me: meStates.length ? meStates[meStates.length - 1] : '',
      meBanned: meStates.some(x => /\bban/i.test(x)),
      meSeen,
      meName: norm(reported),
      meHref,

      unknown: [...new Set((all.match(/Unknown user \d+/gi) || []).map(s => s.replace(/\D/g, '')))]
        .filter(id => !found.has('unknown user ' + id)),
      reopened: /re-?opening report/i.test(all),
    };
  }

  function verdictOf(alts) {
    const counted = alts.filter(a => a.cls !== 'deleted');
    if (counted.some(a => a.cls === 'banned')) return 'banned';
    if (counted.some(a => a.cls === 'active')) return 'active';
    if (counted.some(a => a.cls === 'pending')) return 'pending';
    if (counted.some(a => a.cls === 'foid')) return 'foid';
    if (counted.length && counted.every(a => a.cls === 'rejected')) return 'rejected';
    if (!counted.length && alts.length) return 'deleted';
    return 'other';
  }

  function repKeyOf(a) {
    if (!a) return 'checking';
    if (a.meBanned) return 'banned';
    if (a.me) {
      const c = altClass(a.me);
      return REP_FILTERS.some(r => r.slug === c) ? c : 'unknown';
    }
    return a.meSeen ? 'active' : 'unknown';
  }

  function mtKeyOf(a) {
    if (!a) return 'checking';
    const alts = a.alts || [];
    const deciding = alts.filter(x => x.cls === a.status);
    const list = deciding.length ? deciding : alts;

    const has = (x, m) => (x.methods || []).includes(m);
    if (!list.some(x => (x.methods || []).length)) return 'none';
    if (list.some(x => has(x, 'Cookie') && has(x, 'IP'))) return 'both';
    if (list.some(x => has(x, 'Cookie'))) return 'cookie';
    if (list.every(x => !(x.methods || []).length || ((x.methods || []).length === 1 && has(x, 'IP')))) return 'ip';
    return 'other';
  }

  function setAltAttrs(it) {
    const a = it.alt;
    it.box.setAttribute('data-lrt-alt', a ? a.status : it.altFailed ? 'other' : 'checking');
    it.box.setAttribute('data-lrt-rep', repKeyOf(a));
    it.box.setAttribute('data-lrt-mt', mtKeyOf(a));
  }

  const WARN_KEY = 'lrt-warn-v6';
  const WARN_TTL = 24 * 3600e3;
  const FOID_RE = /\bfoid|\bfemale\b/i;
  const NOTES_RE = /^\s*(staff\s+)?notes?:?\s*$/i;
  const BANLIKE_RE = /perma|\bban/i;
  const warnCache = (() => {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(WARN_KEY)) || {}; } catch (_) {}
    const now = Date.now();
    for (const k of Object.keys(c)) if (!c[k] || now - c[k].t > (c[k].err ? 3600e3 : WARN_TTL)) delete c[k];
    try { ['lrt-warn-v2', 'lrt-warn-v3', 'lrt-warn-v4', 'lrt-warn-v5'].forEach(k => localStorage.removeItem(k)); } catch (_) {}
    return c;
  })();
  let warnSaveTimer = 0;
  const saveWarnSoon = () => {
    if (warnSaveTimer) return;
    warnSaveTimer = setTimeout(() => { warnSaveTimer = 0; try { localStorage.setItem(WARN_KEY, JSON.stringify(warnCache)); } catch (_) {} }, 1500);
  };
  const warnLoads = new Map();
  let warnActive = 0;
  const warnWaiting = [];
  async function warnSlot(fn) {
    if (warnActive >= 2) await new Promise(r => warnWaiting.push(r));
    warnActive++;
    try { return await fn(); } finally { warnActive--; const next = warnWaiting.shift(); if (next) next(); }
  }

  function textWithoutNames(el, altName) {
    const c = el.cloneNode(true);
    c.querySelectorAll('.username, a[href*="members/"], .p-title, .p-breadcrumbs, .p-nav, .memberHeader, script, style').forEach(n => n.remove());
    let t = flatText(c);
    if (altName) t = t.split(altName).join(' ');
    return t;
  }

  function notesOf(doc) {
    const box = doc.querySelector('textarea[name="notes"]');
    if (box) return box.value || box.textContent || '';
    for (const dt of doc.querySelectorAll('dt')) {
      const label = (dt.querySelector('.formRow-label, label') || dt).cloneNode(true);
      label.querySelectorAll('dfn, .formRow-hint').forEach(n => n.remove());
      if (!NOTES_RE.test(label.textContent)) continue;
      const dd = dt.nextElementSibling;
      if (!dd) return '';
      const field = dd.querySelector('textarea, input[type="text"]');
      return field ? (field.value || field.textContent || '') : dd.textContent;
    }
    return null;
  }

  function listNote(link) {
    const row = link.closest('tr');
    const table = row && row.closest('table');
    if (!table) return null;
    const head = [...table.querySelectorAll('tr')].find(r => r.querySelector('th'));
    if (!head || head === row) return null;
    const idx = [...head.children].findIndex(c => NOTES_RE.test(c.textContent));
    const cell = idx >= 0 ? row.children[idx] : null;
    return cell ? norm(cell.textContent) : null;
  }

  async function loadPart(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.set('_xfResponseType', 'json');
      const r = await req(u.href, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (r.ok) {
        const j = JSON.parse(r.text);
        const html = j && j.html && j.html.content;
        if (html) return parse(html);
      }
    } catch (_) {}
    return fetchDoc(url);
  }

  const banWarnTitle = t => !!t && (BANLIKE_RE.test(t) || /\b100\s*%/.test(t) || FOID_RE.test(t));
  async function readWarnings(doc, altName) {
    const scope = doc.querySelector('.p-body-pageContent') || doc.body;
    if (!scope) return { f: false, list: [] };
    const strip = s => (altName && s ? s.split(altName).join(' ') : s);
    const seen = new Set(), list = [];
    for (const a of scope.querySelectorAll('a[href*="/warnings/"]')) {
      const href = a.getAttribute('href') || '';
      if (!/\/warnings\/\d+/.test(href)) continue;
      const url = new URL(href, location.href).href.split('#')[0];
      if (seen.has(url)) continue;
      seen.add(url);
      list.push({ url, t: norm(a.textContent) || 'Warning', n: listNote(a) });
    }

    let f = !list.length && FOID_RE.test(textWithoutNames(scope, altName));
    const titlesKnown = list.some(w => w.t && w.t !== 'Warning');
    const counts = w => !titlesKnown || banWarnTitle(w.t);
    for (const w of list.slice(0, 8)) {
      if (w.n !== null) continue;
      try {
        const d = await loadPart(w.url);
        const notes = notesOf(d);
        w.n = notes !== null ? norm(notes) : null;
        if (!counts(w)) continue;
        const text = notes !== null ? strip(notes)
                                    : textWithoutNames(d.querySelector('.p-body-pageContent') || d.body, altName);
        if (FOID_RE.test(text)) f = true;
      } catch (_) {}
    }
    for (const w of list) if (counts(w) && ((w.n && FOID_RE.test(strip(w.n))) || FOID_RE.test(w.t || ''))) f = true;
    return { f, list: list.map(w => ({ t: w.t, n: w.n })) };
  }

  async function warningsSayFoid(doc, altName) {
    return (await readWarnings(doc, altName)).f;
  }

  function pickWhy(list, foid, altName) {
    const strip = n => altName && n ? n.split(altName).join(' ') : n;
    const w = (foid && (list.find(x => x.n && banWarnTitle(x.t) && FOID_RE.test(strip(x.n))) ||
                        list.find(x => x.n && FOID_RE.test(strip(x.n))))) ||
      list.find(x => BANLIKE_RE.test(x.t)) || list[0];
    return { items: [w, ...list.filter(x => x !== w)].map(x => ({ t: x.t, n: x.n })) };
  }

  async function banReason(base) {
    try {
      const r = await req(base + 'ban');
      if (!r.ok) return '';
      const d = parse(r.text);
      const f = d.querySelector('input[name="user_reason"], textarea[name="user_reason"]');
      return f ? norm(f.value || f.textContent) : '';
    } catch (_) { return ''; }
  }

  function banInfo(alt) {
    const m = /\/members\/(?:[^/?#]*\.)?(\d+)/.exec(alt.href || '');
    const key = m ? m[1] : '';
    if (!key) return Promise.resolve(null);
    const c = warnCache[key];
    if (c && !(c.err && Date.now() - c.t > 3600e3)) return Promise.resolve(c.err ? null : c);
    if (warnLoads.has(key)) return warnLoads.get(key);
    const base = alt.href.split(/[?#]/)[0].replace(/\/?$/, '/');
    const job = warnSlot(async () => {
      let doc = null;
      try {
        const u = new URL(base + 'warnings', location.href);
        u.searchParams.set('_xfResponseType', 'json');
        const r = await req(u.href, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (r.ok) {
          const j = JSON.parse(r.text);
          const html = j && j.html && j.html.content;
          if (html) doc = parse(html);
        }
      } catch (_) {}
      if (!doc) doc = await fetchDoc(base + 'warnings');
      const rw = await readWarnings(doc, alt.name);
      const list = rw.list;
      let f = rw.f, w;
      if (list.length) w = pickWhy(list, f, alt.name);
      else {
        const reason = await banReason(base);
        w = reason ? { items: [{ t: 'Ban reason', n: reason }] } : { items: [], none: true };

        if (!f && reason && FOID_RE.test(alt.name ? reason.split(alt.name).join(' ') : reason)) f = true;
      }
      const info = { f, w, t: Date.now() };
      warnCache[key] = info;
      saveWarnSoon();
      return info;
    });
    const safe = job.catch(() => { warnCache[key] = { f: null, t: Date.now(), err: true }; saveWarnSoon(); return null; })
      .finally(() => warnLoads.delete(key));
    warnLoads.set(key, safe);
    return safe;
  }

  const labelOf = (input, form) => norm((input.closest('label') ||
    (input.id && form.querySelector('label[for="' + input.id + '"]')) || input.parentElement || input).textContent);
  const TEXT_FIELD = ':not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])';
  const PERMA_RE = /100\s*%\s*-?\s*perma|perma\s*-?\s*ban/i;

  async function loadForm(url, isRight) {
    const r = await req(url);
    if (!r.ok) return null;
    const doc = parse(r.text);
    const form = [...doc.querySelectorAll('form')].find(f => isRight(f));
    return form ? { doc, form } : null;
  }

  function menuLink(doc, id, word) {
    if (!doc || !id) return '';
    const a = [...doc.querySelectorAll('a[href]')].find(x => new RegExp('^' + word + '(?: member| user)?$', 'i').test(norm(x.textContent)) &&
      new RegExp('[./=]' + id + '/' + word + '\\b', 'i').test(x.getAttribute('href') || ''));
    try { return a ? new URL(a.getAttribute('href'), location.href).href : ''; } catch (_) { return ''; }
  }

  async function hasFoidWarning(base, name) {
    try {
      const r = await req(base + 'warnings');
      return r.ok && await warningsSayFoid(parse(r.text), name);
    } catch (_) { return false; }
  }

  async function banFoid(href, name, reportDoc) {
    const base = href.split(/[?#]/)[0].replace(/\/?$/, '/');
    const id = (/\/members\/(?:[^/?#]*\.)?(\d+)/.exec(base) || [])[1] || '';
    const warnUrl = menuLink(reportDoc, id, 'warn') || base + 'warn';
    if (await hasFoidWarning(base, name)) return 'already';

    const w = await loadForm(warnUrl, f => !!f.querySelector('textarea[name="notes"], textarea[name*="note" i]') &&
      !!f.querySelector('input[type="radio"], select'));
    if (!w) throw new Error('No warn form for this account (no permission?). Nothing was done.');
    const form = w.form;

    let pickName = '', pickValue = '';
    const radio = [...form.querySelectorAll('input[type="radio"]')].find(r => PERMA_RE.test(labelOf(r, form)));
    if (radio) { pickName = radio.name; pickValue = radio.value; }
    else {
      for (const sel of form.querySelectorAll('select')) {
        const o = [...sel.options].find(x => PERMA_RE.test(x.textContent));
        if (o) { pickName = sel.name; pickValue = o.value; break; }
      }
    }
    if (!pickName) throw new Error('No “100% - Permaban” warning in the warn form. Nothing was done.');

    const fillBody = formBody(form);
    fillBody.set(pickName, pickValue);
    fillBody.set('fill', '1');
    const filled = await submit(form, fillBody, warnUrl);
    const extra = new Map();
    applyFormValues(form, filled && filled.formValues, extra);
    if (!filled || !filled.formValues) throw new Error('The forum did not fill in the warning details. Nothing was done.');

    for (const h of form.querySelectorAll('input[type="hidden"]')) {
      if (/fill/i.test(h.name) && h.name !== 'fill' && !extra.has(h.name) && (!h.value || h.value === '0')) h.value = pickValue;
    }

    const body = formBody(form);
    for (const [k, v] of extra) body.set(k, v);
    body.set(pickName, pickValue);
    for (const c of form.querySelectorAll('input[type="checkbox"]')) {
      const what = labelOf(c, form) + ' ' + c.name;
      if (/apply warning points|points_enable/i.test(what)) body.set(c.name, c.value || '1');
      else if (/expire|expiry/i.test(what)) body.delete(c.name);
      else if (/conversation|alert|notif/i.test(what)) body.delete(c.name);
    }
    const pts = form.querySelector('input[name="points"]') ||
      [...form.querySelectorAll('input' + TEXT_FIELD)].find(i => /^points$|warning_points/i.test(i.name));
    if (pts) body.set(pts.name, '100');
    const notes = form.querySelector('textarea[name="notes"]') || form.querySelector('textarea[name*="note" i]');
    body.set(notes.name, FOID_REASON);
    await submit(form, body, warnUrl);
    return 'given';
  }

  async function bannedOnProfile(href) {
    try {
      const r = await req(href.split(/[?#]/)[0]);
      if (!r.ok) return false;
      const doc = parse(r.text);
      const head = doc.querySelector('.memberHeader, .memberHeader-main');
      if (head && /\bbanned\b/i.test(flatText(head))) return true;
      const nameEl = doc.querySelector('.memberHeader-name .username, .memberHeader .username, h1 .username');
      return !!nameEl && isBannedEl(nameEl);
    } catch (_) { return false; }
  }

  const isBannedAlt = x => !!x.href && (x.cls === 'banned' || x.cls === 'foid');
  async function addFoidInfo(a) {
    if (!a || !a.alts) return a;
    for (const x of a.alts) {
      if (!isBannedAlt(x)) continue;
      try {
        const info = await banInfo(x);
        x.bw = info ? info.w : null;
        delete x.why;
        if (info && info.f) { x.cls = 'foid'; x.foid = true; }
      } catch (e) { log(e); }
    }
    a.status = verdictOf(a.alts);
    return a;
  }

  async function fillWhy(it) {
    if (it.whyBusy) return;
    it.whyBusy = true;
    const a = it.alt;
    try {
      for (const x of a.alts) {
        if (!isBannedAlt(x) || x.bw !== undefined) continue;
        const info = await banInfo(x);
        x.bw = info ? info.w : null;
        delete x.why;
      }
      if (it.alt === a && !it.sent) {
        if (altCache[it.id]) altCache[it.id].d = a;
        saveAltsSoon();
        queueAltDraw(it);
      }
    } catch (e) { log(e); } finally { it.whyBusy = false; }
  }

  const WHY_MAX = 5;
  function whyLine(w) {
    const el = make('span', 'lrt-why');
    if (!w || w.none || !w.items || !w.items.length) {
      el.classList.add('is-dim');
      el.textContent = !w ? 'Ban reason couldn’t be loaded' : 'No warning on this account';
      return el;
    }
    for (const x of w.items.slice(0, WHY_MAX)) {
      const line = make('span', 'lrt-why-line');
      line.appendChild(make('em', '', x.t));
      const n = x.n || '';
      line.appendChild(n ? make('span', 'lrt-why-n', n.length > 300 ? n.slice(0, 299) + '…' : n)
                         : make('span', 'lrt-why-n is-dim', x.n === '' ? 'no note' : 'note not visible'));
      el.appendChild(line);
    }
    if (w.items.length > WHY_MAX) el.appendChild(make('span', 'lrt-why-more', '+' + (w.items.length - WHY_MAX) + ' more'));
    return el;
  }

  async function resolveAlt(it, doc) {
    const a = await addFoidInfo(parseAlts(doc, it.title) || unclearAlt());
    if (!it.sent) setAlt(it, a);
    return a;
  }

  function setAlt(it, a) {
    if (!a || it.sent) return;
    it.alt = a;
    it.altFailed = false;
    it.altStale = false;
    altCache[it.id] = { v: ALT_V, t: Date.now(), title: it.title, d: a };
    saveAltsSoon();
    queueAltDraw(it);
  }

  function altFailedAt(it) {
    it.altFailed = true;
    queueAltDraw(it);
  }

  const altDirty = new Set();
  let altDrawTimer = 0;
  function queueAltDraw(it) {
    altDirty.add(it);
    if (!altDrawTimer) altDrawTimer = setTimeout(drawAlts, 250);
  }

  function drawAlts() {
    altDrawTimer = 0;
    if (!altDirty.size) return;
    if (userBusy()) { altDrawTimer = setTimeout(drawAlts, 250); return; }
    const items = [...altDirty];
    altDirty.clear();
    keepStill(() => {
      for (const it of items) {
        if (it.sent) continue;
        setAltAttrs(it);
        try { renderAltBox(it); } catch (e) { log(e); }
      }
    }, items.map(it => it.card));
    renderSoon();
  }

  function altHead(v, n) {
    const head = make('div', 'lrt-alts-head');
    const icon = make('span', 'lrt-alts-icon', v.icon);
    icon.setAttribute('aria-hidden', 'true');
    head.append(icon, make('span', 'lrt-alts-label', v.label));
    if (n !== null) head.appendChild(make('span', 'lrt-alts-n', n + (n === 1 ? ' alt' : ' alts')));
    return head;
  }

  function renderAltBox(it) {
    if (!it.card || it.sent) return;
    const a = it.alt;
    let box = it.card.querySelector(':scope > .lrt-alts');
    if (!box) {
      box = make('div', 'lrt-alts');
      (it.card.querySelector(':scope > .lrt-who') || it.card.querySelector(':scope > .lrt-title')).after(box);
    }
    if (!a) {
      if (!it.altFailed) return;
      box.setAttribute('data-st', 'other');
      box.replaceChildren(altHead(ALT_VERDICT.other, null),
        make('div', 'lrt-alts-note', 'Couldn\'t load this report' + (it.altErr ? ' (' + it.altErr + ')' : '') +
          '. It loads again when you scroll to it, or use “Open”.'));
      return;
    }
    const v = ALT_VERDICT[a.status] || ALT_VERDICT.other;
    box.setAttribute('data-st', a.status);
    const parts = [altHead(v, a.alts.length)];

    if (a.alts.length) {
      const list = make('div', 'lrt-alts-list');
      for (const x of a.alts) {
        const row = make(x.href ? 'a' : 'span', 'lrt-alt');
        if (x.href) { row.href = x.href; row.target = '_blank'; row.rel = 'noopener'; }
        row.setAttribute('data-c', x.cls);
        const pill = make('i', '', (ALT_STATE[x.cls] || x.state || '?') + (x.wasBanned ? ', was banned' : ''));
        pill.setAttribute('data-c', x.cls);
        row.append(make('b', '', x.name), pill);
        { const dp = LM_DET.pill(x.methods); if (dp) row.appendChild(dp); }
        if (isBannedAlt(x) && x.bw !== undefined) row.appendChild(whyLine(x.bw));
        list.appendChild(row);
      }
      parts.push(list);
      if (a.alts.some(x => isBannedAlt(x) && x.bw === undefined)) fillWhy(it);
    }
    parts.push(make('div', 'lrt-alts-note', v.note));
    if (a.status === 'foid' && banTarget(it)) {
      const b = button('lrt-banbtn', 'Perma-ban ' + a.meName + ' (foid) + resolve');
      b.addEventListener('click', e => { stop(e); markBan(it); });
      parts.push(b);
    }
    const flags = [];
    if (a.me) flags.push('Reported account itself: ' + (ALT_STATE[altClass(a.me)] || a.me));
    if (a.reopened) flags.push('Reopened');
    if (a.unknown && a.unknown.length) flags.push('Unknown user ' + a.unknown.join(', '));
    if (flags.length) parts.push(make('div', 'lrt-alts-flag', flags.join('. ')));
    box.replaceChildren(...parts);
    if (a.status === 'other') setDetails(it, true);
  }

  let altPauseUntil = 0, altStreak = 0, altTimer = 0;
  const altStaleQueue = [];

  function startAltScan() {
    altStarted = true;
    for (const it of reports.values()) enqueueAlt(it);
    pumpAlt();
  }

  function enqueueAlt(it) {
    if (it.cat !== 'multi' || it.sent || it.altQueued || it.altFailed) return;
    if (it.alt && !it.altStale) return;
    it.altQueued = true;
    (it.alt ? altStaleQueue : altQueue).push(it);
  }

  function pumpAlt() {
    const wait = sending ? 1000 : !closedChecked ? 300 : altPauseUntil - Date.now();
    if (wait > 0) {
      clearTimeout(altTimer);
      altTimer = setTimeout(pumpAlt, wait + 50);
      return;
    }
    const limit = altStreak ? 1 : Math.max(1, ALT_PARALLEL - loading);
    while (altLoading < limit && (altQueue.length || altStaleQueue.length)) {
      const it = (altQueue.length ? altQueue : altStaleQueue).shift();
      it.altQueued = false;
      if (it.sent || (it.alt && !it.altStale)) continue;
      if (it.queued && !it.loadFailed) continue;
      altLoading++;
      loadAlt(it)
        .then(() => { altStreak = 0; })
        .catch(e => altError(it, e))
        .finally(() => { altLoading--; pumpAlt(); });
    }
  }

  function altError(it, e) {
    log(e);
    it.altErr = (e && e.message) || 'unknown error';
    altStreak++;
    altPauseUntil = Date.now() + Math.min(10000, 1000 * altStreak);
    it.altTries = (it.altTries || 0) + 1;
    if (it.altTries < 4) { it.altQueued = true; (it.alt ? altStaleQueue : altQueue).push(it); }
    else if (it.alt) it.altStale = false;
    else altFailedAt(it);
    renderLater();
  }

  let jsonNoStatus = false;
  async function loadAlt(it) {
    const done = () => it.sent || (it.alt && !it.altStale);
    let doc = null;
    if (!jsonNoStatus) {
      try {
        const u = new URL(it.url);
        u.searchParams.set('_xfResponseType', 'json');
        const r = await req(u.href, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (r.ok) {
          const j = JSON.parse(r.text);
          const c = j && j.html && j.html.content;
          if (c && MULTI_RE.test(c)) {
            const d = parse(c);
            if (pairOf(d, 'status')) doc = d; else jsonNoStatus = true;
          }
        }
      } catch (_) {}
    }
    if (done()) return;
    if (!doc) {
      doc = await fetchDoc(it.url);
      if (done()) return;
    }
    if (isClosed(doc)) { dropClosed(it); return; }
    const a = await addFoidInfo(parseAlts(doc, it.title) || unclearAlt());
    if (!it.sent) setAlt(it, a);
  }

  const filtersOn = () => altFilter !== 'all' || repFilter !== 'all' || mtFilter !== 'all';
  const bulkKind = () => altFilter !== 'all' ? altFilter : filtersOn() ? 'all' : 'rejected';

  const bulkable = (it, kind) => {
    if (it.cat !== 'multi' || it.sent || !it.box.isConnected || marks[it.id] || !it.alt) return false;
    const st = it.alt.status;
    if (st === 'other' || it.box.getAttribute('data-lrt-alt') !== st) return false;
    if (kind !== 'all' && st !== kind) return false;
    if (repFilter !== 'all' && (repKeyOf(it.alt) !== repFilter || it.box.getAttribute('data-lrt-rep') !== repFilter)) return false;
    if (mtFilter !== 'all' && (mtKeyOf(it.alt) !== mtFilter || it.box.getAttribute('data-lrt-mt') !== mtFilter)) return false;
    if (!matchesQ(it)) return false;
    return true;
  };

  function bulkText(kind, n) {
    const parts = [BULK_VERDICT[kind] || ''];
    const rep = REP_FILTERS.find(r => r.slug === repFilter);
    if (rep) parts.push((kind === 'all' ? 'where the reported account is ' : 'reported account ') + rep.text);
    const mt = MT_FILTERS.find(r => r.slug === mtFilter);
    if (mt) parts.push(mt.text);
    if (searchQ) parts.push('matching “' + searchQ + '”');
    return n + (n === 1 ? ' report ' : ' reports ') + parts.filter(Boolean).join(', ');
  }

  function banTarget(it) {
    const a = it.alt;
    if (!a || !a.meName) return '';
    if (a.meHref) return a.meHref;
    return it.userHref && it.userName.toLowerCase() === a.meName.toLowerCase() ? it.userHref : '';
  }
  const banMark = it => ({ s: 'resolved', u: it.url, v: 'foid', ban: true, who: it.alt.meName, wh: banTarget(it) });

  function markAllHarmless(state) {
    const kind = bulkKind();
    const ban = state === 'ban' && kind === 'foid';
    const list = [...reports.values()].filter(it => bulkable(it, kind) && (!ban || banTarget(it)));
    if (!list.length) return;
    keepStill(() => list.forEach(it => {

      const m = ban ? banMark(it) : { s: state, u: it.url, v: it.alt.status };
      if (repFilter !== 'all') m.r = repFilter;
      if (mtFilter !== 'all') m.mt = mtFilter;
      marks[it.id] = m;
      showMark(it, m.s);
    }));
    saveMarks();
    backToMarks();
    renderSoon();
    setDock('ask-send');
  }

  function initSwipe() {
    const TH = 90;
    let sw = null;
    const reset = (x) => {
      x.card.classList.remove('is-swiping');
      x.card.style.transform = '';
      x.box.removeAttribute('data-lrt-swipe');
    };
    root.addEventListener('touchstart', e => {
      sw = null;
      if (e.touches.length !== 1 || sending) return;
      const card = e.target.closest && e.target.closest('.lrt-card');
      if (!card || e.target.closest('input, textarea, select, pre, table, [contenteditable]')) return;
      const box = card.parentElement;
      const it = box && reports.get(box.getAttribute('data-lrt-id'));
      if (!it || it.card !== card || it.sent || marks[it.id]) return;
      const okBtn = it.bar && it.bar.querySelector('button[data-a="resolved"]');
      if (!okBtn || okBtn.disabled) return;
      const t = e.touches[0];
      if (t.clientX < 30 || t.clientX > window.innerWidth - 30) return;
      sw = { it, card, box, x0: t.clientX, y0: t.clientY, dx: 0, mode: 0 };
    }, { passive: true });
    root.addEventListener('touchmove', e => {
      if (!sw) return;
      const t = e.touches[0];
      const dx = t.clientX - sw.x0, dy = t.clientY - sw.y0;
      if (!sw.mode) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        sw.mode = Math.abs(dx) > Math.abs(dy) * 1.8 ? 1 : -1;
        if (sw.mode === 1) sw.card.classList.add('is-swiping');
      }
      if (sw.mode !== 1) return;
      sw.dx = dx;
      sw.card.style.transform = 'translateX(' + Math.round(dx * 0.92) + 'px)';
      const st = dx > 0 ? (dx > TH ? 'ok' : 'ok-soon') : (dx < -TH ? 'rej' : 'rej-soon');
      if (sw.box.getAttribute('data-lrt-swipe') !== st) sw.box.setAttribute('data-lrt-swipe', st);
    }, { passive: true });
    const end = () => {
      if (!sw) return;
      const x = sw;
      sw = null;
      reset(x);
      if (x.mode === 1 && Math.abs(x.dx) > TH && !marks[x.it.id]) mark(x.it, x.dx > 0 ? 'resolved' : 'rejected');
    };
    root.addEventListener('touchend', end, { passive: true });
    root.addEventListener('touchcancel', () => { if (sw) { reset(sw); sw = null; } }, { passive: true });
  }

  function mark(it, state) {
    marks[it.id] = { s: state, u: it.url };
    saveMarks();
    backToMarks();
    showMark(it, state);

    const vt = viewTop();
    const r = it.card.getBoundingClientRect();
    if (r.height && r.top < vt + 4) scrollByNow(r.top - vt - 8);
    marksChanged();
  }

  function markBan(it) {
    if (!banTarget(it)) return;
    marks[it.id] = banMark(it);
    saveMarks();
    backToMarks();
    showMark(it, 'resolved');
    const vt = viewTop();
    const r = it.card.getBoundingClientRect();
    if (r.height && r.top < vt + 4) scrollByNow(r.top - vt - 8);
    marksChanged();
  }

  function showMark(it, state) {
    const err = it.pv.querySelector(':scope > .lrt-err');
    if (err && it.canAct) err.remove();
    const ban = !!(marks[it.id] && marks[it.id].ban);
    it.card.classList.remove('is-ok', 'is-rej', 'is-ban');
    it.card.classList.add('is-marked', ban ? 'is-ban' : state === 'resolved' ? 'is-ok' : 'is-rej');
    setText(it.card.querySelector('.lrt-state-text'), ban ? 'Marked: perma-ban (foid) + resolve'
      : state === 'resolved' ? 'Marked as resolved' : 'Marked as rejected');
  }

  function clearMark(it) {
    it.card.classList.remove('is-marked', 'is-ok', 'is-rej', 'is-ban');
  }

  function unmark(it) {
    delete marks[it.id];
    saveMarks();
    backToMarks();
    clearMark(it);
    marksChanged();
  }

  function syncMarks() {
    keepStill(() => {
      for (const it of reports.values()) {
        if (it.sent) continue;
        if (marks[it.id]) showMark(it, marks[it.id].s);
        else clearMark(it);
      }
    });
    marksChanged();
  }

  function marksChanged() {
    renderDock();
    renderSoon();
  }

  function backToMarks() {
    if (dockMode !== 'summary') return;
    clearTimeout(summaryTimer);
    dockMode = 'marks';
  }

  const dock = make('div');
  dock.id = 'lrt-dock';
  dock.setAttribute('role', 'region');
  dock.setAttribute('aria-label', 'Marked reports');
  const dockText = make('div', 'lrt-dock-text');
  dockText.setAttribute('aria-live', 'polite');
  const dockRow = make('div', 'lrt-dock-row');
  const dockBar = make('div', 'lrt-dock-progress');
  const dockFill = make('i');
  dockBar.appendChild(dockFill);
  dock.append(make('span', 'lrt-brand', 'LM'), dockText, dockRow, dockBar);

  const TODAY_KEY = 'lrt-today-v2';
  const TODAY_OLD = 'lrt-today-v1';
  const TODAY_GAP = 15 * 60e3;
  const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function todayLoad() {
    try {
      const o = JSON.parse(localStorage.getItem(TODAY_KEY));
      if (o && o.d === dayKey()) return o;
      const old = JSON.parse(localStorage.getItem(TODAY_OLD));
      if (old && old.d === dayKey()) return { d: old.d, n: +old.n || 0, busy: 0, last: 0, ban: 0 };
    } catch (_) {}
    return { d: dayKey(), n: 0, busy: 0, last: 0, ban: 0 };
  }
  function todaySave(o) { try { localStorage.setItem(TODAY_KEY, JSON.stringify(o)); } catch (_) {} }
  function todayTick(o) {
    const now = Date.now();
    const gap = now - (o.last || 0);
    if (o.last && gap > 0 && gap < TODAY_GAP) o.busy += gap;
    o.last = now;
  }
  function todayCount() { return todayLoad().n; }

  let todayTickAt = 0;
  function todayActive() {
    const now = Date.now();
    if (now - todayTickAt < 5000) return;
    todayTickAt = now;
    const o = todayLoad(); todayTick(o); todaySave(o);
  }
  function todayAdd(n, ban) {
    const o = todayLoad();
    todayTick(o);
    o.n += n || 0;
    o.ban = (o.ban || 0) + (ban || 0);
    todaySave(o);
    return o.n;
  }

  function todayRate(o) {
    o = o || todayLoad();
    return o.busy >= 5 * 60e3 && o.n >= 5 ? o.n / (o.busy / 3600e3) : 0;
  }
  const fmtMin = (min) => min < 1 ? '< 1 min' : min < 60 ? Math.round(min) + ' min'
    : Math.floor(min / 60) + ' h ' + String(Math.round(min % 60)).padStart(2, '0');
  function statsText(open) {
    const o = todayLoad();
    const rate = todayRate(o);
    const parts = [o.n + ' today'];
    if (rate) parts.push(Math.round(rate) + '/h');
    if (open != null) parts.push(open + ' open');
    if (rate && open) parts.push('≈ ' + fmtMin(open / rate * 60) + ' left');
    return parts.join(' · ');
  }

  let dockMode = 'marks', armedAt = 0, askTimer = 0, summaryTimer = 0, summary = '', dockKey = '';
  const progress = { done: 0, total: 0 };

  function setDock(mode) {
    dockMode = mode;
    clearTimeout(askTimer);
    if (mode === 'ask-send' || mode === 'ask-undo') {
      armedAt = performance.now();
      askTimer = setTimeout(() => { if (dockMode === mode) setDock('marks'); }, 10000);
    }
    renderDock();
  }

  let openNow = -1;
  function renderDock() {
    const all = Object.values(marks);
    const n = all.length;
    const nBan = all.filter(m => m.ban).length;
    const nOk = all.filter(m => m.s === 'resolved' && !m.ban).length;
    const split = nOk + ' resolved, ' + (n - nOk - nBan) + ' rejected' + (nBan ? ', ' + nBan + ' perma-ban (foid)' : '');
    if (!n && dockMode.startsWith('ask')) { dockMode = 'marks'; clearTimeout(askTimer); }

    let show = true, main, sub = '', btns = [];
    if (dockMode === 'sending') {
      main = 'Sending… ' + progress.done + ' of ' + progress.total;
    } else if (dockMode === 'summary') {
      main = summary;

      if (openNow === 0) {
        sub = 'All handled';
        btns = [['reload', 'Check for new', 'lrt-gold']];
      } else sub = 'Tap to close';
    } else if (dockMode === 'ask-send') {
      main = 'Send ' + n + (n === 1 ? ' report now?' : ' reports now?');
      sub = split;
      btns = [['cancel', 'Cancel', ''], ['go-send', 'Send ' + n, 'lrt-gold']];
    } else if (dockMode === 'ask-undo') {
      main = 'Remove all ' + n + (n === 1 ? ' mark?' : ' marks?');
      sub = 'Nothing has been sent yet.';
      btns = [['cancel', 'Keep', ''], ['go-undo', 'Remove', 'lrt-danger']];
    } else {
      show = n > 0;
      main = n + ' marked';
      sub = split;
      btns = [['undo', 'Undo all', ''], ['send', 'Confirm all', 'lrt-gold']];
    }

    const key = dockMode + '|' + main + '|' + sub;
    if (key !== dockKey) {
      dockKey = key;
      dockText.replaceChildren(make('strong', '', main));
      if (sub) dockText.appendChild(make('small', '', sub));
    }
    const bKey = btns.map(b => b.join(':')).join('|');
    if (dockRow.getAttribute('data-k') !== bKey) {
      dockRow.setAttribute('data-k', bKey);
      dockRow.replaceChildren(...btns.map(([d, label, cls]) => {
        const b = button(cls ? 'lrt-b ' + cls : 'lrt-b', label);
        b.dataset.d = d;
        return b;
      }));
    }
    dock.classList.toggle('show', show);
    dock.classList.toggle('busy', dockMode === 'sending');
    dock.classList.toggle('summary', dockMode === 'summary');
    dock.classList.toggle('asking', dockMode.startsWith('ask'));
    if (dock.dataset.mode !== dockMode) dock.dataset.mode = dockMode;
    dockFill.style.width = progress.total ? Math.round(100 * progress.done / progress.total) + '%' : '0%';
    document.body.classList.toggle('lrt-has-dock', show);
  }

  dock.addEventListener('click', e => {
    if (dockMode === 'summary') {
      if (e.target.closest('button[data-d="reload"]')) { location.reload(); return; }
      clearTimeout(summaryTimer); setDock('marks'); return;
    }
    const b = e.target.closest('button[data-d]');
    if (!b || sending) return;
    const d = b.dataset.d;
    if (d.startsWith('go-') && performance.now() - armedAt < 450) return;
    if (d === 'send') setDock('ask-send');
    else if (d === 'undo') setDock('ask-undo');
    else if (d === 'cancel') setDock('marks');
    else if (d === 'go-send') sendAll();
    else if (d === 'go-undo') undoAll();
  });

  function undoAll() {
    const ids = Object.keys(marks);
    marks = {};
    saveMarks();
    keepStill(() => ids.forEach(id => { const it = reports.get(id); if (it) clearMark(it); }));
    setDock('marks');
    renderSoon();
  }

  async function sendAll() {
    if (sending) return;
    const jobs = Object.entries(marks).map(([id, m]) => ({ id, state: m.s, url: m.u, it: reports.get(id) }));
    if (!jobs.length) { setDock('marks'); return; }
    sending = true;
    progress.done = 0;
    progress.total = jobs.length;
    setDock('sending');
    let ok = 0, fail = 0, gone = 0, changed = 0, next = 0, failRow = 0, banned = 0;

    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const m = marks[job.id];
        let pause = 120;
        if (m && m.s === job.state) {
          try {
            let { form, doc } = await freshForm(job.url);
            let a = null;
            if (m.v) {

              a = await addFoidInfo(parseAlts(doc, job.it ? job.it.title : ''));
              if (job.it && a) setAlt(job.it, a);
              if (!a || a.status !== m.v || (m.r && repKeyOf(a) !== m.r) || (m.mt && mtKeyOf(a) !== m.mt)) {
                const e = new Error('alts changed'); e.code = 'changed'; throw e;
              }
            }
            if (m.ban) {

              const target = (a && a.meHref) || m.wh;
              if (!target) throw new Error('Couldn\'t find the reported account\'s profile');
              {

                const how = a && a.meBanned ? 'already' : await banFoid(target, a ? a.meName : m.who, doc);
                const again = await freshForm(job.url);
                const a2 = parseAlts(again.doc, job.it ? job.it.title : '');
                if (!((a2 && a2.meBanned) || await bannedOnProfile(target))) {
                  const e = new Error((how === 'already' ? 'It already has a permaban warning with “Foid” in the notes'
                    : 'The “100% - Permaban” warning (Notes: Foid) was given') +
                    ', but the account doesn\'t show as banned. Check it; the report stays open.');
                  e.code = 'notbanned';
                  throw e;
                }
                if (how !== 'already') banned++;
                { const bid = (/\/members\/(?:[^/?#]*\.)?(\d+)/.exec(target) || [])[1];
                  if (bid) LMS.banned([bid], 'reports'); }
                form = again.form;
                if (job.it && a2) setAlt(job.it, a2);
              }
            }
            await post(form, job.state, job.url);
            ok++;
            failRow = 0;
            finish(job, null);
          } catch (e) {
            if (e.code === 'closed') { gone++; finish(job, null); }
            else if (e.code === 'changed') {
              changed++;
              finish(job, 'Not sent: its alts or the reported account changed since you marked it. Check this one.', true);
            } else if (m.ban) {
              fail++;
              finish(job, (e.code === 'notbanned' ? '' : 'Ban failed: ') + e.message, true);
            } else {
              fail++;
              failRow++;
              pause = Math.min(8000, 1000 * failRow);
              finish(job, e.message);
            }
          }
        }
        progress.done++;
        renderDock();
        if (next < jobs.length) await sleep(pause);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
    } finally {
      sending = false;
    }

    const today = todayAdd(ok, banned);
    const rate = todayRate();
    dock.classList.toggle('has-fail', !!(fail || changed));
    let msg = 'Done: ' + ok + ' sent';
    if (banned) msg += ' (' + banned + ' perma-banned for foid)';
    if (gone) msg += ', ' + gone + ' already closed by someone else';
    if (changed) msg += ', ' + changed + ' not sent (changed since marking, back in the list)';
    if (fail) msg += ', ' + fail + ' failed (back in the list)';
    summary = msg + '.';
    setDock('summary');
    clearTimeout(summaryTimer);

    summaryTimer = setTimeout(() => { if (dockMode === 'summary' && openNow !== 0) setDock('marks'); }, 6000);
    renderSoon();
  }

  function finish(job, error, plain) {
    if (marks[job.id]) { delete marks[job.id]; saveMarks(); }
    const it = job.it;
    if (it) {
      if (!error) {
        closeLocally(it);
      } else {
        calm(it.card, 'fail' + it.id, () => {
          clearMark(it);
          it.pv.querySelectorAll(':scope > .lrt-err').forEach(n => n.remove());
          it.pv.appendChild(make('div', 'lrt-err', plain ? error : 'Sending failed: ' + error));
        });
      }
    }
    renderSoon();
  }

  addEventListener('pageshow', e => {
    touching = false;
    if (!e.persisted || !root) return;
    const fresh = readMarks();
    if (JSON.stringify(fresh) !== JSON.stringify(marks)) { marks = fresh; syncMarks(); }
    let id = null;
    try { id = sessionStorage.getItem(OPENED_KEY); sessionStorage.removeItem(OPENED_KEY); } catch (_) {}
    const it = id ? reports.get(id) : null;
    if (it && !it.sent) recheck(it);
  });

  addEventListener('storage', e => {
    if (e.key !== MARKS_KEY || sending || !root) return;
    marks = readMarks();
    syncMarks();
  });

  async function recheck(it) {
    try {
      const doc = await fetchDoc(it.url);
      if (isClosed(doc)) { dropClosed(it); return; }

      if (it.cat === 'multi') await resolveAlt(it, doc);
    } catch (_) {}
  }

  function addStyle() {
    if (document.getElementById('lrt-style')) return;
    const rgba = (hex, a) => {
      const n = parseInt(hex.slice(1), 16);
      return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
    };
    const colorRules = CATEGORIES.map(c =>
      '[data-lrc-cat="' + c.id + '"],.lrc-chip[data-lrc-id="' + c.id + '"]{--lrc-c:' + c.color + '}').join('\n');
    const hideRules = [
      ...CATEGORIES.map(c => 'html[data-lrc-filter="' + c.id + '"] [data-lrc-cat]:not([data-lrc-cat="' + c.id + '"])'),
      ...RULE_FILTERS.map(r => 'html[data-lrt-rule-filter="' + r.slug + '"] [data-lrt-rule]:not([data-lrt-rule="' + r.slug + '"])'),
      ...ALT_FILTERS.map(a => 'html[data-lrt-alt-filter="' + a.slug + '"] [data-lrt-alt]:not([data-lrt-alt="' + a.slug + '"])'),
      ...REP_FILTERS.map(a => 'html[data-lrt-rep-filter="' + a.slug + '"] [data-lrt-rep]:not([data-lrt-rep="' + a.slug + '"])'),
      ...MT_FILTERS.map(a => 'html[data-lrt-mt-filter="' + a.slug + '"] [data-lrt-mt]:not([data-lrt-mt="' + a.slug + '"])'),
    ].join(',\n');
    const altColors = ALT_FILTERS.map(a =>
      '.lrt-achip[data-lrt-aid="' + a.slug + '"],.lrt-alts[data-st="' + a.slug + '"]{--lrt-ac:' + a.color +
      ';--lrt-ac-bg:' + rgba(a.color, .11) + ';--lrt-ac-line:' + rgba(a.color, .32) + '}\n' +
      '.lrt-altbulk[data-kind="' + a.slug + '"]{background:' + rgba(a.color, .07) + ';border-left-color:' + a.color + '}').join('\n') +
      '\n' + REP_FILTERS.map(a => '.lrt-pchip[data-lrt-pid="' + a.slug + '"]{--lrt-ac:' + a.color + '}').join('\n');
    const btn = suffix => BTN.split(',').map(x => x + suffix).join(',');

    const s = document.createElement('style');
    s.id = 'lrt-style';
    s.textContent = colorRules + '\n' + altColors + '\n' + hideRules + `{display:none !important}
      html[data-lrc-filter]:not([data-lrc-filter="all"]) .lrc-head:not(.lrt-fhead),
      html[data-lrt-forum-filter="on"] .lrc-head,
      html[data-lrt-rule-filter]:not([data-lrt-rule-filter="all"]) .lrc-head,
      html[data-lrt-alt-filter]:not([data-lrt-alt-filter="all"]) .lrc-head,
      html[data-lrt-rep-filter]:not([data-lrt-rep-filter="all"]) .lrc-head,
      html[data-lrt-mt-filter]:not([data-lrt-mt-filter="all"]) .lrc-head{display:none !important}

      :root{--lrt-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        --lrt-gold:#e0cd9e;--lrt-gold-2:#f4e7c8;--lrt-gold-dim:rgba(224,205,158,.34);--lrt-gold-faint:rgba(224,205,158,.10);
        --lrt-s0:#0b0b0d;--lrt-s1:#111114;--lrt-s2:#18181c;--lrt-s3:#202026;--lrt-line:rgba(255,255,255,.08);--lrt-line-2:rgba(255,255,255,.14);
        --lrt-text:#ece8de;--lrt-muted:#9c978b;--lrt-faint:#6f6b62;
        --lrt-ok:#4cc98a;--lrt-rej:#ff9474;--lrt-ban:#ff5466;--lrt-man:#ffb648;--lrt-info:#8fb6ff;--lrt-foid:#e486b8}

      /* every button: reacts instantly, no double-tap zoom, visible press */
      ${BTN}{touch-action:manipulation;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;
        -webkit-user-select:none;user-select:none;cursor:pointer;
        transition:transform .1s ease,background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}
      ${btn(':active:not(:disabled)')}{transform:scale(.97)}
      ${btn(':focus-visible')}{outline:2px solid var(--lrt-gold);outline-offset:2px}
      ${btn(':disabled')}{cursor:default}

      /* ── Report Center panel (5.5) ── */
      html[data-lrt-q="1"] .lrt-nomatch,html[data-lrt-q="1"] .lrc-head{display:none !important}
      .lrc-bar{position:relative;margin:10px;padding:14px 0 12px;border-radius:20px;border:1px solid rgba(224,205,158,.22);
        background:radial-gradient(120% 70% at 0% 0%,rgba(224,205,158,.10),transparent 55%),linear-gradient(180deg,#151518 0%,#0d0d10 100%);
        box-shadow:0 1px 0 rgba(241,227,194,.14) inset,0 14px 34px rgba(0,0,0,.45);color:var(--lrt-text);font-family:var(--lrt-font);
        -webkit-font-smoothing:antialiased;overflow:hidden}
      .lrt-hd{display:flex;align-items:center;gap:11px;padding:0 14px}
      .lrt-logo{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:13px;
        background:linear-gradient(140deg,#faf0d8 0%,#e0cd9e 45%,#9a8a66 100%);color:#15110a;font:900 14px/1 var(--lrt-font);letter-spacing:.02em;
        box-shadow:0 0 0 1px rgba(255,247,230,.35) inset,0 6px 18px rgba(224,205,158,.22)}
      .lrt-hd-t{min-width:0;flex:1}
      .lrt-hd-t b{display:block;font:800 17px/1.15 var(--lrt-font);letter-spacing:.01em;color:#f6f1e4}
      .lrt-hd-sub{display:block;margin-top:3px;font:600 12px/1.3 var(--lrt-font);color:var(--lrt-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lrt-hd-ver{flex:none;align-self:flex-start;margin-top:2px;padding:3px 8px;border-radius:999px;border:1px solid rgba(224,205,158,.3);
        font:800 10px/1 var(--lrt-font);letter-spacing:.06em;color:rgba(244,231,200,.85)}
      .lrt-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:14px 14px 0}
      .lrt-kpi{min-width:0;padding:9px 6px 8px;border-radius:13px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);text-align:center}
      .lrt-kpi b{display:block;font:800 19px/1.1 var(--lrt-font);font-variant-numeric:tabular-nums;color:#f1e3c2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lrt-kpi span{display:block;margin-top:3px;font:700 10px/1 var(--lrt-font);letter-spacing:.06em;text-transform:uppercase;color:rgba(236,232,222,.5)}
      .lrt-kpi[data-k="open"]{background:linear-gradient(180deg,rgba(224,205,158,.14),rgba(224,205,158,.05));border-color:rgba(224,205,158,.32)}

      /* category tabs: one segmented control */
      .lrc-chips{display:flex;gap:4px;margin:14px 14px 0;padding:4px;border-radius:14px;background:#0a0a0c;border:1px solid rgba(255,255,255,.07);
        overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}
      .lrc-chips::-webkit-scrollbar{display:none}
      .lrc-chip{position:relative;flex:1 1 0;min-width:0;display:inline-flex;flex-direction:column-reverse;align-items:center;justify-content:center;gap:3px;
        min-height:50px;margin:0;padding:6px 2px;border:0;border-radius:10px;background:transparent;color:#a9a497;
        font:700 11.5px/1 var(--lrt-font);letter-spacing:.01em;white-space:nowrap;-webkit-appearance:none;appearance:none}
      .lrc-chip[hidden]{display:none}
      .lrc-chip::after{content:"";position:absolute;left:30%;right:30%;bottom:4px;height:2px;border-radius:2px;background:var(--lrc-c,#e0cd9e);opacity:.55}
      .lrc-chip[data-lrc-id="all"]::after{background:var(--lrt-gold)}
      .lrc-chip-n{font:800 17px/1 var(--lrt-font);font-variant-numeric:tabular-nums;color:#e9e4d6}
      .lrc-chips{position:relative}
      .lrc-chip{z-index:1}
      .lrc-ind{position:absolute;left:0;top:4px;bottom:4px;width:0;border-radius:10px;opacity:0;pointer-events:none;z-index:0;
        background:linear-gradient(180deg,#2a261b,#1b1a15);box-shadow:0 0 0 1px rgba(224,205,158,.5) inset,0 6px 16px rgba(0,0,0,.4),0 0 18px rgba(224,205,158,.12);
        transition:transform .38s cubic-bezier(.22,1,.36,1),width .38s cubic-bezier(.22,1,.36,1),opacity .2s ease}
      @media (prefers-reduced-motion:reduce){.lrc-ind{transition:none}}
      .lrc-chip[aria-pressed="true"]{background:transparent;color:#f8efda}
      .lrc-chip[aria-pressed="true"] .lrc-chip-n{color:#f1e3c2}
      .lrc-chip[aria-pressed="true"]::after{opacity:1;left:22%;right:22%}
      .lrc-chip.is-zero:not([aria-pressed="true"]){opacity:.45}

      /* search */
      .lrt-search{position:relative;display:flex;align-items:center;margin:10px 14px 0}
      .lrt-search-ico{position:absolute;left:13px;top:50%;width:14px;height:14px;margin-top:-8px;border:2px solid rgba(236,232,222,.45);border-radius:50%;pointer-events:none}
      .lrt-search-ico::after{content:"";position:absolute;right:-5px;bottom:-5px;width:6px;height:2px;border-radius:1px;background:rgba(236,232,222,.45);transform:rotate(45deg)}
      .lrt-search input{flex:1;min-width:0;height:44px;margin:0;padding:0 40px 0 38px;border-radius:13px;border:1px solid rgba(255,255,255,.1);
        background:#0f0f12;color:var(--lrt-text);font:500 16px/1 var(--lrt-font);-webkit-appearance:none;appearance:none;outline:none;box-shadow:none}
      .lrt-search input::placeholder{color:rgba(236,232,222,.38)}
      .lrt-search input::-webkit-search-cancel-button{display:none}
      .lrt-search input:focus{border-color:rgba(224,205,158,.55);box-shadow:0 0 0 3px rgba(224,205,158,.14)}
      .lrt-search-x{display:none;position:absolute;right:5px;top:50%;width:34px;height:34px;margin-top:-17px;border:0;border-radius:10px;
        background:rgba(255,255,255,.08);color:var(--lrt-text);font:600 18px/1 var(--lrt-font)}
      .lrt-search.has-q .lrt-search-x{display:block}

      /* collapsible filters */
      .lrt-ftog{display:flex;align-items:center;gap:8px;width:calc(100% - 28px);margin:12px 14px 0;padding:0 2px;min-height:34px;border:0;background:none;
        color:rgba(224,205,158,.85);font:800 11px/1 var(--lrt-font);letter-spacing:.14em;text-transform:uppercase;-webkit-appearance:none;appearance:none}
      .lrt-ftog::after{content:"";order:2;flex:1;height:1px;background:linear-gradient(90deg,rgba(224,205,158,.28),transparent)}
      .lrt-ftog-n{order:1;min-width:18px;padding:3px 6px;border-radius:999px;background:var(--lrt-gold);color:#15110a;font-size:10px;letter-spacing:0;text-align:center}
      .lrt-ftog-n:empty{display:none}
      .lrt-ftog-chev{order:3;width:8px;height:8px;margin:3px 4px 0;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-135deg);transition:transform .2s ease}
      .lrc-bar.is-collapsed .lrt-ftog-chev{transform:rotate(45deg);margin:0 4px 3px}
      .lrc-bar.is-collapsed .lrt-fbody{display:none}
      .lrt-sec{margin:10px 14px 0}
      .lrt-sec[hidden]{display:none}
      .lrt-sec-t{margin:0 2px 7px;font:700 11px/1 var(--lrt-font);letter-spacing:.04em;color:rgba(236,232,222,.55)}
      .lrc-bar[data-cat="multi"] .lrt-sec-forum,.lrc-bar[data-cat="multi"] .lrt-sec-rule{display:none}
      .lrt-rules,.lrt-mtchips,.lrt-repchips,.lrt-forums{display:flex;flex-wrap:wrap;gap:6px}
      .lrt-forums[hidden]{display:none}
      .lrt-rchip{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:34px;margin:0;padding:0 12px;border-radius:999px;
        border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:#d6d1c4;font:650 13px/1 var(--lrt-font);white-space:nowrap;
        -webkit-appearance:none;appearance:none}
      .lrt-rchip[hidden]{display:none}
      .lrt-rchip-n{font-variant-numeric:tabular-nums;color:var(--lrt-muted);font-weight:700;font-size:11.5px}
      .lrt-rchip[aria-pressed="true"]{background:rgba(224,205,158,.14);border-color:rgba(224,205,158,.55);color:#f8efda}
      .lrt-rchip[aria-pressed="true"] .lrt-rchip-n{color:#f8efda}
      .lrt-rchip.is-zero:not([aria-pressed="true"]){opacity:.4}
      .lrt-pchip:not([data-lrt-pid="all"])::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--lrt-ac)}
      .lrt-mchip[data-lrt-mid="both"]::before,.lrt-mchip[data-lrt-mid="cookie"]::before,.lrt-mchip[data-lrt-mid="ip"]::before{content:"";flex:none;width:7px;height:7px;border-radius:50%}
      .lrt-mchip[data-lrt-mid="both"]::before{background:#ff5466}
      .lrt-mchip[data-lrt-mid="cookie"]::before{background:#ff8a65}
      .lrt-mchip[data-lrt-mid="ip"]::before{background:#ffb648}
      .lrt-rule-status{margin:8px 2px 0;font-size:12px;color:var(--lrt-muted)}
      .lrt-rule-status:empty{display:none}
      .lrt-closed-note{margin:8px 16px 0;font-size:12px;color:var(--lrt-muted)}
      .lrt-closed-note:empty{display:none}

      /* Multi-Account: verdict tiles */
      .lrt-altrow{display:none;flex-direction:column}
      .lrc-bar[data-cat="multi"] .lrt-altrow{display:flex}
      .lrt-altchips{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
      .lrt-achip{position:relative;display:flex;align-items:center;gap:8px;min-width:0;min-height:54px;margin:0;padding:8px 10px 8px 8px;border-radius:14px;text-align:left;
        border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.035);color:var(--lrt-text);-webkit-appearance:none;appearance:none;font-family:var(--lrt-font)}
      .lrt-achip[data-lrt-aid="all"]{--lrt-ac:#e0cd9e;--lrt-ac-bg:rgba(224,205,158,.12);--lrt-ac-line:rgba(224,205,158,.4)}
      .lrt-ai{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:8px;font:800 13px/1 var(--lrt-font);font-style:normal;
        color:var(--lrt-ac);background:var(--lrt-ac-bg);border:1px solid var(--lrt-ac-line)}
      .lrt-at{flex:1;min-width:0}
      .lrt-at strong{display:block;font:750 12.5px/1.2 var(--lrt-font);letter-spacing:-.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lrt-at small{display:block;margin-top:2px;font:550 11px/1.25 var(--lrt-font);color:rgba(236,232,222,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lrt-achip .lrt-rchip-n{flex:none;font:800 15px/1 var(--lrt-font);font-variant-numeric:tabular-nums;color:#f3eee0}
      .lrt-achip[aria-pressed="true"]{background:var(--lrt-ac-bg);border-color:var(--lrt-ac-line);box-shadow:0 0 0 1px var(--lrt-ac-line) inset}
      .lrt-achip[aria-pressed="true"] strong,.lrt-achip[aria-pressed="true"] .lrt-rchip-n{color:var(--lrt-ac)}
      .lrt-achip.is-zero:not([aria-pressed="true"]){opacity:.38}
      .lrt-alt-progress{height:3px;margin:12px 14px 0;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden}
      .lrt-alt-progress[hidden]{display:none}
      .lrt-alt-progress i{display:block;height:100%;width:0;border-radius:2px;background:linear-gradient(90deg,#b09d73,#f4e7c8);transition:width .3s ease}
      .lrt-alt-status{margin:8px 16px 0;font-size:12px;line-height:1.4;color:var(--lrt-muted)}
      .lrt-alt-status:empty{display:none}
      .lrt-altbulk{margin:12px 14px 0;padding:13px 14px;border-radius:16px;border:1px solid var(--lrt-line);border-left:3px solid var(--lrt-ok);
        background:rgba(76,201,138,.07)}
      .lrt-altbulk[hidden]{display:none}
      .lrt-altbulk[data-kind="all"]{background:rgba(255,255,255,.03);border-left-color:var(--lrt-gold)}
      .lrt-altbulk-warn{margin:-4px 2px 12px;font-size:12.5px;line-height:1.35;font-weight:700;color:var(--lrt-man)}
      .lrt-altbulk-warn:empty{display:none}
      .lrt-altbulk-text{margin:0 2px 12px;font:14px/1.35 var(--lrt-font);color:var(--lrt-text)}
      .lrt-altbulk-text strong{display:block;font-weight:800}
      .lrt-altbulk-text small{display:block;margin-top:3px;font-size:12px;font-weight:500;color:var(--lrt-muted)}
      .lrt-altbulk-row{display:flex;gap:8px}

      /* "6 of 24 open match · Reset filters" */
      .lrt-sum{display:none;align-items:center;gap:10px;margin:12px 14px 0;padding:9px 10px 9px 13px;border-radius:13px;
        background:rgba(224,205,158,.07);border:1px solid rgba(224,205,158,.22)}
      .lrc-bar.has-filters .lrt-sum{display:flex}
      .lrt-sum.is-none{background:rgba(255,148,116,.08);border-color:rgba(255,148,116,.3)}
      .lrt-sum-t{flex:1;min-width:0;font:650 12.5px/1.35 var(--lrt-font);color:#e9dfc0}
      .lrt-reset{flex:none;min-height:32px;padding:0 12px;border-radius:10px;border:1px solid rgba(224,205,158,.45);background:transparent;
        color:var(--lrt-gold-2);font:750 12.5px/1 var(--lrt-font);-webkit-appearance:none;appearance:none}
      .lrc-empty{display:none;margin:10px 16px 0;font-size:13px;color:var(--lrt-muted)}
      .lrc-bar.is-empty .lrc-empty{display:block}
      @media (max-width:360px){.lrt-kpi b{font-size:16px}.lrt-at small{display:none}}

      /* category section headers */
      .lrc-head{display:flex !important;align-items:center;gap:8px;margin:22px 12px 6px;padding:0 2px;
        list-style:none;border:0 !important;background:none !important;font:800 11.5px/1.3 var(--lrt-font);letter-spacing:.08em;
        text-transform:uppercase;color:var(--lrt-gold-2)}
      .lrc-head::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--lrc-c)}
      .lrc-head.lrc-gone{display:none !important}
      .lrc-head-n{margin-left:auto;font-size:11.5px;font-weight:700;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;color:var(--lrt-muted)}
      /* subforum groups inside Posts: quieter than the category header */
      .lrc-head.lrt-fhead{margin:16px 14px 4px;padding:0;font:700 13px/1.3 var(--lrt-font);letter-spacing:0;text-transform:none;color:#cfcabd}
      .lrc-head.lrt-fhead::before{width:5px;height:5px;background:var(--lrt-faint)}
      .lrt-fhead .lrc-head-n{font-size:11.5px}

      /* ── one card per report, XenForo's own row is hidden ── */
      .lrt-carded{display:block !important;margin:0 !important;padding:0 !important;border:0 !important;
        background:transparent !important;box-shadow:none !important}
      .lrt-carded > :not(.lrt-card){display:none !important}
      .lrt-card{contain:layout paint;margin:10px;padding:12px 13px 11px;border:1px solid var(--lrt-line);border-left:3px solid var(--lrc-c);
        border-radius:14px;background:linear-gradient(180deg,#141417 0%,#0f0f12 100%);
        color:var(--lrt-text);font:14.5px/1.42 var(--lrt-font);transition:opacity .2s ease,transform .2s ease}
      .lrt-card.is-leaving{opacity:0;transform:scale(.97)}
      .lrt-card{touch-action:pan-y}
      .lrt-card.is-swiping{transition:none;position:relative;z-index:1;will-change:transform;box-shadow:0 10px 30px rgba(0,0,0,.45)}
      .lrt-carded[data-lrt-swipe]{position:relative}
      .lrt-carded[data-lrt-swipe]::before{position:absolute;inset:10px;z-index:0;display:flex;align-items:center;padding:0 22px;border-radius:14px;
        font:800 13px/1 var(--lrt-font);letter-spacing:.12em;text-transform:uppercase;border:1px dashed}
      .lrt-carded[data-lrt-swipe^="ok"]::before{content:"✓\\00a0\\00a0Resolve";justify-content:flex-start;color:#7fe0ad;
        background:rgba(76,201,138,.08);border-color:rgba(76,201,138,.35)}
      .lrt-carded[data-lrt-swipe^="rej"]::before{content:"Reject\\00a0\\00a0✕";justify-content:flex-end;color:#ffad95;
        background:rgba(255,148,116,.08);border-color:rgba(255,148,116,.35)}
      .lrt-carded[data-lrt-swipe="ok"]::before{background:rgba(76,201,138,.22);border-style:solid}
      .lrt-carded[data-lrt-swipe="rej"]::before{background:rgba(255,148,116,.22);border-style:solid}
      .lrt-card-top{display:flex;align-items:center;gap:6px;margin-bottom:7px;font-size:12px;color:var(--lrt-muted)}
      .lrt-tag{display:inline-flex;align-items:center;gap:6px;padding:2px 9px 2px 7px;border-radius:999px;border:1px solid var(--lrt-line);
        background:rgba(255,255,255,.04);font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--lrc-c)}
      .lrt-tag::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--lrc-c)}
      .lrt-count{padding:2px 8px;border-radius:999px;border:1px solid rgba(255,182,72,.38);background:rgba(255,182,72,.10);color:#ffd28a;font-weight:700;font-size:11px}
      .lrt-time{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
      .lrt-title{display:block;color:#f4f0e6 !important;font-size:16px;font-weight:700;line-height:1.3;letter-spacing:-.005em;
        text-decoration:none !important;overflow-wrap:anywhere}
      .lrt-who{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:8px;font-size:12px}
      .lrt-who:empty{display:none}
      .lrt-user{font-weight:700;color:var(--lrt-gold-2);margin-right:2px}
      a.lrt-user{color:var(--lrt-gold-2) !important;text-decoration:none !important}
      .lrt-fact{padding:2px 7px;border-radius:6px;border:1px solid var(--lrt-line);background:rgba(255,255,255,.05);color:#d3cec2;
        font-weight:600;font-size:11.5px;font-variant-numeric:tabular-nums}
      .lrt-forum.is-away{color:#ffd28a;border-color:rgba(255,182,72,.38);background:rgba(255,182,72,.08)}

      /* ── verdict strip: the one loud thing on a Multi-Account card ── */
      .lrt-alts{margin-top:10px;padding:11px 12px;border-radius:12px;background:var(--lrt-ac-bg,var(--lrt-s1));
        border:1px solid var(--lrt-ac-line,var(--lrt-line));border-left:3px solid var(--lrt-ac,var(--lrt-faint));font:13.5px/1.4 var(--lrt-font)}
      .lrt-alts[data-st="loading"]{background:var(--lrt-s1);border-color:var(--lrt-line);border-left-color:var(--lrt-gold-dim)}
      .lrt-alts-head{display:flex;align-items:center;gap:9px}
      .lrt-alts-skel{display:flex;flex-direction:column;gap:9px;margin-top:11px}
      .lrt-alts-skel i{display:block;height:12px;border-radius:6px;background:#1c1c21}
      .lrt-alts-skel i:nth-child(2){width:72%}
      .lrt-alts-skel i:nth-child(3){width:48%}
      .lrt-alts-icon{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;
        background:var(--lrt-ac,#3a3a40);color:#111114;font:900 13px/1 var(--lrt-font)}
      .lrt-alts[data-st="loading"] .lrt-alts-icon{background:var(--lrt-gold-faint);border:1px solid var(--lrt-gold-dim)} /* no animation: hundreds of cards wait at once */
      .lrt-alts-label{font-size:12.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--lrt-ac,var(--lrt-muted))}
      .lrt-alts[data-st="loading"] .lrt-alts-label{color:var(--lrt-gold-2);opacity:.8}
      .lrt-alts-n{margin-left:auto;font-size:11.5px;font-weight:700;color:var(--lrt-muted);font-variant-numeric:tabular-nums}
      .lrt-alts-list{display:flex;flex-direction:column;margin-top:9px;border-top:1px solid var(--lrt-line)}
      .lrt-alt{display:flex;flex-wrap:wrap;align-items:center;gap:3px 7px;padding:7px 0 0;color:var(--lrt-text) !important;
        text-decoration:none !important;overflow-wrap:anywhere}
      .lrt-alt b{font-weight:700}
      .lrt-alt i{padding:1px 6px;border-radius:5px;border:1px solid var(--lrt-line);background:rgba(255,255,255,.04);color:#b9b3a6;
        font-size:10px;font-style:normal;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
      .lrt-alt i[data-c="rejected"]{color:#7fe0ad;border-color:rgba(76,201,138,.32)}
      .lrt-alt i[data-c="active"]{color:#ffd28a;border-color:rgba(255,182,72,.4);background:rgba(255,182,72,.08)}
      .lrt-alt i[data-c="banned"]{color:#ff8d99;border-color:rgba(255,84,102,.42);background:rgba(255,84,102,.08)}
      .lrt-alt i[data-c="foid"]{color:#f4b6d6;border-color:rgba(228,134,184,.42);background:rgba(228,134,184,.08)}
      .lrt-alt i[data-c="pending"]{color:#b9d0ff;border-color:rgba(143,182,255,.38)}
      .lrt-alt i[data-c="deleted"]{color:#c4b9ea;border-color:rgba(169,155,216,.36)}
      .lrt-alt[data-c="deleted"] b{text-decoration:line-through;color:var(--lrt-muted)}
      .lrt-alt small{margin-left:auto;font-size:11px;font-weight:600;color:var(--lrt-muted)}
      .lrt-alt .lm-det{margin-left:auto}
      .lrt-why{flex-basis:100%;display:flex;flex-direction:column;gap:4px;margin-top:2px;padding:6px 9px;
        border-radius:8px;background:rgba(255,84,102,.06);border:1px solid rgba(255,84,102,.14);font-size:12.5px;line-height:1.35;color:#e2ded4;font-weight:500}
      .lrt-why-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:1px 7px}
      .lrt-why-line + .lrt-why-line{padding-top:4px;border-top:1px solid var(--lrt-line)}
      .lrt-alt[data-c="foid"] .lrt-why{background:rgba(228,134,184,.07);border-color:rgba(228,134,184,.16)}
      .lrt-why em{font-style:normal;font-size:10.5px;font-weight:800;letter-spacing:.03em;color:var(--lrt-muted)}
      .lrt-why-more{font-size:11px;color:var(--lrt-muted)}
      .lrt-why.is-dim,.lrt-why .is-dim{color:var(--lrt-muted);font-weight:400}
      .lrt-alts-note{margin-top:9px;font-size:12.5px;color:#cfc9bc}
      .lrt-alts-flag{margin-top:4px;font-size:12px;font-weight:600;color:var(--lrt-man)}

      /* placeholder while the reason loads */
      .lrt-skel{display:flex;flex-direction:column;gap:9px;padding:12px;border-radius:10px;background:var(--lrt-s1);border:1px solid var(--lrt-line)}
      .lrt-skel + .lrt-skel{margin-top:8px}
      .lrt-skel i{display:block;height:10px;border-radius:5px;background:#1f1f24;animation:lrt-pulse 1.3s ease-in-out infinite}
      .lrt-skel i:nth-child(2){width:82%;animation-delay:.12s}
      .lrt-skel i:nth-child(3){width:56%;animation-delay:.24s}
      .lrt-skel.lrt-skel-sm i{width:38%}
      .lrt-skel.lrt-skel-sm i:nth-child(2){width:64%}
      @keyframes lrt-pulse{50%{opacity:.4}}
      .lrt-loaderr{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;border:1px solid rgba(255,84,102,.3);
        border-left:3px solid var(--lrt-ban);background:rgba(255,84,102,.07)}
      .lrt-loaderr .lrt-msg{color:#ff8d99}

      /* marked: the card folds up to title + status */
      .lrt-state{display:none;align-items:center;justify-content:space-between;gap:10px;margin-top:9px;
        padding:5px 5px 5px 12px;border-radius:10px;border:1px solid var(--lrt-line);font-size:13px;font-weight:700}
      .lrt-state-text::before{content:"";display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:currentColor;vertical-align:1px}
      .lrt-card.is-marked .lrt-state{display:flex;animation:lrt-in .18s ease-out}
      @keyframes lrt-in{from{opacity:0;transform:translateY(-4px)}}
      .lrt-card.is-marked .lrt-who,.lrt-card.is-marked .lrt-alts,.lrt-card.is-marked .lrt-prev{display:none}
      .lrt-card.is-marked .lrt-title{opacity:.7}
      .lrt-card.is-ok{border-left-color:var(--lrt-ok)}
      .lrt-card.is-ok .lrt-state{color:#9be7bf;background:rgba(76,201,138,.10);border-color:rgba(76,201,138,.38)}
      .lrt-card.is-rej{border-left-color:var(--lrt-rej)}
      .lrt-card.is-rej .lrt-state{color:#ffb39c;background:rgba(255,148,116,.10);border-color:rgba(255,148,116,.38)}
      .lrt-card.is-ban{border-left-color:var(--lrt-foid)}
      .lrt-card.is-ban .lrt-state{color:#f6c4df;background:rgba(228,134,184,.10);border-color:rgba(228,134,184,.4)}
      .lrt-banbtn{display:block;width:100%;min-height:44px;margin-top:10px;border-radius:10px;border:1px solid rgba(228,134,184,.5);
        background:rgba(228,134,184,.13);color:#f6c4df;font:700 14px var(--lrt-font)}
      .lrt-b.lrt-banall{display:flex;width:100%;margin-bottom:8px;background:rgba(228,134,184,.13);border-color:rgba(228,134,184,.5);color:#f6c4df !important}
      .lrt-b.lrt-banall[hidden]{display:none}
      .lrt-undo{min-height:34px;padding:0 13px;border-radius:9px;border:1px solid var(--lrt-line-2);
        background:var(--lrt-s2);color:var(--lrt-text);font:700 13px var(--lrt-font)}

      /* reason and full report */
      .lrt-prev{margin-top:11px}
      .lrt-card--multi:not(.is-details) .lrt-body{display:none}
      .lrt-label{margin-bottom:6px;font:800 10px/1 var(--lrt-font);letter-spacing:.09em;text-transform:uppercase;color:rgba(224,205,158,.75)}
      .lrt-reason{padding:10px 12px;border-radius:10px;background:var(--lrt-s1);border:1px solid var(--lrt-line)}
      .lrt-reason + .lrt-reason{margin-top:8px}
      .lrt-reason-text{font-size:14.5px;line-height:1.45;color:#e8e4da;overflow-wrap:anywhere}
      .lrt-reason-text a{color:var(--lrt-gold-2) !important;text-decoration:none !important}
      .lrt-reason-text ul,.lrt-reason-text ol{margin:6px 0;padding-left:18px}
      .lrt-reason-text .button,.lrt-reason-text button{min-height:0;margin:4px 0;padding:3px 9px;border-radius:7px;
        font-size:12px;line-height:1.4}
      .lrt-reason-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:7px;font-size:12px;color:var(--lrt-muted)}
      .lrt-reason-meta strong{color:#d1ccc0;font-weight:700}
      .lrt-msg{color:var(--lrt-muted);font-size:13.5px}

      /* 5.9: the reported post itself, its translation and the slang under it */
      .lrt-content{margin-bottom:12px;padding:10px 12px;border-radius:10px;background:#0f0f12;border:1px solid var(--lrt-line);
        border-left:3px solid var(--lrc-c)}
      .lrt-ctext{white-space:pre-wrap;font-size:14.5px;line-height:1.45;color:#ece8de;overflow-wrap:anywhere}
      .lrt-content.is-clamped .lrt-ctext{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:7;overflow:hidden}
      .lrt-content.is-clamped .lrt-tr-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:9;overflow:hidden}
      .lrt-more{margin-top:4px}
      .lrt-tr{margin-top:8px;padding:8px 10px 9px;border-radius:9px;background:rgba(143,182,255,.07);border:1px solid rgba(143,182,255,.30)}
      .lrt-tr-h{display:flex;align-items:center;flex-wrap:wrap;gap:4px 7px;margin-bottom:4px;font:700 11px/1.2 var(--lrt-font);color:#b9d0ff}
      .lrt-tr-flag{padding:2px 6px;border-radius:5px;background:rgba(143,182,255,.16);font-size:10.5px;font-weight:800;letter-spacing:.06em}
      .lrt-tr-from{font-weight:600;color:rgba(185,208,255,.75)}
      .lrt-tr-text{white-space:pre-wrap;font-size:14.5px;line-height:1.45;color:#e6ecff;overflow-wrap:anywhere}
      .lrt-tr--sm{margin-top:7px;padding:6px 9px 7px}
      .lrt-tr--sm .lrt-tr-text{font-size:13.5px}
      .lrt-slang{display:flex;flex-direction:column;gap:3px;margin-top:8px;padding:7px 10px;border-radius:9px;
        background:rgba(224,205,158,.06);border:1px dashed rgba(224,205,158,.38);font-size:12.5px;line-height:1.35;color:#d9cfae}
      .lrt-slang-t{font:800 10px/1.2 var(--lrt-font);letter-spacing:.09em;text-transform:uppercase;color:rgba(224,205,158,.8)}
      .lrt-slang b{color:var(--lrt-gold-2)}
      .lrt-trnote{margin-top:6px;font-size:12px;color:var(--lrt-muted)}
      .lrt-trnote[data-k="err"]{color:#ff8d99}
      .lrt-trnote[data-k="run"]{color:#b9d0ff}
      .lrt-trbtn{color:#b9d0ff}
      .lrt-trbtn::after{display:none}
      .lrt-trrow{display:flex;align-items:center;gap:8px;margin:10px 14px 0}
      .lrt-trrow-t{flex:none;font:800 10.5px/1 var(--lrt-font);letter-spacing:.09em;text-transform:uppercase;color:rgba(236,232,222,.55)}
      .lrt-trseg{flex:none;display:inline-flex;gap:3px;padding:3px;border-radius:10px;background:#0a0a0c;border:1px solid rgba(255,255,255,.07)}
      .lrt-trchip{min-height:30px;min-width:42px;margin:0;padding:0 10px;border:0;border-radius:7px;background:transparent;color:#a9a497;
        font:750 12.5px/1 var(--lrt-font);-webkit-appearance:none;appearance:none}
      .lrt-trchip[aria-pressed="true"]{background:rgba(224,205,158,.16);color:#f8efda;box-shadow:0 0 0 1px rgba(224,205,158,.45) inset}
      .lrt-trrow-s{flex:1;min-width:0;text-align:right;font:600 11px/1.3 var(--lrt-font);color:var(--lrt-muted);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lrt-full{display:none;margin-top:8px;padding:10px 12px;border-radius:10px;background:var(--lrt-s1);border:1px solid var(--lrt-line);overflow:hidden}
      .lrt-full.is-open{display:block}
      .lrt-full img,.lrt-full video,.lrt-full iframe{max-width:100% !important;height:auto}

      /* Full report / Report details / Try again: quiet text buttons */
      .lrt-tools{display:flex;gap:8px;margin-top:6px}
      .lrt-card--multi .lrt-tools{margin-top:0}
      .lrt-card--multi.is-details .lrt-tools{margin-top:6px}
      .lrt-tool{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 4px;border:0;background:none;
        color:var(--lrt-gold-2);font:700 13px var(--lrt-font)}
      .lrt-tool::after{content:"";width:6px;height:6px;margin-top:-3px;border-right:2px solid currentColor;
        border-bottom:2px solid currentColor;transform:rotate(45deg);transition:transform .15s ease}
      .lrt-tool.is-on::after{margin-top:3px;transform:rotate(-135deg)}
      .lrt-loaderr .lrt-tool::after,.lrt-copyraw::after{display:none}
      .lrt-rawtools{margin-top:6px}
      .lrt-copyraw{color:var(--lrt-muted);font-weight:600}

      /* buttons (same as the queue's) */
      .lrt-bar{display:flex;gap:8px;margin-top:10px}
      .lrt-b{flex:1;display:flex;align-items:center;justify-content:center;min-height:46px;border-radius:11px;
        border:1px solid var(--lrt-line);background:var(--lrt-s2);color:var(--lrt-text) !important;text-decoration:none !important;
        font:700 14.5px var(--lrt-font)}
      .lrt-b:disabled{opacity:.35}
      .lrt-link{flex:0 0 auto;padding:0 16px;background:transparent;color:#d6d1c4 !important}
      .lrt-ok{background:rgba(76,201,138,.14);border-color:rgba(76,201,138,.45);color:#9be7bf !important}
      .lrt-rej{background:rgba(255,148,116,.12);border-color:rgba(255,148,116,.45);color:#ffb39c !important}
      .lrt-gold{background:linear-gradient(180deg,#f3e6c6,#b09d73);border-color:#f1e2bf;color:#161104 !important}
      .lrt-danger{background:rgba(255,84,102,.14);border-color:rgba(255,84,102,.5);color:#ffb3bb !important}
      .lrt-err{padding-top:8px;color:#ff8d99;font-size:12.5px;font-weight:600}
      .lrt-hidden,[data-lrt-closed]{display:none !important}
      .lrt-closed-note{margin:8px 12px 0;font-size:12px;color:var(--lrt-muted)}
      .lrt-closed-note:empty{display:none}
      .lrt-ver{margin:10px 12px 0;font-size:10px;font-weight:700;letter-spacing:.06em;color:rgba(224,205,158,.55);display:flex;gap:10px;align-items:baseline;justify-content:space-between}
      .lrt-ver-stats{color:rgba(244,231,200,.9);font-variant-numeric:tabular-nums;letter-spacing:.02em;font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lrt-ver-n{flex:none}

      /* status dock: same as the queue's (bottom, LM mark, gold progress line), slides in and out */
      #lrt-dock{position:fixed;left:8px;right:8px;bottom:calc(10px + env(safe-area-inset-bottom, 0px));z-index:99990;
        max-width:560px;margin:0 auto;display:flex;align-items:center;gap:8px;padding:8px 8px 9px 12px;border-radius:16px;
        background:linear-gradient(180deg,#141417,#0b0b0d);border:1px solid var(--lrt-gold-dim);color:var(--lrt-text);font:600 13px/1.3 var(--lrt-font);
        box-shadow:0 8px 28px rgba(0,0,0,.6);overflow:hidden;
        transform:translateY(calc(100% + 40px));opacity:0;visibility:hidden;pointer-events:none;
        transition:transform .26s cubic-bezier(.2,.8,.2,1),opacity .2s ease,visibility 0s linear .26s,border-color .2s ease}
      #lrt-dock.show{transform:none;opacity:1;visibility:visible;pointer-events:auto;
        transition:transform .26s cubic-bezier(.2,.8,.2,1),opacity .2s ease,visibility 0s,border-color .2s ease}
      #lrt-dock[data-mode="ask-send"]{border-color:#f1e2bf}
      #lrt-dock[data-mode="ask-undo"]{border-color:rgba(255,84,102,.6)}
      .lrt-brand{flex:0 0 auto;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;background:linear-gradient(145deg,#f4e7c8,#b09d73);
        color:#141004;font:900 11px/1 var(--lrt-font)}
      .lrt-dock-text{flex:1;min-width:0;font-size:12.5px;line-height:1.25}
      .lrt-dock-text strong{display:block;font-weight:800;color:var(--lrt-text)}
      #lrt-dock.busy .lrt-dock-text strong{color:var(--lrt-gold-2)}
      #lrt-dock.summary .lrt-dock-text strong{color:var(--lrt-ok)}
      #lrt-dock.summary.has-fail .lrt-dock-text strong{color:var(--lrt-man)}
      .lrt-dock-text small{display:block;margin-top:2px;font-size:11.5px;font-weight:600;color:var(--lrt-muted)}
      .lrt-dock-row{display:flex;flex:none;gap:6px}
      #lrt-dock .lrt-dock-row .lrt-b{flex:none;min-height:34px;padding:0 12px;border-radius:10px;font-size:12.5px}
      #lrt-dock.busy .lrt-dock-row,#lrt-dock.summary .lrt-dock-row{display:none}
      #lrt-dock.busy .lrt-dock-text,#lrt-dock.summary .lrt-dock-text{padding:4px 0 6px}
      #lrt-dock.summary{cursor:pointer}
      .lrt-dock-progress{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.06);overflow:hidden;opacity:0;transition:opacity .2s ease}
      #lrt-dock.busy .lrt-dock-progress{opacity:1}
      .lrt-dock-progress i{display:block;width:0;height:100%;background:linear-gradient(90deg,#b09d73,#f4e7c8);transition:width .25s ease}
      body.lrt-has-dock{padding-bottom:calc(80px + env(safe-area-inset-bottom, 0px))}

      /* ── 5.12: compact panel — header in one line, every filter in one swipeable row ── */
      .lrc-bar{padding:12px 0 10px}
      .lrt-hd{gap:10px;padding:0 12px 0 14px}
      .lrt-logo{width:34px;height:34px;border-radius:11px;font-size:12.5px}
      .lrt-hd-t{overflow:hidden}
      .lrt-hd-t b{display:flex;align-items:baseline;gap:7px;font-size:16px;white-space:nowrap}
      .lrt-hd-v{font:700 10px/1 var(--lrt-font);letter-spacing:.04em;color:rgba(224,205,158,.55)}
      .lrt-hd-line{display:flex;align-items:baseline;gap:6px;min-width:0;margin-top:3px}
      .lrt-hd-line .lrt-hd-sub{flex:0 1 auto;margin:0}
      .lrt-hd-line .lrt-trrow-s{flex:0 1 auto;min-width:0;text-align:left;font:600 11px/1.3 var(--lrt-font);color:rgba(236,232,222,.42);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lrt-hd-line .lrt-trrow-s:not(:empty)::before{content:"·";margin-right:6px}
      .lrt-hd .lrt-trseg{flex:none;align-self:center;gap:2px;padding:2px;border-radius:9px}
      .lrt-hd .lrt-trchip{min-height:28px;min-width:0;padding:0 8px;border-radius:7px;font-size:11.5px}
      @media (max-width:380px){.lrt-hd-v{display:none}}
      .lrc-chips{margin-top:12px}
      .lrc-chip{min-height:46px}
      .lrt-ftog{margin-top:10px;min-height:30px}
      .lrt-fpills{display:none;flex-wrap:wrap;gap:6px;margin:2px 14px 0}
      .lrc-bar.is-collapsed.has-filters .lrt-fpills{display:flex}
      .lrt-fpill{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:28px;margin:0;padding:0 5px 0 11px;border-radius:999px;
        border:1px solid rgba(224,205,158,.45);background:rgba(224,205,158,.12);color:#f3e6c6;font:650 12px/1 var(--lrt-font);
        -webkit-appearance:none;appearance:none}
      .lrt-fpill span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .lrt-fpill i{flex:none;display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,.35);
        font:700 13px/1 var(--lrt-font);font-style:normal;color:#f3e6c6}
      .lrt-sec{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:8px 0 0 14px}
      .lrt-sec-t{flex:none;width:62px;margin:0;font:800 10px/1.2 var(--lrt-font);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;color:rgba(236,232,222,.45)}
      /* options with something left first, "All" always first, empty-but-marked ones at the end */
      .lrt-rchip.is-zero:not([aria-pressed="true"]),.lrt-achip.is-zero:not([aria-pressed="true"]){order:2}
      .lrt-sec .lrt-rchip[data-lrt-rid="all"],.lrt-sec .lrt-rchip[data-lrt-fid="all"],.lrt-sec .lrt-rchip[data-lrt-pid="all"],
        .lrt-sec .lrt-rchip[data-lrt-mid="all"],.lrt-sec .lrt-achip[data-lrt-aid="all"]{order:-1}
      .lrt-rules,.lrt-mtchips,.lrt-repchips,.lrt-forums,.lrt-altchips{flex:1 1 0;min-width:0;display:flex;flex-wrap:nowrap;gap:6px;
        overflow-x:auto;padding:2px 14px 2px 0;scrollbar-width:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}
      .lrt-rules::-webkit-scrollbar,.lrt-mtchips::-webkit-scrollbar,.lrt-repchips::-webkit-scrollbar,.lrt-forums::-webkit-scrollbar,
        .lrt-altchips::-webkit-scrollbar{display:none}
      .lrt-forums[hidden]{display:none}
      .lrt-rchip{min-height:32px;padding:0 11px;font-size:12.5px}
      .lrt-rule-status{flex-basis:100%;margin:2px 14px 0 72px}
      .lrt-altchips{grid-template-columns:none}
      .lrt-achip{flex:none;min-height:32px;gap:6px;padding:0 11px 0 5px;border-radius:999px}
      .lrt-achip[hidden]{display:none}
      .lrt-ai{width:22px;height:22px;border-radius:50%;font-size:11px}
      .lrt-at{flex:none}
      .lrt-at strong{font-size:12.5px}
      .lrt-at small{display:none}
      .lrt-achip .lrt-rchip-n{font:700 11.5px/1 var(--lrt-font);color:var(--lrt-muted)}
      .lrt-achip[aria-pressed="true"] .lrt-rchip-n{color:var(--lrt-ac)}
      .lrt-ahint{margin:5px 14px 0 86px;font:650 12px/1.3 var(--lrt-font);color:#e9dfc0}
      .lrt-ahint:empty{display:none}
      .lrt-sum{margin-top:10px}
      /* the group heading already names the category -> the tag on every card is left out (it's back while searching) */
      html:not([data-lrt-q="1"]) .lrt-card .lrt-tag{display:none}

      @media (prefers-reduced-motion: reduce){
        #lrt-dock,.lrt-card,.lrt-dock-progress i,.lrt-alt-progress i,.lrt-tool::after,${BTN}{transition:none !important}
        .lrt-skel i,.lrt-card.is-marked .lrt-state,.lrt-alts-icon{animation:none !important}
      }
    `;
    (document.head || de).appendChild(s);
  }

  function start() {
    root = document.querySelector(ROOT_SEL) || document.body;
    if (!root) return;
    try { sessionStorage.removeItem(OPENED_KEY); } catch (_) {}

    try { [ALT_FILTER_KEY, REP_FILTER_KEY, MT_FILTER_KEY, FORUM_FILTER_KEY].forEach(k => localStorage.removeItem(k)); } catch (_) {}
    addStyle();
    catFilter = readFilter();
    try { altFilter = sessionStorage.getItem(ALT_FILTER_KEY) || 'all'; } catch (_) {}
    try { repFilter = sessionStorage.getItem(REP_FILTER_KEY) || 'all'; } catch (_) {}
    try { mtFilter = sessionStorage.getItem(MT_FILTER_KEY) || 'all'; } catch (_) {}
    try { forumFilter = sessionStorage.getItem(FORUM_FILTER_KEY) || 'all'; } catch (_) {}
    applyFilters();
    document.body.appendChild(dock);
    scan();
    renderDock();
    initSwipe();

    loadClosedTab();
    setTimeout(() => { if (!closedChecked) { closedChecked = true; pumpAlt(); } }, 5000);

    let timer = null;
    mo = new MutationObserver(muts => {
      if (muts.every(m => m.target.closest && m.target.closest('.lrt-card, .lrc-bar, .lrc-head'))) return;
      clearTimeout(timer);
      timer = setTimeout(scan, 300);
    });
    mo.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

function moduleDms() {
  'use strict';

  const CONFIG = {

    BANWARN_WORDS: [
      'ban', 'bans', 'banned', 'unban', 'permaban', 'perma',
      'warn', 'warns', 'warned', 'warning', 'warnings',
      'verwarnung', 'sperre', 'gesperrt',
    ],

    BANWARN_SEPARATE: true,

    PROTECTED: ['Staff Chat', 'Approval Moderators'],

    MY_NAME: '',

    LOAD_ON_FILTER: true,

    PARALLEL: 6,
    PARALLEL_ACTION: 6,
  };

  const VERSION = LM_VERSIONS.dms;
  const ITEM = '.structItem--conversation';
  const NS = 'lmdm:';

  const startItems = document.querySelectorAll(ITEM);
  if (!startItems.length || document.getElementById('lmdDock')) return;

  const mainList = startItems[startItems.length - 1].parentElement;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const plain = (s) => String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  const btn = (cls, text, act) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (act) b.dataset.a = act;
    return b;
  };
  const ss = {
    get(k, d) { try { const v = sessionStorage.getItem(NS + k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { sessionStorage.setItem(NS + k, v); } catch (_) {} },
  };
  const banRe = new RegExp(
    '(?:^|[^a-z0-9äöüß])(?:' + CONFIG.BANWARN_WORDS.map(esc).join('|') + ')(?=$|[^a-z0-9äöüß])', 'i');
  const shield = CONFIG.PROTECTED.map((s) => s.toLowerCase()).filter(Boolean);

  const net = { pauseUntil: 0 };
  async function waitFree() {
    while (Date.now() < net.pauseUntil) await sleep(net.pauseUntil - Date.now());
  }

  function pool(n, par, job, shouldStop) {
    return new Promise((resolve) => {
      const max = Math.max(1, par);
      const min = Math.min(2, max);
      let next = 0, active = 0, limit = max, streak = 0, finished = false;
      const ctl = {
        slower(attempt) {
          limit = Math.max(min, limit - 1);
          streak = 0;
          net.pauseUntil = Math.max(net.pauseUntil, Date.now() + 1500 * (attempt + 1));
        },
        ok() { if (++streak >= 15 && limit < max) { limit++; streak = 0; fill(); } },
      };
      async function worker() {
        try {
          while (!shouldStop() && next < n && active <= limit) {
            const i = next++;
            try { await job(i, ctl); } catch (e) { console.warn('[DM filter] job failed', e); }
          }
        } finally {
          active--;
          fill();
        }
      }
      function fill() {
        while (active < limit && next < n && !shouldStop()) { active++; worker(); }
        if (active === 0 && !finished) { finished = true; resolve(); }
      }
      fill();
    });
  }
  function eta(t0, done, total) {
    if (done < 3 || done >= total) return '';
    const s = ((Date.now() - t0) / done) * (total - done) / 1000;
    return s > 90 ? ' · ~' + Math.ceil(s / 60) + ' min left' : ' · ~' + Math.max(1, Math.round(s)) + ' s left';
  }

  function detectMe() {
    if (CONFIG.MY_NAME.trim()) return { id: '', name: CONFIG.MY_NAME.trim().toLowerCase(), shown: CONFIG.MY_NAME.trim() };
    let id = '', name = '';
    const a = document.querySelector(
      '.p-navgroup-link--user [data-user-id], .p-navgroup--member [data-user-id], .offCanvasMenu [data-user-id]');
    if (a) {
      id = a.getAttribute('data-user-id') || '';
      const lbl = a.querySelector('[aria-label]');
      const img = a.querySelector('img[alt]');
      name = a.getAttribute('title') || (lbl && lbl.getAttribute('aria-label')) || (img && img.getAttribute('alt')) || '';
    }
    const txt = document.querySelector('.p-navgroup-link--user .p-navgroup-linkText');
    if (txt && txt.textContent.trim()) name = txt.textContent.trim();
    if (!id || id === '0') {
      try { if (PAGE.XF && PAGE.XF.config && +PAGE.XF.config.userId) id = String(PAGE.XF.config.userId); } catch (_) {}
    }
    if (!id || id === '0') {
      for (const s of document.scripts) {
        const m = /\buserId\s*:\s*(\d+)/.exec(s.textContent || '');
        if (m && m[1] !== '0') { id = m[1]; break; }
      }
    }
    if (id === '0') id = '';
    return { id, name: name.trim().toLowerCase(), shown: name.trim() };
  }
  const ME = detectMe();
  const meKnown = !!(ME.id || ME.name);

  function csrf() {
    try { if (PAGE.XF && PAGE.XF.config && PAGE.XF.config.csrf) return PAGE.XF.config.csrf; } catch (_) {}
    const h = document.documentElement.getAttribute('data-csrf');
    if (h) return h;
    const i = document.querySelector('input[name="_xfToken"]');
    if (i && i.value) return i.value;
    for (const s of document.scripts) {
      const m = /csrf\s*:\s*['"]([^'"]+)['"]/.exec(s.textContent || '');
      if (m) return m[1];
    }
    return '';
  }

  function info(it) {
    if (it._lmd) return it._lmd;
    const a = it.querySelector('.structItem-title');
    const href = (a && a.getAttribute('href')) || '';
    const m = /^(.*?conversations\/(?:[^/?#]*\.)?(\d+))/.exec(href);
    const title = a ? a.textContent.replace(/\s+/g, ' ').trim() : '';
    const av = it.querySelector('.structItem-cell--icon [data-user-id]');
    const u1 = it.querySelector('.structItem-parts .username, .structItem-cell--main .username');
    let sid = (av && av.getAttribute('data-user-id')) || (u1 && u1.getAttribute('data-user-id')) || '';
    if (sid === '0') sid = '';
    const sname = (it.getAttribute('data-author') || (u1 ? u1.textContent : '')).trim().toLowerCase();

    let mine = null;
    if (ME.id && sid) mine = sid === ME.id;
    else if (ME.name && sname) mine = sname === ME.name;
    else if (meKnown) mine = false;

    const tl = title.toLowerCase();
    const main = it.querySelector('.structItem-cell--main') || it;
    return (it._lmd = {
      id: m ? m[2] : '',
      base: m ? m[1] + '/' : '',
      title,
      mine,
      banwarn: banRe.test(title),
      prot: shield.some((s) => tl.includes(s)),
      text: norm(main.textContent),
    });
  }
  const isUnread = (it) => it.classList.contains('is-unread');

  function cats(i) {
    const k = [];
    if (i.banwarn) k.push('banwarn');
    if (!(i.banwarn && CONFIG.BANWARN_SEPARATE) && i.mine !== null) k.push(i.mine ? 'mine' : 'theirs');
    return k;
  }

  const TAGS = { banwarn: 'Ban/Warn', mine: 'By me', theirs: 'To me' };
  function decorate(it) {
    if (it._lmdTagged) return;
    it._lmdTagged = true;
    const i = info(it);
    const host = it.querySelector('.structItem-minor') || it.querySelector('.structItem-cell--main');
    if (!host) return;
    const wrap = el('span', 'lmd-tags');
    const add = (k, label) => { const t = el('span', 'lmd-tag', label); t.dataset.k = k; wrap.appendChild(t); };
    if (i.banwarn) add('banwarn', TAGS.banwarn);
    if (i.mine !== null) add(i.mine ? 'mine' : 'theirs', i.mine ? TAGS.mine : TAGS.theirs);
    if (i.prot) add('prot', 'Protected');
    if (wrap.childNodes.length) host.insertBefore(wrap, host.firstChild);
    if (i.prot) it.classList.add('is-lmd-prot');
  }

  function lastPage() {
    let max = 1;
    document.querySelectorAll('.pageNav a[href], .pageNavSimple a[href]').forEach((a) => {
      const m = /page-(\d+)/.exec(a.getAttribute('href') || '');
      if (m) max = Math.max(max, +m[1]);
    });
    document.querySelectorAll('.pageNav-page').forEach((li) => {
      const n = parseInt(li.textContent.trim(), 10);
      if (n) max = Math.max(max, n);
    });
    const s = document.querySelector('.pageNavSimple-el--current');
    if (s) {
      const m = /(\d+)\D+(\d+)/.exec(s.textContent);
      if (m) max = Math.max(max, +m[2]);
    }
    return max;
  }
  function currentPage() {
    const c = document.querySelector('.pageNav-page--current');
    const n = c && parseInt(c.textContent, 10);
    if (n) return n;
    const m = /page-(\d+)/.exec(location.pathname);
    return m ? +m[1] : 1;
  }
  const LAST = lastPage();
  const CUR = currentPage();
  const tmplLink = Array.from(document.querySelectorAll('.pageNav a[href*="page-"], .pageNavSimple a[href*="page-"]'))
    .map((a) => a.getAttribute('href')).find(Boolean);

  function pageUrl(p) {
    if (tmplLink) {
      const u = p === 1 ? tmplLink.replace(/page-\d+\/?/, '') : tmplLink.replace(/page-\d+/, 'page-' + p);
      return new URL(u, location.href).href;
    }
    let path = location.pathname.replace(/page-\d+\/?$/, '');
    if (!path.endsWith('/')) path += '/';
    return location.origin + path + (p > 1 ? 'page-' + p : '') + location.search;
  }

  async function fetchPage(p, ctl) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitFree();
      try {
        const r = await fetch(pageUrl(p), { credentials: 'same-origin' });
        if (r.status === 429 || r.status === 503) { ctl.slower(attempt); continue; }
        if (r.status >= 500) { await sleep(1500); continue; }
        if (!r.ok) return null;
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        const items = Array.from(doc.querySelectorAll(ITEM));
        ctl.ok();

        items.forEach((it) => it.querySelectorAll('img').forEach((img) => {
          img.setAttribute('loading', 'lazy');
          img.setAttribute('decoding', 'async');
        }));
        return items;
      } catch (_) {
        await sleep(1500);
      }
    }
    return null;
  }

  const seen = new Set();
  startItems.forEach((it) => { const i = info(it); if (i.id) seen.add(i.id); decorate(it); });

  function insertPage(items, marker, page) {
    const frag = document.createDocumentFragment();
    for (const src of items) {
      const node = document.importNode(src, true);
      const i = info(node);
      if (i.id) {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
      }
      node._lmdImp = true;
      node._lmdPage = page;
      decorate(node);
      if (!matches(node, i)) node.classList.add('lmd-hide');
      frag.appendChild(node);
    }
    if (marker && marker.parentNode === mainList) mainList.insertBefore(frag, marker);
    else mainList.appendChild(frag);
  }

  async function leave(it, ignore, ctl) {
    const i = info(it);
    if (!i.base) return { ok: false, msg: 'link not found' };
    const body = new URLSearchParams({
      _xfToken: csrf(),
      recipient_state: ignore ? 'deleted_ignored' : 'deleted',
      _xfResponseType: 'json',
      _xfRequestUri: location.pathname + location.search,
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitFree();
      try {
        const r = await fetch(new URL(i.base + 'leave', location.href).href, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body,
        });
        if (r.status === 429 || r.status === 503) { ctl.slower(attempt); continue; }
        if (r.status >= 500) { await sleep(1500); continue; }
        let j = null;
        try { j = await r.json(); } catch (_) {}
        if (j) {
          if (j.status === 'ok' || (r.ok && !j.errors && j.status !== 'error')) { ctl.ok(); return { ok: true }; }
          const e = j.errors ? (Array.isArray(j.errors) ? j.errors[0] : Object.values(j.errors)[0]) : '';
          return { ok: false, msg: plain(e || 'error ' + r.status) };
        }
        if (r.ok) { ctl.ok(); return { ok: true }; }
        return { ok: false, msg: 'error ' + r.status };
      } catch (_) {
        await sleep(1500);
      }
    }
    return { ok: false, msg: 'network error' };
  }

  const css = el('style');
  css.id = 'lmd-style';
  css.textContent = `
:root{
  --lmd-gold:#e0cd9e;--lmd-gold-2:#f4e7c8;--lmd-gold-dim:rgba(224,205,158,.34);--lmd-gold-faint:rgba(224,205,158,.10);
  --lmd-s1:#111114;--lmd-s2:#18181c;--lmd-s3:#202026;--lmd-line:rgba(255,255,255,.08);
  --lmd-text:#ece8de;--lmd-muted:#9c978b;
  --lmd-ok:#4cc98a;--lmd-rej:#ff9474;--lmd-ban:#ff5466;--lmd-man:#ffb648;--lmd-info:#8fb6ff;
  --lmd-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.lmd-hide,#lmdDock [hidden]{display:none!important}
${ITEM}{content-visibility:auto;contain-intrinsic-size:auto 96px}

/* filter card */
.lmd-bar{margin:0 0 10px;padding:12px 12px 10px;border-radius:14px;border:1px solid var(--lmd-line);border-left:3px solid var(--lmd-gold);
  background:linear-gradient(180deg,#151518,#101013);color:var(--lmd-text);font:13px/1.4 var(--lmd-font)}
.lmd-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.lmd-row+.lmd-row{margin-top:8px}
.lmd-label{color:rgba(224,205,158,.8);font:800 10px/1 var(--lmd-font);letter-spacing:.09em;text-transform:uppercase;margin-right:2px;white-space:nowrap}
.lmd-chip{-webkit-appearance:none;appearance:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer;
  min-height:32px;padding:0 12px;border-radius:999px;background:var(--lmd-s2);border:1px solid var(--lmd-line);color:#d6d1c4;
  font:600 12.5px/1 var(--lmd-font);touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  transition:transform .1s,background .15s,border-color .15s,color .15s}
.lmd-chip:active{transform:scale(.96)}
.lmd-chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--c,var(--lmd-muted));flex:0 0 auto}
.lmd-chip[data-k=all]::before{display:none}
.lmd-chip[data-k=banwarn]{--c:var(--lmd-ban)}
.lmd-chip[data-k=mine]{--c:var(--lmd-gold)}
.lmd-chip[data-k=theirs]{--c:var(--lmd-info)}
.lmd-chip[data-k=unread]{--c:var(--lmd-ok)}
.lmd-chip b{font-weight:600;opacity:.6;font-size:11.5px;font-variant-numeric:tabular-nums}
.lmd-chip.is-on{background:var(--lmd-gold-faint);border-color:var(--lmd-gold-dim);color:var(--lmd-gold-2)}
.lmd-chip.is-on b{opacity:.95}
.lmd-chip.is-zero:not(.is-on){opacity:.45}
.lmd-chip[disabled]{opacity:.3;cursor:default}
.lmd-search{flex:1 1 160px;min-width:0;height:32px;box-sizing:border-box;padding:0 12px;border-radius:10px;border:1px solid var(--lmd-line);
  background:var(--lmd-s1);color:var(--lmd-text);font:500 16px/1 var(--lmd-font);outline:none;-webkit-appearance:none;appearance:none}
.lmd-search::placeholder{color:#6f6b62}
.lmd-search:focus{border-color:var(--lmd-gold-dim)}
.lmd-note{margin-top:8px;font-size:12px;color:var(--lmd-muted)}
.lmd-note:empty{display:none}
.lmd-note b{color:var(--lmd-man);font-weight:700}

/* empty state */
.lmd-empty{margin:10px 0;padding:14px 16px;border-radius:14px;border:1px solid var(--lmd-line);border-left:3px solid var(--lmd-muted);
  background:linear-gradient(180deg,#151518,#101013);color:#cfc9bc;font:13.5px/1.5 var(--lmd-font)}

/* tags in the row */
.lmd-tags{display:inline-flex;gap:4px;margin-right:6px;vertical-align:1px}
.lmd-tag{font:800 9.5px/1 var(--lmd-font);letter-spacing:.05em;text-transform:uppercase;padding:3px 6px;border-radius:5px;
  border:1px solid var(--lmd-line);color:var(--lmd-muted);background:rgba(255,255,255,.04);white-space:nowrap}
.lmd-tag[data-k=banwarn]{color:#ff9aa5;border-color:rgba(255,84,102,.38);background:rgba(255,84,102,.10)}
.lmd-tag[data-k=mine]{color:var(--lmd-gold-2);border-color:var(--lmd-gold-dim);background:var(--lmd-gold-faint)}
.lmd-tag[data-k=theirs]{color:#b9d0ff;border-color:rgba(143,182,255,.35);background:rgba(143,182,255,.08)}
.lmd-tag[data-k=prot]::before{content:"🔒 "}

/* select mode */
body.lmd-sel ${ITEM}{position:relative;cursor:pointer;-webkit-user-select:none;user-select:none}
body.lmd-sel ${ITEM}::before{content:"";position:absolute;left:5px;top:12px;z-index:3;width:22px;height:22px;box-sizing:border-box;border-radius:50%;
  border:2px solid var(--lmd-gold-dim);background:rgba(11,11,13,.8);color:#161104;font:900 13px/18px var(--lmd-font);text-align:center}
body.lmd-sel ${ITEM}.is-lmd-sel{background:var(--lmd-gold-faint)!important;box-shadow:inset 3px 0 0 var(--lmd-gold)}
body.lmd-sel ${ITEM}.is-lmd-sel::before{content:"✓";border-color:#f1e2bf;background:linear-gradient(180deg,#f3e6c6,#b09d73)}
body.lmd-sel ${ITEM}.is-lmd-prot{cursor:default}
body.lmd-sel ${ITEM}.is-lmd-prot::before{content:"🔒";border-color:transparent;font-size:11px}

/* buttons */
.lmd-btn{-webkit-appearance:none;appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:7px 13px;
  border-radius:10px;border:1px solid var(--lmd-line);background:var(--lmd-s2);color:var(--lmd-text);font:600 12.5px/1.2 var(--lmd-font);
  cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform .1s,background .15s,border-color .15s}
.lmd-btn:active{transform:scale(.97)}
.lmd-btn[disabled]{opacity:.45;cursor:default}
.lmd-btn--gold{background:linear-gradient(180deg,#f3e6c6,#b09d73);border-color:#f1e2bf;color:#161104}
.lmd-btn--danger{background:rgba(255,84,102,.13);border-color:rgba(255,84,102,.45);color:#ffb3bb}
.lmd-btn--solid{background:#9b2230;border-color:#d0435a;color:#fff}
.lmd-btn--ghost{background:transparent}

/* status dock (same as the queue) */
#lmdDock{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 10px);z-index:9990;width:min(560px,calc(100vw - 16px));
  transform:translateX(-50%);background:linear-gradient(180deg,#141417,#0b0b0d);border:1px solid var(--lmd-gold-dim);border-radius:16px;
  box-shadow:0 8px 28px rgba(0,0,0,.6);color:var(--lmd-text);font:600 13px/1.3 var(--lmd-font);overflow:hidden;-webkit-tap-highlight-color:transparent}
#lmdDock[data-tone=ok]{--t:var(--lmd-ok)}#lmdDock[data-tone=run]{--t:var(--lmd-gold-2)}#lmdDock[data-tone=err]{--t:#ff8d99;border-color:rgba(255,84,102,.6)}
#lmdDock[data-tone=man]{--t:var(--lmd-man)}#lmdDock[data-tone=mute]{--t:#cfcabd}
.lmd-dock-row{display:flex;align-items:center;gap:8px;padding:8px 8px 9px 12px;min-height:44px;box-sizing:border-box}
.lmd-brand{flex:0 0 auto;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;background:linear-gradient(145deg,#f4e7c8,#b09d73);
  color:#141004;font:900 11px/1 var(--lmd-font)}
.lmd-dock-txt{flex:1 1 auto;min-width:0;overflow:hidden;color:var(--t,var(--lmd-text));font-size:12.5px;line-height:1.25;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.lmd-dock-btn{flex:0 0 auto;-webkit-appearance:none;appearance:none;border:1px solid var(--lmd-line);background:var(--lmd-s2);color:var(--lmd-text);
  border-radius:10px;min-height:30px;padding:0 10px;font:700 12px/1 var(--lmd-font);cursor:pointer;touch-action:manipulation;white-space:nowrap}
.lmd-dock-btn--gold{background:linear-gradient(180deg,#f3e6c6,#b09d73);border-color:#f1e2bf;color:#161104}
.lmd-dock-btn--stop{background:rgba(255,84,102,.16);border-color:rgba(255,84,102,.5);color:#ffb3bb}
.lmd-dock-btn--more{width:30px;padding:0;color:var(--lmd-muted)}
.lmd-dock-btn--more::before{content:"";display:inline-block;width:7px;height:7px;border-right:2px solid currentColor;border-top:2px solid currentColor;
  transform:translateY(2px) rotate(-45deg);transition:transform .15s}
#lmdDock.is-open .lmd-dock-btn--more::before{transform:translateY(-2px) rotate(135deg)}
.lmd-bar-line{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.06)}
.lmd-bar-line>i{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(var(--p,0));background:linear-gradient(90deg,#b09d73,#f4e7c8);transition:transform .3s ease}
.lmd-dock-more{display:none;padding:2px 12px 12px;border-top:1px solid var(--lmd-line);font-weight:500;font-size:12.5px;color:#d1ccc0}
#lmdDock.is-open .lmd-dock-more{display:block}
.lmd-kv{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--lmd-line)}
.lmd-kv span:first-child{color:var(--lmd-muted);white-space:nowrap}
.lmd-kv span:last-child{text-align:right}
.lmd-q{margin:10px 0 4px;font-size:14.5px;font-weight:800;color:#fff}
.lmd-hint{font-size:12.5px;color:var(--lmd-muted);line-height:1.45}
.lmd-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.lmd-grid .lmd-btn{min-height:40px;font-size:13px}
body.lmd-has-dock{padding-bottom:calc(76px + env(safe-area-inset-bottom,0px))!important}
body.lmd-has-dock.lmd-dock-open{padding-bottom:calc(220px + env(safe-area-inset-bottom,0px))!important}
@media (prefers-reduced-motion:reduce){.lmd-chip,.lmd-btn,.lmd-bar-line>i,.lmd-dock-btn--more::before{transition:none!important}}
`;
  document.head.appendChild(css);

  const TABS = [
    ['all', 'All'],
    ['banwarn', 'Ban/Warn'],
    ['mine', 'By me'],
    ['theirs', 'To me'],
  ];
  const LABEL = Object.fromEntries(TABS);

  const bar = el('div', 'lmd-bar');
  const rowTabs = el('div', 'lmd-row lmd-row--tabs');
  rowTabs.appendChild(el('span', 'lmd-label', 'Filter'));
  const tabBtns = TABS.map(([k, l]) => {
    const b = btn('lmd-chip');
    b.dataset.k = k;
    b.append(el('span', null, l), el('b', null, '0'));
    rowTabs.appendChild(b);
    return b;
  });
  const rowTools = el('div', 'lmd-row');
  const search = el('input', 'lmd-search');
  search.type = 'search';
  search.placeholder = 'Search title or name';
  search.autocomplete = 'off';
  search.setAttribute('autocorrect', 'off');
  search.setAttribute('autocapitalize', 'off');
  search.spellcheck = false;
  const unreadBtn = btn('lmd-chip');
  unreadBtn.dataset.k = 'unread';
  unreadBtn.append(el('span', null, 'Unread'), el('b', null, '0'));
  rowTools.append(search, unreadBtn);
  const note = el('div', 'lmd-note');
  bar.append(rowTabs, rowTools, note);

  const host = startItems[0].closest('.block-container');
  if (host) host.parentNode.insertBefore(bar, host);
  else mainList.parentNode.insertBefore(bar, mainList);

  const empty = el('div', 'lmd-empty lmd-hide');
  mainList.parentNode.insertBefore(empty, mainList.nextSibling);

  const dock = el('div');
  dock.id = 'lmdDock';
  dock.setAttribute('role', 'status');
  const dRow = el('div', 'lmd-dock-row');
  const dTxt = el('div', 'lmd-dock-txt');
  const dBtns = el('span');
  dBtns.style.cssText = 'display:flex;gap:6px;flex:0 0 auto';
  const dMore = btn('lmd-dock-btn lmd-dock-btn--more', '', 'more');
  dMore.setAttribute('aria-label', 'Details');
  dRow.append(el('span', 'lmd-brand', 'LM'), dTxt, dBtns, dMore);
  const dPanel = el('div', 'lmd-dock-more');
  const dLine = el('div', 'lmd-bar-line');
  dLine.appendChild(el('i'));
  dock.append(dRow, dPanel, dLine);
  document.body.appendChild(dock);
  document.body.classList.add('lmd-has-dock');

  if (!meKnown) tabBtns.forEach((b) => { if (b.dataset.k === 'mine' || b.dataset.k === 'theirs') b.disabled = true; });

  let tab = ss.get('tab', 'all');
  if (!LABEL[tab] || (!meKnown && (tab === 'mine' || tab === 'theirs'))) tab = 'all';
  let unreadOnly = ss.get('unread', '0') === '1';
  let query = '';
  let detailsOpen = ss.get('open', '0') === '1';

  const load = { state: 'idle', done: 0, total: 0, t0: 0, failed: [], stop: false, userStopped: false, loaded: new Set([CUR]) };
  const sel = { on: false, phase: 'select', kind: '', msg: '', stop: false, ok: 0, fail: 0, total: 0, t0: 0 };

  const matchesTab = (i) => tab === 'all' || cats(i).includes(tab);
  const matchesRest = (it, i) => (!unreadOnly || isUnread(it)) && (!query || i.text.includes(query) || i.title.toLowerCase().includes(query));
  function matches(it, i) { return matchesTab(i) && matchesRest(it, i); }

  let counts = { all: 0, banwarn: 0, mine: 0, theirs: 0, unread: 0, total: 0, shown: 0 };
  function apply() {
    const c = { all: 0, banwarn: 0, mine: 0, theirs: 0, unread: 0, total: 0, shown: 0 };
    document.querySelectorAll(ITEM).forEach((it) => {
      const i = info(it);
      const k = cats(i);
      const unread = isUnread(it);
      const rest = matchesRest(it, i);
      c.total++;
      if (rest) { c.all++; k.forEach((x) => c[x]++); }
      if (unread && matchesTab(i) && (!query || i.text.includes(query))) c.unread++;
      const show = rest && (tab === 'all' || k.includes(tab));
      it.classList.toggle('lmd-hide', !show);
      if (!show) it.classList.remove('is-lmd-sel');
      if (show) c.shown++;
    });
    counts = c;
    tabBtns.forEach((b) => {
      const k = b.dataset.k;
      b.querySelector('b').textContent = fmt(c[k]);
      b.classList.toggle('is-on', k === tab);
      b.classList.toggle('is-zero', !c[k]);
    });
    unreadBtn.querySelector('b').textContent = fmt(c.unread);
    unreadBtn.classList.toggle('is-on', unreadOnly);
    unreadBtn.classList.toggle('is-zero', !c.unread);

    if (!c.shown) {
      const what = [tab !== 'all' ? '“' + LABEL[tab] + '”' : '', unreadOnly ? 'unread' : '', query ? 'matching “' + query + '”' : '']
        .filter(Boolean).join(', ');
      empty.textContent = 'No conversations' + (what ? ' — ' + what : '') +
        (load.state === 'done' || LAST <= 1 ? '.' : load.state === 'loading' ? ' yet — still loading …' : ' on this page. Tap “Load all” in the dock.');
      empty.classList.remove('lmd-hide');
    } else {
      empty.classList.add('lmd-hide');
    }

    note.textContent = '';
    if (LAST > 1 && load.state !== 'done') note.textContent = 'Filters cover loaded pages only (' + load.loaded.size + ' of ' + LAST + ').';
    if (!meKnown) {
      const w = el('b', null, 'Your name was not detected — set MY_NAME at the top of the script.');
      if (note.textContent) note.append(' ');
      note.appendChild(w);
    }
    paint();
  }
  let applyQueued = 0;
  function applySoon() {
    if (applyQueued) return;
    applyQueued = requestAnimationFrame(() => { applyQueued = 0; apply(); });
  }

  let applyTimer = 0;
  function applyLater() {
    if (applyTimer) return;
    applyTimer = setTimeout(() => { applyTimer = 0; apply(); }, 250);
  }

  const selected = () => Array.from(document.querySelectorAll(ITEM + '.is-lmd-sel'));
  const clearSel = () => selected().forEach((it) => it.classList.remove('is-lmd-sel'));
  let dockSig = '';

  function paint() {
    const nSel = sel.on ? selected().length : 0;
    let tone = 'mute', text = '', p = 0, buttons = [], panel = 'info', open = detailsOpen;

    if (sel.on && sel.phase === 'run') {
      const done = sel.ok + sel.fail;
      tone = 'run';
      text = sel.stop ? 'Stopping … ' + fmt(done) + ' / ' + fmt(sel.total)
        : (sel.kind === 'delete' ? 'Deleting ' : 'Leaving ') + fmt(done) + ' / ' + fmt(sel.total) + eta(sel.t0, done, sel.total);
      p = sel.total ? done / sel.total : 0;
      buttons = [['stop', 'Stop', 'stop']];
      open = false;
    } else if (sel.on && sel.phase === 'confirm') {
      tone = 'err';
      text = 'Please confirm below';
      panel = 'confirm';
      open = true;
    } else if (sel.on) {
      tone = sel.msg ? (/✓/.test(sel.msg) && !/failed/.test(sel.msg) ? 'ok' : 'man') : 'run';
      text = sel.msg || (nSel ? fmt(nSel) + ' selected' : 'Tap conversations to select them');
      buttons = [['done', 'Done', '']];
      panel = 'select';
      open = true;
    } else if (load.state === 'loading') {
      tone = 'run';
      text = 'Loading pages ' + load.done + ' / ' + load.total + eta(load.t0, load.done, load.total);
      p = load.total ? load.done / load.total : 0;
      buttons = [['load', load.stop ? 'Stopping …' : 'Stop', 'stop']];
    } else {
      if (load.state === 'done') { tone = load.failed.length ? 'man' : 'ok'; text = '✓ All ' + fmt(LAST) + ' pages · ' + fmt(counts.total) + ' conversations'; p = 1; }
      else if (LAST > 1) { text = 'Page ' + CUR + ' / ' + fmt(LAST) + ' · ' + fmt(counts.total) + ' loaded'; p = load.loaded.size / LAST; }
      else { text = fmt(counts.total) + ' conversations'; p = 1; }
      if (load.failed.length) text += ' · ' + load.failed.length + ' page' + (load.failed.length === 1 ? '' : 's') + ' failed';
      if (tab !== 'all' || unreadOnly || query) text += ' · ' + fmt(counts.shown) + ' shown';
      if (load.state !== 'done' && LAST > 1) buttons.push(['load', load.failed.length ? 'Try again' : load.userStopped ? 'Continue' : 'Load all', 'gold']);
      buttons.push(['select', 'Select', '']);
    }

    dock.dataset.tone = tone;
    dLine.firstChild.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
    if (dTxt.textContent !== text) dTxt.textContent = text;
    const bSig = buttons.map((b) => b.join(':')).join('|');
    if (bSig !== dockSig) {
      dockSig = bSig;
      dBtns.replaceChildren(...buttons.map(([a, label, kind]) =>
        btn('lmd-dock-btn' + (kind ? ' lmd-dock-btn--' + kind : ''), label, a)));
    }
    dMore.hidden = sel.on;
    dock.classList.toggle('is-open', open);
    document.body.classList.toggle('lmd-dock-open', open);
    document.body.classList.toggle('lmd-sel', sel.on);
    if (open) renderPanel(panel, nSel);
  }

  let panelSig = '';
  const pRef = {};
  function renderPanel(kind, nSel) {
    const del = sel.kind === 'delete';
    const sig = kind === 'confirm' ? kind + nSel + sel.kind : kind;
    if (sig !== panelSig) {
      panelSig = sig;
      dPanel.textContent = '';
      if (kind === 'confirm') {
        dPanel.append(
          el('div', 'lmd-q', (del ? 'Delete ' : 'Leave ') + fmt(nSel) + ' conversation' + (nSel === 1 ? '' : 's') + '?'),
          el('div', 'lmd-hint', (del
            ? 'They leave your list and do NOT come back with new replies.'
            : 'They leave your list, but come back as soon as someone replies.') +
            ' The other participants still see the conversation.'));
        const g = el('div', 'lmd-grid');
        g.append(btn('lmd-btn', 'Cancel', 'cancel'),
          btn('lmd-btn lmd-btn--solid', 'Yes, ' + (del ? 'delete' : 'leave'), 'yes'));
        dPanel.appendChild(g);
      } else if (kind === 'select') {
        const g = el('div', 'lmd-grid');
        pRef.leave = btn('lmd-btn', '', 'leave');
        pRef.del = btn('lmd-btn lmd-btn--danger', '', 'delete');
        g.append(btn('lmd-btn', 'All visible', 'all'), btn('lmd-btn lmd-btn--ghost', 'None', 'none'), pRef.leave, pRef.del);
        dPanel.appendChild(g);
        const h = el('div', 'lmd-hint', 'Leave = comes back with a new reply · Delete = leave and ignore future replies. 🔒 titles are protected.');
        h.style.marginTop = '8px';
        dPanel.appendChild(h);
      } else {
        pRef.kv = {};
        const kv = (k) => { const r = el('div', 'lmd-kv'); const v = el('span'); r.append(el('span', null, k), v); dPanel.appendChild(r); pRef.kv[k] = v; };
        ['Pages loaded', 'Conversations', 'Your account', 'Ban/Warn separate', 'Version'].forEach(kv);
      }
    }
    if (kind === 'select') {
      const tl = 'Leave (' + fmt(nSel) + ')', td = 'Delete (' + fmt(nSel) + ')';
      if (pRef.leave.textContent !== tl) pRef.leave.textContent = tl;
      if (pRef.del.textContent !== td) pRef.del.textContent = td;
      pRef.leave.disabled = pRef.del.disabled = !nSel;
    } else if (kind === 'info') {
      const set = (k, v) => { const e = pRef.kv[k]; if (e && e.textContent !== v) e.textContent = v; };
      set('Pages loaded', load.loaded.size + ' / ' + LAST + (load.failed.length ? ' · failed: ' + load.failed.join(', ') : ''));
      set('Conversations', fmt(counts.total) + ' loaded · ' + fmt(counts.shown) + ' shown');
      set('Your account', meKnown ? (ME.shown || '') + (ME.id ? ' · #' + ME.id : '') : 'not detected (MY_NAME)');
      set('Ban/Warn separate', CONFIG.BANWARN_SEPARATE ? 'yes' : 'no (also under By me / To me)');
      set('Version', 'v' + VERSION);
    }
  }

  const rmSet = new Set();
  let rmRaf = 0;
  function removeSoon(it) {
    rmSet.add(it);
    if (!rmRaf) rmRaf = requestAnimationFrame(flushRemove);
  }
  function flushRemove() {
    if (rmRaf) { cancelAnimationFrame(rmRaf); rmRaf = 0; }
    if (!rmSet.size) return;
    const gone = new Set(rmSet);
    rmSet.clear();
    let anchor = null, before = 0;
    for (const r of document.querySelectorAll(ITEM)) {
      if (gone.has(r) || r.classList.contains('lmd-hide')) continue;
      const t = r.getBoundingClientRect();
      if (t.bottom > 0) { anchor = r; before = t.top; break; }
    }
    gone.forEach((r) => r.remove());
    if (anchor && anchor.isConnected) {
      const d = anchor.getBoundingClientRect().top - before;
      if (Math.abs(d) > 0.5) window.scrollBy(0, d);
    }
  }

  async function loadAll() {
    if (load.state === 'loading') { load.stop = true; load.userStopped = true; paint(); return; }
    if (load.state === 'done' || LAST <= 1) return;
    const pages = [];
    for (let p = 1; p <= LAST; p++) if (!load.loaded.has(p)) pages.push(p);
    if (!pages.length) { load.state = 'done'; apply(); return; }

    load.state = 'loading';
    load.stop = false;
    load.failed = [];
    load.done = 0;
    load.total = pages.length;
    load.t0 = Date.now();

    const marker = {};
    const rows = Array.from(mainList.querySelectorAll(':scope > ' + ITEM));
    for (const p of pages) {
      const c = document.createComment('lmd-' + p);
      const after = rows.find((r) => (r._lmdPage || CUR) > p);
      if (after && after.parentNode === mainList) mainList.insertBefore(c, after);
      else mainList.appendChild(c);
      marker[p] = c;
    }
    apply();

    await pool(pages.length, CONFIG.PARALLEL, async (n, ctl) => {
      const p = pages[n];
      const items = await fetchPage(p, ctl);
      if (items === null) load.failed.push(p);
      else {
        try { insertPage(items, marker[p], p); load.loaded.add(p); }
        catch (e) { console.warn('[DM filter] page ' + p, e); load.failed.push(p); }
      }
      load.done++;
      applyLater();
      paint();
    }, () => load.stop);

    Object.values(marker).forEach((c) => c.remove());
    clearTimeout(applyTimer);
    applyTimer = 0;
    load.failed.sort((a, b) => a - b);
    if (load.loaded.size >= LAST) {
      load.state = 'done';
      load.failed = [];
      document.querySelectorAll('.pageNavWrapper').forEach((e) => e.classList.add('lmd-hide'));
    } else {
      load.state = 'idle';
    }
    apply();
  }

  async function run(ignore) {
    const list = selected().filter((it) => !info(it).prot);
    if (!list.length) { sel.phase = 'select'; paint(); return; }
    if (!csrf()) {
      sel.phase = 'select';
      sel.msg = 'Security token not found — reload the page';
      paint();
      return;
    }
    Object.assign(sel, { phase: 'run', stop: false, ok: 0, fail: 0, total: list.length, t0: Date.now(), msg: '' });
    let lastErr = '';
    paint();
    await pool(list.length, CONFIG.PARALLEL_ACTION, async (n, ctl) => {
      const it = list[n];
      const r = await leave(it, ignore, ctl);
      if (r.ok) { sel.ok++; removeSoon(it); } else { sel.fail++; lastErr = r.msg; }
      paint();
    }, () => sel.stop);
    flushRemove();
    const stopped = sel.stop;
    sel.phase = 'select';
    sel.msg = '✓ ' + fmt(sel.ok) + ' ' + (ignore ? 'deleted' : 'left') +
      (sel.fail ? ' · ' + fmt(sel.fail) + ' failed' + (lastErr ? ' (' + lastErr + ')' : '') : '') +
      (stopped ? ' · stopped' : '');
    apply();
  }

  function setTab(k) {
    if (sel.phase === 'run') return;
    tab = k;
    ss.set('tab', k);
    clearSel();
    sel.phase = 'select';
    sel.msg = '';
    apply();
    if (k !== 'all' && CONFIG.LOAD_ON_FILTER && load.state === 'idle' && !load.userStopped && !load.failed.length && LAST > 1) loadAll();
  }
  function setSelect(on) {
    if (sel.phase === 'run') return;
    sel.on = on;
    sel.phase = 'select';
    sel.msg = '';
    if (!on) clearSel();
    paint();
  }

  tabBtns.forEach((b) => b.addEventListener('click', () => { if (!b.disabled) setTab(tab === b.dataset.k && b.dataset.k !== 'all' ? 'all' : b.dataset.k); }));
  unreadBtn.addEventListener('click', () => {
    unreadOnly = !unreadOnly;
    ss.set('unread', unreadOnly ? '1' : '0');
    clearSel();
    applySoon();
  });
  let qTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const q = norm(search.value);
      if (q === query) return;
      query = q;
      applySoon();
      if (q && CONFIG.LOAD_ON_FILTER && load.state === 'idle' && !load.userStopped && !load.failed.length && LAST > 1) loadAll();
    }, 140);
  });

  dock.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b || b.disabled) return;
    e.preventDefault();
    const a = b.dataset.a;
    if (a === 'more') { detailsOpen = !detailsOpen; ss.set('open', detailsOpen ? '1' : '0'); panelSig = ''; paint(); }
    else if (a === 'load') { load.userStopped = load.state === 'loading'; if (load.state !== 'loading') load.failed = []; loadAll(); }
    else if (a === 'select') setSelect(true);
    else if (a === 'done') setSelect(false);
    else if (a === 'all') {
      document.querySelectorAll(ITEM).forEach((it) => {
        if (!it.classList.contains('lmd-hide') && !info(it).prot) it.classList.add('is-lmd-sel');
      });
      sel.msg = '';
      paint();
    } else if (a === 'none') { clearSel(); sel.msg = ''; paint(); }
    else if (a === 'leave' || a === 'delete') { sel.phase = 'confirm'; sel.kind = a; paint(); }
    else if (a === 'cancel') { sel.phase = 'select'; paint(); }
    else if (a === 'yes') run(sel.kind === 'delete');
    else if (a === 'stop') { sel.stop = true; paint(); }
  });

  document.addEventListener('click', (e) => {
    const it = e.target.closest && e.target.closest(ITEM);
    if (!it) return;
    if (!sel.on) {
      if (it._lmdImp && !e.target.closest('a, button, input, label, select, textarea')) {
        const a = it.querySelector('.structItem-title');
        if (a && a.href) location.href = a.href;
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (sel.phase !== 'select' || info(it).prot) return;
    it.classList.toggle('is-lmd-sel');
    sel.msg = '';
    paint();
  }, true);

  addEventListener('pageshow', (e) => { if (e.persisted) applySoon(); });

  apply();
  if (tab !== 'all' && CONFIG.LOAD_ON_FILTER && LAST > 1) loadAll();
}

function moduleAltCounter() {
  'use strict';

  const VERSION = LM_VERSIONS.alts;
  const DET_V = 3;
  const CFG = {
    altTTL: 3600e3,
    statusTTL: 12 * 3600e3,
    activeTTL: 15 * 60e3,
    maxStale: 24 * 3600e3,
    maxPages: 5,
    concurrency: 5,
    gapMs: 70,
    tabId: 'multipleAccounts',
    entryPhrase: /potential multiple account/i,
    detectionDate: /detection date/i,
    bannedTitleRe: /^\s*banned\s*$/i,
    bannedNoticeRe: /\b(has been|is|was) banned\b|\bbanned (until|permanently)\b/i,
    unapprovedRe: /awaiting approval|pending approval|not (yet )?approved|unapproved|awaiting (email )?confirmation/i,
    notFoundRe: /requested member could not be found|member could not be found/i,
  };

  const NS = 'lmAltCounter:v2:';
  const LABEL = {
    active: 'active',
    unapproved: 'not approved',
    deleted: 'deleted',
    banned: 'banned (not counted)',
    rejected: 'rejected (not counted)',
    disabled: 'disabled (not counted)',
    error: 'status unknown',
  };
  const COUNTED = new Set(['active']);

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(NS + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {   } },
    del(k) { try { localStorage.removeItem(NS + k); } catch (e) {   } },
  };
  const fresh = (rec, ttl) => rec && typeof rec.t === 'number' && Date.now() - rec.t < ttl;

  function prune() {
    try {
      const now = Date.now();
      const last = +localStorage.getItem(NS + 'prunedAt') || 0;
      if (now - last < 3600e3) return;
      localStorage.setItem(NS + 'prunedAt', String(now));
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('lmAltCounter:v1:')) { keys.push([k, true]); continue; }
        if (k.startsWith(NS + 'u:') || k.startsWith(NS + 's:')) keys.push([k, false]);
      }
      for (const [k, old] of keys) {
        if (old) { localStorage.removeItem(k); continue; }
        if (keys.length < 2000) continue;
        const v = JSON.parse(localStorage.getItem(k) || 'null');
        if (!v || now - v.t > CFG.statusTTL) localStorage.removeItem(k);
      }
    } catch (e) {   }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const queue = [];
  const fast = [];
  const later = [];
  let running = 0;
  let nextSlot = 0;

  function request(url, opts, prio) {
    return new Promise((resolve, reject) => {
      (prio === 'fast' ? fast : prio === 'later' ? later : queue).push({ url, opts, resolve, reject });
      pump();
    });
  }

  function pump() {

    const limit = LMS.queueBusy() ? 1 : CFG.concurrency;
    while (running < limit && (fast.length || queue.length || later.length)) {
      runJob((fast.length ? fast : queue.length ? queue : later).shift());
    }
  }

  async function runJob(job) {
    running++;
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Date.now() + wait + CFG.gapMs;
    try {
      if (wait) await sleep(wait);
      const init = Object.assign({ credentials: 'include' }, job.opts || {});
      let res = await fetch(job.url, init);
      if (res.status === 429 || res.status === 503) {
        await sleep(4000);
        res = await fetch(job.url, init);
      }
      const text = await res.text();
      job.resolve({ status: res.status, ok: res.ok, text, url: res.url || job.url });
    } catch (e) {
      job.reject(e);
    } finally {
      running--;
      pump();
    }
  }

  const parseHTML = (html) => new DOMParser().parseFromString(html, 'text/html');

  function csrf() {
    return document.documentElement.getAttribute('data-csrf') ||
      (PAGE.XF && PAGE.XF.config && PAGE.XF.config.csrf) || '';
  }

  async function fetchXF(url, prio) {
    const u = new URL(url, location.href);
    u.searchParams.set('_xfResponseType', 'json');
    u.searchParams.set('_xfWithData', '1');
    u.searchParams.set('_xfRequestUri', location.pathname + location.search);
    u.searchParams.set('_xfToken', csrf());
    const res = await request(u.href, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' },
    }, prio);
    let html = res.text;
    let err = '';
    try {
      const j = JSON.parse(res.text);
      html = j.html ? (typeof j.html === 'string' ? j.html : (j.html.content || '')) : '';
      if (j.status === 'error' || (j.errors && j.errors.length)) err = [].concat(j.errors || []).join(' ');
    } catch (e) {   }
    return { status: res.status, ok: res.ok && !err, err, url: res.url, doc: parseHTML(html || '') };
  }

  function linkUserId(a) {
    if (!a) return 0;
    const d = parseInt(a.getAttribute('data-user-id') || '', 10);
    if (d > 0) return d;
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/members\/(?:[^/?#]*\.)?(\d+)\/?(?:[?#]|$)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function memberLinks(scope) {
    return [...scope.querySelectorAll('a[href*="/members/"], a[data-user-id]')].filter((a) => linkUserId(a) > 0);
  }

  const cleanName = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function classTrail(a) {
    return [a.className || '', ...[...a.querySelectorAll('[class]')].map((x) => x.className)].join(' ');
  }

  function findTabPane(doc) {
    const tab = doc.querySelector('a[href$="#' + CFG.tabId + '"], [id="' + CFG.tabId + '"]');
    const id = (tab && tab.id) || CFG.tabId;
    return doc.querySelector('[aria-labelledby="' + id + '"]') ||
      [...doc.querySelectorAll('.tabPanes > li[data-href], [role="tabpanel"][data-href]')]
        .find((p) => /multi|alt/i.test(p.getAttribute('data-href') || ''));
  }

  function patternFrom(href, base) {
    try {
      const u = new URL(href, base);
      const m = u.pathname.match(/^(.*\/members\/)[^/]*?\.?(\d+)(\/.*)$/);
      return m ? m[1] + '{id}' + m[3] + u.search : null;
    } catch (e) { return null; }
  }

  function learnPattern(doc, base) {
    const pane = findTabPane(doc);
    const dh = pane && pane.getAttribute('data-href');
    const p = dh && patternFrom(dh, base);
    if (p) store.set('tab', { t: Date.now(), pattern: p });
    return p || null;
  }

  const getPattern = () => { const r = store.get('tab'); return r && r.pattern; };

  function markerText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('ul, ol, .button, .username, a[href*="/members/"]').forEach((x) => x.remove());
    const m = cleanName(c.textContent).match(/\(([^()]{2,40})\)/);
    return m ? m[1].trim() : '';
  }

  function mainMarker(a) {
    let t = '';
    for (let s = a.nextSibling; s && t.length < 120; s = s.nextSibling) {
      const x = s.textContent || '';
      t += x;
      if (/has the following/i.test(x)) break;
    }
    const m = t.split(/has the following/i)[0].match(/\(([^()]{2,40})\)/);
    return m ? m[1].trim() : '';
  }

  function detectionMethods(li) {
    const parts = [];

    const full = li.textContent || '';
    const i = full.search(/triggered detection/i);
    if (i >= 0) parts.push(full.slice(i).replace(/(cookie)(ip)/gi, '$1 $2'));

    li.querySelectorAll('ul, ol').forEach((x) => parts.push(x.textContent || ''));
    li.querySelectorAll('ul li, ol li').forEach((x) => parts.push(x.textContent || ''));

    li.querySelectorAll('[title], [aria-label], [data-original-title]').forEach((x) => {
      if (x.closest('a[href*="/members/"], .username')) return;
      parts.push(x.getAttribute('title') || '', x.getAttribute('aria-label') || '', x.getAttribute('data-original-title') || '');
    });
    const txt = LM_SPLIT(parts.join(' '));
    const out = [];
    if (/\bip\b|ip[\s-]?address/i.test(txt)) out.push('IP');
    if (/cookie/i.test(txt)) out.push('Cookie');
    if (/e-?mail/i.test(txt)) out.push('Email');
    if (/browser|fingerprint|user[\s-]?agent|device/i.test(txt)) out.push('Browser');
    return out;
  }

  function parseEntries(scope) {
    const isDoc = scope.nodeType === 9;
    const doc = isDoc ? scope : scope.ownerDocument;
    const root = isDoc ? (doc.querySelector('.p-body-pageContent') || doc.querySelector('.p-body-main') || doc.body) : scope;
    if (!root) return [];
    const W = doc.defaultView || window;
    const NF = W.NodeFilter || NodeFilter;
    const walker = doc.createTreeWalker(root, NF.SHOW_TEXT);
    const starts = [];
    let n;
    while ((n = walker.nextNode())) {
      if (CFG.entryPhrase.test(n.nodeValue)) starts.push(n.parentElement);
    }

    const count = (el) => ((el.textContent || '').match(/potential multiple account/gi) || []).length;
    const entries = [];
    const seen = new Set();

    for (const start of starts) {
      let el = start;
      let best = start;
      while (el && el !== root.parentElement) {
        if (count(el) > 1) break;
        best = el;
        if (CFG.detectionDate.test(el.textContent) && el.querySelector('li, a[href*="/members/"]')) break;
        if (el === root) break;
        el = el.parentElement;
      }
      if (seen.has(best)) continue;
      seen.add(best);

      const nodes = [best];
      if (!best.querySelector('li')) {
        let sib = best.nextElementSibling;
        while (sib && count(sib) === 0) { nodes.push(sib); sib = sib.nextElementSibling; }
      }
      const inEntry = (x) => nodes.some((nd) => nd === x || nd.contains(x));

      const entry = { main: null, alts: [], html: nodes.map((x) => x.outerHTML).join('\n') };

      const mainLink = memberLinks(best).find((a) => !a.closest('li') || !inEntry(a.closest('li')));
      if (mainLink) {
        entry.main = { id: linkUserId(mainLink), name: cleanName(mainLink.textContent), href: mainLink.href, cls: classTrail(mainLink), marker: mainMarker(mainLink) };
      }

      const lis = nodes.flatMap((x) => (x.tagName === 'LI' ? [x] : [...x.querySelectorAll('li')]))
        .filter((li) => { const up = li.parentElement && li.parentElement.closest('li'); return !up || !inEntry(up); });

      if (lis.length) {
        for (const li of lis) {
          const a = memberLinks(li).find((x) => !x.classList.contains('button'));
          const marker = markerText(li);
          if (a) {
            entry.alts.push({ id: linkUserId(a), name: cleanName(a.textContent), href: a.href, cls: classTrail(a), marker, det: detectionMethods(li) });
          } else {
            const nameEl = li.querySelector('.username');
            let name = cleanName(nameEl ? nameEl.textContent : li.textContent);
            name = name.split(/\(|use for future events|ignore for future events|triggered detection/i)[0].trim();
            if (name) entry.alts.push({ id: 0, name, href: '', deleted: true, marker, det: detectionMethods(li) });
          }
        }
      } else {
        for (const a of nodes.flatMap((x) => memberLinks(x))) {
          if (a === mainLink || a.classList.contains('button')) continue;
          entry.alts.push({ id: linkUserId(a), name: cleanName(a.textContent), href: a.href, cls: classTrail(a), marker: '', det: [] });
        }
      }
      entries.push(entry);
    }
    return entries;
  }

  function nextPageUrl(doc, base) {
    const next = doc.querySelector('a.pageNav-jump--next, .pageNav-jump--next[href], a[rel="next"]');
    if (!next) return null;
    try { return new URL(next.getAttribute('href'), base).href; } catch (e) { return null; }
  }

  async function fetchTabPages(url, dbg, prio) {
    const all = [];
    let next = url;
    for (let p = 0; p < CFG.maxPages && next; p++) {
      const r = await fetchXF(next, p ? 'fast' : prio);
      dbg.urls.push(next.replace(location.origin, '') + ' → ' + r.status + (r.err ? ' ' + r.err : ''));
      if (!r.ok) throw new Error('tab returned ' + (r.err || 'HTTP ' + r.status));
      all.push(...parseEntries(r.doc));
      next = nextPageUrl(r.doc, location.href);
    }
    return all;
  }

  let learning = null;
  async function entriesFor(user, dbg, prio) {
    let pattern = getPattern();
    if (!pattern && learning) { await learning.catch(() => {}); pattern = getPattern(); }
    if (!pattern) {
      const job = entriesViaProfile(user, dbg);
      if (!learning) learning = job.then(() => {}, () => {}).then(() => { learning = null; });
      return job;
    }
    dbg.pattern = pattern;
    return fetchTabPages(location.origin + pattern.replace('{id}', user.id), dbg, prio);
  }

  async function entriesViaProfile(user, dbg) {
    const res = await request(location.origin + '/members/' + user.id + '/', undefined, 'fast');
    dbg.urls.push('/members/' + user.id + '/ → ' + res.status);
    if (!res.ok) throw new Error('profile returned HTTP ' + res.status);
    const doc = parseHTML(res.text);
    const pane = findTabPane(doc);
    if (!pane) { dbg.note = 'No "Multiple accounts" tab in the profile'; return []; }
    const inline = parseEntries(pane);
    if (inline.length) { dbg.note = 'Tab content inline in the profile'; return inline; }
    const pattern = learnPattern(doc, res.url);
    if (!pattern) { dbg.note = 'Tab found, but without a link: ' + pane.outerHTML.slice(0, 300); return []; }
    dbg.pattern = pattern;
    return fetchTabPages(location.origin + pattern.replace('{id}', user.id), dbg, 'fast');
  }

  async function altsFor(user, dbg, swr) {
    let rec = store.get('u:' + user.id);
    if (rec && rec.dv !== DET_V) rec = null;
    if (fresh(rec, CFG.altTTL)) { dbg.cached = true; return rec.alts; }
    if (swr && fresh(rec, CFG.maxStale)) { dbg.cached = true; scheduleRefresh(user); return rec.alts; }

    const entries = await entriesFor(user, dbg, swr ? undefined : 'later');
    const alts = new Map();

    const add = (a, det, via) => {
      if (!a || a.id === user.id) return;
      const key = a.id ? 'id:' + a.id : 'del:' + a.name.toLowerCase();
      const d = (det || []).slice();
      const direct = !via;
      const old = alts.get(key);
      if (!old) {
        alts.set(key, { id: a.id, name: a.name, href: a.href || '', deleted: !!a.deleted, cls: a.cls || '', marker: a.marker || '', det: d, via: via || '' });
        return;
      }
      if (!old.marker && a.marker) old.marker = a.marker;
      if (!old.det) old.det = [];
      if (direct && old.via) { old.via = ''; old.det = d; return; }
      if (!direct && !old.via) return;
      for (const x of d) if (!old.det.includes(x)) old.det.push(x);
    };
    let matched = 0;
    for (const e of entries) {
      const isMain = e.main && e.main.id === user.id;
      const self = isMain ? null : e.alts.find((a) => a.id === user.id);
      if (!isMain && !self) continue;
      matched++;
      if (dbg.samples.length < 1 && e.html) dbg.samples.push(e.html.slice(0, 2500));
      if (isMain) {

        e.alts.forEach((a) => add(a, a.det));
      } else {

        add(e.main, self.det);

        e.alts.forEach((a) => { if (a !== self) add(a, a.det, (e.main && e.main.name) || '?'); });
      }
    }
    dbg.entriesParsed = entries.length;
    dbg.entriesMatched = matched;
    const list = [...alts.values()];
    store.set('u:' + user.id, { t: Date.now(), dv: DET_V, alts: list });
    return list;
  }

  function statusFromLog(alt) {
    const m = alt.marker || '';
    if (/banned/i.test(m)) return 'banned';
    if (/reject/i.test(m)) return 'rejected';
    if (/disabled/i.test(m)) return 'disabled';
    if (/deleted/i.test(m)) return 'deleted';
    if (/awaiting|approval|moderat|confirm|pending|unapproved/i.test(m)) return 'unapproved';
    if (alt.deleted || !alt.id) return 'deleted';
    if (/^deleted member\b/i.test(alt.name)) return 'deleted';
    if (/\busername--banned\b|\bis-banned\b/i.test(alt.cls || '') || hasBannedStyle(alt.cls)) return 'banned';
    return null;
  }

  const statusInflight = new Map();

  function statusOf(alt, dbg, swr, user) {
    if (alt.id && isKnownBanned(alt.id)) return Promise.resolve('banned');
    const fromLog = statusFromLog(alt);
    if (fromLog) return Promise.resolve(fromLog);
    const rec = store.get('s:' + alt.id);
    if (rec && fresh(rec, rec.st === 'active' ? CFG.activeTTL : CFG.statusTTL)) return Promise.resolve(rec.st);
    if (swr && rec && fresh(rec, CFG.maxStale)) { scheduleRefresh(user); return Promise.resolve(rec.st); }
    if (statusInflight.has(alt.id)) return statusInflight.get(alt.id);

    const p = (async () => {
      try {
        let st = null;
        const tip = await fetchXF(location.origin + '/members/' + alt.id + '/tooltip', swr ? 'fast' : 'later');
        if (CFG.notFoundRe.test(tip.err)) st = 'deleted';
        else if (tip.ok && tip.doc.querySelector('.userTitle, .username, .memberTooltip')) {
          st = classifyTooltip(tip.doc);
          if (dbg.profiles.length < 2) dbg.profiles.push(alt.name + ' → ' + st + ' (Tooltip)\n' + tip.doc.body.innerHTML.slice(0, 1200));
        }
        if (!st) {
          const res = await request(alt.href || location.origin + '/members/' + alt.id + '/', undefined, swr ? 'fast' : 'later');
          if (res.status === 404 || res.status === 410) st = 'deleted';
          else if (!res.ok) return 'error';
          else {
            const doc = parseHTML(res.text);
            st = classifyProfile(doc);
            if (dbg.profiles.length < 2) {
              const h = doc.querySelector('.memberHeader') || doc.querySelector('.p-body-main') || doc.body;
              dbg.profiles.push(alt.name + ' → ' + st + '\n' + (h ? h.outerHTML.slice(0, 1200) : ''));
            }
          }
        }
        store.set('s:' + alt.id, { t: Date.now(), st });
        if (st === 'banned') markBanned(alt.id, true);
        return st;
      } catch (e) {
        return 'error';
      } finally {
        statusInflight.delete(alt.id);
      }
    })();
    statusInflight.set(alt.id, p);
    return p;
  }

  function classifyTooltip(doc) {
    const titles = [...doc.querySelectorAll('.userTitle, .userBanner')].map((e) => cleanName(e.textContent));
    if (titles.some((t) => CFG.bannedTitleRe.test(t))) return 'banned';
    if (doc.querySelector('.username--banned, .userBanner--banned')) return 'banned';
    const nameEl = doc.querySelector('.username');
    if (nameEl && hasBannedStyle(classTrail(nameEl))) return 'banned';
    const txt = (doc.body && doc.body.textContent) || '';
    if (CFG.bannedNoticeRe.test(txt)) return 'banned';
    if (CFG.unapprovedRe.test(txt)) return 'unapproved';
    return 'active';
  }

  function classifyProfile(doc) {
    const header = doc.querySelector('.memberHeader');
    const main = doc.querySelector('.p-body-main') || doc.body;
    if (!header) {
      const err = doc.querySelector('.blockMessage--error, .p-body-main .blockMessage');
      if (err && CFG.notFoundRe.test(err.textContent)) return 'deleted';
      if (CFG.notFoundRe.test((main && main.textContent) || '')) return 'deleted';
    }
    const scope = header || main;
    const titles = [...scope.querySelectorAll('.userTitle, .userBanner, .memberHeader-blurb')].map((e) => cleanName(e.textContent));
    if (titles.some((t) => CFG.bannedTitleRe.test(t))) return 'banned';
    if (scope.querySelector('.username--banned, .userBanner--banned')) return 'banned';
    const nameEl = scope.querySelector('.memberHeader-name .username, .username');
    if (nameEl && hasBannedStyle(classTrail(nameEl))) return 'banned';
    const notices = [...doc.querySelectorAll('.memberHeader-banners, .blockMessage, .memberHeader-blurb')]
      .map((e) => e.textContent).join(' \n ');
    if (CFG.bannedNoticeRe.test(notices)) return 'banned';
    if (CFG.unapprovedRe.test(notices)) return 'unapproved';
    return 'active';
  }

  function styleTokens(el) {
    return [el, ...el.querySelectorAll('*')].flatMap((x) => [...x.classList]).filter((t) => /^username--/.test(t));
  }
  function isStruck(el) {
    return [el, ...el.querySelectorAll('*')].some((x) => {
      try { return /line-through/.test(getComputedStyle(x).textDecorationLine || getComputedStyle(x).textDecoration || ''); } catch (e) { return false; }
    });
  }

  function learnBanned(els) {
    const struck = new Set();
    const normal = new Set();
    let newlyBanned = false;
    let changed = false;
    for (const el of els) {
      const hit = isStruck(el);
      styleTokens(el).forEach((t) => (hit ? struck : normal).add(t));
      const id = parseInt(el.getAttribute('data-user-id'), 10);
      if (id > 0 && markBanned(id, hit, true)) { changed = true; if (hit) newlyBanned = true; }
    }
    if (changed) saveBannedIds();
    const rec = store.get('bannedCls') || { t: 0, list: [] };
    const set = new Set(rec.list);
    struck.forEach((t) => { if (!normal.has(t)) set.add(t); });
    normal.forEach((t) => set.delete(t));
    const list = [...set];
    if (list.join(' ') !== rec.list.join(' ')) store.set('bannedCls', { t: Date.now(), list });
    if (newlyBanned) refreshAll();
  }

  let bannedIds = null;
  const unbanned = new Set();
  function loadBannedIds() {
    if (!bannedIds) { const r = store.get('bannedIds'); bannedIds = (r && r.ids) || {}; }
    return bannedIds;
  }
  function saveBannedIds() {
    const ids = loadBannedIds();

    const r = store.get('bannedIds');
    if (r && r.ids) Object.keys(r.ids).forEach((k) => { if (!ids[k] && !unbanned.has(k)) ids[k] = 1; });
    const keys = Object.keys(ids);
    if (keys.length > 5000) keys.slice(0, keys.length - 5000).forEach((k) => delete ids[k]);
    store.set('bannedIds', { t: Date.now(), ids });
  }

  function markBanned(id, banned, noSave) {
    const ids = loadBannedIds();
    const was = !!ids[id];
    if (was === !!banned) return false;
    if (banned) { ids[id] = 1; unbanned.delete(String(id)); } else { delete ids[id]; unbanned.add(String(id)); }
    if (!noSave) saveBannedIds();
    return true;
  }
  const isKnownBanned = (id) => !!loadBannedIds()[id];

  let refreshTimer = null;
  function refreshAll() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      userInflight.clear();
      const seen = new Set();
      document.querySelectorAll('.lmac-box').forEach((b) => {
        if (!b._lmac || seen.has(b.dataset.uid)) return;
        seen.add(b.dataset.uid);
        load(b);
      });
    }, 200);
  }
  function hasBannedStyle(cls) {
    const rec = store.get('bannedCls');
    if (!rec || !rec.list.length) return false;
    const toks = new Set((cls || '').split(/\s+/));
    return rec.list.some((t) => toks.has(t));
  }

  const userInflight = new Map();
  const debugInfo = new Map();

  function resultFor(user, swr = true) {
    const key = user.id + (swr ? '' : ':r');
    if (userInflight.has(key)) return userInflight.get(key);
    const dbg = { user: user.name + ' (#' + user.id + ')', urls: [], samples: [], profiles: [] };
    if (swr || !debugInfo.has(user.id)) debugInfo.set(user.id, dbg);
    const p = (async () => {
      const alts = await altsFor(user, dbg, swr);
      const withStatus = await Promise.all(alts.map(async (a) => Object.assign({}, a, { st: await statusOf(a, dbg, swr, user) })));
      const counted = withStatus.filter((a) => COUNTED.has(a.st));
      const active = withStatus.filter((a) => a.st === 'active').length;
      const banned = withStatus.filter((a) => a.st === 'banned').length;
      return { state: 'ok', count: counted.length, active, banned, alts: withStatus };
    })().catch((e) => ({ state: 'error', error: String((e && e.message) || e) }));
    userInflight.set(key, p);
    p.then(() => setTimeout(() => userInflight.delete(key), 1000));
    return p;
  }

  const pendingRefresh = new Map();
  let pendingTimer = null;
  function scheduleRefresh(user) {
    if (!user || pendingRefresh.has(user.id)) return;
    pendingRefresh.set(user.id, user);
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(runRefresh, 1500);
  }
  function runRefresh() {
    const users = [...pendingRefresh.values()];
    pendingRefresh.clear();
    for (const u of users) {
      resultFor(u, false).then((r) => {
        if (r.state !== 'ok') return;
        document.querySelectorAll('.lmac-box[data-uid="' + u.id + '"]').forEach((b) => { b._lmac = r; paint(b, r); });
      });
    }
  }

  const BAN = {
    warningId: '14',
    fillPauseMs: 150,
    gapMs: 300,
    parallel: 3,
    retries: 3,
  };
  const REASONS = {
    alt: { label: 'Alt account', pm: true },
    custom: { label: 'Custom reason', pm: true },
  };
  const banPM = (name, comment) => name + ',\n\nYou have been permanently banned by Moderation Staff.\n\n' +
    'Additional Comments: ' + comment + '\n\n' +
    'If you wish to appeal you may post in the "Ban Appeal" section and tag @Moderation Staff, he will be in charge ' +
    'of your appeal. Read the sticky AND the rules first, abuse won\'t be tolerated.\n\nThank you.';

  function formParams(form) {
    const p = new URLSearchParams();
    for (const el of form.querySelectorAll('input, select, textarea')) {
      if (!el.name || el.disabled) continue;
      const t = (el.type || '').toLowerCase();
      if (['submit', 'button', 'file', 'image', 'reset'].includes(t)) continue;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
      if (el.tagName === 'SELECT') { for (const o of el.options) if (o.selected) p.append(el.name, o.value); continue; }
      p.append(el.name, el.tagName === 'TEXTAREA' ? el.textContent : (el.value || ''));
    }
    return p;
  }

  async function xfGet(url) {
    const ctrl = window.AbortController ? new AbortController() : null;
    const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {   } }, 20000);
    try {
      const r = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      return { status: r.status, text: await r.text() };
    } finally { clearTimeout(timer); }
  }

  async function xfPost(url, params) {
    params.set('_xfResponseType', 'json');
    params.set('_xfWithData', '1');
    params.set('_xfRequestUri', location.pathname + location.search);
    const ctrl = window.AbortController ? new AbortController() : null;
    const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {   } }, 30000);
    try {
      const r = await fetch(url, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body: params.toString(),
        signal: ctrl ? ctrl.signal : undefined,
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {   }
      return { status: r.status, json, text, redirected: r.redirected };
    } finally { clearTimeout(timer); }
  }

  function xfErrorText(json) {
    const e = json && (json.errors || json.error || json.message);
    if (!e) return '';
    const parts = Array.isArray(e) ? e : (typeof e === 'object' ? Object.values(e) : [e]);
    return parts.map((x) => String(x).replace(/<[^>]+>/g, '').trim()).filter(Boolean).join(' / ').slice(0, 200);
  }

  function xfResult(res) {
    if (res.json) {
      if (res.json.status === 'ok') return { status: 'done' };
      return { status: 'failed', error: xfErrorText(res.json) || 'forum response HTTP ' + res.status };
    }
    if (res.status >= 400) return { status: 'failed', error: 'HTTP ' + res.status };
    if (/blockMessage--error|formRow--error/.test(res.text || '')) return { status: 'failed', error: 'form error' };
    if (res.redirected) return { status: 'done' };
    return { status: 'unknown', error: 'forum response not conclusive' };
  }

  async function warnFill(actionUrl, form, id) {
    const out = {};
    const apply = (j) => {
      const fv = j && (j.formValues || (j.data && j.data.formValues));
      if (!fv || typeof fv !== 'object') return false;
      for (const sel of Object.keys(fv)) {
        const m = String(sel).match(/name=["']?([^"'\]]+)["']?\]/);
        if (!m) continue;
        const v = fv[sel];
        out[m[1]] = v === true ? '1' : (v === false || v == null) ? null : String(v);
      }
      return true;
    };
    const base = () => {
      const q = new URLSearchParams();
      const tok = form.querySelector('input[name="_xfToken"]');
      q.set('_xfToken', tok ? tok.value : csrf());
      q.set('fill', '1');
      q.set('warning_definition_id', String(id));
      return q;
    };
    try { if (apply((await xfPost(actionUrl, base())).json)) return out; } catch (e) {   }
    try {
      const q = base();
      q.set('_xfResponseType', 'json'); q.set('_xfWithData', '1');
      const r = await xfGet(actionUrl + (actionUrl.includes('?') ? '&' : '?') + q.toString());
      let j = null; try { j = JSON.parse(r.text); } catch (e) {   }
      if (apply(j)) return out;
    } catch (e) {   }
    return out;
  }

  let lastWarnAt = 0;
  let gapChain = Promise.resolve();
  function warnGap() {
    const p = gapChain.then(async () => {
      const wait = lastWarnAt + BAN.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastWarnAt = Date.now();
    });
    gapChain = p.catch(() => {});
    return p;
  }

  async function warnOnce(target, job) {
    const warnUrl = location.origin + '/members/' + target.id + '/warn';
    let page;
    try { page = await xfGet(warnUrl); } catch (e) { return { status: 'failed', error: 'warn page did not load' }; }
    if (page.status !== 200) return { status: 'failed', error: 'warn page HTTP ' + page.status };
    const doc = parseHTML(page.text);
    if (doc.documentElement.getAttribute('data-logged-in') === 'false') return { status: 'failed', error: 'not logged in' };
    const radio = doc.querySelector('input[name="warning_definition_id"][value="' + job.warningId + '"]');
    const form = radio && radio.closest('form');
    if (!form) return { status: 'failed', error: '"100%" warning not in the form (no permission?)' };
    let actionUrl;
    try { actionUrl = new URL(form.getAttribute('action') || warnUrl, warnUrl).href; } catch (e) { actionUrl = warnUrl; }

    const p = formParams(form);
    p.set('warning_definition_id', job.warningId);
    const fill = await warnFill(actionUrl, form, job.warningId);
    for (const k of Object.keys(fill)) { if (fill[k] === null) p.delete(k); else p.set(k, fill[k]); }

    const safe = LM_WARN_SAFE(form, p, fill, job.warningId);
    if (!safe.ok) return { status: 'failed', error: safe.why };
    p.set('filled_warning_definition_id', job.warningId);
    p.set('warning_definition_id', job.warningId);
    p.set('notes', job.notes || '');
    if (job.pm) {
      p.set('start_conversation', '1');
      p.set('conversation_title', job.pmTitle || 'Ban');
      p.set('conversation_message', job.pmMessage || '');
      p.set('conversation_locked', '1');
    } else {
      ['start_conversation', 'conversation_title', 'conversation_message', 'conversation_locked'].forEach((k) => p.delete(k));
    }
    await sleep(BAN.fillPauseMs);
    await warnGap();
    let res;
    try { res = await xfPost(actionUrl, p); } catch (e) { return { status: 'unknown', error: 'no response from the forum' }; } finally { lastWarnAt = Date.now(); }
    return xfResult(res);
  }

  async function warnUser(target, job) {
    let last = null;
    for (let i = 1; i <= BAN.retries; i++) {
      last = await warnOnce(target, job);
      if (last.status !== 'failed') return last;
      if (i < BAN.retries) await sleep(i * 1500);
    }
    return last;
  }

  function myUserId() {
    try { if (PAGE.XF && PAGE.XF.config && +PAGE.XF.config.userId > 0) return +PAGE.XF.config.userId; } catch (e) {   }
    const a = document.querySelector('.p-navgroup-link--user [data-user-id], a.p-navgroup-link--user[data-user-id], .p-navgroup--member [data-user-id]');
    return a ? parseInt(a.getAttribute('data-user-id'), 10) || 0 : 0;
  }
  const isStaffCls = (cls) => /\busername--(staff|moderator|admin)\b|\buserBanner--staff\b/i.test(cls || '');
  const detBoth = (det) => !!(det && det.includes('IP') && det.includes('Cookie'));
  function detLabel(det, via) {
    let s = '';
    if (det && det.length) {
      const ip = det.includes('IP');
      const ck = det.includes('Cookie');
      if (det.length === 1 && ip) s = 'IP only';
      else if (det.length === 1 && ck) s = 'Cookie only';
      else if (det.length === 2 && ip && ck) s = 'IP + Cookie';
      else s = det.join(' + ');
    }
    if (via) return 'indirect via @' + via + (s ? ' (' + s + ')' : '');
    return s || 'method unknown';
  }

  const DET_ORDER = ['Cookie', 'IP', 'Email', 'Browser'];
  const DET_SHORT = { IP: 'IP', Cookie: '🍪', Email: 'Mail', Browser: 'FP' };
  function detShort(a) {
    if (a.via) return 'via';
    const det = (a.det || []).slice().sort((x, y) => DET_ORDER.indexOf(x) - DET_ORDER.indexOf(y));
    return det.length ? det.map((d) => DET_SHORT[d] || d).join('+') : '?';
  }

  function detRank(lbl) {
    if (lbl === '?') return -2;
    if (lbl === 'via') return -1;
    return (lbl.includes('🍪') ? 2 : 0) + (lbl.split('+').includes('IP') ? 1 : 0);
  }

  function detGroups(alts) {
    const g = new Map();
    for (const a of alts || []) {
      if (a.st !== 'active') continue;
      const k = detShort(a);
      g.set(k, (g.get(k) || 0) + 1);
    }
    return [...g.entries()].sort((x, y) => detRank(y[0]) - detRank(x[0]));
  }
  const GROUP_WORDS = { 'IP': 'IP only', '🍪': 'Cookie', '🍪+IP': 'Cookie + IP', via: 'only via another account', '?': 'method unknown' };

  const groupKind = (lbl) => lbl === '🍪+IP' ? 'both' : lbl === '🍪' ? 'cookie' : lbl === 'IP' ? 'ip' : lbl.includes('🍪') ? 'cookie' : 'other';

  const CSS = `
    .lmac-box,.lmac-pop,.lmac-shade{
      --lmac-gold:#e0cd9e;--lmac-gold-2:#f4e7c8;--lmac-gold-dim:rgba(224,205,158,.34);--lmac-gold-faint:rgba(224,205,158,.10);
      --lmac-s1:#111114;--lmac-s2:#18181c;--lmac-s3:#202026;--lmac-line:rgba(255,255,255,.08);
      --lmac-text:#ece8de;--lmac-muted:#9c978b;
      --lmac-ok:#4cc98a;--lmac-rej:#ff9474;--lmac-ban:#ff5466;--lmac-man:#ffb648;--lmac-info:#8fb6ff;
      --lmac-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif}

    /* badge next to the username */
    .lmac-box{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;margin-left:5px;padding:0 6px;
      box-sizing:border-box;border:1px solid var(--lmac-line);border-radius:999px;
      font:800 10px/1 var(--lmac-font);letter-spacing:.02em;color:var(--lmac-muted);background:rgba(255,255,255,.04);
      vertical-align:middle;cursor:pointer;text-decoration:none!important;-webkit-text-fill-color:currentColor;
      text-shadow:none!important;filter:none!important;animation:none!important;white-space:nowrap;user-select:none;-webkit-user-select:none;
      -webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .12s ease}
    .lmac-box:active{transform:scale(.9)}
    .lmac-box.lmac-red{color:#ffb3bb;border-color:rgba(255,84,102,.62);background:rgba(255,84,102,.18)}
    .lmac-box .lmac-n{font-weight:900;color:#fff}
    .lmac-box .lmac-m{margin-left:2px;font-weight:700;opacity:.95}
    .lmac-box.lmac-amber{color:#ffe0a6;border-color:rgba(255,182,72,.6);background:rgba(255,182,72,.16)}
    .lmac-box .lmac-sg[data-k=ip] .lmac-m{color:#ffd28a}
    .lmac-box .lmac-sg[data-k=both] .lmac-m,.lmac-box .lmac-sg[data-k=cookie] .lmac-m{color:#ffc2c8}
    .lmac-break{display:flex;flex-wrap:wrap;gap:6px;margin:-4px 0 12px}
    .lmac-name .lm-det{align-self:flex-start;margin-top:1px}
    .lmac-box .lmac-sep{margin:0 3px;opacity:.55;font-weight:400}
    .lmac-box.lmac-wait{opacity:.4}
    .lmac-box.lmac-hide{display:none}
    .lmac-box.lmac-err{color:var(--lmac-man);border-color:rgba(255,182,72,.45);border-style:dashed}

    /* bottom sheet */
    .lmac-shade{position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.5)}
    .lmac-pop{position:fixed;left:0;right:0;bottom:0;z-index:2147483646;max-height:80vh;overflow:auto;-webkit-overflow-scrolling:touch;
      overscroll-behavior:contain;max-width:620px;margin:0 auto;
      background:linear-gradient(180deg,#151518,#0f0f12);color:var(--lmac-text);
      border:1px solid var(--lmac-gold-dim);border-bottom:0;border-radius:18px 18px 0 0;
      padding:12px 14px calc(16px + env(safe-area-inset-bottom));
      font:13.5px/1.45 var(--lmac-font);box-shadow:0 -10px 40px rgba(0,0,0,.65);animation:lmac-up .2s ease-out;
      transform:translateY(var(--lm-drag,0px));transition:transform .25s cubic-bezier(.22,1,.36,1)}
    @keyframes lmac-up{from{transform:translateY(24px);opacity:.4}}
    .lmac-pop *{box-sizing:border-box}
    .lmac-grab{width:38px;height:4px;border-radius:2px;background:var(--lmac-gold-dim);margin:0 auto 12px}
    .lmac-head{display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-right:38px;flex-wrap:wrap}
    .lmac-brand{flex:0 0 auto;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;background:linear-gradient(145deg,#f4e7c8,#b09d73);
      color:#141004;font:900 11px/1 var(--lmac-font)}
    .lmac-head h4{margin:0;font-size:16px;font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--lmac-text)}
    .lmac-head h4 a{color:var(--lmac-text)!important;text-decoration:none!important}
    .lmac-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;border-radius:999px;font-size:11px;font-weight:800;
      letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;border:1px solid var(--lmac-line);color:var(--lmac-muted);background:rgba(255,255,255,.04)}
    .lmac-chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
    .lmac-chip.red{color:var(--lmac-ban);border-color:rgba(255,84,102,.42);background:rgba(255,84,102,.13)}
    .lmac-chip.amber{color:var(--lmac-man);border-color:rgba(255,182,72,.40);background:rgba(255,182,72,.11)}
    .lmac-chip.grey{color:var(--lmac-ok);border-color:rgba(76,201,138,.38);background:rgba(76,201,138,.10)}
    .lmac-x{position:absolute;top:10px;right:12px;width:32px;height:32px;border-radius:10px;background:var(--lmac-s2);border:1px solid var(--lmac-line);
      color:var(--lmac-muted);font-size:18px;line-height:30px;padding:0;text-align:center;cursor:pointer}
    .lmac-list{margin:0 0 8px;padding:0;list-style:none;border:1px solid var(--lmac-line);border-radius:12px;overflow:hidden;background:var(--lmac-s1)}
    .lmac-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:1px solid var(--lmac-line);min-height:46px}
    .lmac-row:first-child{border-top:0}
    .lmac-row.is-main{background:var(--lmac-gold-faint);box-shadow:inset 3px 0 0 var(--lmac-gold)}
    .lmac-row input[type=checkbox]{width:20px;height:20px;accent-color:var(--lmac-gold);flex:none;margin:0}
    .lmac-row .lmac-cbph{width:20px;flex:none}
    .lmac-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
    .lmac-nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .lmac-nm a{color:var(--lmac-gold-2)!important;text-decoration:none!important;font-weight:700}
    .lmac-nm small{color:var(--lmac-muted);margin-left:6px;font-size:11px}
    .lmac-det{font-size:10.5px;font-weight:700;letter-spacing:.03em;color:var(--lmac-muted)}
    .lmac-det.both{color:#ff9aa5}
    .lmac-st{font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;padding:2px 6px;border-radius:5px;
      border:1px solid var(--lmac-line);color:var(--lmac-muted)}
    .lmac-st:empty{display:none}
    .lmac-st.st-active{color:#ff8d99;border-color:rgba(255,84,102,.4);background:rgba(255,84,102,.08)}
    .lmac-st.st-unapproved{color:#ffd28a;border-color:rgba(255,182,72,.3)}
    .lmac-st.st-deleted,.lmac-st.st-error{color:#b9b3a6}
    .lmac-st.st-banned,.lmac-st.st-rejected,.lmac-st.st-disabled{color:#7a766d}
    .lmac-st.st-main{color:var(--lmac-gold-2);border-color:var(--lmac-gold-dim)}
    .lmac-res{font-size:12px;font-weight:700;white-space:nowrap;max-width:45%;overflow:hidden;text-overflow:ellipsis}
    .lmac-res.ok{color:var(--lmac-ok)}.lmac-res.bad{color:#ff8d99}.lmac-res.unk{color:var(--lmac-man)}.lmac-res.run{color:var(--lmac-gold-2)}
    .lmac-more{margin:0 0 10px;color:var(--lmac-muted);font-size:12.5px}
    .lmac-more summary{cursor:pointer;padding:4px 0;list-style:none;font-weight:700}
    .lmac-more summary::-webkit-details-marker{display:none}
    .lmac-more .lmac-list{margin-top:6px}
    .lmac-sec{margin:14px 0 8px;font:800 10px/1 var(--lmac-font);letter-spacing:.09em;text-transform:uppercase;color:rgba(224,205,158,.8)}
    .lmac-seg{display:flex;background:var(--lmac-s1);border:1px solid var(--lmac-line);border-radius:12px;padding:3px;gap:3px;margin-bottom:8px}
    .lmac-seg button{flex:1;border:1px solid transparent;background:transparent;color:#d6d1c4;border-radius:9px;padding:8px 0;font:700 13px/1.1 var(--lmac-font);cursor:pointer}
    .lmac-seg button.on{background:var(--lmac-gold-faint);border-color:var(--lmac-gold-dim);color:var(--lmac-gold-2)}
    .lmac-input{width:100%;background:var(--lmac-s1);color:var(--lmac-text);border:1px solid var(--lmac-line);border-radius:10px;padding:9px 11px;
      font:500 16px/1.2 var(--lmac-font);margin-bottom:8px;outline:none}
    .lmac-input:focus{border-color:var(--lmac-gold-dim)}
    .lmac-toggle{display:flex;align-items:center;gap:8px;margin:2px 0 10px;color:#d1ccc0;font-size:13px}
    .lmac-toggle input{width:18px;height:18px;accent-color:var(--lmac-gold);margin:0}
    .lmac-preview{font-size:12px;color:var(--lmac-muted);margin:-2px 0 10px;word-break:break-word}
    .lmac-go{width:100%;border:1px solid #d0435a;border-radius:12px;padding:13px 0;font:800 15px/1.1 var(--lmac-font);background:#9b2230;color:#fff;cursor:pointer;
      touch-action:manipulation;transition:transform .1s}
    .lmac-go:active{transform:scale(.98)}
    .lmac-go:disabled{background:var(--lmac-s2);border-color:var(--lmac-line);color:#6f6b62;cursor:default}
    .lmac-confirm{border:1px solid rgba(255,84,102,.35);border-left:3px solid var(--lmac-ban);border-radius:12px;padding:11px 12px;margin-bottom:8px;
      font-size:13px;color:#ffd0d3;background:rgba(255,84,102,.07)}
    .lmac-confirm>div:first-child{font-weight:800;color:#ff9aa5;margin-bottom:2px}
    .lmac-confirm .lmac-two{display:flex;gap:8px;margin-top:10px}
    .lmac-confirm button{flex:1;border-radius:10px;padding:11px 0;font:800 14px/1.1 var(--lmac-font);cursor:pointer}
    .lmac-confirm .no{background:var(--lmac-s2);border:1px solid var(--lmac-line);color:var(--lmac-text)}
    .lmac-confirm .yes{background:#9b2230;border:1px solid #d0435a;color:#fff}
    .lmac-sum{margin:8px 0 0;font-size:13px;font-weight:700}
    .lmac-sum.ok{color:var(--lmac-ok)}.lmac-sum.warn{color:var(--lmac-man)}
    .lmac-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;padding-top:10px;border-top:1px solid var(--lmac-line)}
    .lmac-foot button,.lmac-foot a{flex:1 1 auto;display:inline-flex;align-items:center;justify-content:center;min-height:32px;background:var(--lmac-s2);
      color:#d1ccc0!important;border:1px solid var(--lmac-line);border-radius:9px;padding:0 10px;font:600 12px/1 var(--lmac-font);
      text-decoration:none!important;cursor:pointer;white-space:nowrap}
    .lmac-ver{flex-basis:100%;margin-top:4px;text-align:right;font-size:10px;font-weight:700;letter-spacing:.06em;color:rgba(224,205,158,.55)}
    .lmac-empty{color:var(--lmac-muted);margin:6px 0 10px}
    @media (prefers-reduced-motion:reduce){.lmac-pop{animation:none}.lmac-box,.lmac-go{transition:none}}
  `;

  function injectCSS() {
    if (document.getElementById('lmac-css')) return;
    const s = document.createElement('style');
    s.id = 'lmac-css';
    s.setAttribute('data-suite', '5');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function paint(box, r) {
    box.classList.remove('lmac-wait', 'lmac-red', 'lmac-amber', 'lmac-err', 'lmac-hide');
    if (r.state === 'ok') {
      if (r.active > 0) {
        box.textContent = '';
        const groups = detGroups(r.alts);

        box.classList.add(groups.every(([lbl]) => lbl === 'IP') ? 'lmac-amber' : 'lmac-red');
        if (groups.length === 1 && groups[0][0] === '?') {
          box.textContent = String(r.active);
        } else {
          groups.forEach(([lbl, n], i) => {
            if (i) box.appendChild(el('span', 'lmac-sep', '·'));
            const sg = el('span', 'lmac-sg');
            sg.dataset.k = groupKind(lbl);
            sg.append(el('span', 'lmac-n', String(n)), el('span', 'lmac-m', lbl));
            box.appendChild(sg);
          });
        }
        box.title = r.active + ' active alt' + (r.active === 1 ? '' : 's') + ': ' +
          groups.map(([lbl, n]) => n + '× ' + (GROUP_WORDS[lbl] || lbl)).join(', ');
      } else {
        box.textContent = '';
        box.classList.add('lmac-hide');
      }
    } else {
      box.textContent = '?';
      box.classList.add('lmac-err');
      box.title = 'Error: ' + (r.error || '');
    }
  }

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        load(e.target);
      }
    }, { rootMargin: '300px 0px' })
    : null;

  function load(box) {
    const user = { id: +box.dataset.uid, name: box.dataset.uname };
    resultFor(user).then((r) => {
      document.querySelectorAll('.lmac-box[data-uid="' + user.id + '"]').forEach((b) => { b._lmac = r; paint(b, r); });

      if (pop && pop.dataset.waitUid === String(user.id) && !banRunning) {
        const b = [...document.querySelectorAll('.lmac-box[data-uid="' + user.id + '"]')].find((x) => x.offsetParent) || box;
        if (b && b._lmac) openPop(b);
      }
    });
  }

  function decorate(root) {
    const els = (root.matches && root.matches('.username[data-user-id]') ? [root] : [])
      .concat([...(root.querySelectorAll ? root.querySelectorAll('.username[data-user-id]') : [])]);
    const added = [];
    for (const el of els) {
      if (el.dataset.lmac) continue;
      if (el.closest('.lmac-pop')) continue;
      const parentUser = el.parentElement && el.parentElement.closest('.username[data-user-id]');
      if (parentUser) continue;
      const id = parseInt(el.getAttribute('data-user-id'), 10);
      const name = cleanName(el.textContent);
      if (!(id > 0) || !name) continue;
      el.dataset.lmac = '1';
      added.push(el);

      const box = document.createElement('span');
      box.className = 'lmac-box lmac-wait';
      box.textContent = '…';
      box.dataset.uid = String(id);
      box.dataset.uname = name;
      if (isStaffCls(classTrail(el))) box.dataset.staff = '1';
      if (el.getAttribute('href')) box.dataset.href = el.getAttribute('href');
      box.setAttribute('role', 'button');
      el.insertAdjacentElement('afterend', box);
      if (io) io.observe(box); else load(box);
    }
    if (added.length) learnBanned(added);
  }

  let pop = null;
  let shade = null;
  let banRunning = false;
  function closePop(force) {
    if (banRunning && !force) return;
    if (pop) { pop.remove(); pop = null; }
    if (shade) { shade.remove(); shade = null; }
  }

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function openPop(box) {
    closePop(true);
    const r = box._lmac;
    const uid = +box.dataset.uid;
    const uname = box.dataset.uname;
    const me = myUserId();

    shade = el('div', 'lmac-shade');
    shade.addEventListener('click', () => closePop());
    pop = el('div', 'lmac-pop');
    const grab = el('div', 'lmac-grab');
    pop.appendChild(grab);
    const x = el('button', 'lmac-x', '×');
    x.onclick = () => closePop();
    pop.appendChild(x);

    const head = el('div', 'lmac-head');
    head.appendChild(el('span', 'lmac-brand', 'LM'));
    const h = el('h4');
    const hl = el('a', null, uname);
    hl.href = box.dataset.href || ('/members/' + uid + '/');
    h.appendChild(hl);
    head.appendChild(h);
    if (r && r.state === 'ok') {
      const chipCls = r.active ? 'red' : 'grey';
      const chipTxt = r.active ? r.active + ' active alt' + (r.active === 1 ? '' : 's') : 'no active alts';
      head.appendChild(el('span', 'lmac-chip ' + chipCls, chipTxt));
    }
    pop.appendChild(head);
    LM_SWIPE_CLOSE(pop, [grab, head], () => closePop());

    if (r && r.state === 'ok' && r.active) {
      const groups = detGroups(r.alts);
      if (!(groups.length === 1 && groups[0][0] === '?')) {
        const brk = el('div', 'lmac-break');
        groups.forEach(([lbl, n]) => {
          LM_DET.css();
          const p = el('span', 'lm-det', n + ' × ' + (GROUP_WORDS[lbl] || lbl));
          p.dataset.k = groupKind(lbl);
          brk.appendChild(p);
        });
        pop.appendChild(brk);
      }
    }

    if (!r) {
      pop.appendChild(el('div', 'lmac-empty', 'Still loading …'));

      pop.dataset.waitUid = String(uid);
      load(box);
    } else if (r.state === 'error') {
      pop.appendChild(el('div', 'lmac-empty', 'Error: ' + r.error));
    }

    const rows = [];
    const mkRow = (t, isMain) => {
      const li = el('li', 'lmac-row' + (isMain ? ' is-main' : ''));
      let cb = null;
      const bannable = t.id > 0 && t.id !== me && !t.staff && !['banned', 'deleted'].includes(t.st);
      if (bannable) {
        cb = el('input');
        cb.type = 'checkbox';

        cb.checked = isMain ? !isKnownBanned(t.id) && !!(r && r.state === 'ok' && r.active > 0)
          : t.st === 'active' && !(LMS.opt('altCookieOnly') && !t.via && LM_DET.kind(t.det) === 'ip');
        cb.addEventListener('change', updateAction);
      } else {
        li.appendChild(el('span', 'lmac-cbph'));
      }
      if (cb) li.appendChild(cb);
      const name = el('span', 'lmac-name');
      const nm = el('span', 'lmac-nm');
      if (t.href || t.id) {
        const a = el('a', null, t.name);
        a.href = t.href || ('/members/' + t.id + '/');
        a.target = '_blank';
        nm.appendChild(a);
      } else {
        nm.textContent = t.name;
      }
      if (isMain) nm.appendChild(el('small', null, 'this account'));
      name.appendChild(nm);
      if (!isMain) {
        const dp = LM_DET.pill(t.det, t.via);
        name.appendChild(dp || el('span', 'lmac-det', detLabel(t.det, t.via)));
      }
      li.appendChild(name);
      const stTxt = t.id === me ? 'you' : t.staff ? 'Staff' : isMain ? (isKnownBanned(t.id) ? 'banned' : '') : (LABEL[t.st] || t.st || '');
      const st = el('span', 'lmac-st st-' + (isMain ? (isKnownBanned(t.id) ? 'banned' : 'main') : t.st), stTxt.replace(' (not counted)', ''));
      li.appendChild(st);
      const res = el('span', 'lmac-res');
      li.appendChild(res);
      rows.push({ t, cb, res, st, isMain });
      return li;
    };

    const mainT = { id: uid, name: uname, href: box.dataset.href || '', staff: box.dataset.staff === '1', st: isKnownBanned(uid) ? 'banned' : 'main' };
    const counted = r && r.alts ? r.alts.filter((a) => COUNTED.has(a.st) || a.st === 'error') : [];
    const others = r && r.alts ? r.alts.filter((a) => !(COUNTED.has(a.st) || a.st === 'error')) : [];
    const order = { active: 0, unapproved: 1, error: 2, deleted: 3, disabled: 4, rejected: 5, banned: 6 };
    const asT = (a) => ({ id: a.id, name: a.name, href: a.href, st: a.st, staff: isStaffCls(a.cls), det: a.det || [], via: a.via || '' });

    const list = el('ul', 'lmac-list');
    list.appendChild(mkRow(mainT, true));
    counted.sort((a, b) => order[a.st] - order[b.st]).forEach((a) => list.appendChild(mkRow(asT(a), false)));
    pop.appendChild(list);
    if (r && r.state === 'ok' && !counted.length) pop.appendChild(el('div', 'lmac-empty', 'No active alts.'));

    if (others.length) {
      const det = el('details', 'lmac-more');
      det.appendChild(el('summary', null, '▸ Not counted (' + others.length + '): awaiting approval / banned / deleted'));
      const l2 = el('ul', 'lmac-list');
      others.sort((a, b) => order[a.st] - order[b.st]).forEach((a) => l2.appendChild(mkRow(asT(a), false)));
      det.appendChild(l2);
      pop.appendChild(det);
    }

    let reason = 'alt';
    const act = el('div');
    act.appendChild(el('div', 'lmac-sec', 'Give 100% (permaban)'));
    const seg = el('div', 'lmac-seg');
    const segBtns = {};
    Object.keys(REASONS).forEach((k) => {
      const b = el('button', k === reason ? 'on' : '', REASONS[k].label);
      b.type = 'button';
      b.onclick = () => {
        reason = k;
        Object.keys(segBtns).forEach((kk) => segBtns[kk].classList.toggle('on', kk === k));
        pmCb.checked = REASONS[k].pm;
        input.style.display = k === 'custom' ? '' : 'none';
        updateAction();
      };
      segBtns[k] = b;
      seg.appendChild(b);
    });
    act.appendChild(seg);
    const input = el('input', 'lmac-input');
    input.placeholder = 'Reason (goes into the notes and the PM)';
    input.style.display = 'none';
    input.addEventListener('input', updateAction);
    act.appendChild(input);
    const tg = el('label', 'lmac-toggle');
    const pmCb = el('input');
    pmCb.type = 'checkbox';
    pmCb.checked = REASONS[reason].pm;
    pmCb.addEventListener('change', updateAction);
    tg.append(pmCb, document.createTextNode('Send locked PM "Ban"'));
    act.appendChild(tg);
    const preview = el('div', 'lmac-preview');
    act.appendChild(preview);
    const confirmBox = el('div');
    act.appendChild(confirmBox);
    const go = el('button', 'lmac-go');
    go.type = 'button';
    act.appendChild(go);
    const sum = el('div', 'lmac-sum');
    act.appendChild(sum);
    pop.appendChild(act);

    const selected = () => rows.filter((x) => x.cb && x.cb.checked && !x.cb.disabled);
    const altFallbackNames = () => counted.filter((a) => a.id > 0 && a.st !== 'deleted').map((a) => a.name);

    const jobFor = (row, sel) => {
      const t = row.t;
      let notes;
      if (reason === 'custom') {
        notes = input.value.trim();
      } else if (row.isMain) {
        const picked = sel.filter((x) => !x.isMain && x.t.id !== t.id).map((x) => x.t.name);
        const names = picked.length ? picked : altFallbackNames();
        notes = 'successful alt' + (names.length > 1 ? 's' : '') + (names.length ? ' ' + names.map((n) => '@' + n).join(' ') : '');
      } else {
        notes = 'successful alt of @' + mainT.name;
      }
      return { warningId: BAN.warningId, notes, pm: pmCb.checked, pmTitle: 'Ban', pmMessage: banPM(t.name, notes) };
    };

    function updateAction() {
      if (banRunning) return;
      confirmBox.innerHTML = '';
      const sel = selected();
      const n = sel.length;
      const needText = reason === 'custom' && !input.value.trim();
      go.disabled = !n || needText;
      go.style.display = '';
      go.textContent = n ? 'Give 100% to ' + n + ' account' + (n === 1 ? '' : 's') : 'Select accounts above';
      const pmTxt = pmCb.checked ? ' · with PM' : ' · without PM';
      if (!n) { preview.textContent = ''; return; }
      if (reason === 'custom') {
        preview.textContent = 'Notes: "' + (input.value.trim() || '…') + '"' + pmTxt;
      } else {
        const mainSel = sel.find((x) => x.isMain);
        const altSel = sel.filter((x) => !x.isMain);
        const parts = [];
        if (mainSel) parts.push('Main: "' + jobFor(mainSel, sel).notes + '"');
        if (altSel.length) parts.push('Alt: "successful alt of @' + mainT.name + '"');
        preview.textContent = parts.join(' · ') + pmTxt;
      }
    }

    go.onclick = () => {
      const sel = selected();
      if (!sel.length) return;
      go.style.display = 'none';
      confirmBox.innerHTML = '';
      const c = el('div', 'lmac-confirm');
      c.appendChild(el('div', null, 'Really give 100% (permaban) to ' + sel.length + ' account' + (sel.length === 1 ? '' : 's') + '?'));
      c.appendChild(el('div', null, sel.map((x) => x.t.name).join(', ')));
      const two = el('div', 'lmac-two');
      const no = el('button', 'no', 'Cancel');
      no.type = 'button';
      no.onclick = () => updateAction();
      const yes = el('button', 'yes', 'Yes, ban');
      yes.type = 'button';
      yes.onclick = () => runBans(sel);
      two.append(no, yes);
      c.appendChild(two);
      confirmBox.appendChild(c);
    };

    async function runBans(sel) {
      banRunning = true;
      confirmBox.innerHTML = '';
      go.style.display = 'none';
      x.disabled = true;
      rows.forEach((row) => { if (row.cb) row.cb.disabled = true; });
      Object.values(segBtns).forEach((b) => { b.disabled = true; });
      input.disabled = true; pmCb.disabled = true;
      const jobs = sel.map((row) => ({ row, job: jobFor(row, sel) }));
      jobs.forEach(({ row }) => { row.res.className = 'lmac-res run'; row.res.textContent = 'waiting …'; });
      let ok = 0, bad = 0, unk = 0, next = 0;
      sum.className = 'lmac-sum';
      const showSum = () => {
        const done = ok + bad + unk;
        sum.textContent = done < jobs.length
          ? 'Banning … ' + done + ' / ' + jobs.length
          : ok + ' banned' + (bad ? ' · ' + bad + ' failed' : '') + (unk ? ' · ' + unk + ' unclear' : '');
      };
      showSum();

      const worker = async () => {
        while (next < jobs.length) {
          const { row, job } = jobs[next++];
          row.res.textContent = 'running …';
          let out;
          try { out = await warnUser(row.t, job); } catch (e) { out = { status: 'unknown', error: String(e && e.message) }; }
          if (out.status === 'done') {
            ok++;
            row.res.className = 'lmac-res ok'; row.res.textContent = '✓ banned';
            markBanned(row.t.id, true);
            store.set('s:' + row.t.id, { t: Date.now(), st: 'banned' });
            LMS.banned([row.t.id], 'alts');
            LMS.countAltBans(1);
          } else if (out.status === 'failed') {
            bad++;
            row.res.className = 'lmac-res bad'; row.res.textContent = '✗ ' + (out.error || 'error');
            row.res.title = out.error || '';
          } else {
            unk++;
            row.res.className = 'lmac-res unk'; row.res.textContent = '? unclear – check profile';
            row.res.title = out.error || '';
          }
          showSum();
        }
      };
      await Promise.all(Array.from({ length: Math.min(BAN.parallel, jobs.length) }, worker));
      banRunning = false;
      x.disabled = false;
      showSum();
      sum.className = 'lmac-sum ' + (bad || unk ? 'warn' : 'ok');
      store.del('u:' + uid);
      refreshAll();
    }

    updateAction();

    const foot = el('div', 'lmac-foot');
    const reload = el('button', null, 'Reload');
    reload.type = 'button';
    reload.onclick = () => {
      store.del('u:' + uid);
      if (r && r.alts) r.alts.forEach((a) => a.id && store.del('s:' + a.id));
      closePop(true);
      document.querySelectorAll('.lmac-box[data-uid="' + uid + '"]').forEach((b) => {
        b.classList.add('lmac-wait'); b.textContent = '…'; b._lmac = null;
      });
      const b0 = document.querySelector('.lmac-box[data-uid="' + uid + '"]');
      if (b0) load(b0);
    };
    const dbgBtn = el('button', 'lmac-dbg', 'debug');
    dbgBtn.type = 'button';
    dbgBtn.title = 'Copy debug info';
    dbgBtn.onclick = () => copy(buildDebug(uid, r)).then((okc) => { dbgBtn.textContent = okc ? 'Copied ✓' : 'Copy failed'; });

    const altTab = el('a', null, 'Alt list ↗');
    altTab.href = (box.dataset.href || ('/members/' + uid + '/')).split('#')[0] + '#' + CFG.tabId;
    altTab.target = '_blank';
    altTab.rel = 'noopener';

    const names = ['@' + uname].concat(counted.concat(others)
      .filter((a) => a.id > 0 && a.name && !/^deleted member\b/i.test(a.name)).map((a) => '@' + a.name));
    const namesBtn = el('button', null, 'Copy @names');
    namesBtn.type = 'button';
    namesBtn.onclick = () => copy([...new Set(names)].join(' ')).then((okc) => { namesBtn.textContent = okc ? 'Copied ✓' : 'Copy failed'; });
    const meta = el('div', 'lmac-meta');
    meta.append(el('span', 'lmac-ver', 'Moderator Suite v' + LM_VERSIONS.suite), dbgBtn);
    foot.append(altTab, namesBtn, reload, meta);
    pop.appendChild(foot);

    document.body.appendChild(shade);
    document.body.appendChild(pop);
  }

  function text(s) { const p = document.createElement('div'); p.style.marginBottom = '10px'; p.textContent = s; return p; }

  function buildDebug(uid, r) {
    const d = debugInfo.get(uid) || {};
    const pane = findTabPane(document);
    return [
      'Looksmax Alt Counter ' + VERSION + ' – Debug',
      'Page: ' + location.href,
      'User: ' + (d.user || uid),
      'Tab link: ' + JSON.stringify(store.get('tab')),
      'Result: ' + JSON.stringify(r && { state: r.state, count: r.count, active: r.active, error: r.error,
        alts: r.alts && r.alts.map((a) => [a.id, a.name, a.marker, a.st, (a.det || []).join('+') || '-', a.via ? 'via ' + a.via : 'direct']) }),
      'Fetches: ' + ((d.urls || []).join(' | ') || (d.cached ? '(from cache)' : '-')),
      'Note: ' + (d.note || '-'),
      'Entries read/matched: ' + d.entriesParsed + '/' + d.entriesMatched,
      'Banned styles: ' + JSON.stringify(store.get('bannedCls')),
      'Tab on this page: ' + (pane ? pane.outerHTML.slice(0, 400) : '(none)'),
      '--- Sample entry ---',
      (d.samples || [])[0] || '(none)',
      '--- Profiles ---',
      (d.profiles || []).join('\n\n') || '-',
      'Browser: ' + navigator.userAgent,
    ].join('\n');
  }

  function copy(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).then(() => true, () => legacyCopy(s));
    }
    return Promise.resolve(legacyCopy(s));
  }
  function legacyCopy(s) {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function onSuiteBan(ids) {
    let changed = false;
    (ids || []).forEach((id) => { if (markBanned(id, true, true)) changed = true; });
    if (changed) { saveBannedIds(); refreshAll(); }
  }
  function listenSuiteBans() {
    window.addEventListener('lm-suite-ban', (e) => onSuiteBan(e.detail && e.detail.ids));
    window.addEventListener('storage', (e) => {
      if (e.key !== LMS.BAN_KEY || !e.newValue) return;
      try { onSuiteBan(JSON.parse(e.newValue).ids); } catch (_) {   }
    });
  }

  function start() {
    injectCSS();
    prune();
    listenSuiteBans();
    LMS.onQueueIdle(pump);
    learnPattern(document, location.href);
    decorate(document.body);

    document.addEventListener('click', (e) => {
      const box = e.target.closest && e.target.closest('.lmac-box');
      if (box) {
        e.preventDefault();
        e.stopPropagation();
        openPop(box);
      } else if (pop && !e.target.closest('.lmac-pop')) {
        closePop();
      }
    }, true);

    document.addEventListener('keydown', (e) => { if (pop && e.key === 'Escape') closePop(); });

    const pending = new Set();
    let raf = 0;
    const flush = () => {
      raf = 0;
      const nodes = new Set(pending);
      pending.clear();
      for (const node of nodes) {
        if (!node.isConnected) continue;

        let up = node.parentElement, inner = false;
        while (up) { if (nodes.has(up)) { inner = true; break; } up = up.parentElement; }
        if (!inner) decorate(node);
      }
    };
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1 || node.classList.contains('lmac-box')) continue;
          if (node.closest && node.closest('.lmac-pop')) continue;
          pending.add(node);
        }
      }
      if (pending.size && !raf) raf = requestAnimationFrame(flush);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  if (window.__LMAC_TEST__) window.__LMAC__ = { parseEntries, findTabPane, patternFrom, resultFor, paint };
}

(function lmSuite() {
  'use strict';
  const SUITE_VERSION = LM_VERSIONS.suite;
  const OFF_KEY = 'lmSuite:off';
  const TOP = window.self === window.top;
  const isQueue = () => location.hostname === 'looksmax.org' && /^\/approval-queue\//.test(location.pathname);
  const TOOLS = [

    { id: 'queue', label: 'Approval queue', fn: moduleQueue, here: isQueue, frames: true },
    { id: 'reports', label: 'Report Center', fn: moduleReports, here: () => /^\/reports/.test(location.pathname) },
    { id: 'dms', label: 'DM filter', fn: moduleDms, here: () => /^\/conversations/.test(location.pathname) },
    { id: 'alts', label: 'Alt counter', fn: moduleAltCounter, here: () => true },
  ];
  const readOff = () => {
    try { return new Set(JSON.parse(localStorage.getItem(OFF_KEY) || '[]')); } catch (_) { return new Set(); }
  };
  const off = readOff();
  const old = [];

  if (TOP && typeof GM_registerMenuCommand === 'function') {
    TOOLS.forEach((t) => {
      try {
        const isOff = off.has(t.id);
        GM_registerMenuCommand((isOff ? '○ ' : '● ') + t.label + ': ' + (isOff ? 'OFF — turn on' : 'ON — turn off'), () => {
          const o = readOff();
          if (o.has(t.id)) o.delete(t.id); else o.add(t.id);
          try { localStorage.setItem(OFF_KEY, JSON.stringify([...o])); } catch (_) {}
          location.reload();
        });
      } catch (_) {}
    });
  }

  function start(t) {
    try {
      const r = t.fn();
      if (r && typeof r.catch === 'function') r.catch((e) => console.error('[Moderator Suite] ' + t.label + ' crashed:', e));
    } catch (e) {
      console.error('[Moderator Suite] ' + t.label + ' crashed:', e);
    }
  }

  const queueHere = isQueue();
  TOOLS.forEach((t) => {
    if (off.has(t.id) || !t.here() || (!TOP && !t.frames)) return;
    if (t.id === 'queue' && (document.getElementById('lmq-style') || document.getElementById('lmqDock'))) {

      old.push('Approval queue (the suite\'s queue stays off on this page)');
      return;
    }
    if (t.id === 'alts' && queueHere) { setTimeout(() => start(t), 1200); return; }
    start(t);
  });
  console.log('[Moderator Suite] v' + SUITE_VERSION + ' — on: ' +
    TOOLS.filter((t) => !off.has(t.id) && t.here() && (TOP || t.frames)).map((t) => t.label).join(', '));

  const SVC = [

    { id: 'zerogpt', label: 'AI check (Sapling)', url: 'https://api.sapling.ai/' },
    { id: 'proxycheck', label: 'proxycheck', url: 'https://proxycheck.io/' },

    { id: 'translate', label: 'Translation', url: 'https://api-free.deepl.com/', quiet: true },
  ];
  const WHERE = { queue: '/approval-queue/', reports: '/reports', dms: '/conversations', alts: 'every page' };
  const ICON = { queue: 'Q', reports: 'R', dms: 'DM', alts: 'A' };

  const GO = [
    { id: 'queue', label: 'Queue', href: '/approval-queue/', badge: 'a[href*="approval-queue"][data-badge]' },
    { id: 'reports', label: 'Reports', href: '/reports/', badge: '.p-staffBar a[href*="/reports"][data-badge], a.p-staffBar-link[href*="/reports"][data-badge]' },
    { id: 'dms', label: 'DMs', href: '/conversations/', badge: '.p-navgroup-link--conversations[data-badge], a[href$="/conversations/"][data-badge]' },
  ];

  const OPTS = [
    { id: 'altCookieOnly', ico: 'A', label: 'Ban sheet: tick cookie alts only',
      on: 'IP-only alts start unticked in the alt counter sheet — tick them by hand if you want',
      off: 'off — every active alt starts ticked' },
  ];
  const offAtStart = new Set(off);
  const P = { el: null, shade: null, rows: {}, opts: {}, svc: {}, tiles: {}, go: {}, timer: 0, ping: {}, pingAt: 0 };
  const nf = (n) => Number(n || 0).toLocaleString('en-US');
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  };
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const put = (e, v) => { v = String(v); if (e.textContent !== v) e.textContent = v; };
  const badgeOf = (sel) => {
    const b = document.querySelector(sel);
    if (!b) return null;
    const n = parseInt(String(b.getAttribute('data-badge') || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };

  function panelCss() {
    if (document.getElementById('lms-css')) return;
    const st = mk('style');
    st.id = 'lms-css';
    st.textContent = `
#lmsShade{position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.58);opacity:0;transition:opacity .2s ease;-webkit-tap-highlight-color:transparent}
#lmsShade.is-on{opacity:1}
#lmsPanel{--lm-drag:0px;position:fixed;left:50%;bottom:0;z-index:2147483646;width:min(560px,100vw);max-height:86vh;overflow:auto;overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;box-sizing:border-box;padding:8px 14px calc(env(safe-area-inset-bottom,0px) + 18px);
  transform:translate(-50%,calc(104% + var(--lm-drag)));transition:transform .32s cubic-bezier(.22,1,.36,1);
  background:radial-gradient(120% 60% at 50% 0%,rgba(224,205,158,.09),transparent 60%),linear-gradient(180deg,#141417,#0a0a0c);
  color:#ece8de;border:1px solid rgba(224,205,158,.26);border-bottom:0;border-radius:22px 22px 0 0;
  box-shadow:0 -1px 0 rgba(241,227,194,.18) inset,0 -16px 50px rgba(0,0,0,.65);
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
#lmsPanel.is-on{transform:translate(-50%,var(--lm-drag))}
#lmsPanel *{box-sizing:border-box}
#lmsPanel [hidden]{display:none!important}
#lmsPanel .lms-top{padding:2px 0 4px;margin:0 -14px;padding-left:14px;padding-right:14px}
#lmsPanel .lms-grab{width:40px;height:5px;border-radius:3px;background:rgba(224,205,158,.38);margin:2px auto 12px}
#lmsPanel .lms-head{display:flex;align-items:center;gap:11px;margin-bottom:14px}
#lmsPanel .lms-brand{flex:none;display:grid;place-items:center;width:38px;height:38px;border-radius:12px;
  background:linear-gradient(140deg,#faf0d8 0%,#e0cd9e 45%,#9a8a66 100%);color:#15110a;font-weight:900;font-size:14px;letter-spacing:.02em;
  box-shadow:0 0 0 1px rgba(255,247,230,.35) inset,0 6px 18px rgba(224,205,158,.25)}
#lmsPanel .lms-title{min-width:0;font-weight:850;letter-spacing:.1em;font-size:12.5px;color:#f2e5c6}
#lmsPanel .lms-title small{display:flex;align-items:center;gap:6px;margin-top:3px;font-weight:650;letter-spacing:.01em;font-size:12px;color:rgba(236,232,222,.62);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#lmsPanel .lms-title small::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:#55555c}
#lmsPanel .lms-title small[data-s=ok]::before{background:#3ecf8e;box-shadow:0 0 8px rgba(62,207,142,.7)}
#lmsPanel .lms-title small[data-s=bad]{color:#ffb3bb}
#lmsPanel .lms-title small[data-s=bad]::before{background:#ff5466;box-shadow:0 0 8px rgba(255,84,102,.7)}
#lmsPanel .lms-x{margin-left:auto;flex:none;width:44px;height:44px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);
  color:#ece8de;font:600 20px/1 inherit;cursor:pointer;display:grid;place-items:center}
#lmsPanel h4{display:flex;align-items:center;gap:8px;margin:18px 2px 8px;font-size:10.5px;letter-spacing:.14em;color:rgba(224,205,158,.8);font-weight:850;text-transform:uppercase}
#lmsPanel h4::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(224,205,158,.25),transparent)}
#lmsPanel .lms-go{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
#lmsPanel .lms-go a{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-height:62px;padding:10px 12px;border-radius:14px;
  background:linear-gradient(180deg,#1b1b20,#141418);border:1px solid rgba(255,255,255,.07);color:#ece8de!important;text-decoration:none!important;
  -webkit-tap-highlight-color:transparent;transition:transform .12s ease,border-color .2s ease}
#lmsPanel .lms-go a:active{transform:scale(.97)}
#lmsPanel .lms-go a b{font-size:22px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums;color:#f1e3c2}
#lmsPanel .lms-go a span{font-size:11px;font-weight:700;color:rgba(236,232,222,.62);letter-spacing:.02em}
#lmsPanel .lms-go a[data-hot]{border-color:rgba(224,205,158,.45);box-shadow:0 0 0 1px rgba(224,205,158,.12) inset}
#lmsPanel .lms-go a small{font-size:10.5px;font-weight:700;color:rgba(236,232,222,.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
#lmsPanel .lms-go a small:empty{display:none}
#lmsPanel .lms-go a small[data-s=hot]{color:#f1e3c2}
#lmsPanel .lms-go a[data-here]::after{content:"here";position:absolute;top:9px;right:10px;font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(224,205,158,.75)}
#lmsPanel .lms-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
#lmsPanel .lms-tile{padding:10px 8px;border-radius:14px;background:rgba(255,255,255,.03);border:1px solid rgba(224,205,158,.14);text-align:center}
#lmsPanel .lms-tile b{display:block;font-size:19px;font-weight:800;color:#f1e3c2;font-variant-numeric:tabular-nums}
#lmsPanel .lms-tile span{font-size:10.5px;font-weight:650;color:rgba(236,232,222,.58)}
#lmsPanel .lms-list{border-radius:16px;background:#111114;border:1px solid rgba(255,255,255,.07);overflow:hidden}
#lmsPanel .lms-row{display:flex;align-items:center;gap:12px;padding:10px 12px;min-height:58px;border-top:1px solid rgba(255,255,255,.06)}
#lmsPanel .lms-row:first-child{border-top:0}
#lmsPanel .lms-ico{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:11px;font-weight:900;font-size:12px;letter-spacing:.02em;
  color:#f1e3c2;background:rgba(224,205,158,.1);border:1px solid rgba(224,205,158,.28)}
#lmsPanel .lms-row[data-off] .lms-ico{color:#77736b;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1)}
#lmsPanel .lms-row-main{flex:1;min-width:0}
#lmsPanel .lms-row-main b{display:block;font-size:14px;font-weight:700}
#lmsPanel .lms-row-main b small{font-size:11px;font-weight:700;color:rgba(224,205,158,.7);margin-left:6px;letter-spacing:.03em}
#lmsPanel .lms-row-main span{display:block;font-size:12px;color:rgba(236,232,222,.58);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#lmsPanel .lms-row-main span[data-s=bad]{color:#ffa3ad}
#lmsPanel .lms-row-main span.lms-wrap,#lmsPanel .lms-opt .lms-row-main span{white-space:normal}
#lmsPanel .lms-dot{flex:none;width:10px;height:10px;border-radius:50%;background:#55555c;margin:0 4px}
#lmsPanel .lms-dot[data-s=ok]{background:#3ecf8e;box-shadow:0 0 10px rgba(62,207,142,.6)}
#lmsPanel .lms-dot[data-s=bad]{background:#ff5466;box-shadow:0 0 10px rgba(255,84,102,.6)}
#lmsPanel .lms-dot[data-s=run]{background:#f1e3c2;animation:lms-pulse 1s ease-in-out infinite}
#lmsPanel .lms-dot[data-s=off]{background:#6f6b62;box-shadow:none}
@keyframes lms-pulse{50%{opacity:.3}}
#lmsPanel .lms-ms{flex:none;font-size:11px;font-weight:750;font-variant-numeric:tabular-nums;color:rgba(236,232,222,.55);padding:3px 8px;border-radius:999px;
  border:1px solid rgba(255,255,255,.1)}
#lmsPanel .lms-ms:empty{display:none}
#lmsPanel .lms-ms[data-s=bad]{color:#ffa3ad;border-color:rgba(255,84,102,.4)}
#lmsPanel .lms-sw{flex:none;position:relative;width:52px;height:32px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:#2a2a30;cursor:pointer;padding:0;
  -webkit-tap-highlight-color:transparent}
#lmsPanel .lms-sw::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#bdbab2;
  transition:transform .22s cubic-bezier(.3,1.4,.5,1),background .16s ease;box-shadow:0 2px 6px rgba(0,0,0,.4)}
#lmsPanel .lms-sw[aria-checked=true]{background:linear-gradient(135deg,#efe0bb,#a8966f);border-color:rgba(241,227,194,.6)}
#lmsPanel .lms-sw[aria-checked=true]::after{transform:translateX(20px);background:#15110a}
#lmsPanel .lms-btn{min-height:44px;padding:0 16px;border-radius:13px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#ece8de;
  font:700 13px/1 inherit;cursor:pointer;transition:transform .12s ease;-webkit-tap-highlight-color:transparent}
#lmsPanel .lms-btn:active,#lmsPanel .lms-x:active{transform:scale(.96)}
#lmsPanel .lms-btn--gold{background:linear-gradient(135deg,#f1e3c2,#ab9870);color:#15110a;border-color:transparent;box-shadow:0 6px 18px rgba(224,205,158,.22)}
#lmsPanel .lms-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
#lmsPanel .lms-actions .lms-btn{flex:1 1 auto}
#lmsPanel .lms-warn{margin-top:12px;padding:11px 13px;border-radius:14px;border:1px solid rgba(255,84,102,.45);border-left:3px solid #ff5466;background:#1a1012;color:#ffb3bb}
#lmsPanel .lms-foot{margin-top:14px;font-size:10.5px;color:rgba(236,232,222,.38);text-align:center}
#lmsPanel .lms-by{display:inline-block;margin-left:8px;padding:2px 7px;border-radius:999px;border:1px solid rgba(224,205,158,.35);
  font-size:10px;font-weight:800;letter-spacing:.06em;color:rgba(244,231,200,.9);vertical-align:2px}
#lmsPanel .lms-sig{display:flex;flex-direction:column;align-items:center;gap:3px;margin:18px 0 4px;font-size:10px;letter-spacing:.22em;
  text-transform:uppercase;color:rgba(236,232,222,.35)}
#lmsPanel .lms-sig b{font-size:13px;letter-spacing:.12em;font-weight:850;background:linear-gradient(115deg,#a8966f,#fff7e6 45%,#e0cd9e 70%,#9a8a66);
  background-size:260% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:lm-gold 2.6s ease-in-out 1}
.lms-trigger{display:inline-flex;align-items:center;justify-content:center;height:22px;min-width:34px;margin:0 4px;padding:0 8px;border-radius:7px;
  border:1px solid rgba(255,247,230,.55);background:linear-gradient(140deg,#faf0d8,#e0cd9e 50%,#a8966f);color:#15110a;font:900 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;
  letter-spacing:.04em;cursor:pointer;vertical-align:middle;-webkit-tap-highlight-color:transparent;position:relative;box-shadow:0 2px 10px rgba(224,205,158,.25)}
.lms-trigger::before{content:"";position:absolute;inset:-11px -4px}
.lms-trigger:active{transform:scale(.94)}
.lms-trigger[data-s=bad]::after{content:"";position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;background:#ff5466;border:1px solid #111;
  box-shadow:0 0 6px rgba(255,84,102,.8)}
.lms-trigger.lms-float{position:fixed;left:10px;bottom:calc(env(safe-area-inset-bottom,0px) + 12px);z-index:2147483000;height:34px;min-width:44px;border-radius:11px;
  box-shadow:0 4px 16px rgba(0,0,0,.5);opacity:.88;transition:bottom .2s ease}
body.lrt-has-dock .lms-trigger.lms-float,body.lmd-has-dock .lms-trigger.lms-float{bottom:calc(env(safe-area-inset-bottom,0px) + 96px)}
@media (prefers-reduced-motion:reduce){#lmsPanel,#lmsShade,#lmsPanel .lms-sw::after{transition:none}}
`;
    (document.head || document.documentElement).appendChild(st);
  }

  function panelBuild() {
    if (P.el) return;
    panelCss();
    const shade = mk('div');
    shade.id = 'lmsShade';
    shade.addEventListener('click', () => panelClose());
    const el = mk('div');
    el.id = 'lmsPanel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Moderator Suite by Atra');

    const top = mk('div', 'lms-top');
    const head = mk('div', 'lms-head');
    const title = mk('div', 'lms-title', 'MODERATOR SUITE');
    title.appendChild(mk('span', 'lms-by', 'by Atra · v' + SUITE_VERSION));
    P.sum = mk('small', null, '');
    title.appendChild(P.sum);
    const x = mk('button', 'lms-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => panelClose());
    head.append(mk('span', 'lms-brand', 'LM'), title, x);
    top.append(mk('div', 'lms-grab'), head);

    const go = mk('div', 'lms-go');
    GO.forEach((g) => {
      const a = mk('a');
      a.href = g.href;
      const b = mk('b', null, '–');
      const sub = mk('small', null, '');
      a.append(b, mk('span', null, g.label), sub);
      go.appendChild(a);
      P.go[g.id] = { a, b, sub };
    });

    const tiles = mk('div', 'lms-tiles');
    [['queue', 'Queue saved'], ['reports', 'Reports handled'], ['bans', 'Permabans']].forEach(([k, l]) => {
      const t = mk('div', 'lms-tile');
      const b = mk('b', null, '0');
      t.append(b, mk('span', null, l));
      tiles.appendChild(t);
      P.tiles[k] = b;
    });

    const tools = mk('div', 'lms-list');
    TOOLS.forEach((t) => {
      const row = mk('div', 'lms-row');
      const main = mk('div', 'lms-row-main');
      const name = mk('b', null, t.label);
      name.appendChild(mk('small', null, 'v' + (LM_VERSIONS[t.id] || '')));
      const where = mk('span');
      main.append(name, where);
      const sw = mk('button', 'lms-sw');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', t.label);
      sw.addEventListener('click', () => {
        const o = readOff();
        if (o.has(t.id)) o.delete(t.id); else o.add(t.id);
        try { localStorage.setItem(OFF_KEY, JSON.stringify([...o])); } catch (_) {}
        panelUpdate();
      });
      row.append(mk('span', 'lms-ico', ICON[t.id] || '•'), main, sw);
      tools.appendChild(row);
      P.rows[t.id] = { row, where, sw };
    });
    const toolAct = mk('div', 'lms-actions');
    const reload = mk('button', 'lms-btn lms-btn--gold', 'Reload to apply');
    reload.type = 'button';
    reload.addEventListener('click', () => location.reload());
    reload.hidden = true;
    P.reload = reload;

    const fresh = mk('button', 'lms-btn', 'Reload alt data');
    fresh.type = 'button';
    fresh.addEventListener('click', () => {
      try {
        Object.keys(localStorage).forEach((k) => {
          if (/^lmAltCounter:v2:(u|s|m):/.test(k)) localStorage.removeItem(k);
        });
      } catch (_) {}
      location.reload();
    });
    toolAct.append(reload, fresh);

    const opts = mk('div', 'lms-list lms-opt');
    OPTS.forEach((o) => {
      const row = mk('div', 'lms-row');
      const main = mk('div', 'lms-row-main');
      const what = mk('span');
      main.append(mk('b', null, o.label), what);
      const sw = mk('button', 'lms-sw');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', o.label);
      sw.addEventListener('click', () => { LMS.setOpt(o.id, !LMS.opt(o.id)); panelUpdate(); });
      row.append(mk('span', 'lms-ico', o.ico), main, sw);
      opts.appendChild(row);
      P.opts[o.id] = { row, what, sw };
    });

    const svc = mk('div', 'lms-list');
    SVC.forEach((v) => {
      const row = mk('div', 'lms-row');
      const dot = mk('i', 'lms-dot');
      const main = mk('div', 'lms-row-main');
      const last = mk('span');
      main.append(mk('b', null, v.label), last);
      const ms = mk('span', 'lms-ms');
      row.append(dot, main, ms);
      svc.appendChild(row);
      P.svc[v.id] = { dot, last, ms };
    });
    const svcAct = mk('div', 'lms-actions');
    const test = mk('button', 'lms-btn', 'Test again');
    test.type = 'button';
    test.addEventListener('click', () => pingAll(true));
    svcAct.appendChild(test);

    P.warn = mk('div', 'lms-warn');
    P.warn.hidden = true;
    const foot = mk('div', 'lms-foot', 'The test only checks that each server answers — no key is sent, no credits are used. Numbers are from this device.');
    const sig = mk('div', 'lms-sig');
    sig.append(mk('span', null, 'Moderator Suite'), mk('b', null, 'crafted by Atra'));

    void tiles;
    el.append(top, mk('h4', null, 'Go to'), go, mk('h4', null, 'Tools'), tools, toolAct,
      mk('h4', null, 'Options'), opts, mk('h4', null, 'Services'), svc, svcAct, P.warn, foot, sig);
    document.body.append(shade, el);
    P.el = el;
    P.shade = shade;
    LM_SWIPE_CLOSE(el, [top], () => panelClose());
  }

  function panelUpdate() {
    if (!P.el) return;
    GO.forEach((g) => {
      const r = P.go[g.id];
      const n = badgeOf(g.badge);
      put(r.b, n == null ? '→' : nf(n));
      if (n > 0) r.a.dataset.hot = ''; else delete r.a.dataset.hot;
      const here = location.pathname.indexOf(g.href) === 0;
      if (here) r.a.dataset.here = ''; else delete r.a.dataset.here;

      const st = LMS.status(g.id);
      const fresh = st && Date.now() - st.t < 3 * 3600e3;
      const txt = !fresh ? ''
        : g.id === 'queue' ? (st.paused ? 'paused' : st.manual ? st.manual + ' manual' : st.busy ? 'checking …' : 'no manual')
        : g.id === 'reports' ? (st.ready ? st.ready + ' ready to send' : st.checking ? 'checking …' : st.open ? st.open + ' to review' : 'all done')
        : '';
      put(r.sub, txt);
      if (fresh && ((g.id === 'queue' && st.manual) || (g.id === 'reports' && st.ready))) r.sub.dataset.s = 'hot'; else delete r.sub.dataset.s;
    });
    const d = LMS.today();
    put(P.tiles.queue, nf(d.queue));
    put(P.tiles.reports, nf(d.reports));
    put(P.tiles.bans, nf(d.queueBans + d.reportBans + d.altBans));
    const o = readOff();
    let changed = false;
    TOOLS.forEach((t) => {
      const r = P.rows[t.id];
      const on = !o.has(t.id);
      if (on !== !offAtStart.has(t.id)) changed = true;
      r.sw.setAttribute('aria-checked', String(on));
      if (on) delete r.row.dataset.off; else r.row.dataset.off = '';
      const here = t.here();
      put(r.where, !on ? 'off' + (offAtStart.has(t.id) ? '' : ' after reload')
        : offAtStart.has(t.id) ? 'on after reload · ' + WHERE[t.id]
        : here ? 'running on this page' : 'starts on ' + WHERE[t.id]);
    });
    P.reload.hidden = !changed;
    OPTS.forEach((o) => {
      const r = P.opts[o.id];
      const on = LMS.opt(o.id);
      r.sw.setAttribute('aria-checked', String(on));
      if (on) delete r.row.dataset.off; else r.row.dataset.off = '';
      put(r.what, on ? o.on : o.off);
    });
    const st = LMS.svcRead();
    const bad = [];
    SVC.forEach((v) => {
      const r = P.svc[v.id];
      if (v.id === 'server' && !LMS.opt('lmServer')) {
        put(r.last, 'switched off in Options — local dedup only');
        delete r.last.dataset.s;
        put(r.ms, '');
        r.dot.dataset.s = 'off';
        return;
      }
      const e = st[v.id];
      const pg = P.ping[v.id];
      const lastBad = e && !e.ok && !v.quiet;
      put(r.last, e ? (e.ok ? '✓ answered ' : '✗ ' + String(e.m || 'failed').replace(/^proxycheck\s+/i, '') + ' · ') + ago(e.t)
        : 'not used on this device yet');
      if (lastBad) r.last.dataset.s = 'bad'; else delete r.last.dataset.s;
      put(r.ms, !pg ? '' : pg.run ? '…' : pg.ok ? pg.ms + ' ms' : 'offline');
      if (pg && !pg.run && !pg.ok) r.ms.dataset.s = 'bad'; else delete r.ms.dataset.s;
      let s = pg && pg.run ? 'run' : pg && !pg.run && !pg.ok ? 'bad' : lastBad && Date.now() - e.t < 3600e3 ? 'bad'
        : (pg && pg.ok) || (e && e.ok) ? 'ok' : '';
      if (v.quiet && s === 'bad') s = 'off';
      if (v.quiet && e && !e.ok && s !== 'run') s = 'off';
      if ((r.dot.dataset.s || '') !== s) r.dot.dataset.s = s;
      if (s === 'bad') bad.push(v.label);
    });

    const sumTxt = bad.length ? bad.join(' + ') + (bad.length > 1 ? ' have' : ' has') + ' a problem' : 'All services OK';
    put(P.sum, sumTxt);
    P.sum.dataset.s = bad.length ? 'bad' : 'ok';
    const list = [...new Set(old)];
    P.warn.hidden = !list.length;
    if (list.length) put(P.warn, 'Old script still installed: ' + list.join(', ') + '. Delete or turn it off in your userscript manager.');
    triggerState();
  }

  function ping(v) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      let done = false;
      const fin = (ok, m) => { if (done) return; done = true; clearTimeout(wd); resolve({ ok, m, ms: Math.round(performance.now() - t0) }); };
      const wd = setTimeout(() => fin(false, 'no answer in 8 s'), 8000);
      try {
        GM_xmlhttpRequest({ method: 'GET', url: v.url, timeout: 7000,
          onload: () => fin(true), onerror: () => fin(false, 'network error'), ontimeout: () => fin(false, 'timeout') });
      } catch (e) { fin(false, 'request blocked'); }
    });
  }
  function pingAll(force) {
    if (typeof GM_xmlhttpRequest !== 'function') return;
    if (!force && Date.now() - P.pingAt < 60e3) return;
    P.pingAt = Date.now();
    SVC.forEach((v) => {
      if (v.id === 'server' && !LMS.opt('lmServer')) return;
      P.ping[v.id] = { run: true };
      ping(v).then((r) => { P.ping[v.id] = r; panelUpdate(); });
    });
    panelUpdate();
  }

  function countUpAll() {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const els = [...Object.values(P.tiles), ...Object.values(P.go).map((g) => g.b)];
    const goal = els.map((e) => { const n = Number(String(e.textContent).replace(/[^\d]/g, '')); return /\d/.test(e.textContent) ? n : null; });
    const t0 = performance.now(), dur = 650;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), ease = 1 - Math.pow(1 - k, 3);
      els.forEach((e, i) => { if (goal[i] !== null) e.textContent = nf(Math.round(goal[i] * ease)); });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  let lastFocus = null;
  function panelOpen() {
    panelBuild();
    panelUpdate();
    countUpAll();
    lastFocus = document.activeElement;
    P.shade.style.display = P.el.style.display = '';
    P.el.style.setProperty('--lm-drag', '0px');
    requestAnimationFrame(() => requestAnimationFrame(() => { P.shade.classList.add('is-on'); P.el.classList.add('is-on'); }));
    pingAll(false);
    clearInterval(P.timer);
    P.timer = setInterval(panelUpdate, 3000);
  }
  function panelClose() {
    if (!P.el || !P.el.classList.contains('is-on')) return;
    clearInterval(P.timer);
    P.shade.classList.remove('is-on');
    P.el.classList.remove('is-on');
    setTimeout(() => { if (!P.el.classList.contains('is-on')) { P.shade.style.display = 'none'; P.el.style.display = 'none'; } }, 340);
    try { if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); } catch (_) {}
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') panelClose(); });

  let trig = null;
  function triggerState() {
    if (!trig) return;
    const st = LMS.svcRead();
    const bad = SVC.some((v) => !v.quiet && st[v.id] && !st[v.id].ok && Date.now() - st[v.id].t < 3600e3);
    const s = bad ? 'bad' : '';
    if ((trig.dataset.s || '') !== s) { if (s) trig.dataset.s = s; else delete trig.dataset.s; }
    trig.title = bad ? 'Moderator Suite by Atra — a service had a problem' : 'Moderator Suite by Atra';
  }
  function placeTrigger() {
    if (trig && trig.isConnected) return;
    panelCss();
    trig = mk('button', 'lms-trigger', 'LM');
    trig.type = 'button';
    trig.setAttribute('aria-label', 'Moderator Suite by Atra');
    trig.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); panelOpen(); });
    const bar = document.querySelector('.p-staffBar-inner') || document.querySelector('.p-staffBar');
    if (bar) bar.appendChild(trig);
    else { trig.classList.add('lms-float'); document.body.appendChild(trig); }
    triggerState();
  }
  if (TOP) {
    if (document.body) placeTrigger();
    else document.addEventListener('DOMContentLoaded', placeTrigger);
    window.addEventListener('storage', (e) => {
      if (e.key === LMS.SVC_KEY) { triggerState(); if (P.el && P.el.classList.contains('is-on')) panelUpdate(); }
    });
    window.addEventListener('lm-suite-svc', () => { triggerState(); if (P.el && P.el.classList.contains('is-on')) panelUpdate(); });
    setInterval(triggerState, 60e3);
    if (typeof GM_registerMenuCommand === 'function') {
      try { GM_registerMenuCommand('⚙ Suite panel', panelOpen); } catch (_) {}
    }
  }

  if (TOP) {
    const HIST_KEY = 'lmSuite:hist';
    const snap = () => {
      try {
        const d = LMS.today();
        if (!d.queue && !d.queueBans && !d.reports && !d.reportBans && !d.altBans) return;
        const h = JSON.parse(localStorage.getItem(HIST_KEY) || '{}');
        const k = LMS.dayKey();
        const v = { q: d.queue, qb: d.queueBans, r: d.reports, rb: d.reportBans, ab: d.altBans };
        if (JSON.stringify(h[k]) === JSON.stringify(v)) return;
        h[k] = v;
        const keys = Object.keys(h);

        const num = (x) => x.split('-').reduce((a, n) => a * 100 + Number(n), 0);
        if (keys.length > 60) keys.sort((x, y) => num(x) - num(y)).slice(0, keys.length - 60).forEach((x) => delete h[x]);
        localStorage.setItem(HIST_KEY, JSON.stringify(h));
      } catch (_) {}
    };
    setTimeout(snap, 4000);
    setInterval(snap, 30000);
    window.addEventListener('pagehide', snap);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') snap(); });
  }

  if (TOP) {
    const lux = document.createElement('style');
    lux.id = 'lm-lux-css';
    lux.textContent = `
@keyframes lm-gold{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
@keyframes lm-pop{0%{transform:scale(.86);opacity:.2}60%{transform:scale(1.04);opacity:1}100%{transform:scale(1)}}
@keyframes lm-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes lm-glow{0%{box-shadow:0 0 0 0 rgba(241,227,194,.55)}100%{box-shadow:0 0 0 12px rgba(241,227,194,0)}}
.lrt-logo,#lmsPanel .lms-brand,.lms-trigger,.lmq-brand,.lrt-brand,.lmd-brand,.lmac-brand{
  background-image:linear-gradient(115deg,#a8966f 0%,#e0cd9e 22%,#fff7e6 40%,#e0cd9e 58%,#9a8a66 80%,#e0cd9e 100%)!important;
  background-size:260% 100%!important;animation:lm-gold 2.6s ease-in-out 1}
/* a fresh result pops in once */
.lmq-card:not([data-tone="run"]) .lmq-verdict{animation:lm-pop .34s cubic-bezier(.2,.9,.3,1.3) both}
.lmac-box.lmac-red,.lmac-box.lmac-amber{animation:lm-pop .3s cubic-bezier(.2,.9,.3,1.3) both}
.lrt-card.is-marked .lrt-state{animation:lm-rise .28s ease-out both}
.lrt-card.is-marked{animation:lm-glow .7s ease-out 1}
.is-lmd-sel{animation:lm-glow .6s ease-out 1}
/* panels come in softly */
.lrt-fbody,.lrt-sum,.lrt-altbulk{animation:lm-rise .3s ease-out both}
#lmsPanel.is-on .lms-top,#lmsPanel.is-on > h4,#lmsPanel.is-on > .lms-go,#lmsPanel.is-on > .lms-tiles,#lmsPanel.is-on > .lms-list,
#lmsPanel.is-on > .lms-actions{animation:lm-rise .42s cubic-bezier(.22,1,.36,1) both}
#lmsPanel.is-on > :nth-child(2),#lmsPanel.is-on > :nth-child(3){animation-delay:.04s}
#lmsPanel.is-on > :nth-child(4),#lmsPanel.is-on > :nth-child(5){animation-delay:.08s}
#lmsPanel.is-on > :nth-child(6),#lmsPanel.is-on > :nth-child(7),#lmsPanel.is-on > :nth-child(8){animation-delay:.12s}
#lmsPanel.is-on > :nth-child(n+9){animation-delay:.16s}
@media (prefers-reduced-motion:reduce){
  .lrt-logo,#lmsPanel .lms-brand,.lms-trigger,.lmq-brand,.lrt-brand,.lmd-brand,.lmac-brand,
  .lmq-card .lmq-verdict,.lmac-box,.lrt-card,.lrt-card .lrt-state,.is-lmd-sel,.lrt-fbody,.lrt-sum,.lrt-altbulk,#lmsPanel *{animation:none!important}
}`;
    (document.head || document.documentElement).appendChild(lux);

    const aura = document.createElement('style');
    aura.id = 'lm-aura-css';
    aura.textContent = `
@keyframes lm-aura{0%,100%{opacity:.18;transform:scaleX(.55)}50%{opacity:.8;transform:scaleX(1)}}
#lmqDock,#lrt-dock,#lmdDock{
  background:radial-gradient(130% 140% at 50% -60%,rgba(244,231,200,.11),transparent 58%),linear-gradient(180deg,#151518,#0b0b0d)!important;
  border-color:rgba(241,227,194,.30)!important;
  box-shadow:0 12px 32px rgba(0,0,0,.62),0 0 26px -8px rgba(224,205,158,.30),inset 0 1px 0 rgba(255,250,238,.08)!important}
#lmqDock[data-tone=err],#lmdDock[data-tone=err]{border-color:rgba(255,84,102,.6)!important}
.lmd-bar{position:relative;border:1px solid rgba(241,227,194,.18)!important}
.lrc-bar,.xfcf-wrap,.lmac-pop,.lmd-bar{
  box-shadow:inset 0 1px 0 rgba(255,250,238,.09),0 14px 34px rgba(0,0,0,.42),0 0 30px -12px rgba(224,205,158,.28)!important}
.xfcf-wrap{position:relative;overflow:hidden;border-color:rgba(241,227,194,.18)!important}
#lmsPanel{box-shadow:0 -1px 0 rgba(255,250,238,.16) inset,0 -16px 50px rgba(0,0,0,.65),0 -6px 40px -14px rgba(224,205,158,.30)!important}
/* the breathing light line on the top edge */
#lrt-dock::after,#lmdDock::after,.lrc-bar::after,.xfcf-wrap::after,#lmqDock::after,.lmd-bar::after{content:"";position:absolute;left:14%;right:14%;top:0;height:1px;
  pointer-events:none;background:linear-gradient(90deg,transparent,rgba(255,250,238,.9),transparent);animation:lm-aura 3.2s ease-in-out 1 both}
/* calmer cards: the content and the verdict stand out, not the frame */
.lmq-card.lmq-card,.lrt-card.lrt-card{border-top-color:rgba(255,255,255,.065);border-right-color:rgba(255,255,255,.065);border-bottom-color:rgba(255,255,255,.065);box-shadow:inset 0 1px 0 rgba(255,255,255,.035)}
/* every active filter chip looks the same in all tools: filled white gold,
   dark text — you see at once what is switched on */
.lrt-rchip:not(.lrt-achip)[aria-pressed="true"],.lrt-trchip.lrt-trchip[aria-pressed="true"],.lmd-chip.lmd-chip.is-on{
  background:linear-gradient(180deg,#f8efda,#dcc89a);border-color:#f4e7c8;color:#161104;box-shadow:0 2px 10px rgba(224,205,158,.18)}
.lrt-rchip:not(.lrt-achip)[aria-pressed="true"] .lrt-rchip-n,.lmd-chip.lmd-chip.is-on b{color:#161104;opacity:.7}
/* the round LM button steps aside while the DM selection panel is open
   (it sat on top of "All visible" / "Leave") */
body.lmd-sel .lms-trigger.lms-float,body.lmd-dock-open .lms-trigger.lms-float{opacity:0;pointer-events:none;transform:scale(.85)}
.lms-trigger.lms-float{transition:bottom .2s ease,opacity .2s ease,transform .2s ease}
/* section titles in the same quiet white-gold */
#lmsPanel>h4{color:rgba(244,231,200,.85)!important}
@media (prefers-reduced-motion:reduce){
  #lrt-dock::after,#lmdDock::after,.lrc-bar::after,.xfcf-wrap::after,#lmqDock::after,.lmd-bar::after{animation:none;opacity:.35;transform:none}
}`;
    (document.head || document.documentElement).appendChild(aura);

    const P = (pre) => ['gold', 'gold-2', 'gold-dim', 'gold-faint', 's1', 's2', 's3', 'line', 'text', 'muted', 'ok', 'rej', 'ban', 'man', 'info']
      .map((k) => '--' + pre + '-' + k + ':var(--lm-' + k + ')').join(';');
    const design = document.createElement('style');
    design.id = 'lm-design-css';
    design.textContent = `
html:root{
  --lm-gold:#e7d3a3;--lm-gold-2:#f6ead0;--lm-gold-dim:rgba(241,227,194,.44);--lm-gold-faint:rgba(224,205,158,.14);
  --lm-s1:#141418;--lm-s2:#1c1c22;--lm-s3:#26262d;--lm-line:rgba(255,255,255,.12);
  --lm-text:#f3efe6;--lm-muted:#b4ae9f;
  --lm-ok:#4fd093;--lm-rej:#ff9c7c;--lm-ban:#ff5c6e;--lm-man:#ffbd55;--lm-info:#97bcff;
  --lm-panel:linear-gradient(180deg,#1b1b20 0%,#111115 100%);
  ${P('lmq')};${P('lrt')};${P('lmd')};${P('lmac')};
  --lrt-line-2:rgba(255,255,255,.2);--lrt-faint:#857f70
}
/* every panel: the same surface and a clear white-gold edge */
.lrc-bar,#lmqPanel,.lmd-bar,.lmac-pop,#lmsPanel,#lrt-dock,#lmdDock{background:var(--lm-panel)!important;border:1px solid var(--lm-gold-dim)!important;
  box-shadow:inset 0 1px 0 rgba(255,250,238,.11),0 14px 34px rgba(0,0,0,.5),0 0 28px -12px rgba(224,205,158,.34)!important}
#lmqPanel #lmqDock.is-top,#lmqPanel .xfcf-wrap{background:transparent!important;border-left:0!important;border-right:0!important;border-bottom:0!important;box-shadow:none!important}
#lmqPanel #lmqDock.is-top{border-top:0!important}
#lmqPanel #lmqDock.is-top::after,#lmqPanel .xfcf-wrap::after{display:none}
#lmqPanel::after{content:"";position:absolute;left:14%;right:14%;top:0;height:1px;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(255,250,238,.9),transparent);animation:lm-aura 3.2s ease-in-out 1 both}
/* small section titles: the same white gold everywhere */
html body .xfcf-label,html body .lrt-sec-t,html body .lmd-label{color:rgba(244,231,200,.8)}
/* chips: same size, text and look in every tool (the "on" look stays per tool's own rule) */
html body .xfcf-chip,html body .lrt-rchip,html body .lmd-chip{min-height:32px;padding:0 12px;border-radius:999px;box-sizing:border-box;
  border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#ece7da;font:650 12.5px/1 var(--lmq-font,-apple-system,BlinkMacSystemFont,sans-serif)}
html body .xfcf-n,html body .lrt-rchip-n,html body .lmd-chip b{color:var(--lm-muted);opacity:1;font-weight:700;font-size:11.5px}
html body .xfcf-chip.is-active .xfcf-n,html body .lmd-chip.is-on b,html body .lrt-rchip[aria-pressed="true"] .lrt-rchip-n{color:#161104;opacity:.72}
/* cards: a visible frame again (was nearly invisible) */
html body .lmq-card.lmq-card,html body .lrt-card.lrt-card{border-top-color:rgba(255,255,255,.12);border-right-color:rgba(255,255,255,.12);border-bottom-color:rgba(255,255,255,.12)}
/* 5.15: EVERYTHING AT ONCE — no chip row scrolls sideways any more, in no tool.
   Chips wrap onto the next line, the row title stays on the left and every
   line lines up under the first one. Chips a bit smaller so more fit. */
html body .xfcf-chip,html body .lrt-rchip,html body .lmd-chip{min-height:30px;padding:0 10px;font-size:12.5px}
html body .lrt-achip{min-height:30px}
.xfcf,.lrt-rules,.lrt-mtchips,.lrt-repchips,.lrt-forums,.lrt-altchips,.lmd-row--tabs{
  flex-wrap:wrap!important;overflow:visible!important;-webkit-mask-image:none!important;mask-image:none!important}
/* queue: title column 62px, chips wrap next to it */
.xfcf{position:relative;gap:6px!important;padding:0 0 0 66px!important;min-height:30px}
.xfcf>li{flex:0 0 auto;max-width:100%}
.xfcf>li.xfcf-label{position:absolute!important;left:0;top:0;height:30px;width:62px;min-width:0!important;margin:0;padding:0;
  background:none!important;box-shadow:none!important;overflow:hidden;text-overflow:ellipsis}
/* a second title inside a row (Queue … Rank) stays in the flow */
.xfcf>li.xfcf-label:not(:first-child){position:static!important;width:auto;height:30px;display:flex;align-items:center;margin:0 0 0 4px}
#lmqPanel .xfcf-wrap{gap:8px;padding:10px 12px 12px 14px}
#lmqPanel .xfcf-wrap .xfcf + .xfcf{padding-top:8px!important}
.xfcf-wrap .xfcf + .xfcf>li.xfcf-label:first-child{top:7px}
#lmqPanel .xfcf-wrap .xfcf + .xfcf>li.xfcf-label:first-child{top:8px}
/* reports: title on the left, chips wrap next to it */
.lrt-sec{align-items:flex-start!important}
.lrt-sec .lrt-sec-t{align-self:flex-start;line-height:30px!important;height:30px;margin-top:0!important;margin-bottom:0!important}
.lrt-rules,.lrt-mtchips,.lrt-repchips,.lrt-forums,.lrt-altchips{padding:0 14px 0 0!important;row-gap:6px!important}
/* DMs: the same */
.lmd-row--tabs{position:relative;padding-left:58px}
.lmd-row--tabs>.lmd-label{position:absolute;left:0;top:0;height:30px;line-height:30px;width:54px;margin:0}
.lmd-row--tabs>*{flex:0 0 auto;max-width:100%}
/* alt sheet: "debug" as a quiet link next to the version */
.lmac-pop .lmac-ver{flex:1 1 auto;flex-basis:auto}
.lmac-pop .lmac-meta{flex:1 1 100%;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
.lmac-pop .lmac-meta .lmac-ver{margin:0;text-align:left}
.lmac-pop button.lmac-dbg{flex:none;min-height:0;padding:2px 4px;border:0;background:none;font-size:10.5px;font-weight:700;color:rgba(224,205,158,.5)}
@media (prefers-reduced-motion:reduce){#lmqPanel::after{animation:none;opacity:.35}}
`;
    (document.head || document.documentElement).appendChild(design);
  }

  if (TOP) {
    const CONTACT_SEL = '#lmqPanel, .lrc-bar, .lmd-bar, .lmac-pop, #lmsPanel';
    const ccss = document.createElement('style');
    ccss.id = 'lm-contact-css';
    ccss.textContent =
      '.lm-contact{display:block;flex:1 1 100%;grid-column:1/-1;align-self:stretch;width:auto;max-width:100%;box-sizing:border-box;' +
      'margin:10px 14px 4px;padding:7px 0 2px;border-top:1px solid rgba(255,255,255,.07);text-align:center;' +
      'font:600 10.5px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;letter-spacing:.01em;color:rgba(236,232,222,.52)}' +
      '.lm-contact a{color:#e7d3a3!important;font-weight:800;text-decoration:none!important}' +
      '#lmqPanel>.lm-contact{margin:0 14px 10px}' +

      '#lmsPanel>.lm-contact,.lmac-pop>.lm-contact{position:sticky;bottom:0;z-index:3;margin:6px -1px 0;' +
      'padding:8px 14px calc(8px + env(safe-area-inset-bottom,0px));background:#121216;border-top:1px solid rgba(241,227,194,.14)}' +
      '.xf-report-btn,.xf-report-panel{display:none!important}';
    (document.head || document.documentElement).appendChild(ccss);
    const contactLine = () => {
      const d = document.createElement('div');
      d.className = 'lm-contact';
      d.append('If you have problems with the script, please contact ');
      const a = document.createElement('a');
      a.href = '/conversations/add?to=Atra';
      a.textContent = '@Atra';
      d.append(a);
      return d;
    };
    const ensureContact = () => {
      document.querySelectorAll(CONTACT_SEL).forEach((p) => {
        let c = null;
        for (const ch of p.children) { if (ch.classList.contains('lm-contact')) { c = ch; break; } }
        if (!c) p.appendChild(contactLine());
        else if (p.lastElementChild !== c) p.appendChild(c);
      });
    };
    let cT = 0;
    const soon = () => { if (!cT) cT = setTimeout(() => { cT = 0; ensureContact(); }, 250); };
    try { new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
    setTimeout(ensureContact, 300);
    setInterval(ensureContact, 3000);
  }

  if (TOP) {

    const FADE_SEL = '.lrc-chips';
    const css = document.createElement('style');
    css.id = 'lm-touch-css';
    css.textContent =
      '[data-lm-fade=r]{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 36px),transparent)}' +
      '[data-lm-fade=l]{-webkit-mask-image:linear-gradient(90deg,transparent,#000 28px);mask-image:linear-gradient(90deg,transparent,#000 28px)}' +
      '[data-lm-fade=lr]{-webkit-mask-image:linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 36px),transparent);' +
      'mask-image:linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 36px),transparent)}' +

      '.xfcf[data-lm-fade=l]{-webkit-mask-image:linear-gradient(90deg,#000 74px,rgba(0,0,0,.1) 76px,#000 106px);mask-image:linear-gradient(90deg,#000 74px,rgba(0,0,0,.1) 76px,#000 106px)}' +
      '.xfcf[data-lm-fade=lr]{-webkit-mask-image:linear-gradient(90deg,#000 74px,rgba(0,0,0,.1) 76px,#000 106px,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(90deg,#000 74px,rgba(0,0,0,.1) 76px,#000 106px,#000 calc(100% - 36px),transparent)}' +
      '.xfcf-chip,.lmq-dock-btn,.lmd-dock-btn,.lrt-b{transition:transform .12s ease}' +
      '.xfcf-chip:active,.lmq-dock-btn:active,.lmd-dock-btn:active{transform:scale(.96)}';
    (document.head || document.documentElement).appendChild(css);
    const fade = (el) => {
      const max = el.scrollWidth - el.clientWidth;
      const l = el.scrollLeft > 4, r = max - el.scrollLeft > 4;
      const v = l && r ? 'lr' : l ? 'l' : r ? 'r' : '';
      if ((el.getAttribute('data-lm-fade') || '') !== v) { if (v) el.setAttribute('data-lm-fade', v); else el.removeAttribute('data-lm-fade'); }
    };
    const fadeAll = () => document.querySelectorAll(FADE_SEL).forEach(fade);
    document.addEventListener('scroll', (e) => {
      const t = e.target;
      if (t && t.nodeType === 1 && t.matches(FADE_SEL)) fade(t);
    }, { capture: true, passive: true });
    window.addEventListener('resize', fadeAll, { passive: true });
    [800, 2000, 4500, 9000].forEach((ms) => setTimeout(fadeAll, ms));
    document.addEventListener('click', () => setTimeout(fadeAll, 60), { capture: true, passive: true });
  }

  if (!TOP) return;
  const check = () => {
    if (document.querySelectorAll('#lmqDock').length > 1 && !old.includes('Approval queue')) {
      old.push('Approval queue');

    }
  };
  if (queueHere) setTimeout(check, 400);
  setTimeout(() => {
    check();
    if (document.querySelector('.lmxdm-bar')) old.push('DM filter (old 1.x)');
    const ac = document.getElementById('lmac-css');
    if (ac && !ac.hasAttribute('data-suite')) old.push('Alt counter');
    if (document.querySelectorAll('.lrc-bar[data-lrt-bar]').length > 1 ||
        (document.querySelector('.lrc-bar[data-lrt-bar]') &&
         !document.querySelector('.lrc-bar[data-lrt-bar="' + LM_VERSIONS.reports + '"]'))) old.push('Report Turbo');
    if (!old.length || document.getElementById('lmSuiteOld')) return;
    const box = document.createElement('div');
    box.id = 'lmSuiteOld';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 10px);transform:translateX(-50%);z-index:2147483647;' +
      'width:min(520px,calc(100vw - 16px));box-sizing:border-box;padding:12px 14px;border-radius:14px;border:1px solid rgba(255,84,102,.45);' +
      'border-left:3px solid #ff5466;background:linear-gradient(180deg,#1a1012,#120b0d);color:#ece8de;box-shadow:0 8px 28px rgba(0,0,0,.6);' +
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif';
    const t = document.createElement('div');
    t.style.cssText = 'font-weight:800;color:#ff8d99;margin-bottom:4px';
    t.textContent = 'Old script still installed: ' + [...new Set(old)].join(', ');
    const b = document.createElement('div');
    b.textContent = 'The Mod Suite already contains it. Delete or turn off the old single script in your userscript manager, ' +
      'then reload — two copies of the queue would approve, reject and ban twice.' +
'';
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = 'OK';
    x.style.cssText = 'margin-top:10px;min-height:32px;padding:0 14px;border-radius:9px;border:1px solid rgba(255,255,255,.12);' +
      'background:#18181c;color:#ece8de;font:700 12.5px/1 inherit;cursor:pointer';
    x.addEventListener('click', () => box.remove());
    box.append(t, b, x);
    document.body.appendChild(box);
    console.warn('[Moderator Suite] old single script(s) still running: ' + old.join(', '));
  }, 2500);
})();
