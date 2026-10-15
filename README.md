# ระบบจองโรงจอดรถ (โปรเจกต์วิชาฐานข้อมูล)

Python (Flask + psycopg 3) + PostgreSQL + หน้าเว็บทดสอบ (vanilla JS ไม่ต้อง build)
จองที่จอดผ่านเว็บแบบเลือกช่องเหมือนที่นั่งโรงหนัง, walk-in รับช่องที่ kiosk โดยไม่ต้องสมัคร,
ใช้ **ใบเหลือง / no-show** คุมพฤติกรรม (ไม่มีระบบแต้มและการเติมเงิน)

## เริ่มใช้งานใน Antigravity IDE

ต้องมี Python 3.10+ และ PostgreSQL 14+

1. เปิดโฟลเดอร์นี้ (File → Open Folder) แล้วเปิด Terminal ในตัว IDE
2. เปิดฐานข้อมูล PostgreSQL อย่างใดอย่างหนึ่ง
   - ใช้ Docker: `docker compose up -d` (สร้าง user/db ชื่อ `parking` ให้เลย)
   - หรือใช้ PostgreSQL ที่ติดตั้งในเครื่อง แล้วสร้าง
     `CREATE USER parking WITH PASSWORD 'parking'; CREATE DATABASE parking OWNER parking;`
3. ติดตั้งและสร้างตาราง

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env             # Windows: copy .env.example .env   (แก้ DATABASE_URL ถ้าไม่ได้ใช้ค่าตามเดิม)
python -m app.setup_db           # สร้างตาราง + ข้อมูลตั้งต้น + ผู้ใช้ตัวอย่าง (ลบข้อมูลเดิมทั้งหมด)
python run.py                    # เปิด http://localhost:3000
```

บัญชีทดลอง: `demo1@parking.test` / `demo1234` · `demo2@parking.test` / `demo1234` · ผู้ดูแล `admin@parking.test` / `admin1234`
(หน้าล็อกอินมีปุ่มกรอกให้)

## ทดลองเล่นตามลำดับนี้

1. ล็อกอินเป็น demo1 → “ผังที่จอด” → แตะช่องสีเขียวในโซนจอง → เลื่อนเวลามาถึง (ได้ไม่เกิน 120 นาที) → ยืนยัน
2. “การจองของฉัน” จะเห็นรหัส `R…` → ไป “Kiosk จำลอง” → Check-in → ช่องกลายเป็น “มีรถ”
3. Kiosk → ยืนยันออกด้วยรหัสเดิม → ช่องว่างทันที (ไม่มีการนับเวลาจอด)
4. จองใหม่แล้วกดยกเลิกใกล้เวลา (น้อยกว่า 30 นาที) → ได้ใบเหลือง; ทำซ้ำ 2 ครั้ง = no-show 1 ครั้ง
5. ล็อกอินเป็น admin → “ตัวจำลองเวลา” → กด +30 นาที เพื่อให้การจองที่ไม่ check-in กลายเป็น no-show; ครบ 3 ครั้งบัญชีถูกระงับ → กด “ปลดระงับ” ได้ที่หน้าภาพรวม
6. Kiosk → “รับช่อง Walk-in” (ไม่ต้องล็อกอิน) ระบบสุ่มช่องในโซน walk-in ให้พร้อมรหัสตั๋ว `W…`

## กติกาและจุดที่บังคับในฐานข้อมูล

| กติกา | อยู่ที่ไหน |
| --- | --- |
| จองล่วงหน้าไม่เกิน 2 ชม. (กด 10:11 เลือกได้ถึง 12:11, 12:12 ไม่ได้) | trigger `reservation_validate` ใน `db/schema.sql` อ่านค่าจาก `system_config` |
| จองซ้อนช่องเดียวกันไม่ได้ / สมาชิกจองได้ครั้งละ 1 ช่อง | partial unique index `uq_active_reservation_per_slot`, `uq_active_reservation_per_member` |
| 1 ช่องมีรถจอดอยู่ได้คันเดียว | partial unique index `uq_open_session_per_slot` |
| โซนจอง 1/3 (12 ช่อง) : walk-in 2/3 (24 ช่อง); จองได้เฉพาะโซนจอง | `db/seed.sql` + trigger |
| ไม่นับเวลาจอด ช่องว่างเมื่อยืนยันออกเท่านั้น | `parking_session.exit_time IS NULL` = ยังจอดอยู่ (`app/rules.py` → `exit_by_code`) |
| ยกเลิกก่อนเวลามาถึง ≥ 30 นาที ไม่มีโทษ, น้อยกว่านั้น = ใบเหลือง | `cancel_reservation` |
| ใบเหลือง 2 ใบ = no-show 1 ครั้ง, ใช้บริการตามปกติใบเหลืองหาย | `evaluate_member`, `exit_by_code` |
| ไม่ check-in ภายใน grace (15 นาที) = no-show; no-show ครบ 3 = ระงับ | `sweep_no_shows` (ตัวเบื้องหลังรันทุก 30 วินาที) |
| walk-in หลายคันพร้อมกันได้คนละช่อง | `FOR UPDATE SKIP LOCKED` ใน `walk_in` |
| ปรับกติกาตามรายงานทุก 3 เดือน | หน้า admin: ค่าตั้งระบบ (บันทึก `config_history`) + รายงาน 3 เดือน |

ตัวเลขทั้งหมด (120 / 30 / 15 / 2 / 3) อยู่ในตาราง `system_config` ไม่ได้ฝังในโค้ด

## โครงสร้างโปรเจกต์

```
db/schema.sql       ตาราง, index, trigger, ฟังก์ชัน app_now()
db/seed.sql         ค่า config, โซน, ช่องจอด
app/db.py           การเชื่อมต่อ PostgreSQL (ไฟล์เดียวที่ import psycopg)
app/rules.py        กติกาทั้งหมด (จอง ยกเลิก check-in ออก walk-in no-show)
app/routes.py       เส้นทาง API (สมาชิก / kiosk / admin)
app/auth.py         สมัคร/ล็อกอิน (scrypt + token)
app/setup_db.py     สร้างฐานข้อมูลใหม่ + ผู้ใช้ตัวอย่าง
run.py              เริ่มเซิร์ฟเวอร์ + ตัวตรวจ no-show เบื้องหลัง
web/                หน้าเว็บทดสอบ (index.html, style.css, app.js)
tests/test_api.py   ทดสอบ API กับ PostgreSQL จริง (14 กรณี)
js/store.js, test/rules.test.js   ต้นแบบฝั่งเบราว์เซอร์แบบ localStorage (มีอยู่เดิม ไม่ได้แก้ ต้องใช้ Node ถึงจะรันเทสต์นี้)
```

## ทดสอบ

```bash
python -m unittest discover -s tests -v
```

คำเตือน: ชุดทดสอบนี้รัน `db/schema.sql` ซึ่งลบข้อมูลเดิมทั้งหมด ควรชี้ `DATABASE_URL` ไปที่ฐานข้อมูลสำหรับทดสอบ เช่น
`DATABASE_URL=postgresql://parking:parking@localhost:5432/parking_test python -m unittest discover -s tests -v`
(ต้องสร้างฐานข้อมูล `parking_test` ก่อน)

## ข้อจำกัด (เป็นโปรเจกต์ทดสอบ ไม่ใช่ระบบจริง)

- การล็อกอินเป็น token แบบง่ายเก็บในตาราง `auth_token` ไม่มีหมดอายุ ไม่มี HTTPS
- Kiosk เปิดให้ใครก็เรียกได้ เพราะใช้จำลองเครื่องหน้าลาน (ของจริงต้องจำกัดเฉพาะอุปกรณ์ของลานจอด)
- ตัวจำลองเวลา (`clock_offset_minutes`) ใช้ทดสอบเท่านั้น ตั้ง `ALLOW_TIME_TRAVEL=false` ใน `.env` เมื่อไม่ต้องการ
- เปิดการเชื่อมต่อฐานข้อมูลใหม่ทุกคำขอ (ไม่ใช้ connection pool) เพื่อให้โค้ดอ่านง่าย พอสำหรับงานทดสอบ
- `run.py` ใช้เซิร์ฟเวอร์พัฒนาของ Flask; ถ้าจะใช้งานจริงให้รันผ่าน gunicorn/waitress
- เมื่อแก้ค่า `reserved_ratio_pct` จะไม่สร้างช่องใหม่ให้ (ใช้แสดงผล/ตรวจรายงาน) สัดส่วนจริงกำหนดที่ `db/seed.sql`
