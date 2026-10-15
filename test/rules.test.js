/* ทดสอบกติกาของระบบ: node test/rules.test.js */
const assert = require('assert');
const S = require('../js/store.js');

const MIN = 60000;
let T;

function reset(startHour, startMin, startSec) {
  S.useStorage(S.memoryStorage());
  T = new Date(2026, 9, 14, startHour === undefined ? 10 : startHour, startMin === undefined ? 11 : startMin, startSec || 0).getTime();
  S.setBaseClock(() => T);
  let seed = 7;
  S.setRandom(() => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; });
  S.resetAll();
}

const floorMin = (ms) => Math.floor(ms / MIN) * MIN;
const book = (memberId, slotId, ahead) => S.createReservation(memberId, slotId, floorMin(S.now()) + ahead * MIN);
const view = (id) => S.memberView(id);
const slotState = (label) => S.snapshot().slots.find((x) => x.label === label).state;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------- ผังและสัดส่วน ---------- */
test('โซนจอง 1/3 และ walk-in 2/3', () => {
  reset();
  const c = S.snapshot().counts;
  assert.strictEqual(c.reservedTotal, 12);
  assert.strictEqual(c.walkinTotal, 24);
  assert.strictEqual(c.reservedTotal / (c.reservedTotal + c.walkinTotal), 1 / 3);
});

/* ---------- จองล่วงหน้าไม่เกิน 2 ชม. ---------- */
test('จอง 10:11 เลือก 12:11 ได้ แต่ 12:12 ไม่ได้', () => {
  reset(10, 11, 0);
  const bad = book(1, 1, 121);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'ARRIVAL_TOO_FAR');
  assert.ok(bad.error.includes('12:11'));
  assert.strictEqual(book(1, 1, 120).ok, true);
});

test('นับตามนาทีที่กดจอง แม้กดตอน 10:11:45', () => {
  reset(10, 11, 45);
  assert.strictEqual(S.createReservation(1, 1, new Date(2026, 9, 14, 12, 12).getTime()).ok, false);
  assert.strictEqual(S.createReservation(1, 1, new Date(2026, 9, 14, 12, 11).getTime()).ok, true);
});

test('เลือกเวลาที่ผ่านมาแล้วไม่ได้', () => {
  reset(10, 11, 0);
  const r = S.createReservation(1, 1, new Date(2026, 9, 14, 10, 10).getTime());
  assert.strictEqual(r.code, 'ARRIVAL_PAST');
});

test('จองช่องโซน walk-in ไม่ได้', () => {
  reset();
  assert.strictEqual(book(1, 13, 30).code, 'ZONE');
});

test('ปรับ max_advance_minutes ได้', () => {
  reset();
  S.setConfig('max_advance_minutes', 60);
  assert.strictEqual(book(1, 1, 90).code, 'ARRIVAL_TOO_FAR');
  assert.strictEqual(book(1, 1, 60).ok, true);
});

/* ---------- จองซ้อน ---------- */
test('ช่องเดียวกันจองซ้อนไม่ได้ และหนึ่งคนถือการจองได้ทีละรายการ', () => {
  reset();
  assert.strictEqual(book(1, 1, 30).ok, true);
  assert.strictEqual(book(2, 1, 30).code, 'SLOT_TAKEN');
  assert.strictEqual(book(1, 2, 30).code, 'ALREADY_BOOKED');
  assert.strictEqual(slotState('A1'), 'booked');
});

/* ---------- ยกเลิก ---------- */
test('ยกเลิกก่อนถึงเวลา 30 นาทีขึ้นไป = ไม่มีโทษ ช่องว่างทันที', () => {
  reset();
  const r = book(1, 1, 60);
  const c = S.cancelReservation(r.reservation.id, 1);
  assert.strictEqual(c.penalty, 'NONE');
  assert.strictEqual(view(1).yellowActive, 0);
  assert.strictEqual(slotState('A1'), 'free');
});

test('ยกเลิกพอดี 30 นาที = ไม่มีโทษ แต่ 29 นาที = ใบเหลือง', () => {
  reset();
  const a = book(1, 1, 30);
  assert.strictEqual(S.cancelReservation(a.reservation.id, 1).penalty, 'NONE');
  const b = book(1, 1, 29);
  assert.strictEqual(S.cancelReservation(b.reservation.id, 1).penalty, 'YELLOW');
  assert.strictEqual(view(1).yellowActive, 1);
});

test('ใบเหลือง 2 ใบ = no-show 1 ครั้ง', () => {
  reset();
  const a = book(1, 1, 10);
  assert.strictEqual(S.cancelReservation(a.reservation.id, 1).convertedToNoShow, false);
  const b = book(1, 1, 10);
  const c = S.cancelReservation(b.reservation.id, 1);
  assert.strictEqual(c.convertedToNoShow, true);
  const v = view(1);
  assert.strictEqual(v.yellowActive, 0);
  assert.strictEqual(v.noShowActive, 1);
  assert.strictEqual(v.penalties.filter((p) => p.status === 'CONVERTED').length, 2);
});

test('ยกเลิกโดยคนอื่น หรือหลัง check-in ไม่ได้', () => {
  reset();
  const r = book(1, 1, 60);
  assert.strictEqual(S.cancelReservation(r.reservation.id, 2).code, 'NOT_FOUND');
  S.checkIn(r.reservation.code);
  assert.strictEqual(S.cancelReservation(r.reservation.id, 1).code, 'NOT_CANCELLABLE');
});

/* ---------- no-show ---------- */
test('ไม่ check-in เกิน grace = no-show (ขอบเขตที่ 15 นาทีพอดียังทัน)', () => {
  reset();
  const r = book(1, 1, 10);
  S.advanceClock(25);
  assert.strictEqual(view(1).reservations[0].status, 'BOOKED');
  S.advanceClock(1);
  const v = view(1);
  assert.strictEqual(v.reservations[0].status, 'NO_SHOW');
  assert.strictEqual(v.noShowActive, 1);
  assert.strictEqual(slotState('A1'), 'free');
  assert.strictEqual(S.checkIn(r.reservation.code).code, 'NO_SHOW');
});

test('check-in ภายใน grace ได้ และ check-in ก่อนเวลาก็ได้', () => {
  reset();
  const a = book(1, 1, 10);
  S.advanceClock(20);
  assert.strictEqual(S.checkIn(a.reservation.code).ok, true);
  const b = book(2, 2, 90);
  assert.strictEqual(S.checkIn(b.reservation.code).ok, true);
});

test('no-show ครบ 3 ครั้ง = ระงับ จองไม่ได้ จนกว่าจะปลดระงับ', () => {
  reset();
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(book(1, 1, 5).ok, true);
    S.advanceClock(21);
  }
  const v = view(1);
  assert.strictEqual(v.noShowActive, 3);
  assert.strictEqual(v.member.status, 'SUSPENDED');
  assert.strictEqual(book(1, 1, 5).code, 'SUSPENDED');
  S.unsuspend(1);
  assert.strictEqual(view(1).member.status, 'ACTIVE');
  assert.strictEqual(view(1).noShowActive, 0);
  assert.strictEqual(book(1, 1, 5).ok, true);
});

test('ใบเหลืองที่แปลงเป็น no-show นับรวมกับ no-show จริงจนครบ 3', () => {
  reset();
  book(1, 1, 5); S.advanceClock(21);               // no-show 1
  book(1, 1, 5); S.advanceClock(21);               // no-show 2
  const a = book(1, 1, 10); S.cancelReservation(a.reservation.id, 1);   // เหลือง 1
  assert.strictEqual(view(1).member.status, 'ACTIVE');
  const b = book(1, 1, 10); S.cancelReservation(b.reservation.id, 1);  // เหลือง 2 -> no-show 3
  assert.strictEqual(view(1).noShowActive, 3);
  assert.strictEqual(view(1).member.status, 'SUSPENDED');
});

/* ---------- เข้า-ออก ---------- */
test('ยืนยันออกแล้วช่องว่าง และใบเหลืองหาย', () => {
  reset();
  const y = book(1, 1, 10);
  S.cancelReservation(y.reservation.id, 1);
  assert.strictEqual(view(1).yellowActive, 1);
  const r = book(1, 1, 30);
  assert.strictEqual(S.checkIn(r.reservation.code).ok, true);
  assert.strictEqual(slotState('A1'), 'occupied');
  S.advanceClock(600); // จอดนานแค่ไหนก็ไม่นับเวลา ไม่เกิดโทษ
  assert.strictEqual(slotState('A1'), 'occupied');
  const out = S.exitVehicle(r.reservation.code);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.clearedYellows, 1);
  assert.strictEqual(slotState('A1'), 'free');
  const v = view(1);
  assert.strictEqual(v.yellowActive, 0);
  assert.strictEqual(v.reservations[0].status, 'COMPLETED');
});

test('ช่องที่มีรถจอดอยู่ คนอื่นจองไม่ได้ จนกว่าจะออก', () => {
  reset();
  const r = book(1, 1, 5);
  S.checkIn(r.reservation.code);
  assert.strictEqual(book(2, 1, 5).code, 'SLOT_TAKEN');
  S.exitVehicle(r.reservation.code);
  assert.strictEqual(book(2, 1, 5).ok, true);
});

test('กรอกรหัสผิด / ออกซ้ำ ได้ข้อความผิดพลาด', () => {
  reset();
  assert.strictEqual(S.checkIn('ZZZZZZ').code, 'NOT_FOUND');
  assert.strictEqual(S.exitVehicle('ZZZZZZ').code, 'NOT_FOUND');
  const r = book(1, 1, 5);
  S.checkIn(r.reservation.code);
  assert.strictEqual(S.checkIn(r.reservation.code).code, 'ALREADY');
  S.exitVehicle(r.reservation.code);
  assert.strictEqual(S.exitVehicle(r.reservation.code).code, 'NOT_FOUND');
});

/* ---------- walk-in ---------- */
test('walk-in ได้ช่องว่างในโซน walk-in เท่านั้น ไม่ซ้ำกัน และเต็มแล้วแจ้งเต็ม', () => {
  reset();
  const seen = new Set();
  const tickets = [];
  for (let i = 0; i < 24; i++) {
    const w = S.walkIn('ทดสอบ ' + i);
    assert.strictEqual(w.ok, true);
    assert.strictEqual(w.slot.zone, 'WALKIN');
    assert.ok(/^W[A-Z0-9]{5}$/.test(w.ticket));
    assert.ok(!seen.has(w.slot.id));
    seen.add(w.slot.id);
    tickets.push(w.ticket);
  }
  assert.strictEqual(S.walkIn('').code, 'FULL');
  assert.strictEqual(S.snapshot().counts.reservedFree, 12);   // ไม่แตะโซนจอง
  const out = S.exitVehicle(tickets[0].toLowerCase());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.type, 'walkin');
  assert.strictEqual(S.walkIn('').ok, true);
});

/* ---------- สมาชิก ---------- */
test('สมัคร / เข้าสู่ระบบ', () => {
  reset();
  assert.strictEqual(S.register({ name: '', email: 'a@b.co', password: '123456', plate: 'x' }).ok, false);
  assert.strictEqual(S.register({ name: 'ก', email: 'bad', password: '123456', plate: 'x' }).code, 'EMAIL');
  assert.strictEqual(S.register({ name: 'ก', email: 'a@b.co', password: '123', plate: 'x' }).code, 'PASSWORD');
  const ok = S.register({ name: 'ก', email: 'New@B.co', password: '123456', plate: '3คค 9' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(S.currentUser().email, 'new@b.co');
  assert.strictEqual(S.register({ name: 'ข', email: 'new@b.co', password: '123456', plate: 'y' }).code, 'EMAIL_TAKEN');
  S.logout();
  assert.strictEqual(S.currentUser(), null);
  assert.strictEqual(S.login('new@b.co', 'wrong1').ok, false);
  assert.strictEqual(S.login('NEW@b.co', '123456').ok, true);
  assert.strictEqual(S.currentUser().password, undefined);
});

/* ---------- รัน ---------- */
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('  ผ่าน  ' + name); }
  catch (e) { failed++; console.log('  ไม่ผ่าน  ' + name + '\n        ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n        ')); }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' ผ่าน');
process.exit(failed ? 1 : 0);
