"""การเชื่อมต่อ PostgreSQL — ไฟล์เดียวที่ import psycopg

connect() ใช้เป็น context manager: ออกจากบล็อกปกติ = COMMIT, เกิด exception = ROLLBACK
(และปิดการเชื่อมต่อให้เสมอ) แถวผลลัพธ์เป็น dict
"""
import os
from contextlib import contextmanager

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

load_dotenv()


def database_url() -> str:
    return os.environ.get("DATABASE_URL", "postgresql://parking:parking@localhost:5432/parking")


def connect():
    return psycopg.connect(database_url(), row_factory=dict_row)


@contextmanager
def tx():
    """รันหลายคำสั่งใน transaction เดียว: สำเร็จ = COMMIT, error = ROLLBACK"""
    with connect() as conn:
        yield conn


def query(sql, params=None):
    """อ่านหลายแถว (เปิด-ปิดการเชื่อมต่อเอง)"""
    with connect() as conn:
        return conn.execute(sql, params).fetchall()


def query_one(sql, params=None):
    with connect() as conn:
        return conn.execute(sql, params).fetchone()


def execute(sql, params=None):
    """สั่งแก้ข้อมูลคำสั่งเดียว คืนจำนวนแถวที่ถูกแก้"""
    with connect() as conn:
        return conn.execute(sql, params).rowcount
