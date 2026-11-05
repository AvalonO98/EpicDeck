# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Synthetic keystrokes for Steam's built-in browser (X11 / XTest).

Epic's web login only redirects to URLs registered on the OAuth client
(``epicgames.com/id/api/redirect``), so a loopback callback is rejected and the
browser parks on a page whose *body* is the JSON holding the authorization
code. Reading that page normally means selecting text on a handheld — an
on-screen-keyboard chore. Instead the plugin presses Ctrl+A / Ctrl+C on whatever
Steam is showing; the code then sits on the X11 CLIPBOARD where
``py_modules.clipboard`` already reads it from.

Pressing keys into somebody's login form is only acceptable when they are not
typing, so ``ActivityWatch`` listens for XInput2 raw events and reports how long
the screen has been quiet. (gamescope's X server has no MIT-SCREEN-SAVER, so
the usual idle query is unavailable here; raw events are the only signal.)

Everything here is best-effort. If libXtst/libXi is missing or the display is
gone, callers fall back to asking the user for the code.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import threading
import time

# XInput2 event codes for raw (pre-grab) input, which is what tells us a human
# touched the machine. See the XI2 protocol spec, "Raw Events".
_RAW_EVENT_BITS = (13, 14, 15, 16, 17, 22, 23)
_XI_ALL_MASTER_DEVICES = 1


class _XIEventMask(ctypes.Structure):
    _fields_ = [
        ("deviceid", ctypes.c_int),
        ("mask_len", ctypes.c_int),
        ("mask", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _lib(name: str):
    return ctypes.CDLL(ctypes.util.find_library(name) or name)


def _open_display():
    """Open Steam's X server.

    ``plugin_loader`` is a systemd service and does not inherit the desktop
    session, so ``DISPLAY`` is usually unset here; in Game Mode the Steam UI
    always lives on ``:0``.
    """
    try:
        x11 = _lib("libX11.so.6")
    except OSError:
        return None, None
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    for candidate in (os.environ.get("DISPLAY"), ":0"):
        if not candidate:
            continue
        dpy = x11.XOpenDisplay(candidate.encode())
        if dpy:
            x11.XDefaultRootWindow.restype = ctypes.c_ulong
            x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
            return x11, dpy
    return x11, None


class ActivityWatch:
    """Track when the user last touched the machine, via XI2 raw events."""

    def __init__(self):
        self._dpy = None
        self._x11 = None
        self._thread = None
        self._stop = threading.Event()
        self._last = time.monotonic()

    def start(self) -> bool:
        """Begin watching. Returns False when the signal is unavailable."""
        self._x11, dpy = _open_display()
        if not dpy:
            return False
        try:
            xi = _lib("libXi.so.6")
            xi.XIQueryVersion.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_int),
                ctypes.POINTER(ctypes.c_int),
            ]
            xi.XISelectEvents.argtypes = [
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.POINTER(_XIEventMask),
                ctypes.c_int,
            ]
            major, minor = ctypes.c_int(2), ctypes.c_int(0)
            if xi.XIQueryVersion(dpy, ctypes.byref(major), ctypes.byref(minor)) != 0:
                return False
            if (major.value, minor.value) < (2, 0):
                return False

            mask_len = max(_RAW_EVENT_BITS) // 8 + 1
            bits = (ctypes.c_ubyte * mask_len)()
            for bit in _RAW_EVENT_BITS:
                bits[bit // 8] |= 1 << (bit % 8)
            mask = _XIEventMask(_XI_ALL_MASTER_DEVICES, mask_len, bits)
            if (
                xi.XISelectEvents(
                    dpy, self._x11.XDefaultRootWindow(dpy), ctypes.byref(mask), 1
                )
                != 0
            ):
                return False
        except (OSError, AttributeError):
            return False

        self._dpy = dpy
        self._stop.clear()
        self._last = time.monotonic()
        self._thread = threading.Thread(
            target=self._pump, daemon=True, name="epicdeck-activity"
        )
        self._thread.start()
        return True

    def _pump(self):
        x11 = self._x11
        x11.XPending.argtypes = [ctypes.c_void_p]
        x11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        # XEvent is a 192-byte union on 64-bit; we only need its type, but the
        # buffer must be at least that big or Xlib writes past it.
        event = (ctypes.c_long * 24)()
        while not self._stop.is_set():
            try:
                drained = 0
                while x11.XPending(self._dpy) and drained < 64:
                    x11.XNextEvent(self._dpy, ctypes.byref(event))
                    drained += 1
                if drained:
                    self._last = time.monotonic()
            except Exception:
                return
            time.sleep(0.12)

    def stop(self):
        self._stop.set()
        thread = self._thread
        self._thread = None
        if thread is not None:
            thread.join(timeout=1.0)
        if self._dpy is not None:
            try:
                self._x11.XCloseDisplay(self._dpy)
            except Exception:
                pass
            self._dpy = None

    def idle_seconds(self) -> float:
        return time.monotonic() - self._last

    def note_activity(self):
        """Pretend the user just acted (our own keystrokes count as activity)."""
        self._last = time.monotonic()



def _press_keys(keys, ctrl: bool = False) -> bool:
    """Send a synthetic key combination to the focused window via XTest."""
    x11, dpy = _open_display()
    if not dpy:
        return False
    try:
        try:
            xtst = _lib("libXtst.so.6")
        except OSError:
            return False
        xtst.XTestFakeKeyEvent.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.c_int,
            ctypes.c_ulong,
        ]
        xtst.XTestFakeKeyEvent.restype = ctypes.c_int
        x11.XStringToKeysym.restype = ctypes.c_ulong
        x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
        x11.XKeysymToKeycode.restype = ctypes.c_ubyte
        x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XFlush.argtypes = [ctypes.c_void_p]

        def keycode(name: str) -> int:
            return int(x11.XKeysymToKeycode(dpy, x11.XStringToKeysym(name.encode())))

        ctrl = keycode("Control_L") if ctrl else 0
        if ctrl and not ctrl:
            return False

        for name in keys:
            key = keycode(name)
            if not key:
                return False
            if ctrl:
                xtst.XTestFakeKeyEvent(dpy, ctrl, 1, 0)
            xtst.XTestFakeKeyEvent(dpy, key, 1, 0)
            x11.XFlush(dpy)
            time.sleep(0.08)
            xtst.XTestFakeKeyEvent(dpy, key, 0, 0)
            if ctrl:
                xtst.XTestFakeKeyEvent(dpy, ctrl, 0, 0)
            x11.XFlush(dpy)
            time.sleep(0.4)
        return True
    except (OSError, AttributeError):
        return False
    finally:
        x11.XCloseDisplay(dpy)


def select_all_and_copy() -> bool:
    """Send Ctrl+A then Ctrl+C to the focused window."""
    return _press_keys(("a", "c"), ctrl=True)


def press_esc() -> bool:
    """Press Escape — Steam's browser closes on it in Game Mode (like B).

    Used after a successful login so the user is not left staring at Epic's
    JSON redirect page: the browser dismisses itself and the plugin's UI (which
    already flipped to "signed in") is what they see next.
    """
    return _press_keys(("Escape",))
