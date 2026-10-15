"""ระบบจองโรงจอดรถ — Flask app factory"""
import datetime
import decimal
import os
import threading
import time

from flask import Flask, jsonify, send_from_directory
from flask.json.provider import DefaultJSONProvider

from . import rules
from .errors import AppError
from .routes import api

WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "web")


class JSONProvider(DefaultJSONProvider):
    """วันที่ส่งเป็น ISO 8601 (หน้าเว็บอ่านด้วย Date.parse) และ Decimal เป็นตัวเลข"""

    @staticmethod
    def default(o):
        if isinstance(o, (datetime.datetime, datetime.date)):
            return o.isoformat()
        if isinstance(o, decimal.Decimal):
            return float(o)
        return DefaultJSONProvider.default(o)


def create_app() -> Flask:
    app = Flask(__name__, static_folder=WEB_DIR, static_url_path="")
    app.json = JSONProvider(app)
    app.json.ensure_ascii = False
    app.register_blueprint(api)

    @app.get("/")
    def index():
        return send_from_directory(WEB_DIR, "index.html")

    @app.errorhandler(AppError)
    def handle_app_error(e: AppError):
        return jsonify({"error": e.message, "code": e.code}), e.status

    @app.errorhandler(404)
    def handle_404(_e):
        from flask import request
        if request.path.startswith("/api"):
            return jsonify({"error": "ไม่พบ API นี้", "code": "NOT_FOUND"}), 404
        return "Not Found", 404

    @app.errorhandler(Exception)
    def handle_unexpected(e):
        from werkzeug.exceptions import HTTPException
        if isinstance(e, HTTPException):
            return e
        app.logger.exception("unhandled error")
        return jsonify({"error": "เกิดข้อผิดพลาดในระบบ", "code": "INTERNAL"}), 500

    return app


def start_sweeper(interval_seconds: float) -> None:
    """ตัวทำงานเบื้องหลัง: ตรวจการจองที่เลยเวลา + grace แล้วไม่ check-in -> no-show"""
    def loop():
        while True:
            time.sleep(interval_seconds)
            try:
                done = rules.sweep_no_shows()
                if done:
                    print(f"[sweep] no-show: {done}", flush=True)
            except Exception as exc:  # noqa: BLE001 — ตัวเบื้องหลังต้องไม่ตาย
                print(f"[sweep] error: {exc}", flush=True)

    threading.Thread(target=loop, daemon=True, name="no-show-sweeper").start()
