"""ทดสอบ API กับ PostgreSQL จริง:   python -m unittest discover -s tests -v

คำเตือน: ก่อนเริ่มจะรัน db/schema.sql ซึ่งลบข้อมูลเดิมทั้งหมดใน DATABASE_URL จึงควรชี้ไปที่ฐานข้อมูลสำหรับทดสอบ เช่น
    DATABASE_URL=postgresql://parking:parking@localhost:5432/parking_test python -m unittest discover -s tests -v
"""
import os
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import create_app  # noqa: E402
from app.setup_db import setup  # noqa: E402

APP = create_app()


def call(method, path, token=None, body=None):
    """เรียก API (สร้าง test client ใหม่ทุกครั้ง จึงใช้ใน thread ได้)"""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    res = APP.test_client().open(path, method=method, json=body, headers=headers)
    return res.status_code, (res.get_json(silent=True) or {})


class ParkingApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        setup()
        cls.tok = {}
        for who, email, pw in [("admin", "admin@parking.test", "admin1234"),
                               ("demo1", "demo1@parking.test", "demo1234"),
                               ("demo2", "demo2@parking.test", "demo1234")]:
            status, body = call("POST", "/api/auth/login", body={"email": email, "password": pw})
            assert status == 200, body
            cls.tok[who] = body["token"]

    def setUp(self):
        call("POST", "/api/admin/reset-data", self.tok["admin"])  # ล้างการจอง/ใบเหลือง/นาฬิกาจำลอง

    # ---------- ตัวช่วย ----------
    def me(self, who):
        return call("GET", "/api/me", self.tok[who])[1]

    def reserve(self, who, slot, minutes):
        vehicle = self.me(who)["vehicles"][0]["vehicle_id"]
        return call("POST", "/api/reservations", self.tok[who],
                    {"slot_id": slot, "vehicle_id": vehicle, "arrival_minutes": minutes})

    def cancel(self, who, reservation_id):
        return call("POST", f"/api/reservations/{reservation_id}/cancel", self.tok[who])

    def advance(self, minutes):
        return call("POST", "/api/admin/clock", self.tok["admin"], {"advance_minutes": minutes})

    def slot_state(self, slot_id, who=None):
        slots = call("GET", "/api/slots", self.tok.get(who))[1]
        return next(s for s in slots if s["slot_id"] == slot_id)

    # ---------- ผังและสัดส่วน ----------
    def test_zone_ratio_one_third(self):
        _, body = call("GET", "/api/status")
        self.assertEqual((body["reserved_total"], body["walkin_total"]), (12, 24))

    # ---------- จองล่วงหน้าไม่เกิน 2 ชั่วโมง ----------
    def test_advance_limit_two_hours(self):
        status, body = self.reserve("demo1", 1, 121)
        self.assertEqual((status, body["code"]), (400, "ARRIVAL_TOO_FAR"))
        self.assertEqual(self.reserve("demo1", 1, -1)[1]["code"], "ARRIVAL_PAST")
        status, booked = self.reserve("demo1", 1, 120)
        self.assertEqual(status, 201)
        _, result = self.cancel("demo1", booked["reservation_id"])
        self.assertFalse(result["penalty"], "ยกเลิกก่อน 30 นาทีต้องไม่มีโทษ")

    def test_cannot_reserve_walkin_zone(self):
        status, body = self.reserve("demo1", 13, 30)
        self.assertEqual((status, body["code"]), (400, "ZONE"))

    # ---------- จองซ้อน ----------
    def test_double_booking_race(self):
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda who: self.reserve(who, 2, 30), ["demo1", "demo2"]))
        self.assertEqual(sorted(r[0] for r in results), [201, 409])
        loser = next(r for r in results if r[0] == 409)
        self.assertEqual(loser[1]["code"], "SLOT_TAKEN")

    def test_one_active_reservation_per_member(self):
        self.assertEqual(self.reserve("demo1", 3, 60)[0], 201)
        status, body = self.reserve("demo1", 4, 60)
        self.assertEqual((status, body["code"]), (409, "ALREADY_HAS_RESERVATION"))

    # ---------- ใบเหลือง / no-show / ระงับ ----------
    def test_two_late_cancels_become_one_noshow(self):
        for i in range(2):
            status, booked = self.reserve("demo2", 5, 10)
            self.assertEqual(status, 201)
            _, result = self.cancel("demo2", booked["reservation_id"])
            self.assertTrue(result["penalty"], "ยกเลิกใกล้เวลาต้องได้ใบเหลือง")
            if i == 0:
                self.assertEqual(self.me("demo2")["counts"]["yellow_active"], 1)
        counts = self.me("demo2")["counts"]
        self.assertEqual((counts["yellow_active"], counts["noshow_active"]), (0, 1))

    def test_noshow_three_times_suspends_then_admin_unsuspends(self):
        for _ in range(3):
            self.assertEqual(self.reserve("demo2", 5, 5)[0], 201)
            self.advance(25)  # มาถึง +5 นาที, grace 15 -> เลย +20 แล้ว
        m = self.me("demo2")
        self.assertEqual(m["counts"]["noshow_active"], 3)
        self.assertEqual(m["member"]["status"], "SUSPENDED")
        status, body = self.reserve("demo2", 6, 30)
        self.assertEqual((status, body["code"]), (403, "SUSPENDED"))

        self.assertEqual(call("POST", f"/api/admin/members/{m['member']['member_id']}/unsuspend",
                              self.tok["admin"])[0], 200)
        self.assertEqual(self.reserve("demo2", 6, 30)[0], 201)

    def test_checkin_after_grace_is_noshow(self):
        _, booked = self.reserve("demo1", 7, 5)
        self.advance(25)
        status, body = call("POST", "/api/kiosk/checkin", body={"code": booked["checkin_code"]})
        self.assertEqual((status, body["code"]), (409, "NO_SHOW"))
        self.assertEqual(self.me("demo1")["counts"]["noshow_active"], 1)

    def test_member_cannot_use_admin_api(self):
        self.assertEqual(call("GET", "/api/admin/overview", self.tok["demo1"])[0], 403)
        self.assertEqual(call("GET", "/api/admin/overview")[0], 401)

    # ---------- check-in / ยืนยันออก ----------
    def test_checkin_exit_clears_yellow_and_no_time_counting(self):
        _, early = self.reserve("demo1", 7, 10)
        self.cancel("demo1", early["reservation_id"])  # ใบเหลือง 1 ใบ
        self.assertEqual(self.me("demo1")["counts"]["yellow_active"], 1)

        _, booked = self.reserve("demo1", 7, 0)
        status, ci = call("POST", "/api/kiosk/checkin", body={"code": booked["checkin_code"]})
        self.assertEqual(status, 200)
        self.assertEqual(ci["slot_label"], self.slot_state(7)["label"])

        self.advance(600)  # จอดนาน 10 ชม. ก็ไม่นับเวลา ไม่เกิดโทษ ช่องไม่ว่างเอง
        self.assertEqual(self.slot_state(7)["state"], "OCCUPIED")
        self.assertEqual(self.me("demo1")["member"]["status"], "ACTIVE")

        status, out = call("POST", "/api/kiosk/exit", body={"code": booked["checkin_code"]})
        self.assertEqual((status, out["yellow_cleared"]), (200, 1))
        self.assertEqual(self.me("demo1")["counts"]["yellow_active"], 0)
        self.assertEqual(self.slot_state(7)["state"], "FREE")
        self.assertEqual(self.me("demo1")["reservations"][0]["status"], "COMPLETED")
        # ออกซ้ำไม่ได้
        self.assertEqual(call("POST", "/api/kiosk/exit", body={"code": booked["checkin_code"]})[0], 404)

    # ---------- walk-in ----------
    def test_walkin_24_concurrent_then_full_then_exit_frees_slot(self):
        with ThreadPoolExecutor(12) as pool:
            results = list(pool.map(
                lambda i: call("POST", "/api/kiosk/walkin", body={"plate": f"W-{i}"}), range(24)))
        self.assertTrue(all(r[0] == 201 for r in results), "ทุกคันต้องได้ช่อง")
        labels = [r[1]["slot_label"] for r in results]
        self.assertEqual(len(set(labels)), 24, "ห้ามได้ช่องซ้ำ")
        self.assertTrue(all(l[0] in "CDEF" for l in labels), "ต้องอยู่โซน walk-in เท่านั้น")

        status, body = call("POST", "/api/kiosk/walkin", body={})
        self.assertEqual((status, body["code"]), (409, "FULL"))

        first = results[0][1]
        self.assertEqual(call("POST", "/api/kiosk/exit", body={"code": first["ticket_code"]})[0], 200)
        status, again = call("POST", "/api/kiosk/walkin", body={})
        self.assertEqual((status, again["slot_label"]), (201, first["slot_label"]))

    # ---------- ค่าตั้งระบบ ----------
    def test_config_change_applies_and_is_logged(self):
        try:
            self.assertEqual(call("PUT", "/api/admin/config", self.tok["admin"],
                                  {"max_advance_minutes": 60})[0], 200)
            self.assertEqual(self.reserve("demo1", 8, 61)[1]["code"], "ARRIVAL_TOO_FAR")
            self.assertEqual(self.reserve("demo1", 8, 60)[0], 201)
            history = call("GET", "/api/admin/config", self.tok["admin"])[1]["history"]
            self.assertTrue(any(h["config_key"] == "max_advance_minutes" and h["new_value"] == "60"
                                for h in history))
            self.assertEqual(call("PUT", "/api/admin/config", self.tok["admin"],
                                  {"noshow_limit": 0})[0], 400)
        finally:
            call("PUT", "/api/admin/config", self.tok["admin"], {"max_advance_minutes": 120})

    # ---------- สมัครสมาชิก / รายงาน ----------
    def test_register_login_and_duplicates(self):
        body = {"name": "ทดสอบ", "email": "New@Parking.test", "password": "secret1", "plate": "9ทท 9999"}
        status, res = call("POST", "/api/auth/register", body=body)
        self.assertEqual(status, 201)
        self.assertEqual(self.me_by_token(res["token"])["member"]["email"], "new@parking.test")
        self.assertEqual(call("POST", "/api/auth/register", body=body)[0], 409)
        self.assertEqual(call("POST", "/api/auth/login",
                              body={"email": "new@parking.test", "password": "wrong"})[0], 401)

    def me_by_token(self, token):
        return call("GET", "/api/me", token)[1]

    def test_reports_shape(self):
        _, booked = self.reserve("demo1", 9, 5)
        self.advance(25)
        status, rep = call("GET", "/api/admin/reports", self.tok["admin"])
        self.assertEqual(status, 200)
        self.assertEqual(rep["monthly"][0]["no_show"], 1)
        self.assertEqual(rep["ratio"]["reserved"], 12)
        self.assertEqual(rep["topNoShow"][0]["no_shows"], 1)

    # ---------- การจัดการของผู้ดูแลระบบ (บังคับยกเลิก / บังคับออก) ----------
    def test_admin_force_cancel(self):
        status, res = self.reserve("demo1", 8, 30)
        self.assertEqual(status, 201)
        res_id = res["reservation_id"]
        self.assertEqual(self.slot_state(8)["state"], "BOOKED")

        # สมาชิกทั่วไปเรียกไม่ได้
        self.assertEqual(call("POST", f"/api/admin/reservations/{res_id}/cancel", self.tok["demo2"])[0], 403)

        # ผู้ดูแลระบบบังคับยกเลิก
        status, body = call("POST", f"/api/admin/reservations/{res_id}/cancel", self.tok["admin"])
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

        # ช่องจอดว่างทันที และสมาชิกไม่มีใบเหลือง
        self.assertEqual(self.slot_state(8)["state"], "FREE")
        self.assertEqual(self.me("demo1")["counts"]["yellow_active"], 0)

    def test_admin_force_exit_walkin_and_reservation(self):
        # 1. Walk-in เข้าจอด
        st, wi = call("POST", "/api/kiosk/walkin", body={"plate": "กข 1234"})
        self.assertEqual(st, 201)
        ticket = wi["ticket_code"]

        # ผู้ดูแลดู overview ต้องเห็นรถใน parked
        st, ov = call("GET", "/api/admin/overview", self.tok["admin"])
        self.assertEqual(st, 200)
        sess = next(s for s in ov["parked"] if s["ticket_code"] == ticket)

        # สมาชิกทั่วไปสั่งออกไม่ได้
        self.assertEqual(call("POST", f"/api/admin/sessions/{sess['session_id']}/exit", self.tok["demo1"])[0], 403)

        # ผู้ดูแลบังคับออกด้วย session_id
        st, out = call("POST", f"/api/admin/sessions/{sess['session_id']}/exit", self.tok["admin"])
        self.assertEqual(st, 200)
        self.assertTrue(out["ok"])

        # 2. จองแล้ว check-in จากนั้นผู้ดูแลบังคับออกด้วยรหัส
        _, res = self.reserve("demo1", 7, 10)
        call("POST", "/api/kiosk/checkin", body={"code": res["checkin_code"]})
        self.assertEqual(self.slot_state(7)["state"], "OCCUPIED")

        st, out2 = call("POST", "/api/admin/sessions/force-exit", self.tok["admin"], {"code": res["checkin_code"]})
        self.assertEqual(st, 200)
        self.assertTrue(out2["ok"])
        self.assertEqual(self.slot_state(7)["state"], "FREE")


if __name__ == "__main__":
    unittest.main()

