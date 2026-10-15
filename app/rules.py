"""กติกาธุรกิจทั้งหมดของระบบจองโรงจอดรถ

 - จองล่วงหน้าไม่เกิน max_advance_minutes (ตรวจใน trigger ของฐานข้อมูล)
 - ยกเลิกก่อนเวลามาถึง free_cancel_minutes ขึ้นไป = ไม่มีโทษ, น้อยกว่านั้น = ใบเหลือง
 - ใบเหลืองครบ yellow_per_noshow ใบ = no-show 1 ครั้ง
 - ไม่ check-in ภายใน grace_minutes หลังเวลามาถึง = no-show
 - no-show ครบ noshow_limit ครั้ง = ระงับบัญชี
 - ยืนยันออกตามปกติ = ใบเหลืองที่ค้างอยู่หาย
 - ไม่นับเวลาจอด ช่องว่างเมื่อยืนยันออกเท่านั้น

ทุกการเปลี่ยนสถานะที่เกี่ยวกับใบเหลือง/no-show ทำใน transaction เดียว และล็อกแถวสมาชิก
(FOR UPDATE) เพื่อกันสองคำสั่งแก้ข้อมูลเดียวกันพร้อมกัน ลำดับการล็อกคือ สมาชิก -> การจอง เสมอ
"""
import os
import secrets
from zoneinfo import ZoneInfo

import psycopg

from . import db
from .errors import AppError

CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
APP_TZ = os.environ.get("APP_TZ", "Asia/Bangkok")


def make_code(prefix: str, length: int = 5) -> str:
    return prefix + "".join(secrets.choice(CODE_CHARS) for _ in range(length))


def _rows(c, sql, params=None):
    return c.execute(sql, params).fetchall() if c else db.query(sql, params)


def _one(c, sql, params=None):
    return c.execute(sql, params).fetchone() if c else db.query_one(sql, params)


def fmt_time(dt) -> str:
    return dt.astimezone(ZoneInfo(os.environ.get("APP_TZ", APP_TZ))).strftime("%H:%M")


# ---------- ตัวช่วยอ่านค่า ----------

def get_config(c=None) -> dict:
    return {r["config_key"]: int(r["config_value"])
            for r in _rows(c, "SELECT config_key, config_value FROM system_config")}


def get_now(c=None) -> dict:
    """now = เวลาของระบบ (รวมค่าจำลอง), minute = ตัดวินาทีทิ้ง"""
    return _one(c, "SELECT app_now() AS now, date_trunc('minute', app_now()) AS minute")


# ---------- ใบเหลือง / no-show / ระงับบัญชี ----------

def lock_member(c, member_id):
    return c.execute(
        "SELECT member_id, status FROM member WHERE member_id = %s FOR UPDATE", (member_id,)
    ).fetchone()


def evaluate_member(c, member_id, reservation_id):
    """รวมใบเหลืองเป็น no-show และระงับบัญชีเมื่อครบเกณฑ์ (เรียกหลังเพิ่ม penalty ทุกครั้ง)"""
    cfg = get_config(c)
    per = cfg["yellow_per_noshow"]
    while True:
        rows = c.execute(
            """SELECT penalty_id FROM penalty
                WHERE member_id = %s AND type = 'YELLOW' AND status = 'ACTIVE'
                ORDER BY penalty_id LIMIT %s""",
            (member_id, per),
        ).fetchall()
        if len(rows) < per:
            break
        c.execute(
            """UPDATE penalty SET status = 'CONVERTED', resolved_at = app_now()
                WHERE penalty_id = ANY(%s::int[])""",
            ([r["penalty_id"] for r in rows],),
        )
        c.execute(
            "INSERT INTO penalty (member_id, reservation_id, type) VALUES (%s, %s, 'NO_SHOW')",
            (member_id, reservation_id),
        )
    n = c.execute(
        """SELECT count(*)::int AS n FROM penalty
            WHERE member_id = %s AND type = 'NO_SHOW' AND status = 'ACTIVE'""",
        (member_id,),
    ).fetchone()["n"]
    if n >= cfg["noshow_limit"]:
        c.execute("UPDATE member SET status = 'SUSPENDED' WHERE member_id = %s", (member_id,))


def add_penalty(c, member_id, reservation_id, ptype):
    c.execute(
        "INSERT INTO penalty (member_id, reservation_id, type) VALUES (%s, %s, %s)",
        (member_id, reservation_id, ptype),
    )
    evaluate_member(c, member_id, reservation_id)


# ---------- จอง ----------

def create_reservation(member, body):
    try:
        slot_id = int(body.get("slot_id"))
        vehicle_id = int(body.get("vehicle_id"))
        minutes = int(body.get("arrival_minutes"))
    except (TypeError, ValueError):
        raise AppError(400, "BAD_REQUEST", "กรุณาเลือกช่องจอด รถ และเวลามาถึงให้ครบ")

    own = db.query_one(
        "SELECT 1 AS ok FROM vehicle WHERE vehicle_id = %s AND member_id = %s",
        (vehicle_id, member["member_id"]),
    )
    if not own:
        raise AppError(400, "BAD_VEHICLE", "ไม่พบรถคันนี้ในบัญชีของคุณ")

    for _ in range(3):
        try:
            with db.tx() as c:
                return c.execute(
                    """INSERT INTO reservation (member_id, vehicle_id, slot_id, arrival_time, checkin_code)
                       VALUES (%s, %s, %s,
                               date_trunc('minute', app_now()) + make_interval(mins => %s::int), %s)
                       RETURNING *""",
                    (member["member_id"], vehicle_id, slot_id, minutes, make_code("R")),
                ).fetchone()
        except psycopg.Error as e:
            if e.diag.sqlstate == "23505" and e.diag.constraint_name == "reservation_checkin_code_key":
                continue  # รหัสซ้ำ สุ่มใหม่
            err = translate_reservation_error(e)
            if err is e:
                raise
            raise err from e
    raise AppError(500, "CODE_COLLISION", "สร้างรหัสจองไม่สำเร็จ ลองใหม่อีกครั้ง")


def translate_reservation_error(e: psycopg.Error):
    state, msg = e.diag.sqlstate, e.diag.message_primary
    if state == "23505":
        if e.diag.constraint_name == "uq_active_reservation_per_slot":
            return AppError(409, "SLOT_TAKEN", "ช่องนี้เพิ่งถูกจองไป กรุณาเลือกช่องอื่น")
        if e.diag.constraint_name == "uq_active_reservation_per_member":
            return AppError(409, "ALREADY_HAS_RESERVATION",
                            "คุณมีการจองที่ยังไม่จบอยู่แล้ว (จองได้ครั้งละ 1 ช่อง)")
    if state == "P0001":  # RAISE EXCEPTION จาก trigger reservation_validate
        cfg = get_config()
        if msg == "MEMBER_SUSPENDED":
            return AppError(403, "SUSPENDED",
                            f"บัญชีถูกระงับเพราะ no-show ครบ {cfg['noshow_limit']} ครั้ง "
                            "จองไม่ได้จนกว่าผู้ดูแลจะปลดระงับ")
        if msg == "SLOT_NOT_RESERVABLE":
            return AppError(400, "ZONE", "ช่องนี้จองไม่ได้ (ต้องเป็นช่องในโซนจอง)")
        if msg == "ARRIVAL_PAST":
            return AppError(400, "ARRIVAL_PAST", "เลือกเวลาที่ผ่านมาแล้วไม่ได้")
        if msg == "ARRIVAL_TOO_FAR":
            from datetime import timedelta
            limit = get_now()["minute"] + timedelta(minutes=cfg["max_advance_minutes"])
            return AppError(400, "ARRIVAL_TOO_FAR",
                            f"จองล่วงหน้าได้ไม่เกิน {cfg['max_advance_minutes']} นาที "
                            f"(เลือกได้ถึง {fmt_time(limit)})")
    return e


# ---------- ยกเลิก ----------

def cancel_reservation(member, reservation_id):
    sweep_no_shows()  # ถ้าเลยเวลา + grace ไปแล้ว ต้องถูกนับเป็น no-show ก่อน ไม่ใช่ยกเลิก
    with db.tx() as c:
        lock_member(c, member["member_id"])
        r = c.execute(
            "SELECT * FROM reservation WHERE reservation_id = %s AND member_id = %s FOR UPDATE",
            (reservation_id, member["member_id"]),
        ).fetchone()
        if not r:
            raise AppError(404, "NOT_FOUND", "ไม่พบการจองนี้")
        if r["status"] != "BOOKED":
            msg = {"NO_SHOW": "การจองนี้ถูกนับเป็น no-show ไปแล้ว",
                   "CHECKED_IN": "เข้าใช้งานแล้ว ยกเลิกไม่ได้ (ให้ยืนยันออกที่ทางออก)"
                   }.get(r["status"], "การจองนี้จบไปแล้ว")
            raise AppError(409, "NOT_CANCELLABLE", msg)

        cfg = get_config(c)
        now = get_now(c)
        # เทียบที่ระดับนาที: ยกเลิกก่อนเวลามาถึง >= free_cancel_minutes = ไม่มีโทษ
        minutes_left = (r["arrival_time"] - now["minute"]).total_seconds() / 60
        free = minutes_left >= cfg["free_cancel_minutes"]
        c.execute("UPDATE reservation SET status = 'CANCELLED', cancelled_at = app_now() "
                  "WHERE reservation_id = %s", (r["reservation_id"],))
        if not free:
            add_penalty(c, member["member_id"], r["reservation_id"], "YELLOW")
        status = c.execute("SELECT status FROM member WHERE member_id = %s",
                           (member["member_id"],)).fetchone()["status"]
        return {"penalty": not free, "minutes_left": minutes_left,
                "free_cancel_minutes": cfg["free_cancel_minutes"], "member_status": status}


# ---------- check-in / ออก ----------

def check_in(code):
    sweep_no_shows()
    with db.tx() as c:
        r = c.execute(
            """SELECT r.*, v.plate, s.label AS slot_label
                 FROM reservation r JOIN vehicle v USING (vehicle_id) JOIN parking_slot s USING (slot_id)
                WHERE r.checkin_code = %s FOR UPDATE OF r""",
            (str(code or "").strip().upper(),),
        ).fetchone()
        if not r:
            raise AppError(404, "NOT_FOUND", "ไม่พบรหัสจองนี้")
        if r["status"] == "CHECKED_IN":
            raise AppError(409, "ALREADY", "check-in ไปแล้ว")
        if r["status"] == "NO_SHOW":
            raise AppError(409, "NO_SHOW", "เลยเวลาแล้ว การจองนี้ถูกนับเป็น no-show")
        if r["status"] != "BOOKED":
            raise AppError(409, "CLOSED", "การจองนี้จบไปแล้ว")
        c.execute(
            "INSERT INTO parking_session (slot_id, reservation_id, ticket_code, plate) VALUES (%s, %s, %s, %s)",
            (r["slot_id"], r["reservation_id"], r["checkin_code"], r["plate"]),
        )
        c.execute("UPDATE reservation SET status = 'CHECKED_IN' WHERE reservation_id = %s",
                  (r["reservation_id"],))
        return {"slot_label": r["slot_label"], "plate": r["plate"], "reservation_id": r["reservation_id"]}


def exit_by_code(code):
    """ยืนยันออกด้วยรหัสจอง (R....) หรือรหัสตั๋ว walk-in (W....) — ช่องว่างเมื่อยืนยันออกเท่านั้น"""
    with db.tx() as c:
        s = c.execute(
            """SELECT ps.*, sl.label AS slot_label, r.member_id
                 FROM parking_session ps
                 JOIN parking_slot sl USING (slot_id)
                 LEFT JOIN reservation r USING (reservation_id)
                WHERE ps.ticket_code = %s AND ps.exit_time IS NULL
                FOR UPDATE OF ps""",
            (str(code or "").strip().upper(),),
        ).fetchone()
        if not s:
            raise AppError(404, "NOT_FOUND", "ไม่พบรถที่จอดอยู่ด้วยรหัสนี้ (อาจออกไปแล้ว)")
        cleared = 0
        if s["member_id"]:
            lock_member(c, s["member_id"])
        c.execute("UPDATE parking_session SET exit_time = app_now() WHERE session_id = %s", (s["session_id"],))
        if s["reservation_id"]:
            c.execute("UPDATE reservation SET status = 'COMPLETED' WHERE reservation_id = %s",
                      (s["reservation_id"],))
            cleared = c.execute(
                """UPDATE penalty SET status = 'CLEARED', resolved_at = app_now()
                    WHERE member_id = %s AND type = 'YELLOW' AND status = 'ACTIVE'""",
                (s["member_id"],),
            ).rowcount
        return {"slot_label": s["slot_label"], "walk_in": not s["reservation_id"], "yellow_cleared": cleared}


# ---------- walk-in ----------

def walk_in(plate=None):
    for _ in range(3):
        try:
            with db.tx() as c:
                # สุ่มช่องว่างในโซน walk-in; SKIP LOCKED = รถเข้าพร้อมกันได้คนละช่อง ไม่ต้องรอกัน
                slot = c.execute(
                    """SELECT s.slot_id, s.label
                         FROM parking_slot s JOIN zone z USING (zone_id)
                        WHERE z.zone_type = 'WALKIN' AND s.is_active
                          AND NOT EXISTS (SELECT 1 FROM parking_session p
                                           WHERE p.slot_id = s.slot_id AND p.exit_time IS NULL)
                        ORDER BY random() LIMIT 1
                          FOR UPDATE OF s SKIP LOCKED"""
                ).fetchone()
                if not slot:
                    raise AppError(409, "FULL", "โซน walk-in เต็มแล้ว")
                ticket = make_code("W")
                s = c.execute(
                    "INSERT INTO parking_session (slot_id, ticket_code, plate) VALUES (%s, %s, %s) RETURNING entry_time",
                    (slot["slot_id"], ticket, str(plate).strip() if plate else None),
                ).fetchone()
                return {"slot_label": slot["label"], "ticket_code": ticket, "entry_time": s["entry_time"]}
        except psycopg.Error as e:
            if e.diag.sqlstate == "23505":
                continue  # ชนกันที่ unique index (หายาก) — สุ่มใหม่
            raise
    raise AppError(409, "FULL", "ไม่สามารถจัดช่องให้ได้ในตอนนี้ ลองใหม่อีกครั้ง")


# ---------- ตัวทำงานเบื้องหลัง: no-show ----------

def sweep_no_shows():
    """การจองที่เลย (เวลามาถึง + grace) แล้วยังไม่ check-in = no-show คืนรายการ reservation_id ที่เพิ่งถูกนับ"""
    cfg = get_config()
    rows = db.query(
        """SELECT reservation_id, member_id FROM reservation
            WHERE status = 'BOOKED' AND app_now() > arrival_time + make_interval(mins => %s::int)
            ORDER BY arrival_time""",
        (cfg["grace_minutes"],),
    )
    done = []
    for row in rows:
        with db.tx() as c:
            lock_member(c, row["member_id"])  # ล็อกสมาชิกก่อนการจองเสมอ (ลำดับเดียวกับ cancel) กัน deadlock
            r = c.execute(
                """SELECT reservation_id, member_id FROM reservation
                    WHERE reservation_id = %s AND status = 'BOOKED' FOR UPDATE SKIP LOCKED""",
                (row["reservation_id"],),
            ).fetchone()
            if not r:
                continue
            c.execute("UPDATE reservation SET status = 'NO_SHOW' WHERE reservation_id = %s",
                      (r["reservation_id"],))
            add_penalty(c, r["member_id"], r["reservation_id"], "NO_SHOW")
            done.append(r["reservation_id"])
    return done


# ---------- มุมมองข้อมูล ----------

def slot_map(member_id=None):
    return db.query(
        """SELECT s.slot_id, s.label, s.row_no, s.col_no, z.zone_type,
                  CASE WHEN NOT s.is_active THEN 'CLOSED'
                       WHEN ps.session_id IS NOT NULL THEN 'OCCUPIED'
                       WHEN r.reservation_id IS NOT NULL THEN 'BOOKED'
                       ELSE 'FREE' END AS state,
                  COALESCE(r.member_id = %s::int, false) AS mine
             FROM parking_slot s
             JOIN zone z USING (zone_id)
             LEFT JOIN parking_session ps ON ps.slot_id = s.slot_id AND ps.exit_time IS NULL
             LEFT JOIN reservation r ON r.slot_id = s.slot_id AND r.status IN ('BOOKED', 'CHECKED_IN')
            ORDER BY s.row_no, s.col_no""",
        (member_id,),
    )


def member_overview(member_id):
    cfg = get_config()
    with db.tx() as c:
        member = c.execute(
            "SELECT member_id, name, email, phone, role, status FROM member WHERE member_id = %s",
            (member_id,)).fetchone()
        vehicles = c.execute(
            "SELECT vehicle_id, plate FROM vehicle WHERE member_id = %s ORDER BY vehicle_id",
            (member_id,)).fetchall()
        counts = c.execute(
            """SELECT count(*) FILTER (WHERE type = 'YELLOW'  AND status = 'ACTIVE')::int AS yellow_active,
                      count(*) FILTER (WHERE type = 'NO_SHOW' AND status = 'ACTIVE')::int AS noshow_active
                 FROM penalty WHERE member_id = %s""", (member_id,)).fetchone()
        reservations = c.execute(
            """SELECT r.reservation_id, r.status, r.arrival_time, r.created_at, r.cancelled_at, r.checkin_code,
                      s.label AS slot_label, v.plate,
                      r.arrival_time + make_interval(mins => %s::int) AS checkin_deadline
                 FROM reservation r JOIN parking_slot s USING (slot_id) JOIN vehicle v USING (vehicle_id)
                WHERE r.member_id = %s ORDER BY r.reservation_id DESC LIMIT 30""",
            (cfg["grace_minutes"], member_id)).fetchall()
    limits = {k: cfg[k] for k in ("yellow_per_noshow", "noshow_limit", "free_cancel_minutes",
                                  "grace_minutes", "max_advance_minutes")}
    active = next((r for r in reservations if r["status"] in ("BOOKED", "CHECKED_IN")), None)
    return {"member": member, "vehicles": vehicles, "counts": counts, "limits": limits,
            "active": active, "reservations": reservations}
