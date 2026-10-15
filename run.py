"""เริ่มเซิร์ฟเวอร์:  python run.py  แล้วเปิด http://localhost:3000"""
import os

from dotenv import load_dotenv

load_dotenv()

from app import create_app, start_sweeper  # noqa: E402

app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    start_sweeper(float(os.environ.get("SWEEP_INTERVAL_SECONDS", "30")))
    print(f"ระบบจองโรงจอดรถ  →  http://localhost:{port}")
    print("ผู้ใช้ตัวอย่าง: admin@parking.test / admin1234   demo1@parking.test / demo1234")
    # threaded=True: รองรับหลายคำขอพร้อมกัน (เช่น walk-in หลายคัน)
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)
