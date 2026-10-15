/* หน้าเว็บทดสอบระบบจองโรงจอดรถ — vanilla JS ไม่ต้อง build */
'use strict';

const TZ = 'Asia/Bangkok';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (d) => new Date(d).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const fmtDT = (d) => new Date(d).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
};

const state = {
  token: store.get('parking_token'),
  me: null,          // ผลจาก /api/me
  status: null,      // ผลจาก /api/status
  slots: [],
  view: 'map',
  adminTab: 'overview',
  selectedSlot: null,
  clockBase: Date.now(),
  clockAt: performance.now(),
  pollTimer: null,
};

/* ---------- เรียก API ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) { setToken(null); }
    const err = new Error(data.error || 'เกิดข้อผิดพลาด');
    err.code = data.code; err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 5000 : 3000);
}

async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, true); return null; }
}

function setToken(t) {
  state.token = t; store.set('parking_token', t);
  if (!t) { state.me = null; if (state.view === 'mine' || state.view === 'admin') state.view = 'map'; }
}

/* ---------- เวลาของระบบ (รวมค่าจำลอง) ---------- */

const systemNow = () => state.clockBase + (performance.now() - state.clockAt);

function tickClock() {
  const el = $('#clock');
  if (!state.status) { el.textContent = ''; return; }
  const shifted = state.status.clock_offset_minutes > 0;
  el.className = `clock${shifted ? ' shifted' : ''}`;
  const d = new Date(systemNow());
  const hhmmss = d.toLocaleTimeString('th-TH', { hour12: false, timeZone: TZ });
  const date = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: TZ });
  el.innerHTML = `${esc(date)} ${esc(hhmmss)}${shifted ? `<br><small>จำลองเวลา +${state.status.clock_offset_minutes} นาที</small>` : ''}`;
}
setInterval(tickClock, 1000);

/* ---------- โหลดข้อมูลกลาง ---------- */

async function loadStatus() {
  state.status = await api('/status');
  state.clockBase = Date.parse(state.status.now); state.clockAt = performance.now();
  tickClock();
}
async function loadMe() {
  if (!state.token) { state.me = null; return; }
  try { state.me = await api('/me'); } catch (_) { state.me = null; }
}
async function loadSlots() { state.slots = await api('/slots'); }

async function refreshCore() {
  await Promise.all([loadStatus(), loadSlots(), loadMe()]);
  const down = $('#notice');
  down.hidden = true;
}

/* ---------- แถบบน ---------- */

function paintTop() {
  const items = [['map', 'ผังที่จอด'], ['mine', 'การจองของฉัน'], ['kiosk', 'Kiosk จำลอง']];
  if (state.me && state.me.member.role === 'ADMIN') items.push(['admin', 'ผู้ดูแลระบบ']);
  $('#nav').innerHTML = items.map(([k, t]) =>
    `<button data-v="${k}" ${state.view === k ? 'aria-current="page"' : ''}>${t}</button>`).join('');
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.v)));

  const box = $('#authBox');
  if (state.me) {
    const m = state.me.member;
    box.innerHTML = `<div class="user-chip"><span>${esc(m.name)}${m.status === 'SUSPENDED' ? ' <span class="pill bad">ถูกระงับ</span>' : ''}</span><button class="btn sm" id="logoutBtn">ออกจากระบบ</button></div>`;
    $('#logoutBtn').addEventListener('click', async () => {
      await act(() => api('/auth/logout', { method: 'POST' }));
      setToken(null); render();
    });
  } else {
    box.innerHTML = '<button class="btn primary sm" id="loginBtn">เข้าสู่ระบบ / สมัคร</button>';
    $('#loginBtn').addEventListener('click', openAuth);
  }
}

function go(v) { state.view = v; render(); }

async function render() {
  paintTop();
  const view = $('#view');
  clearInterval(state.pollTimer);
  try {
    if (state.view === 'map') await renderMap(view);
    else if (state.view === 'mine') await renderMine(view);
    else if (state.view === 'kiosk') renderKiosk(view);
    else if (state.view === 'admin') await renderAdmin(view);
  } catch (e) {
    view.innerHTML = `<div class="card"><h2>เกิดข้อผิดพลาด</h2><p>${esc(e.message)}</p></div>`;
  }
}

/* ============================================================
 *  1) ผังที่จอด
 * ============================================================ */

function renderMap(view) {
  view.innerHTML = `
    <div class="map-layout">
      <section class="card lot">
        <div class="lot-gate"><span>ทางเข้า</span><span>ทางออก</span></div>
        <div id="grid"></div>
        <div class="legend">
          <span><i style="border-color:var(--free);background:var(--free-soft)"></i>ว่าง</span>
          <span><i style="border-color:#e0b35c;background:var(--booked-soft)"></i>ถูกจองแล้ว</span>
          <span><i style="border-color:var(--taken);background:var(--taken-soft)"></i>มีรถจอด</span>
          <span><i style="border-color:var(--brand);background:var(--brand-soft)"></i>ของฉัน</span>
        </div>
      </section>
      <aside class="card" id="bookPanel"></aside>
    </div>`;
  paintGrid(); paintBook();
  state.pollTimer = setInterval(async () => {
    try { await Promise.all([loadSlots(), loadStatus(), loadMe()]); paintGrid(); } catch (_) { /* รอบหน้า */ }
  }, 5000);
}

function paintGrid() {
  const el = $('#grid');
  if (!el) return;
  const sel = state.slots.find((s) => s.slot_id === state.selectedSlot);
  if (sel && sel.state !== 'FREE') state.selectedSlot = null;
  const canPick = !!state.me && state.me.member.status === 'ACTIVE' && !state.me.active;
  let html = '', lastZone = null;
  const rows = [...new Set(state.slots.map((s) => s.row_no))];
  for (const r of rows) {
    const rowSlots = state.slots.filter((s) => s.row_no === r);
    const zone = rowSlots[0].zone_type;
    if (zone !== lastZone) {
      const n = state.slots.filter((s) => s.zone_type === zone).length;
      html += `<div class="zone-label">${zone === 'RESERVED' ? `โซนจอง (${n} ช่อง) — สมาชิกเลือกช่องได้` : `โซน Walk-in (${n} ช่อง) — ระบบสุ่มให้ที่ kiosk`}</div>`;
      lastZone = zone;
    }
    html += `<div class="lot-row"><span class="rl">${esc(rowSlots[0].label[0])}</span><div class="lot-cells">` +
      rowSlots.map((s) => {
        const cls = ['slot', s.state.toLowerCase()];
        if (s.mine) cls.push('mine');
        const pickable = zone === 'RESERVED' && s.state === 'FREE' && canPick;
        if (pickable) cls.push('pickable');
        if (s.slot_id === state.selectedSlot) cls.push('selected');
        const tag = s.mine ? 'ของฉัน' : s.state === 'BOOKED' ? 'จองแล้ว' : s.state === 'OCCUPIED' ? 'มีรถ' : '';
        return `<button type="button" class="${cls.join(' ')}" data-id="${s.slot_id}" ${pickable ? '' : 'tabindex="-1"'} aria-label="ช่อง ${esc(s.label)} ${esc(tag || 'ว่าง')}">${esc(s.label)}${tag ? `<small>${tag}</small>` : ''}</button>`;
      }).join('') + '</div></div>';
  }
  el.innerHTML = html;
  $$('.slot.pickable', el).forEach((b) => b.addEventListener('click', () => {
    state.selectedSlot = Number(b.dataset.id); paintGrid(); paintBook();
  }));
  paintBook(true);
}

function paintBook(keepForm) {
  const el = $('#bookPanel');
  if (!el) return;
  const s = state.status, me = state.me;
  if (!me) {
    el.innerHTML = `<h2>จองที่จอด</h2><p class="muted">สมัครสมาชิกหรือเข้าสู่ระบบก่อน จึงจะจองช่องในโซนจองได้ ส่วนรถ walk-in ไปรับช่องที่ Kiosk ได้เลยโดยไม่ต้องสมัคร</p><button class="btn primary" id="bookLogin">เข้าสู่ระบบ / สมัคร</button>`;
    $('#bookLogin').addEventListener('click', openAuth); return;
  }
  if (me.member.status === 'SUSPENDED') {
    el.innerHTML = `<h2>จองที่จอด</h2><div class="result err">บัญชีถูกระงับเพราะ no-show ครบ ${me.limits.noshow_limit} ครั้ง จองไม่ได้จนกว่าผู้ดูแลจะปลดระงับ</div>`; return;
  }
  if (me.active) {
    el.innerHTML = `<h2>คุณมีการจองอยู่แล้ว</h2><p>ช่อง <b>${esc(me.active.slot_label)}</b> · มาถึง ${fmtTime(me.active.arrival_time)}</p><button class="btn primary" id="toMine">ดูรายละเอียด / ยกเลิก</button>`;
    $('#toMine').addEventListener('click', () => go('mine')); return;
  }
  const slot = state.slots.find((x) => x.slot_id === state.selectedSlot);
  if (!slot) {
    el.innerHTML = `<h2>จองที่จอด</h2><p class="muted">แตะช่องสีเขียวในโซนจองเพื่อเลือก (จองล่วงหน้าได้ไม่เกิน ${me.limits.max_advance_minutes} นาที)</p>`; return;
  }
  if (keepForm && $('#bookForm') && Number($('#bookForm').dataset.slot) === slot.slot_id) return; // ไม่ล้างฟอร์มตอน poll
  const max = me.limits.max_advance_minutes;
  const baseMin = Math.floor(systemNow() / 60000) * 60000;
  el.innerHTML = `
    <h2>จองช่อง ${esc(slot.label)}</h2>
    <form id="bookForm" class="stack" data-slot="${slot.slot_id}">
      <label>รถ<select name="vehicle">${me.vehicles.map((v) => `<option value="${v.vehicle_id}">${esc(v.plate)}</option>`).join('')}</select></label>
      <label>จะมาถึงอีก <b id="minLabel">15</b> นาที (เวลา <b id="arrLabel"></b>)
        <input type="range" name="min" min="0" max="${max}" step="5" value="15"></label>
      <p class="muted">มาถึงช้ากว่า ${me.limits.grace_minutes} นาทีโดยไม่ check-in = no-show · ยกเลิกก่อนเวลา ${me.limits.free_cancel_minutes} นาทีขึ้นไปไม่มีโทษ</p>
      <button class="btn primary" style="width:100%">ยืนยันการจอง</button>
    </form>`;
  const f = $('#bookForm'), range = f.min;
  const upd = () => { $('#minLabel').textContent = range.value; $('#arrLabel').textContent = fmtTime(baseMin + Number(range.value) * 60000); };
  range.addEventListener('input', upd); upd();
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await act(() => api('/reservations', { method: 'POST', body: { slot_id: slot.slot_id, vehicle_id: Number(f.vehicle.value), arrival_minutes: Number(range.value) } }));
    if (r) { toast(`จองช่อง ${slot.label} แล้ว รหัส ${r.checkin_code}`); state.selectedSlot = null; await refreshCore(); go('mine'); }
    else { await loadSlots(); paintGrid(); }
  });
}

/* ============================================================
 *  2) การจองของฉัน
 * ============================================================ */

const STATUS_TH = { BOOKED: ['รอมาถึง', 'info'], CHECKED_IN: ['จอดอยู่', 'ok'], COMPLETED: ['เสร็จสิ้น', 'ok'], CANCELLED: ['ยกเลิก', ''], NO_SHOW: ['no-show', 'bad'] };
const meter = (n, total, cls) => `<div class="meter ${cls}">${Array.from({ length: total }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;

async function renderMine(view) {
  if (!state.me) {
    view.innerHTML = '<div class="card"><h2>การจองของฉัน</h2><p>เข้าสู่ระบบเพื่อดูการจอง</p><button class="btn primary" id="x">เข้าสู่ระบบ / สมัคร</button></div>';
    $('#x').addEventListener('click', openAuth); return;
  }
  await loadMe();
  const me = state.me, L = me.limits, a = me.active;
  let activeHtml = '<p class="muted">ยังไม่มีการจองที่ค้างอยู่ — ไปที่ “ผังที่จอด” เพื่อจอง</p>';
  if (a) {
    const left = Math.floor((new Date(a.arrival_time) - Math.floor(systemNow() / 60000) * 60000) / 60000);
    const free = left >= L.free_cancel_minutes;
    activeHtml = `
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div><div class="muted">ช่องจอด</div><div class="big-slot">${esc(a.slot_label)}</div></div>
        <span class="pill ${STATUS_TH[a.status][1]}">${STATUS_TH[a.status][0]}</span>
      </div>
      <div><div class="muted">รหัสยืนยัน (ใช้ที่ Kiosk ตอน check-in และตอนออก)</div><div class="big-code">${esc(a.checkin_code)}</div></div>
      <p>รถ ${esc(a.plate)} · มาถึง <b>${fmtTime(a.arrival_time)}</b>${a.status === 'BOOKED' ? ` · ต้อง check-in ก่อน <b>${fmtTime(a.checkin_deadline)}</b>` : ''}</p>
      ${a.status === 'BOOKED' ? `
        <p class="muted">${free ? `ยกเลิกตอนนี้ไม่มีโทษ (ก่อนเวลามาถึงอีก ${left} นาที)` : `ยกเลิกตอนนี้จะได้ใบเหลือง (เหลือเวลาก่อนมาถึง ${Math.max(left, 0)} นาที ต่ำกว่า ${L.free_cancel_minutes} นาที)`}</p>
        <button class="btn danger" id="cancelBtn">ยกเลิกการจอง</button>` : '<p class="muted">เข้าใช้งานแล้ว — ช่องจะว่างเมื่อยืนยันออกที่ทางออก</p>'}`;
  }
  view.innerHTML = `
    <div class="grid cols-3">
      <div class="card"><div class="muted">สถานะบัญชี</div><div class="stat">${me.member.status === 'ACTIVE' ? 'ปกติ' : 'ถูกระงับ'}</div><span class="pill ${me.member.status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(me.member.name)}</span></div>
      <div class="card"><div class="muted">ใบเหลือง (${L.yellow_per_noshow} ใบ = no-show 1 ครั้ง)</div><div class="stat">${me.counts.yellow_active}/${L.yellow_per_noshow}</div>${meter(me.counts.yellow_active, L.yellow_per_noshow, 'y')}<small>ใช้บริการตามปกติจนยืนยันออก ใบเหลืองจะหาย</small></div>
      <div class="card"><div class="muted">no-show (ครบ ${L.noshow_limit} ครั้งถูกระงับ)</div><div class="stat">${me.counts.noshow_active}/${L.noshow_limit}</div>${meter(me.counts.noshow_active, L.noshow_limit, 'r')}</div>
    </div>
    <section class="card stack" style="margin-top:1rem"><h2>การจองปัจจุบัน</h2>${activeHtml}</section>
    <section class="card" style="margin-top:1rem"><h2>ประวัติ</h2>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>ช่อง</th><th>รถ</th><th>เวลามาถึง</th><th>สถานะ</th></tr></thead><tbody>
        ${me.reservations.map((r) => `<tr><td>${r.reservation_id}</td><td>${esc(r.slot_label)}</td><td>${esc(r.plate)}</td><td>${fmtDT(r.arrival_time)}</td><td><span class="pill ${STATUS_TH[r.status][1]}">${STATUS_TH[r.status][0]}</span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">ยังไม่มีประวัติ</td></tr>'}
      </tbody></table></div></section>`;
  const cb = $('#cancelBtn');
  if (cb) cb.addEventListener('click', async () => {
    if (!confirm('ยืนยันยกเลิกการจอง?')) return;
    const r = await act(() => api(`/reservations/${a.reservation_id}/cancel`, { method: 'POST' }));
    if (r) { toast(r.penalty ? 'ยกเลิกแล้ว — ได้ใบเหลือง 1 ใบ' : 'ยกเลิกแล้ว ไม่มีโทษ', r.penalty); await refreshCore(); render(); }
  });
}

/* ============================================================
 *  3) Kiosk จำลอง (หน้าลานจอด)
 * ============================================================ */

function renderKiosk(view) {
  view.innerHTML = `
    <p class="muted">จำลองเครื่องที่หน้าลานจอด ใช้ได้โดยไม่ต้องเข้าสู่ระบบ</p>
    <div class="grid cols-3">
      <section class="card stack"><h2>1) Check-in (สมาชิก)</h2>
        <p class="muted">กรอกรหัสจองที่ได้จากหน้า “การจองของฉัน” เมื่อมาถึงช่องจอด</p>
        <form data-k="checkin" class="stack"><input name="code" placeholder="เช่น R7K2P9" autocomplete="off" required><button class="btn primary">ยืนยันมาถึง</button></form><div class="out"></div></section>
      <section class="card stack"><h2>2) รับช่อง Walk-in</h2>
        <p class="muted">ไม่ต้องสมัครสมาชิก ระบบสุ่มช่องว่างในโซน walk-in ให้</p>
        <form data-k="walkin" class="stack"><input name="plate" placeholder="ทะเบียนรถ (ไม่บังคับ)" autocomplete="off"><button class="btn primary">รับช่องจอด</button></form><div class="out"></div></section>
      <section class="card stack"><h2>3) ยืนยันออก</h2>
        <p class="muted">กรอกรหัสจอง (R…) หรือรหัสตั๋ว walk-in (W…) ช่องจะว่างเมื่อยืนยันตรงนี้เท่านั้น</p>
        <form data-k="exit" class="stack"><input name="code" placeholder="เช่น W4M8Q2" autocomplete="off" required><button class="btn primary">ยืนยันออก</button></form><div class="out"></div></section>
    </div>`;
  $$('form[data-k]', view).forEach((f) => f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = $('.out', f.parentElement), k = f.dataset.k;
    const body = k === 'walkin' ? { plate: f.plate.value } : { code: f.code.value };
    try {
      const r = await api(`/kiosk/${k}`, { method: 'POST', body });
      let html;
      if (k === 'checkin') html = `ยืนยันแล้ว — ไปจอดที่ช่อง <div class="big-slot">${esc(r.slot_label)}</div>`;
      else if (k === 'walkin') html = `ไปจอดที่ช่อง <div class="big-slot">${esc(r.slot_label)}</div>เก็บรหัสตั๋วไว้ใช้ตอนออก <div class="big-code">${esc(r.ticket_code)}</div>`;
      else html = `ออกจากช่อง ${esc(r.slot_label)} แล้ว ช่องว่างแล้ว${r.yellow_cleared ? ` · ใบเหลืองหาย ${r.yellow_cleared} ใบ` : ''}`;
      out.innerHTML = `<div class="result ok">${html}</div>`;
      if (k !== 'checkin') f.reset();
    } catch (e) { out.innerHTML = `<div class="result err">${esc(e.message)}</div>`; }
  }));
}

/* ============================================================
 *  4) ผู้ดูแลระบบ
 * ============================================================ */

const CFG_LABEL = {
  max_advance_minutes: 'จองล่วงหน้าได้ไม่เกิน (นาที)', free_cancel_minutes: 'ยกเลิกฟรีก่อนมาถึง (นาที)',
  grace_minutes: 'รอ check-in หลังเวลามาถึง (นาที)', yellow_per_noshow: 'ใบเหลืองกี่ใบ = no-show 1 ครั้ง',
  noshow_limit: 'no-show กี่ครั้งถูกระงับ', reserved_ratio_pct: 'สัดส่วนโซนจอง (%) — แสดงผลเท่านั้น',
};

async function renderAdmin(view) {
  if (!state.me || state.me.member.role !== 'ADMIN') { view.innerHTML = '<div class="card">เฉพาะผู้ดูแลระบบ</div>'; return; }
  const tabs = [['overview', 'ภาพรวม'], ['config', 'ค่าตั้งระบบ'], ['reports', 'รายงาน 3 เดือน'], ['clock', 'ตัวจำลองเวลา']];
  view.innerHTML = `<div class="subtabs">${tabs.map(([k, t]) => `<button data-t="${k}" aria-current="${state.adminTab === k}">${t}</button>`).join('')}</div><div id="adminBody"></div>`;
  $$('.subtabs button', view).forEach((b) => b.addEventListener('click', () => { state.adminTab = b.dataset.t; renderAdmin(view); }));
  const body = $('#adminBody');
  if (state.adminTab === 'overview') await adminOverview(body);
  else if (state.adminTab === 'config') await adminConfig(body);
  else if (state.adminTab === 'reports') await adminReports(body);
  else adminClock(body);
}

async function adminOverview(body) {
  const d = await api('/admin/overview');
  body.innerHTML = `
    <div class="grid cols-3">
      <div class="card"><div class="muted">รถจอดอยู่ตอนนี้</div><div class="stat">${d.stats.parked_now}</div></div>
      <div class="card"><div class="muted">การจองที่รอมาถึง</div><div class="stat">${d.stats.booked_now}</div></div>
      <div class="card"><div class="muted">บัญชีที่ถูกระงับ</div><div class="stat">${d.stats.suspended}</div></div>
    </div>
    <section class="card" style="margin-top:1rem"><h2>สมาชิก</h2><div class="table-wrap"><table>
      <thead><tr><th>ชื่อ</th><th>อีเมล</th><th>ใบเหลือง</th><th>no-show</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${d.members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${m.yellow_active}</td><td>${m.noshow_active} <small>(สะสม ${m.noshow_total})</small></td>
        <td><span class="pill ${m.status === 'ACTIVE' ? 'ok' : 'bad'}">${m.status === 'ACTIVE' ? 'ปกติ' : 'ถูกระงับ'}</span></td>
        <td>${m.status === 'SUSPENDED' || m.yellow_active || m.noshow_active ? `<button class="btn sm" data-unsus="${m.member_id}">ปลดระงับ/ล้างโทษ</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">ยังไม่มีสมาชิก</td></tr>'}
      </tbody></table></div></section>
    <section class="card" style="margin-top:1rem"><h2>การจองล่าสุด</h2><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>สมาชิก</th><th>รถ</th><th>ช่อง</th><th>มาถึง</th><th>รหัส</th><th>สถานะ</th></tr></thead><tbody>
      ${d.recent.map((r) => `<tr><td>${r.reservation_id}</td><td>${esc(r.name)}</td><td>${esc(r.plate)}</td><td>${esc(r.slot_label)}</td><td>${fmtDT(r.arrival_time)}</td><td class="mono">${esc(r.checkin_code)}</td><td><span class="pill ${STATUS_TH[r.status][1]}">${STATUS_TH[r.status][0]}</span></td></tr>`).join('') || '<tr><td colspan="7" class="muted">ยังไม่มีการจอง</td></tr>'}
      </tbody></table></div></section>`;
  $$('[data-unsus]', body).forEach((b) => b.addEventListener('click', async () => {
    if (await act(() => api(`/admin/members/${b.dataset.unsus}/unsuspend`, { method: 'POST' }), 'ปลดระงับและล้างโทษแล้ว')) adminOverview(body);
  }));
}

async function adminConfig(body) {
  const d = await api('/admin/config');
  body.innerHTML = `
    <div class="grid cols-2">
      <section class="card"><h2>ค่าตั้งระบบ</h2><p class="muted">ปรับตามรายงานการใช้งานทุก 3 เดือน ทุกการแก้ไขถูกบันทึกประวัติ</p>
        <form id="cfgForm">${d.config.map((c) => `<div class="cfg-row"><div>${esc(CFG_LABEL[c.config_key] || c.config_key)}<br><small class="mono">${esc(c.config_key)}</small></div><input type="number" name="${esc(c.config_key)}" value="${esc(c.config_value)}" min="0"></div>`).join('')}
        <div class="row end" style="margin-top:.8rem"><button class="btn primary">บันทึก</button></div></form></section>
      <section class="card"><h2>ประวัติการแก้ไข</h2><div class="table-wrap"><table><thead><tr><th>เวลา</th><th>ค่า</th><th>เดิม → ใหม่</th></tr></thead><tbody>
        ${d.history.map((h) => `<tr><td>${fmtDT(h.changed_at)}</td><td class="mono">${esc(h.config_key)}</td><td>${esc(h.old_value)} → ${esc(h.new_value)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">ยังไม่เคยแก้ไข</td></tr>'}
      </tbody></table></div></section>
    </div>`;
  $('#cfgForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = Object.fromEntries(new FormData(ev.target).entries());
    if (await act(() => api('/admin/config', { method: 'PUT', body: payload }), 'บันทึกแล้ว')) { await loadStatus(); adminConfig(body); }
  });
}

function bars(rows, key, val, fmt) {
  const max = Math.max(1, ...rows.map((r) => r[val]));
  return rows.length ? `<table><tbody>${rows.map((r) => `<tr><td style="width:5rem">${fmt(r[key])}</td><td><div class="bar" style="width:${(r[val] / max) * 100}%"></div></td><td style="width:2.5rem;text-align:right">${r[val]}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">ยังไม่มีข้อมูล</p>';
}

async function adminReports(body) {
  const d = await api('/admin/reports');
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  body.innerHTML = `
    <section class="card"><h2>ผลการจองรายเดือน (ย้อนหลัง 3 เดือน)</h2><div class="table-wrap"><table>
      <thead><tr><th>เดือน</th><th>เสร็จสิ้น</th><th>ยกเลิก</th><th>no-show</th><th>รวม</th><th>อัตรา no-show</th></tr></thead><tbody>
      ${d.monthly.map((m) => `<tr><td>${esc(m.month)}</td><td>${m.completed}</td><td>${m.cancelled}</td><td>${m.no_show}</td><td>${m.total}</td><td>${m.no_show_pct}%</td></tr>`).join('') || '<tr><td colspan="6" class="muted">ยังไม่มีข้อมูล</td></tr>'}
      </tbody></table></div>
      <p class="muted" style="margin-top:.6rem">สัดส่วนโซนจองจริง: ${d.ratio.reserved}/${d.ratio.total} ช่อง (${d.ratio.reserved_pct}%)</p></section>
    <div class="grid cols-2" style="margin-top:1rem">
      <section class="card"><h2>ใบเหลืองแยกตามชั่วโมงที่นัดมาถึง</h2><p class="muted">กระจุกตัวช่วงไหน ให้ทบทวนเวลายกเลิกฟรี</p>${bars(d.yellowByHour, 'hour', 'n', hh)}</section>
      <section class="card"><h2>no-show แยกตามชั่วโมงที่นัดมาถึง</h2><p class="muted">สูงมาก ให้ลดเวลาจองล่วงหน้าหรือ grace period</p>${bars(d.noShowByHour, 'hour', 'n', hh)}</section>
    </div>
    <section class="card" style="margin-top:1rem"><h2>สมาชิกที่ no-show มากที่สุด</h2><table><tbody>
      ${d.topNoShow.map((t) => `<tr><td>${esc(t.name)}</td><td style="text-align:right">${t.no_shows} ครั้ง</td></tr>`).join('') || '<tr><td class="muted">ยังไม่มีข้อมูล</td></tr>'}
    </tbody></table></section>`;
}

function adminClock(body) {
  const off = state.status ? state.status.clock_offset_minutes : 0;
  body.innerHTML = `
    <section class="card stack"><h2>ตัวจำลองเวลา</h2>
      <p class="muted">เลื่อนนาฬิการะบบไปข้างหน้าเพื่อดูการเกิดใบเหลืองและ no-show โดยไม่ต้องรอจริง (ตอนนี้เลื่อนไปแล้ว <b>${off}</b> นาที) ระบบตรวจ no-show ให้ทันทีหลังเลื่อน</p>
      <div class="row">${[10, 15, 30, 60, 120].map((n) => `<button class="btn" data-adv="${n}">+${n} นาที</button>`).join('')}
        <button class="btn" id="clkReset">รีเซ็ตเวลา</button></div>
      <div id="clkOut"></div>
    </section>
    <section class="card stack" style="margin-top:1rem"><h2>เครื่องมือทดสอบ</h2>
      <div class="row"><button class="btn" id="sweepBtn">ตรวจ no-show ทันที</button>
        <button class="btn danger" id="resetData">ล้างข้อมูลการจอง/ใบเหลือง (เก็บสมาชิกไว้)</button></div>
    </section>`;
  $$('[data-adv]', body).forEach((b) => b.addEventListener('click', async () => {
    const r = await act(() => api('/admin/clock', { method: 'POST', body: { advance_minutes: Number(b.dataset.adv) } }));
    if (r) { await loadStatus(); adminClock(body); $('#clkOut').innerHTML = `<div class="result ok">เวลาระบบ ${fmtDT(r.now)} · no-show ใหม่ ${r.new_no_shows} รายการ</div>`; }
  }));
  $('#clkReset').addEventListener('click', async () => {
    const r = await act(() => api('/admin/clock', { method: 'POST', body: { reset: true } }), 'รีเซ็ตเวลาแล้ว');
    if (r) { await loadStatus(); adminClock(body); }
  });
  $('#sweepBtn').addEventListener('click', async () => {
    const r = await act(() => api('/admin/sweep', { method: 'POST' }));
    if (r) toast(`พบ no-show ใหม่ ${r.new_no_shows} รายการ`);
  });
  $('#resetData').addEventListener('click', async () => {
    if (!confirm('ล้างการจอง การจอด และใบเหลือง/no-show ทั้งหมด?')) return;
    if (await act(() => api('/admin/reset-data', { method: 'POST' }), 'ล้างข้อมูลแล้ว')) { await refreshCore(); paintTop(); }
  });
}

/* ============================================================
 *  สมัคร / เข้าสู่ระบบ
 * ============================================================ */

function openAuth() { const d = $('#authDialog'); $('#authError').textContent = ''; d.showModal(); }

(function initAuth() {
  const dlg = $('#authDialog'), form = $('#authForm');
  let mode = 'login';
  const setMode = (m) => {
    mode = m; dlg.classList.toggle('register', m === 'register');
    $$('.tab', dlg).forEach((t) => t.classList.toggle('on', t.dataset.mode === m));
    $('#authSubmit').textContent = m === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก';
    form.name.required = form.plate.required = m === 'register';
  };
  $$('.tab', dlg).forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  $('#authCancel').addEventListener('click', () => dlg.close());
  $$('#demoUsers button').forEach((b) => b.addEventListener('click', () => {
    setMode('login'); form.email.value = b.dataset.e; form.password.value = b.dataset.p;
  }));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const r = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
      setToken(r.token); dlg.close(); form.reset();
      await refreshCore(); render();
      toast(mode === 'login' ? 'เข้าสู่ระบบแล้ว' : 'สมัครสมาชิกเรียบร้อย');
    } catch (e) { $('#authError').textContent = e.message; }
  });
  setMode('login');
})();

/* ---------- เริ่มทำงาน ---------- */

(async function boot() {
  try { await refreshCore(); }
  catch (_) {
    const n = $('#notice');
    n.hidden = false; n.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจว่ารัน npm start และเปิดฐานข้อมูลอยู่';
  }
  render();
})();
