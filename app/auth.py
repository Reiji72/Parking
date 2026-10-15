"""สมัคร/ล็อกอินแบบง่าย: รหัสผ่านแฮชด้วย scrypt, token สุ่มเก็บในตาราง auth_token"""
import hashlib
import hmac
import secrets
from functools import wraps

from flask import g, request

from . import db
from .errors import AppError


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=2**14, r=8, p=1, dklen=64)
    return f"{salt}:{digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest = stored.split(":")
    except ValueError:
        return False
    test = hashlib.scrypt(password.encode(), salt=salt.encode(), n=2**14, r=8, p=1, dklen=64)
    return hmac.compare_digest(test.hex(), digest)


def issue_token(member_id: int) -> str:
    token = secrets.token_hex(24)
    db.execute("INSERT INTO auth_token (token, member_id) VALUES (%s, %s)", (token, member_id))
    return token


def _member_from_request():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    return db.query_one(
        """SELECT m.member_id, m.name, m.email, m.phone, m.role, m.status
             FROM auth_token t JOIN member m USING (member_id)
            WHERE t.token = %s""",
        (header[7:],),
    )


def optional_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.member = _member_from_request()
        return fn(*args, **kwargs)
    return wrapper


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.member = _member_from_request()
        if not g.member:
            raise AppError(401, "UNAUTHORIZED", "กรุณาเข้าสู่ระบบ")
        return fn(*args, **kwargs)
    return wrapper


def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.member = _member_from_request()
        if not g.member:
            raise AppError(401, "UNAUTHORIZED", "กรุณาเข้าสู่ระบบ")
        if g.member["role"] != "ADMIN":
            raise AppError(403, "FORBIDDEN", "เฉพาะผู้ดูแลระบบ")
        return fn(*args, **kwargs)
    return wrapper
