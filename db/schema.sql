-- =====================================================================
--  ระบบจองโรงจอดรถ  |  PostgreSQL 14+ schema
--  รันซ้ำได้ (ลบตารางเดิมทิ้งก่อน) ใช้สำหรับพัฒนา/ทดสอบเท่านั้น
-- =====================================================================

DROP TABLE IF EXISTS auth_token      CASCADE;
DROP TABLE IF EXISTS penalty         CASCADE;
DROP TABLE IF EXISTS parking_session CASCADE;
DROP TABLE IF EXISTS reservation     CASCADE;
DROP TABLE IF EXISTS parking_slot    CASCADE;
DROP TABLE IF EXISTS zone            CASCADE;
DROP TABLE IF EXISTS vehicle         CASCADE;
DROP TABLE IF EXISTS member          CASCADE;
DROP TABLE IF EXISTS config_history  CASCADE;
DROP TABLE IF EXISTS system_config   CASCADE;
DROP FUNCTION IF EXISTS trg_reservation_validate() CASCADE;
DROP FUNCTION IF EXISTS app_now()    CASCADE;
DROP FUNCTION IF EXISTS cfg_int(text) CASCADE;

-- ---------------------------------------------------------------------
-- SystemConfig / ConfigHistory : ค่าที่ปรับได้ตามรายงานทุก 3 เดือน
-- ---------------------------------------------------------------------
CREATE TABLE system_config (
    config_key    text PRIMARY KEY,
    config_value  text        NOT NULL,
    description   text        NOT NULL DEFAULT '',
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    integer
);

CREATE TABLE config_history (
    id          bigserial PRIMARY KEY,
    config_key  text        NOT NULL,
    old_value   text,
    new_value   text        NOT NULL,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    changed_by  integer
);

-- อ่านค่า config เป็นจำนวนเต็ม (คืน NULL ถ้าไม่มี key)
CREATE FUNCTION cfg_int(k text) RETURNS integer
LANGUAGE sql STABLE AS $$
    SELECT config_value::integer FROM system_config WHERE config_key = k
$$;

-- "เวลาของระบบ" = เวลาจริง + ค่า clock_offset_minutes
-- ใช้ตัวนี้แทน now() ทุกที่ เพื่อให้หน้าจำลองเวลาเลื่อนนาฬิกาได้
-- (ตอนใช้งานจริงตั้ง clock_offset_minutes = 0 ฟังก์ชันนี้ก็เท่ากับ now())
CREATE FUNCTION app_now() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT now() + COALESCE(cfg_int('clock_offset_minutes'), 0) * interval '1 minute'
$$;

-- ---------------------------------------------------------------------
-- Member / Vehicle
-- ---------------------------------------------------------------------
CREATE TABLE member (
    member_id      serial PRIMARY KEY,
    name           text        NOT NULL,
    email          text        NOT NULL UNIQUE,
    phone          text,
    password_hash  text        NOT NULL,
    role           text        NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER', 'ADMIN')),
    status         text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicle (
    vehicle_id  serial PRIMARY KEY,
    member_id   integer NOT NULL REFERENCES member ON DELETE CASCADE,
    plate       text    NOT NULL UNIQUE
);

CREATE TABLE auth_token (
    token       text PRIMARY KEY,
    member_id   integer     NOT NULL REFERENCES member ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Zone / ParkingSlot  (โซนจอง 1/3  |  โซน walk-in 2/3)
-- ---------------------------------------------------------------------
CREATE TABLE zone (
    zone_id    serial PRIMARY KEY,
    name       text NOT NULL UNIQUE,
    zone_type  text NOT NULL CHECK (zone_type IN ('RESERVED', 'WALKIN'))
);

CREATE TABLE parking_slot (
    slot_id    serial PRIMARY KEY,
    zone_id    integer NOT NULL REFERENCES zone,
    label      text    NOT NULL UNIQUE,         -- เช่น A1, C4
    row_no     integer NOT NULL,                -- ใช้วาดผังแบบที่นั่งโรงหนัง
    col_no     integer NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    UNIQUE (zone_id, row_no, col_no)
);

-- ---------------------------------------------------------------------
-- Reservation
-- ---------------------------------------------------------------------
CREATE TABLE reservation (
    reservation_id  serial PRIMARY KEY,
    member_id       integer     NOT NULL REFERENCES member,
    vehicle_id      integer     NOT NULL REFERENCES vehicle,
    slot_id         integer     NOT NULL REFERENCES parking_slot,
    created_at      timestamptz NOT NULL DEFAULT app_now(),
    arrival_time    timestamptz NOT NULL,
    status          text        NOT NULL DEFAULT 'BOOKED'
                    CHECK (status IN ('BOOKED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
    cancelled_at    timestamptz,
    checkin_code    text        NOT NULL UNIQUE
);

-- 1 ช่อง มีการจองที่ยังไม่จบได้ครั้งละ 1 รายการ  (กันจองซ้อนที่ระดับฐานข้อมูล)
CREATE UNIQUE INDEX uq_active_reservation_per_slot
    ON reservation (slot_id) WHERE status IN ('BOOKED', 'CHECKED_IN');

-- 1 สมาชิก มีการจองที่ยังไม่จบได้ครั้งละ 1 รายการ
CREATE UNIQUE INDEX uq_active_reservation_per_member
    ON reservation (member_id) WHERE status IN ('BOOKED', 'CHECKED_IN');

CREATE INDEX ix_reservation_status_arrival ON reservation (status, arrival_time);

-- ตรวจเงื่อนไขตอนจอง (ค่าอ่านจาก system_config จึงปรับได้โดยไม่ต้องแก้โค้ด)
--   * บัญชีต้องไม่ถูกระงับ
--   * ช่องต้องอยู่ในโซนจอง และเปิดใช้งาน
--   * arrival_time ต้องไม่ก่อนนาทีที่กดจอง และไม่เกิน max_advance_minutes
--     (นับจากต้นนาทีที่กดจอง เช่น กด 10:11 จอง 12:11 ได้ 12:12 ไม่ได้)
CREATE FUNCTION trg_reservation_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    base      timestamptz := date_trunc('minute', NEW.created_at);
    max_adv   integer     := COALESCE(cfg_int('max_advance_minutes'), 120);
    m_status  text;
    z_type    text;
    s_active  boolean;
BEGIN
    SELECT status INTO m_status FROM member WHERE member_id = NEW.member_id;
    IF m_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'MEMBER_SUSPENDED' USING ERRCODE = 'P0001';
    END IF;

    SELECT z.zone_type, s.is_active INTO z_type, s_active
      FROM parking_slot s JOIN zone z USING (zone_id)
     WHERE s.slot_id = NEW.slot_id;
    IF z_type IS DISTINCT FROM 'RESERVED' OR NOT s_active THEN
        RAISE EXCEPTION 'SLOT_NOT_RESERVABLE' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.arrival_time < base THEN
        RAISE EXCEPTION 'ARRIVAL_PAST' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.arrival_time > base + max_adv * interval '1 minute' THEN
        RAISE EXCEPTION 'ARRIVAL_TOO_FAR' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER reservation_validate
    BEFORE INSERT ON reservation
    FOR EACH ROW EXECUTE FUNCTION trg_reservation_validate();

-- ---------------------------------------------------------------------
-- ParkingSession : การจอดจริง ใช้ร่วมกันทั้งสมาชิกและ walk-in
--   exit_time IS NULL = ยังจอดอยู่ (ไม่มีการนับเวลา ช่องว่างเมื่อยืนยันออกเท่านั้น)
-- ---------------------------------------------------------------------
CREATE TABLE parking_session (
    session_id      serial PRIMARY KEY,
    slot_id         integer     NOT NULL REFERENCES parking_slot,
    reservation_id  integer     UNIQUE REFERENCES reservation,   -- NULL = walk-in
    ticket_code     text        NOT NULL UNIQUE,
    plate           text,
    entry_time      timestamptz NOT NULL DEFAULT app_now(),
    exit_time       timestamptz,
    CHECK (exit_time IS NULL OR exit_time >= entry_time)
);

-- 1 ช่อง มีรถที่ยังไม่ออกได้ครั้งละ 1 คัน
CREATE UNIQUE INDEX uq_open_session_per_slot
    ON parking_session (slot_id) WHERE exit_time IS NULL;

-- ---------------------------------------------------------------------
-- Penalty : ประวัติใบเหลือง / no-show เป็นแถวๆ ตรวจย้อนหลังได้
--   YELLOW  ACTIVE     = ใบเหลืองที่ยังค้าง
--   YELLOW  CLEARED    = หายเพราะใช้บริการตามปกติ
--   YELLOW  CONVERTED  = ถูกรวมเป็น no-show 1 ครั้งแล้ว
--   NO_SHOW ACTIVE     = นับรวมเข้าเกณฑ์ระงับ
--   NO_SHOW CLEARED    = ผู้ดูแลปลดระงับแล้ว
-- ---------------------------------------------------------------------
CREATE TABLE penalty (
    penalty_id      serial PRIMARY KEY,
    member_id       integer     NOT NULL REFERENCES member,
    reservation_id  integer     REFERENCES reservation,
    type            text        NOT NULL CHECK (type IN ('YELLOW', 'NO_SHOW')),
    status          text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLEARED', 'CONVERTED')),
    created_at      timestamptz NOT NULL DEFAULT app_now(),
    resolved_at     timestamptz
);

CREATE INDEX ix_penalty_member ON penalty (member_id, type, status);
