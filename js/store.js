/*
 * store.js — ข้อมูลจำลอง + กติกาของระบบจองโรงจอดรถ
 *
 * ทำงานได้ทั้งในเบราว์เซอร์ (เก็บใน localStorage) และใน Node (ใช้ทดสอบ)
 * ทุกฟังก์ชันที่เปลี่ยนข้อมูลคืนค่า { ok: true, ... } หรือ { ok: false, error: '...' }
 *
 * กติกาที่ใส่ไว้ (ค่าตัวเลขอยู่ใน config ปรับได้จากหน้าจำลอง):
 *  - จองล่วงหน้าไม่เกิน max_advance_minutes (120) นับจากนาทีที่กดจอง
 *  - ยกเลิกก่อนเวลามาถึง free_cancel_minutes (30) ขึ้นไป = ไม่มีโทษ
 *  - ยกเลิกน้อยกว่านั้น = ใบเหลือง; ใบเหลืองครบ yellow_per_noshow (2) = no-show 1 ครั้ง
 *  - ไม่ check-in ภายใน grace_minutes (15) หลังเวลามาถึง = no-show
 *  - no-show ครบ noshow_limit (3) = ระงับบัญชี
 *  - ใช้งานจนยืนยันออกตามปกติ = ใบเหลืองที่ค้างอยู่หาย
 *  - ไม่นับเวลาจอด ช่องว่างเมื่อยืนยันออกเท่านั้น
 *  - โซนจอง 1/3 (แถว A, B) โซน walk-in 2/3 (แถว C-F)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ParkStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'parking_demo_v1';
  var MIN = 60000;
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  var DEFAULT_CONFIG = {
    max_advance_minutes: 120,
    free_cancel_minutes: 30,
    grace_minutes: 15,
    yellow_per_noshow: 2,
    noshow_limit: 3
  };

  var storage = null;          // { getItem, setItem, removeItem }
  var baseNow = function () { return Date.now(); };
  var rand = Math.random;

  /* ---------- ตัวช่วยทั่วไป ---------- */

  function memoryStorage() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; }
    };
  }

  function getStorage() {
    if (storage) return storage;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('__probe', '1');
        localStorage.removeItem('__probe');
        storage = localStorage;
        return storage;
      }
    } catch (e) { /* ใช้หน่วยความจำแทน */ }
    storage = memoryStorage();
    return storage;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function floorMin(ms) { return Math.floor(ms / MIN) * MIN; }
  function fail(error, code) { return { ok: false, error: error, code: code || 'ERROR' }; }

  function makeCode(len, used) {
    var out;
    do {
      out = '';
      for (var i = 0; i < len; i++) out += CODE_CHARS.charAt(Math.floor(rand() * CODE_CHARS.length));
    } while (used && used.indexOf(out) !== -1);
    return out;
  }

  /* ---------- สถานะเริ่มต้น ---------- */

  function buildSlots() {
    var rows = ['A', 'B', 'C', 'D', 'E', 'F'];
    var slots = [];
    var id = 1;
    rows.forEach(function (r, ri) {
      for (var c = 1; c <= 6; c++) {
        slots.push({
          id: id++,
          label: r + c,
          row: r,
          col: c,
          zone: ri < 2 ? 'RESERVED' : 'WALKIN',
          active: true
        });
      }
    });
    return slots;
  }

  function freshState() {
    return {
      version: 1,
      seq: { member: 3, reservation: 1, session: 1, penalty: 1 },
      clockOffsetMs: 0,
      currentUserId: null,
      config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      members: [
        { id: 1, name: 'สมชาย ทดสอบ', email: 'demo1@parking.test', phone: '081-000-0001', password: 'demo1234', plate: '1กก 1234', status: 'ACTIVE', createdAt: baseNow() },
        { id: 2, name: 'สมหญิง ตัวอย่าง', email: 'demo2@parking.test', phone: '081-000-0002', password: 'demo1234', plate: '2ขข 5678', status: 'ACTIVE', createdAt: baseNow() }
      ],
      slots: buildSlots(),
      reservations: [],
      sessions: [],
      penalties: []
    };
  }

  function load() {
    var raw = getStorage().getItem(KEY);
    if (raw) {
      try {
        var s = JSON.parse(raw);
        if (s && s.version === 1) return s;
      } catch (e) { /* เริ่มใหม่ */ }
    }
    var fresh = freshState();
    save(fresh);
    return fresh;
  }

  function save(s) { getStorage().setItem(KEY, JSON.stringify(s)); }
  function nowOf(s) { return baseNow() + s.clockOffsetMs; }
  function nextId(s, name) { return s.seq[name]++; }

  function memberById(s, id) { return s.members.filter(function (m) { return m.id === id; })[0] || null; }
  function slotById(s, id) { return s.slots.filter(function (x) { return x.id === id; })[0] || null; }
  function resById(s, id) { return s.reservations.filter(function (x) { return x.id === id; })[0] || null; }
  function isActiveRes(r) { return r.status === 'BOOKED' || r.status === 'CHECKED_IN'; }
  function openSessionOfSlot(s, slotId) {
    return s.sessions.filter(function (x) { return x.slotId === slotId && x.exitTime === null; })[0] || null;
  }
  function activeResOfSlot(s, slotId) {
    return s.reservations.filter(function (x) { return x.slotId === slotId && isActiveRes(x); })[0] || null;
  }
  function activeResOfMember(s, memberId) {
    return s.reservations.filter(function (x) { return x.memberId === memberId && isActiveRes(x); })[0] || null;
  }
  function publicMember(m) {
    if (!m) return null;
    var c = {}; for (var k in m) if (k !== 'password') c[k] = m[k];
    return c;
  }

  /* ---------- บทลงโทษ ---------- */

  function addPenalty(s, memberId, reservationId, type, now) {
    var p = {
      id: nextId(s, 'penalty'),
      memberId: memberId,
      reservationId: reservationId,
      type: type,                 // YELLOW | NO_SHOW
      status: 'ACTIVE',           // ACTIVE | CLEARED | CONVERTED | WAIVED
      createdAt: now,
      resolvedAt: null
    };
    s.penalties.push(p);
    return p;
  }

  function activePenalties(s, memberId, type) {
    return s.penalties.filter(function (p) {
      return p.memberId === memberId && p.type === type && p.status === 'ACTIVE';
    });
  }

  // ใบเหลืองครบเกณฑ์ -> แปลงเป็น no-show 1 ครั้ง
  function convertYellows(s, memberId, reservationId, now) {
    var converted = 0;
    var yellows = activePenalties(s, memberId, 'YELLOW');
    while (yellows.length >= s.config.yellow_per_noshow) {
      for (var i = 0; i < s.config.yellow_per_noshow; i++) {
        yellows[i].status = 'CONVERTED';
        yellows[i].resolvedAt = now;
      }
      addPenalty(s, memberId, reservationId, 'NO_SHOW', now);
      converted++;
      yellows = activePenalties(s, memberId, 'YELLOW');
    }
    return converted;
  }

  // no-show ครบเกณฑ์ -> ระงับบัญชี
  function evaluateSuspension(s, memberId) {
    var m = memberById(s, memberId);
    if (!m || m.status === 'SUSPENDED') return false;
    if (activePenalties(s, memberId, 'NO_SHOW').length >= s.config.noshow_limit) {
      m.status = 'SUSPENDED';
      return true;
    }
    return false;
  }

  // การจองที่เลยเวลามาถึง + grace แล้วยังไม่ check-in -> no-show
  function processNoShows(s) {
    var now = nowOf(s);
    var changed = 0;
    s.reservations.forEach(function (r) {
      if (r.status === 'BOOKED' && now > r.arrivalTime + s.config.grace_minutes * MIN) {
        r.status = 'NO_SHOW';
        r.closedAt = now;
        addPenalty(s, r.memberId, r.id, 'NO_SHOW', now);
        evaluateSuspension(s, r.memberId);
        changed++;
      }
    });
    return changed;
  }

  /* ---------- เวลาและตรวจเวลาจอง ---------- */

  function validateArrivalIn(s, arrivalMs) {
    var nowMin = floorMin(nowOf(s));
    var maxMs = nowMin + s.config.max_advance_minutes * MIN;
    if (typeof arrivalMs !== 'number' || isNaN(arrivalMs)) return fail('กรุณาเลือกเวลามาถึง', 'ARRIVAL_EMPTY');
    if (arrivalMs < nowMin) return fail('เวลามาถึงต้องไม่เป็นเวลาที่ผ่านมาแล้ว', 'ARRIVAL_PAST');
    if (arrivalMs > maxMs) {
      return fail('จองล่วงหน้าได้ไม่เกิน ' + (s.config.max_advance_minutes / 60) + ' ชั่วโมง ตอนนี้เลือกได้ถึง ' + hhmm(maxMs), 'ARRIVAL_TOO_FAR');
    }
    return { ok: true, maxArrival: maxMs, minArrival: nowMin };
  }

  /* ---------- API ---------- */

  var API = {
    MIN: MIN,
    hhmm: hhmm,

    /* การตั้งค่าสำหรับทดสอบ */
    useStorage: function (adapter) { storage = adapter; },
    memoryStorage: memoryStorage,
    setBaseClock: function (fn) { baseNow = fn; },
    setRandom: function (fn) { rand = fn; },

    getState: function () { return load(); },
    getConfig: function () { return load().config; },
    now: function () { return nowOf(load()); },
    clockOffsetMinutes: function () { return Math.round(load().clockOffsetMs / MIN); },

    /* ---- เวลาจำลอง ---- */
    advanceClock: function (minutes) {
      var s = load();
      s.clockOffsetMs += minutes * MIN;
      var n = processNoShows(s);
      save(s);
      return { ok: true, noShows: n, now: nowOf(s) };
    },
    resetClock: function () {
      var s = load();
      s.clockOffsetMs = 0;
      save(s);
      return { ok: true };
    },
    tick: function () {
      var s = load();
      var n = processNoShows(s);
      if (n) save(s);
      return n;
    },

    /* ---- สมาชิก ---- */
    register: function (d) {
      var s = load();
      var name = (d.name || '').trim();
      var email = (d.email || '').trim().toLowerCase();
      var plate = (d.plate || '').trim();
      if (!name) return fail('กรุณากรอกชื่อ', 'NAME');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('รูปแบบอีเมลไม่ถูกต้อง', 'EMAIL');
      if (!plate) return fail('กรุณากรอกทะเบียนรถ', 'PLATE');
      if (!d.password || d.password.length < 6) return fail('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร', 'PASSWORD');
      if (s.members.some(function (m) { return m.email === email; })) return fail('อีเมลนี้สมัครไว้แล้ว ลองเข้าสู่ระบบแทน', 'EMAIL_TAKEN');
      var m = {
        id: nextId(s, 'member'),
        name: name,
        email: email,
        phone: (d.phone || '').trim(),
        password: d.password,
        plate: plate,
        status: 'ACTIVE',
        createdAt: nowOf(s)
      };
      s.members.push(m);
      s.currentUserId = m.id;
      save(s);
      return { ok: true, member: publicMember(m) };
    },
    login: function (email, password) {
      var s = load();
      var e = (email || '').trim().toLowerCase();
      var m = s.members.filter(function (x) { return x.email === e; })[0];
      if (!m || m.password !== password) return fail('อีเมลหรือรหัสผ่านไม่ถูกต้อง', 'LOGIN');
      s.currentUserId = m.id;
      save(s);
      return { ok: true, member: publicMember(m) };
    },
    logout: function () {
      var s = load();
      s.currentUserId = null;
      save(s);
      return { ok: true };
    },
    currentUser: function () {
      var s = load();
      return s.currentUserId ? publicMember(memberById(s, s.currentUserId)) : null;
    },
    listMembers: function () { return load().members.map(publicMember); },

    /* ---- ผังที่จอด ---- */
    snapshot: function () {
      var s = load();
      var slots = s.slots.map(function (sl) {
        var session = openSessionOfSlot(s, sl.id);
        var res = activeResOfSlot(s, sl.id);
        var state = session ? 'occupied' : (res ? 'booked' : 'free');
        return {
          id: sl.id, label: sl.label, row: sl.row, col: sl.col, zone: sl.zone,
          state: state,
          memberId: res ? res.memberId : null,
          reservationId: res ? res.id : null,
          ticket: session && !session.reservationId ? session.ticket : null
        };
      });
      function free(zone) { return slots.filter(function (x) { return x.zone === zone && x.state === 'free'; }).length; }
      function total(zone) { return slots.filter(function (x) { return x.zone === zone; }).length; }
      return {
        slots: slots,
        counts: {
          reservedFree: free('RESERVED'), reservedTotal: total('RESERVED'),
          walkinFree: free('WALKIN'), walkinTotal: total('WALKIN')
        }
      };
    },

    /* ---- จอง ---- */
    validateArrival: function (arrivalMs) { return validateArrivalIn(load(), arrivalMs); },

    createReservation: function (memberId, slotId, arrivalMs) {
      var s = load();
      processNoShows(s);
      var m = memberById(s, memberId);
      if (!m) return fail('กรุณาเข้าสู่ระบบก่อนจอง', 'AUTH');
      if (m.status === 'SUSPENDED') return fail('บัญชีถูกระงับเพราะ no-show ครบ ' + s.config.noshow_limit + ' ครั้ง จองไม่ได้จนกว่าผู้ดูแลจะปลดระงับ', 'SUSPENDED');
      var slot = slotById(s, slotId);
      if (!slot || !slot.active) return fail('ไม่พบช่องจอดนี้', 'SLOT');
      if (slot.zone !== 'RESERVED') return fail('ช่องนี้อยู่โซน walk-in จองล่วงหน้าไม่ได้', 'ZONE');
      var v = validateArrivalIn(s, arrivalMs);
      if (!v.ok) { save(s); return v; }
      if (activeResOfMember(s, memberId)) { save(s); return fail('คุณมีการจองที่ยังไม่เสร็จอยู่แล้ว ใช้งานหรือยกเลิกก่อนจึงจะจองใหม่ได้', 'ALREADY_BOOKED'); }
      if (activeResOfSlot(s, slotId) || openSessionOfSlot(s, slotId)) { save(s); return fail('ช่อง ' + slot.label + ' เพิ่งถูกจองหรือมีรถจอดอยู่ เลือกช่องอื่น', 'SLOT_TAKEN'); }
      var now = nowOf(s);
      var r = {
        id: nextId(s, 'reservation'),
        memberId: memberId,
        slotId: slotId,
        createdAt: now,
        arrivalTime: arrivalMs,
        status: 'BOOKED',
        code: makeCode(6, s.reservations.map(function (x) { return x.code; })),
        cancelledAt: null,
        checkedInAt: null,
        closedAt: null,
        penaltyOnCancel: null
      };
      s.reservations.push(r);
      save(s);
      return { ok: true, reservation: r, slot: slot };
    },

    cancelReservation: function (reservationId, memberId) {
      var s = load();
      processNoShows(s);
      var r = resById(s, reservationId);
      if (!r || r.memberId !== memberId) { save(s); return fail('ไม่พบการจองนี้', 'NOT_FOUND'); }
      if (r.status !== 'BOOKED') { save(s); return fail('การจองนี้ยกเลิกไม่ได้แล้ว (สถานะ ' + r.status + ')', 'NOT_CANCELLABLE'); }
      var now = nowOf(s);
      var free = r.arrivalTime - now >= s.config.free_cancel_minutes * MIN;
      r.status = 'CANCELLED';
      r.cancelledAt = now;
      r.closedAt = now;
      var result = { ok: true, penalty: 'NONE', convertedToNoShow: false, suspended: false };
      if (!free) {
        addPenalty(s, memberId, r.id, 'YELLOW', now);
        r.penaltyOnCancel = 'YELLOW';
        result.penalty = 'YELLOW';
        var conv = convertYellows(s, memberId, r.id, now);
        result.convertedToNoShow = conv > 0;
        result.suspended = evaluateSuspension(s, memberId);
      }
      save(s);
      return result;
    },

    /* ---- จำลองหน้าลานจอด ---- */
    checkIn: function (code) {
      var s = load();
      processNoShows(s);
      var c = (code || '').trim().toUpperCase();
      if (!c) { save(s); return fail('กรุณากรอกรหัสจอง', 'CODE_EMPTY'); }
      var r = s.reservations.filter(function (x) { return x.code === c; })[0];
      if (!r) { save(s); return fail('ไม่พบรหัสจอง ' + c, 'NOT_FOUND'); }
      if (r.status === 'NO_SHOW') { save(s); return fail('การจองนี้เลยเวลาแล้ว ถูกนับเป็น no-show', 'NO_SHOW'); }
      if (r.status === 'CHECKED_IN') { save(s); return fail('การจองนี้ยืนยันเข้าไปแล้ว', 'ALREADY'); }
      if (r.status !== 'BOOKED') { save(s); return fail('การจองนี้ใช้งานไม่ได้แล้ว (สถานะ ' + r.status + ')', 'STATUS'); }
      var now = nowOf(s);
      var m = memberById(s, r.memberId);
      var slot = slotById(s, r.slotId);
      r.status = 'CHECKED_IN';
      r.checkedInAt = now;
      s.sessions.push({
        id: nextId(s, 'session'),
        slotId: r.slotId,
        reservationId: r.id,
        ticket: null,
        plate: m ? m.plate : '',
        entryTime: now,
        exitTime: null
      });
      save(s);
      return { ok: true, slot: slot, member: publicMember(m), reservation: r };
    },

    walkIn: function (plate) {
      var s = load();
      processNoShows(s);
      var free = s.slots.filter(function (sl) {
        return sl.zone === 'WALKIN' && sl.active && !openSessionOfSlot(s, sl.id);
      });
      if (!free.length) { save(s); return fail('โซน walk-in เต็มแล้ว', 'FULL'); }
      var slot = free[Math.floor(rand() * free.length)];
      var used = s.sessions.filter(function (x) { return x.exitTime === null && x.ticket; }).map(function (x) { return x.ticket; });
      var ticket = 'W' + makeCode(5, used.map(function (t) { return t.slice(1); }));
      var session = {
        id: nextId(s, 'session'),
        slotId: slot.id,
        reservationId: null,
        ticket: ticket,
        plate: (plate || '').trim(),
        entryTime: nowOf(s),
        exitTime: null
      };
      s.sessions.push(session);
      save(s);
      return { ok: true, slot: slot, ticket: ticket, session: session };
    },

    // ยืนยันออก: รับได้ทั้งรหัสจอง (6 ตัว) และรหัสตั๋ว walk-in (W + 5 ตัว)
    exitVehicle: function (codeOrTicket) {
      var s = load();
      processNoShows(s);
      var c = (codeOrTicket || '').trim().toUpperCase();
      if (!c) { save(s); return fail('กรุณากรอกรหัสจองหรือรหัสตั๋ว', 'CODE_EMPTY'); }
      var session = s.sessions.filter(function (x) {
        if (x.exitTime !== null) return false;
        if (x.ticket && x.ticket === c) return true;
        if (x.reservationId) {
          var r = resById(s, x.reservationId);
          return r && r.code === c;
        }
        return false;
      })[0];
      if (!session) { save(s); return fail('ไม่พบรถที่จอดอยู่ด้วยรหัส ' + c, 'NOT_FOUND'); }
      var now = nowOf(s);
      var slot = slotById(s, session.slotId);
      session.exitTime = now;
      var out = { ok: true, slot: slot, type: 'walkin', clearedYellows: 0 };
      if (session.reservationId) {
        var r = resById(s, session.reservationId);
        r.status = 'COMPLETED';
        r.closedAt = now;
        out.type = 'member';
        out.member = publicMember(memberById(s, r.memberId));
        activePenalties(s, r.memberId, 'YELLOW').forEach(function (p) {
          p.status = 'CLEARED';
          p.resolvedAt = now;
          out.clearedYellows++;
        });
      }
      save(s);
      return out;
    },

    openSessions: function () {
      var s = load();
      return s.sessions.filter(function (x) { return x.exitTime === null; }).map(function (x) {
        var r = x.reservationId ? resById(s, x.reservationId) : null;
        var m = r ? memberById(s, r.memberId) : null;
        return {
          id: x.id,
          slotLabel: slotById(s, x.slotId).label,
          zone: slotById(s, x.slotId).zone,
          code: r ? r.code : x.ticket,
          who: m ? m.name : 'walk-in',
          plate: x.plate,
          entryTime: x.entryTime
        };
      });
    },

    bookedReservations: function () {
      var s = load();
      return s.reservations.filter(function (r) { return r.status === 'BOOKED'; }).map(function (r) {
        var m = memberById(s, r.memberId);
        return {
          id: r.id, code: r.code, slotLabel: slotById(s, r.slotId).label,
          who: m ? m.name : '', arrivalTime: r.arrivalTime,
          deadline: r.arrivalTime + s.config.grace_minutes * MIN
        };
      });
    },

    /* ---- โปรไฟล์ ---- */
    memberView: function (memberId) {
      var s = load();
      processNoShows(s);
      save(s);
      var m = memberById(s, memberId);
      if (!m) return null;
      var byNewest = function (a, b) { return b.createdAt - a.createdAt; };
      var reservations = s.reservations.filter(function (r) { return r.memberId === memberId; })
        .sort(byNewest).map(function (r) {
          var c = {}; for (var k in r) c[k] = r[k];
          c.slotLabel = slotById(s, r.slotId).label;
          return c;
        });
      var penalties = s.penalties.filter(function (p) { return p.memberId === memberId; })
        .sort(byNewest).map(function (p) {
          var c = {}; for (var k in p) c[k] = p[k];
          var r = resById(s, p.reservationId);
          c.slotLabel = r ? slotById(s, r.slotId).label : '';
          return c;
        });
      return {
        member: publicMember(m),
        config: s.config,
        activeReservation: (function () {
          var r = activeResOfMember(s, memberId);
          if (!r) return null;
          var c = {}; for (var k in r) c[k] = r[k];
          c.slotLabel = slotById(s, r.slotId).label;
          return c;
        })(),
        yellowActive: activePenalties(s, memberId, 'YELLOW').length,
        noShowActive: activePenalties(s, memberId, 'NO_SHOW').length,
        reservations: reservations,
        penalties: penalties,
        now: nowOf(s)
      };
    },

    /* ---- เครื่องมือผู้ดูแล / ทดสอบ ---- */
    unsuspend: function (memberId) {
      var s = load();
      var m = memberById(s, memberId);
      if (!m) return fail('ไม่พบสมาชิก', 'NOT_FOUND');
      var now = nowOf(s);
      m.status = 'ACTIVE';
      activePenalties(s, memberId, 'NO_SHOW').forEach(function (p) { p.status = 'WAIVED'; p.resolvedAt = now; });
      save(s);
      return { ok: true };
    },
    setConfig: function (key, value) {
      var s = load();
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) return fail('ไม่รู้จักค่า ' + key, 'KEY');
      var n = Number(value);
      if (!isFinite(n) || n < 1 || Math.floor(n) !== n) return fail('ค่าต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป', 'VALUE');
      s.config[key] = n;
      save(s);
      return { ok: true };
    },
    resetAll: function () {
      var keepUser = null;
      var fresh = freshState();
      save(fresh);
      return { ok: true, keepUser: keepUser };
    },
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };

  return API;
});
