# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Read the desktop clipboard.

Why this exists: Game Mode on SteamOS has no system browser and no
``wl-paste``/``xclip`` installed, so the only way to carry an Epic
authorization code from Steam's built-in browser into the plugin is to read
X11's CLIPBOARD selection ourselves. Steam runs as an XWayland client
(``DISPLAY=:0``), so the classic X11 selection protocol is what its CEF
browser writes to.

The implementation is deliberately dependency-free (ctypes + libX11) because
SteamOS is read-only and installing a package there survives neither a system
update nor a different user's machine. External helpers are still preferred
when present, since they handle edge cases (large payloads, INCR transfers)
we do not need for a 32-character code.
"""

import ctypes
import ctypes.util
import os
import shutil
import subprocess
import time

# XSelectionEvent.property sits at this offset in the 192-byte XEvent union
# (type 4 + pad 4, serial 8, send_event 4 + pad 4, display 8, requestor 8,
# selection 8, target 8, property 8, time 8).
_PROPERTY_OFFSET = 56
_SELECTION_NOTIFY = 31


class _X11:
    """Lazily loaded libX11 with the handful of calls we need."""

    def __init__(self):
        name = ctypes.util.find_library("X11") or "libX11.so.6"
        lib = ctypes.CDLL(name)

        lib.XOpenDisplay.restype = ctypes.c_void_p
        lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        lib.XDefaultRootWindow.restype = ctypes.c_ulong
        lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        lib.XCreateSimpleWindow.restype = ctypes.c_ulong
        lib.XCreateSimpleWindow.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
            ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong,
            ctypes.c_ulong,
        ]
        lib.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        lib.XInternAtom.restype = ctypes.c_ulong
        lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        lib.XConvertSelection.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
            ctypes.c_ulong, ctypes.c_ulong,
        ]
        lib.XPending.argtypes = [ctypes.c_void_p]
        lib.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        lib.XFlush.argtypes = [ctypes.c_void_p]
        lib.XFree.argtypes = [ctypes.c_void_p]
        lib.XGetWindowProperty.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long,
            ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
        ]
        self.lib = lib


_x11 = None


def _lib():
    global _x11
    if _x11 is None:
        _x11 = _X11()
    return _x11.lib


def _candidate_displays():
    """DISPLAY from the environment first, then the usual Game Mode value.

    plugin_loader runs as a systemd service and does not inherit the desktop
    session's environment, so DISPLAY is often unset even though Steam's own
    X server is right there on :0.
    """
    seen = []
    for value in (os.environ.get("DISPLAY"), ":0", ":1"):
        if value and value not in seen:
            seen.append(value)
    return seen


def _fetch(display, target_name: str, timeout: float) -> str:
    lib = _lib()
    dpy = lib.XOpenDisplay(display.encode())
    if not dpy:
        return ""
    win = 0
    try:
        root = lib.XDefaultRootWindow(dpy)
        win = lib.XCreateSimpleWindow(dpy, root, 0, 0, 1, 1, 0, 0, 0)
        clipboard = lib.XInternAtom(dpy, b"CLIPBOARD", False)
        target = lib.XInternAtom(dpy, target_name.encode(), False)
        prop = lib.XInternAtom(dpy, b"EPICDECK_CLIP", False)

        lib.XConvertSelection(dpy, clipboard, target, prop, win, 0)
        lib.XFlush(dpy)

        event = ctypes.create_string_buffer(192)
        deadline = time.time() + timeout
        got = False
        while time.time() < deadline:
            if lib.XPending(dpy):
                lib.XNextEvent(dpy, event)
                if ctypes.cast(event, ctypes.POINTER(ctypes.c_int))[0] == _SELECTION_NOTIFY:
                    got = True
                    break
            else:
                time.sleep(0.01)
        if not got:
            return ""

        prop_atom = ctypes.cast(
            ctypes.byref(event, _PROPERTY_OFFSET), ctypes.POINTER(ctypes.c_ulong)
        )[0]
        if not prop_atom:
            # Selection owner refused this target (or there is no owner).
            return ""

        actual_type = ctypes.c_ulong()
        actual_format = ctypes.c_int()
        nitems = ctypes.c_ulong()
        bytes_after = ctypes.c_ulong()
        data = ctypes.POINTER(ctypes.c_ubyte)()
        status = lib.XGetWindowProperty(
            dpy, win, prop, 0, 1 << 22, False, 0,
            ctypes.byref(actual_type), ctypes.byref(actual_format),
            ctypes.byref(nitems), ctypes.byref(bytes_after), ctypes.byref(data),
        )
        if status != 0 or not data:
            return ""
        try:
            if actual_format.value != 8 or not nitems.value:
                return ""
            raw = ctypes.string_at(data, nitems.value)
            return raw.decode("utf-8", errors="replace")
        finally:
            lib.XFree(data)
    finally:
        if win:
            lib.XDestroyWindow(dpy, win)
        lib.XCloseDisplay(dpy)


def _external_read() -> str:
    for cmd in (["wl-paste", "-n"], ["xclip", "-o", "-selection", "clipboard"], ["xsel", "-b"]):
        exe = shutil.which(cmd[0])
        if not exe:
            continue
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=3.0)
            if out.returncode == 0 and out.stdout:
                return out.stdout.decode("utf-8", errors="replace")
        except (OSError, subprocess.SubprocessError):
            continue
    return ""


def read_clipboard(timeout: float = 1.5) -> str:
    """Return the current clipboard text, or "" when unavailable/empty."""
    text = _external_read()
    if text:
        return text
    for display in _candidate_displays():
        for target in ("UTF8_STRING", "STRING", "TEXT"):
            try:
                text = _fetch(display, target, timeout)
            except (OSError, ctypes.ArgumentError):
                text = ""
            if text:
                return text
    return ""
