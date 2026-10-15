"""สร้างตารางใหม่ทั้งหมด + ข้อมูลตั้งต้น + ผู้ใช้ตัวอย่าง

    python -m app.setup_db

คำเตือน: ลบข้อมูลเดิมในตารางของระบบนี้ทั้งหมด
"""
import os

from . import auth, db

ROOT = os.path.join(os.path.dirname(__file__), "..")

USERS = [
    ("ผู้ดูแลระบบ", "admin@parking.test", "admin1234", "ADMIN", None),
    ("สมชาย ทดสอบ", "demo1@parking.test", "demo1234", "MEMBER", "1กก 1234"),
    ("สมหญิง ตัวอย่าง", "demo2@parking.test", "demo1234", "MEMBER", "2ขข 5678"),
]


def setup() -> None:
    with db.tx() as c:
        for name in ("schema.sql", "seed.sql"):
            with open(os.path.join(ROOT, "db", name), encoding="utf-8") as f:
                c.execute(f.read())
        for display, email, password, role, plate in USERS:
            member_id = c.execute(
                "INSERT INTO member (name, email, password_hash, role) VALUES (%s, %s, %s, %s) RETURNING member_id",
                (display, email, auth.hash_password(password), role)).fetchone()["member_id"]
            if plate:
                c.execute("INSERT INTO vehicle (member_id, plate) VALUES (%s, %s)", (member_id, plate))


if __name__ == "__main__":
    setup()
    print("สร้างฐานข้อมูลเรียบร้อย  ผู้ใช้: admin@parking.test / admin1234, "
          "demo1@parking.test / demo1234, demo2@parking.test / demo1234")
