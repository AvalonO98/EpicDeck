#!/usr/bin/env python3
"""Screenshot one Steam CEF target over CDP.

Usage: cdp_shot.py <out.png> [target-title-fragment]

Writes a PNG next to wherever you point it. Used to *look* at the plugin UI
from the PC side instead of asking the person holding the Deck to describe it.
"""

import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp_eval as C  # noqa: E402


def capture(page, out_path, clip=None):
    sock, buf = C.connect(page["webSocketDebuggerUrl"])
    try:
        C.send_text(sock, json.dumps({"id": 1, "method": "Page.enable"}))
        params = {"format": "png", "captureBeyondViewport": False}
        if clip:
            params["clip"] = clip
        C.send_text(sock, json.dumps({
            "id": 2,
            "method": "Page.captureScreenshot",
            "params": params,
        }))
        for _ in range(40):
            text, buf = C.recv_text(sock, buf)
            try:
                message = json.loads(text)
            except ValueError:
                continue
            if message.get("id") != 2:
                continue
            result = message.get("result", {})
            data = result.get("data")
            if not data:
                print("NO_DATA", json.dumps(result)[:300])
                return 1
            with open(out_path, "wb") as handle:
                handle.write(base64.b64decode(data))
            print("saved %s (%d bytes)" % (out_path, os.path.getsize(out_path)))
            return 0
    finally:
        try:
            sock.close()
        except OSError:
            pass
    print("NO_RESPONSE")
    return 1


def main():
    if len(sys.argv) < 2:
        print("usage: cdp_shot.py <out.png> [target] [x,y,w,h[,scale]]")
        return 2
    page = C.find_page(sys.argv[2] if len(sys.argv) > 2 else "QuickAccess")
    if page is None:
        print("NO_PAGE")
        return 1
    # Optional crop: a 2px ring on a 38x22 toggle is invisible in a 1080px-wide
    # shot, so allow zooming into a region instead of eyeballing the whole screen.
    # Coordinates are CSS pixels, the same space as getBoundingClientRect().
    clip = None
    if len(sys.argv) > 3:
        parts = [float(v) for v in sys.argv[3].split(",")]
        if len(parts) >= 4:
            clip = {"x": parts[0], "y": parts[1], "width": parts[2],
                    "height": parts[3], "scale": parts[4] if len(parts) > 4 else 3}
    print("target: %s" % (page.get("title") or "?"))
    return capture(page, sys.argv[1], clip)


if __name__ == "__main__":
    sys.exit(main())
