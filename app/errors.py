class AppError(Exception):
    """ข้อผิดพลาดที่ตั้งใจให้ผู้ใช้เห็น (มี HTTP status, code และข้อความไทย)"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
