import json
import time
from pathlib import Path

import cv2
import numpy as np
from paddleocr import TextRecognition


ROOT = Path(__file__).resolve().parent
DATASET = ROOT / "captcha-dataset"


def load_samples():
    samples = []
    for line in (DATASET / "answers.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        image_path = DATASET / row.get("image", "")
        if row.get("actual") and image_path.is_file():
            samples.append((image_path, row["actual"]))
    return samples


def variants(image):
    height, width = image.shape[:2]
    left, top = int(width * 0.16), int(height * 0.15)
    crop = image[top : top + int(height * 0.70), left : left + int(width * 0.70)]
    crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
    yield "original", image
    yield "crop", crop
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    for threshold in (80, 100, 120, 140, 160, 180):
        _, binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
        yield f"threshold-{threshold}", cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def result_payload(result):
    data = result.json
    if callable(data):
        data = data()
    return data.get("res", data)


def main():
    samples = load_samples()
    started = time.perf_counter()
    model = TextRecognition(model_name="PP-OCRv5_mobile_rec", device="cpu")
    load_ms = round((time.perf_counter() - started) * 1000)
    rows = []
    for image_path, actual in samples:
        image = cv2.imread(str(image_path))
        for variant, prepared in variants(image):
            tick = time.perf_counter()
            output = model.predict(input=prepared, batch_size=1)
            payload = result_payload(output[0])
            text = str(payload.get("rec_text", "")).replace(" ", "").strip()
            rows.append({
                "image": image_path.name,
                "actual": actual,
                "variant": variant,
                "text": text,
                "correct": text == actual,
                "score": round(float(payload.get("rec_score", 0)), 4),
                "ms": round((time.perf_counter() - tick) * 1000, 1),
            })

    summaries = []
    for variant in dict.fromkeys(row["variant"] for row in rows):
        group = [row for row in rows if row["variant"] == variant]
        summaries.append({
            "variant": variant,
            "exact": sum(row["correct"] for row in group),
            "total": len(group),
            "valid_length": sum(len(row["text"]) == len(row["actual"]) for row in group),
            "average_score": round(sum(row["score"] for row in group) / len(group), 4),
            "average_ms": round(sum(row["ms"] for row in group) / len(group), 1),
        })
    summaries.sort(key=lambda row: (row["exact"], row["valid_length"], row["average_score"]), reverse=True)
    best = summaries[0]
    print(json.dumps({
        "model_load_ms": load_ms,
        "best": best,
        "summaries": summaries,
        "details": [row for row in rows if row["variant"] == best["variant"]],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
