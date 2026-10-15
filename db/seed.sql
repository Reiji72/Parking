-- =====================================================================
--  ข้อมูลตั้งต้น: ค่า config, โซน/ช่องจอด (จอง 12 = 1/3, walk-in 24 = 2/3)
--  ผู้ใช้ตัวอย่างสร้างโดย server/seed-users.js (ต้องแฮชรหัสผ่านด้วย Node)
-- =====================================================================

INSERT INTO system_config (config_key, config_value, description) VALUES
  ('max_advance_minutes', '120',  'จองล่วงหน้าได้ไม่เกินกี่นาที (นับจากนาทีที่กดจอง)'),
  ('free_cancel_minutes', '30',   'ยกเลิกก่อนเวลามาถึงเท่านี้ขึ้นไป = ไม่มีโทษ'),
  ('grace_minutes',       '15',   'รอ check-in หลังเวลามาถึงกี่นาที ก่อนนับเป็น no-show'),
  ('yellow_per_noshow',   '2',    'ใบเหลืองกี่ใบเท่ากับ no-show 1 ครั้ง'),
  ('noshow_limit',        '3',    'no-show กี่ครั้งถึงถูกระงับบัญชี'),
  ('reserved_ratio_pct',  '33',   'สัดส่วนช่องโซนจอง (เปอร์เซ็นต์) — ใช้แสดงผล/ตรวจรายงาน ไม่ได้สร้างช่องอัตโนมัติ'),
  ('clock_offset_minutes','0',    'ตัวจำลองเวลา: เลื่อนนาฬิการะบบไปข้างหน้ากี่นาที (ใช้งานจริงต้องเป็น 0)');

INSERT INTO zone (name, zone_type) VALUES
  ('โซนจอง',     'RESERVED'),
  ('โซน Walk-in', 'WALKIN');

-- โซนจอง: แถว A-B x 6 ช่อง = 12 ช่อง
INSERT INTO parking_slot (zone_id, label, row_no, col_no)
SELECT (SELECT zone_id FROM zone WHERE zone_type = 'RESERVED'),
       chr(64 + r) || c, r, c
  FROM generate_series(1, 2) r, generate_series(1, 6) c;

-- โซน walk-in: แถว C-F x 6 ช่อง = 24 ช่อง
INSERT INTO parking_slot (zone_id, label, row_no, col_no)
SELECT (SELECT zone_id FROM zone WHERE zone_type = 'WALKIN'),
       chr(64 + r) || c, r, c
  FROM generate_series(3, 6) r, generate_series(1, 6) c;
