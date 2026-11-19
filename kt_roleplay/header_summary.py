"""Select current-session public projections for the title-bar summary."""

MAX_HEADER_PINS = 8


def header_summary(view: dict[str, object], pinned: list[str]) -> dict[str, object]:
    candidates = {}
    panels = view.get("nativePanels", [])
    for panel in panels:
        if panel["type"] in ("meter", "inventory", "quest"):
            key = "panel:" + panel["id"]
            candidates[key] = {**panel, "id": key}
    for field in view.get("stateFields", []):
        key = "field:" + field["key"]
        candidates[key] = {**field, "id": key}
    for variable in (view.get("mvu") or {}).get("values", []):
        key = "mvu:" + variable["id"]
        candidates[key] = {**variable, "id": key, "type": "mvu"}
    return {"options": [{"id": item["id"], "label": item["label"], "type": item["type"]}
                        for item in candidates.values()],
            "pinned": [key for key in pinned if key in candidates],
            "items": [candidates[key] for key in pinned if key in candidates], "maxPins": MAX_HEADER_PINS}
