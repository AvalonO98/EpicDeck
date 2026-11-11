"""Nudge the Deck's screensaver awake with one harmless XTest keypress.

Run this **on the Steam Deck** (not on the dev machine) before any CDP-driven
test. While the screensaver is up, Steam's CEF produces no frames and every
injected keypress is swallowed — the symptom looks exactly like "the plugin's
navigation is broken" (keys neither reach the page nor `__epicdeckNavLog`), and
it cost two false bug reports on 2026-11-11 alone.

Detection: evaluate `document.body.innerText` on the `Screensaver_uid2` page —
a non-empty clock means it is still up.

    ssh deck@<ip> 'python3 cdp_wake.py'

Sends Shift_L press+release through XTest: no window focus change, no click, no
input to the plugin — just enough real input for Steam to consider the user
present.
"""
import ctypes
import ctypes.util
import os
import sys
import time

os.environ.setdefault("DISPLAY", ":0")

x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
xtst = ctypes.CDLL(ctypes.util.find_library("Xtst") or "libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
dpy = x11.XOpenDisplay(None)
if not dpy:
    print("no display (is DISPLAY set?)", file=sys.stderr)
    sys.exit(1)

# Keycode 50 is Shift_L on every layout SteamOS ships; a wrong keycode is
# harmless anyway — any real key press wakes the screensaver.
CODE = 50
xtst.XTestFakeKeyEvent(ctypes.c_void_p(dpy), CODE, True, 0)
x11.XFlush(ctypes.c_void_p(dpy))
time.sleep(0.05)
xtst.XTestFakeKeyEvent(ctypes.c_void_p(dpy), CODE, False, 0)
x11.XFlush(ctypes.c_void_p(dpy))
time.sleep(0.2)
x11.XCloseDisplay(ctypes.c_void_p(dpy))
print("sent shift")
