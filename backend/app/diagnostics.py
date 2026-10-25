"""Small, persistent per-region processing ledger stored in Region.render."""

import time


def record(options, status, reason=""):
    stages = dict(options.get("stage_statuses", {}))
    for prefix, stage in (("OCR_", "ocr"), ("TRANSLATION_", "translation"),
                          ("MASK_", "mask"), ("INPAINTING_", "cleaning"),
                          ("RENDERING_", "rendering")):
        if status.startswith(prefix):
            stages[stage] = {"status": status, "reason": reason}
            break
    if status == "DETECTED":
        stages["detection"] = {"status": status, "reason": reason}
    options["stage_statuses"] = stages
    events = list(options.get("stage_history", []))
    if not events or (events[-1]["status"], events[-1].get("reason", "")) != (status, reason):
        events.append({"status": status, "reason": reason, "at": round(time.time(), 3)})
    options["stage_history"] = events[-40:]
    options["diagnostic_status"] = status
    options["failure_reason"] = reason
    return options
