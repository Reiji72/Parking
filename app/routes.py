"""เส้นทาง API: สถานะระบบ / สมาชิก / kiosk (หน้าลานจอด) / ผู้ดูแลระบบ"""
import os

import psycopg
from flask import Blueprint, g, jsonify, request

from . import auth, db, rules
from .errors import AppError

api = Blueprint("api", __name__, url_prefix="/api")
APP_TZ = os.environ.get("APP_TZ", "Asia/Bangkok")


def body() -> dict:
    return request.get_json(silent=True) or {}


# ================= สถานะระบบ (ไม่ต้องล็อกอิน) =================

@api.get("/status")
def status():
    cfg = rules.get_config()
    counts = db.query_one(
        """SELECT count(*) FILTER (WHERE z.zone_type = 'RESERVED')::int AS reserved_total,
                  count(*) FILTER (WHERE z.zone_type = 'WALKIN')::int   AS walkin_total
             FROM parking_slot s JOIN zone z USING (zone_id) WHERE s.is_active""")
    return jsonify({"now": rules.get_now()["now"], "clock_offset_minutes": cfg["clock_offset_minutes"],
                    "time_travel": os.environ.get("ALLOW_TIME_TRAVEL", "true") != "false",
                    "config": cfg, **counts})


@api.get("/slots")
@auth.optional_auth
def slots():
    return jsonify(rules.slot_map(g.member["member_id"] if g.member else None))


# ================= สมัคร / เข้าสู่ระบบ =================

@api.post("/auth/register")
def register():
    b = body()
    name, email, password, plate = (str(b.get(k) or "").strip() for k in ("name", "email", "password", "plate"))
    if not (name and email and password and plate):
        raise AppError(400, "BAD_REQUEST", "กรอก ชื่อ อีเมล รหัสผ่าน และทะเบียนรถให้ครบ")
    if len(password) < 6:
        raise AppError(400, "BAD_REQUEST", "รหัสผ่านอย่างน้อย 6 ตัวอักษร")
    try:
        with db.tx() as c:
            member_id = c.execute(
                "INSERT INTO member (name, email, phone, password_hash) VALUES (%s, lower(%s), %s, %s) "
                "RETURNING member_id",
                (name, email, b.get("phone") or None, auth.hash_password(password))).fetchone()["member_id"]
            c.execute("INSERT INTO vehicle (member_id, plate) VALUES (%s, %s)", (member_id, plate))
    except psycopg.Error as e:
        if e.diag.sqlstate == "23505":
            raise AppError(409, "DUPLICATE",
                           "ทะเบียนรถนี้ถูกใช้แล้ว" if e.diag.constraint_name == "vehicle_plate_key"
                           else "อีเมลนี้สมัครไว้แล้ว") from e
        raise
    return jsonify({"token": auth.issue_token(member_id)}), 201


@api.post("/auth/login")
def login():
    b = body()
    m = db.query_one("SELECT member_id, password_hash FROM member WHERE email = lower(%s)",
                     (str(b.get("email") or "").strip(),))
    if not m or not auth.verify_password(str(b.get("password") or ""), m["password_hash"]):
        raise AppError(401, "BAD_LOGIN", "อีเมลหรือรหัสผ่านไม่ถูกต้อง")
    return jsonify({"token": auth.issue_token(m["member_id"])})


@api.post("/auth/logout")
@auth.require_auth
def logout():
    db.execute("DELETE FROM auth_token WHERE token = %s", (request.headers["Authorization"][7:],))
    return jsonify({"ok": True})


# ================= สมาชิก =================

@api.get("/me")
@auth.require_auth
def me():
    rules.sweep_no_shows()
    return jsonify(rules.member_overview(g.member["member_id"]))


@api.post("/vehicles")
@auth.require_auth
def add_vehicle():
    plate = str(body().get("plate") or "").strip()
    if not plate:
        raise AppError(400, "BAD_REQUEST", "กรอกทะเบียนรถ")
    try:
        v = db.query_one("INSERT INTO vehicle (member_id, plate) VALUES (%s, %s) RETURNING *",
                         (g.member["member_id"], plate))
    except psycopg.Error as e:
        if e.diag.sqlstate == "23505":
            raise AppError(409, "DUPLICATE", "ทะเบียนรถนี้ถูกใช้แล้ว") from e
        raise
    return jsonify(v), 201


@api.post("/reservations")
@auth.require_auth
def create_reservation():
    return jsonify(rules.create_reservation(g.member, body())), 201


@api.post("/reservations/<int:reservation_id>/cancel")
@auth.require_auth
def cancel_reservation(reservation_id):
    return jsonify(rules.cancel_reservation(g.member, reservation_id))


# ================= Kiosk จำลอง (หน้าลานจอด — ไม่ต้องล็อกอิน) =================

@api.post("/kiosk/checkin")
def kiosk_checkin():
    return jsonify(rules.check_in(body().get("code")))


@api.post("/kiosk/walkin")
def kiosk_walkin():
    return jsonify(rules.walk_in(body().get("plate"))), 201


@api.post("/kiosk/exit")
def kiosk_exit():
    return jsonify(rules.exit_by_code(body().get("code")))


# ================= ผู้ดูแลระบบ =================

@api.get("/admin/overview")
@auth.require_admin
def admin_overview():
    rules.sweep_no_shows()
    cfg = rules.get_config()
    members = db.query(
        """SELECT m.member_id, m.name, m.email, m.status,
                  count(p.*) FILTER (WHERE p.type = 'YELLOW'  AND p.status = 'ACTIVE')::int AS yellow_active,
                  count(p.*) FILTER (WHERE p.type = 'NO_SHOW' AND p.status = 'ACTIVE')::int AS noshow_active,
                  count(p.*) FILTER (WHERE p.type = 'NO_SHOW')::int                         AS noshow_total
             FROM member m LEFT JOIN penalty p USING (member_id)
            WHERE m.role = 'MEMBER' GROUP BY m.member_id
            ORDER BY noshow_active DESC, yellow_active DESC, m.member_id""")
    recent = db.query(
        """SELECT r.reservation_id, r.status, r.arrival_time, r.checkin_code, s.label AS slot_label, m.name, v.plate
             FROM reservation r JOIN parking_slot s USING (slot_id) JOIN member m USING (member_id)
             JOIN vehicle v USING (vehicle_id)
            ORDER BY r.reservation_id DESC LIMIT 20""")
    stats = db.query_one(
        """SELECT (SELECT count(*) FROM parking_session WHERE exit_time IS NULL)::int AS parked_now,
                  (SELECT count(*) FROM reservation WHERE status = 'BOOKED')::int      AS booked_now,
                  (SELECT count(*) FROM member WHERE status = 'SUSPENDED')::int        AS suspended""")
    parked = db.query(
        """SELECT ps.session_id, ps.slot_id, sl.label AS slot_label, ps.plate, ps.ticket_code,
                  ps.entry_time, ps.reservation_id,
                  m.name AS member_name, m.email AS member_email,
                  z.zone_type
             FROM parking_session ps
             JOIN parking_slot sl USING (slot_id)
             JOIN zone z USING (zone_id)
             LEFT JOIN reservation r USING (reservation_id)
             LEFT JOIN member m ON r.member_id = m.member_id
            WHERE ps.exit_time IS NULL
            ORDER BY ps.entry_time DESC""")
    active_reservations = db.query(
        """SELECT r.reservation_id, r.status, r.arrival_time, r.created_at, r.checkin_code,
                  s.label AS slot_label, m.name, m.email, v.plate,
                  r.arrival_time + make_interval(mins => %s::int) AS checkin_deadline
             FROM reservation r
             JOIN parking_slot s USING (slot_id)
             JOIN member m USING (member_id)
             JOIN vehicle v USING (vehicle_id)
            WHERE r.status = 'BOOKED'
            ORDER BY r.arrival_time ASC""",
        (cfg["grace_minutes"],))
    return jsonify({"members": members, "recent": recent, "stats": stats,
                    "parked": parked, "active_reservations": active_reservations,
                    "config": cfg, "now": rules.get_now()["now"]})


@api.post("/admin/members/<int:member_id>/unsuspend")
@auth.require_admin
def admin_unsuspend(member_id):
    with db.tx() as c:
        if not rules.lock_member(c, member_id):
            raise AppError(404, "NOT_FOUND", "ไม่พบสมาชิก")
        c.execute("""UPDATE penalty SET status = 'CLEARED', resolved_at = app_now()
                      WHERE member_id = %s AND status = 'ACTIVE'""", (member_id,))
        c.execute("UPDATE member SET status = 'ACTIVE' WHERE member_id = %s", (member_id,))
    return jsonify({"ok": True})


@api.post("/admin/reservations/<int:reservation_id>/cancel")
@auth.require_admin
def admin_cancel_reservation(reservation_id):
    return jsonify(rules.admin_cancel_reservation(reservation_id=reservation_id, admin_id=g.member["member_id"]))


@api.post("/admin/reservations/force-cancel")
@auth.require_admin
def admin_force_cancel():
    b = body()
    res_id = b.get("reservation_id")
    return jsonify(rules.admin_cancel_reservation(
        reservation_id=int(res_id) if res_id else None,
        code=b.get("code"),
        slot_label=b.get("slot_label"),
        admin_id=g.member["member_id"],
    ))


@api.post("/admin/sessions/<int:session_id>/exit")
@auth.require_admin
def admin_exit_session(session_id):
    return jsonify(rules.admin_force_exit(session_id=session_id))


@api.post("/admin/sessions/force-exit")
@auth.require_admin
def admin_force_exit():
    b = body()
    sess_id = b.get("session_id")
    return jsonify(rules.admin_force_exit(
        session_id=int(sess_id) if sess_id else None,
        code=b.get("code"),
        slot_label=b.get("slot_label"),
    ))



# ---- ค่าตั้งระบบ (ทุกการแก้ไขบันทึกลง config_history) ----
EDITABLE = {
    "max_advance_minutes": (1, 1440),
    "free_cancel_minutes": (0, 1440),
    "grace_minutes": (0, 240),
    "yellow_per_noshow": (1, 10),
    "noshow_limit": (1, 20),
    "reserved_ratio_pct": (1, 99),
}


@api.get("/admin/config")
@auth.require_admin
def admin_config():
    config = db.query("""SELECT config_key, config_value, description FROM system_config
                          WHERE config_key <> 'clock_offset_minutes' ORDER BY config_key""")
    history = db.query("SELECT * FROM config_history ORDER BY id DESC LIMIT 30")
    return jsonify({"config": config, "history": history})


@api.put("/admin/config")
@auth.require_admin
def admin_config_update():
    changes = body()
    clean = {}
    for key, value in changes.items():
        if key not in EDITABLE:
            raise AppError(400, "BAD_KEY", f"ไม่รู้จักค่า {key}")
        lo, hi = EDITABLE[key]
        try:
            n = int(value)
        except (TypeError, ValueError):
            n = None
        if n is None or str(value).strip() != str(n) or not lo <= n <= hi:
            raise AppError(400, "BAD_VALUE", f"{key} ต้องเป็นจำนวนเต็ม {lo}-{hi}")
        clean[key] = n
    with db.tx() as c:
        for key, n in clean.items():
            old = c.execute("SELECT config_value FROM system_config WHERE config_key = %s FOR UPDATE",
                            (key,)).fetchone()
            if not old or old["config_value"] == str(n):
                continue
            c.execute("UPDATE system_config SET config_value = %s, updated_at = now(), updated_by = %s "
                      "WHERE config_key = %s", (str(n), g.member["member_id"], key))
            c.execute("INSERT INTO config_history (config_key, old_value, new_value, changed_by) "
                      "VALUES (%s, %s, %s, %s)", (key, old["config_value"], str(n), g.member["member_id"]))
    return jsonify({"ok": True})


# ---- ตัวจำลองเวลา: เลื่อนนาฬิการะบบเพื่อทดสอบ no-show โดยไม่ต้องรอจริง ----
@api.post("/admin/clock")
@auth.require_admin
def admin_clock():
    if os.environ.get("ALLOW_TIME_TRAVEL", "true") == "false":
        raise AppError(403, "DISABLED", "ปิดตัวจำลองเวลาไว้")
    b = body()
    if b.get("reset"):
        db.execute("UPDATE system_config SET config_value = '0' WHERE config_key = 'clock_offset_minutes'")
    else:
        try:
            n = int(b.get("advance_minutes"))
        except (TypeError, ValueError):
            n = 0
        if not 1 <= n <= 10080:
            raise AppError(400, "BAD_VALUE", "เลื่อนได้ 1-10080 นาทีต่อครั้ง")
        db.execute("UPDATE system_config SET config_value = (config_value::int + %s)::text "
                   "WHERE config_key = 'clock_offset_minutes'", (n,))
    new = rules.sweep_no_shows()
    return jsonify({"now": rules.get_now()["now"], "new_no_shows": len(new)})


@api.post("/admin/sweep")
@auth.require_admin
def admin_sweep():
    return jsonify({"new_no_shows": len(rules.sweep_no_shows())})


# ล้างข้อมูลการจอง/การจอด/ใบเหลือง กลับเป็นสถานะเริ่มต้น (เก็บสมาชิกและค่า config ไว้)
@api.post("/admin/reset-data")
@auth.require_admin
def admin_reset():
    with db.tx() as c:
        c.execute("TRUNCATE penalty, parking_session, reservation RESTART IDENTITY CASCADE")
        c.execute("UPDATE member SET status = 'ACTIVE'")
        c.execute("UPDATE system_config SET config_value = '0' WHERE config_key = 'clock_offset_minutes'")
    return jsonify({"ok": True})


# ---- รายงานสำหรับทบทวนกติกาทุก 3 เดือน ----
@api.get("/admin/reports")
@auth.require_admin
def admin_reports():
    tz = (APP_TZ,)
    monthly = db.query(
        """SELECT to_char(date_trunc('month', arrival_time AT TIME ZONE %s::text), 'YYYY-MM') AS month,
                  count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
                  count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                  count(*) FILTER (WHERE status = 'NO_SHOW')::int   AS no_show,
                  count(*)::int AS total,
                  round(100.0 * count(*) FILTER (WHERE status = 'NO_SHOW') / count(*), 1)::float8 AS no_show_pct
             FROM reservation
            WHERE status IN ('COMPLETED', 'CANCELLED', 'NO_SHOW')
              AND arrival_time >= app_now() - interval '3 months'
            GROUP BY 1 ORDER BY 1""", tz)
    yellow_by_hour = db.query(
        """SELECT extract(hour FROM r.arrival_time AT TIME ZONE %s::text)::int AS hour, count(*)::int AS n
             FROM penalty p JOIN reservation r USING (reservation_id)
            WHERE p.type = 'YELLOW' AND p.created_at >= app_now() - interval '3 months'
            GROUP BY 1 ORDER BY 1""", tz)
    no_show_by_hour = db.query(
        """SELECT extract(hour FROM arrival_time AT TIME ZONE %s::text)::int AS hour, count(*)::int AS n
             FROM reservation
            WHERE status = 'NO_SHOW' AND arrival_time >= app_now() - interval '3 months'
            GROUP BY 1 ORDER BY 1""", tz)
    top = db.query(
        """SELECT m.member_id, m.name, count(*)::int AS no_shows
             FROM penalty p JOIN member m USING (member_id)
            WHERE p.type = 'NO_SHOW' AND p.created_at >= app_now() - interval '3 months'
            GROUP BY m.member_id ORDER BY no_shows DESC, m.member_id LIMIT 10""")
    ratio = db.query_one(
        """SELECT count(*) FILTER (WHERE z.zone_type = 'RESERVED')::int AS reserved,
                  count(*)::int AS total,
                  round(100.0 * count(*) FILTER (WHERE z.zone_type = 'RESERVED') / count(*), 1)::float8 AS reserved_pct
             FROM parking_slot s JOIN zone z USING (zone_id) WHERE s.is_active""")
    return jsonify({"monthly": monthly, "yellowByHour": yellow_by_hour, "noShowByHour": no_show_by_hour,
                    "topNoShow": top, "ratio": ratio})
