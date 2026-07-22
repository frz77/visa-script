import base64
import json
import sys
import time

import cv2
import numpy as np
from paddleocr import TextRecognition


def emit(prefix, payload):
    print(f"{prefix} {json.dumps(payload, ensure_ascii=False)}", flush=True)


def preprocess(image_bytes):
    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Could not decode image")
    height, width = image.shape[:2]
    left, top = int(width * 0.16), int(height * 0.15)
    crop = image[top : top + int(height * 0.70), left : left + int(width * 0.70)]
    crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 120, 255, cv2.THRESH_BINARY)
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def payload_from_result(result):
    data = result.json
    if callable(data):
        data = data()
    return data.get("res", data)


def main():
    model = TextRecognition(model_name="PP-OCRv5_mobile_rec", device="cpu")
    emit("OCR_READY", {"model": "PP-OCRv5_mobile_rec"})

    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            started = time.perf_counter()
            image_bytes = base64.b64decode(request["image"], validate=True)
            output = model.predict(input=preprocess(image_bytes), batch_size=1)
            payload = payload_from_result(output[0])
            text = "".join(str(payload.get("rec_text", "")).split())
            emit("OCR_RESULT", {
                "id": request["id"],
                "text": text,
                "confidence": float(payload.get("rec_score", 0)),
                "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
            })
        except Exception as error:
            emit("OCR_RESULT", {"id": request.get("id") if "request" in locals() else None, "error": str(error)})


if __name__ == "__main__":
    main()
