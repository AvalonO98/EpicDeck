#!/usr/bin/env python3
"""Evaluate a JS expression in Steam's SharedJSContext via CDP.

Usage: cdp_eval.py "<expression>"

Read-only probes only; the caller decides what to run.
"""

import base64
import json
import os
import socket
import struct
import sys
import urllib.request

CDP_LIST = "http://127.0.0.1:8080/json/list"


def find_page(want="SharedJSContext"):
    pages = json.load(urllib.request.urlopen(CDP_LIST, timeout=5))
    for page in pages:
        if want in (page.get("title") or ""):
            return page
    for page in pages:
        if "SharedJSContext" in (page.get("title") or ""):
            return page
    return pages[0] if pages else None


def connect(ws_url):
    rest = ws_url[len("ws://"):]
    hostport, _, path = rest.partition("/")
    host, _, port = hostport.partition(":")
    sock = socket.create_connection((host, int(port)), timeout=20)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((
        "GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)
    ).encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("handshake closed")
        buf += chunk
    head, _, tail = buf.partition(b"\r\n\r\n")
    if b"101" not in head.split(b"\r\n")[0]:
        raise RuntimeError("handshake rejected")
    return sock, tail


def send_text(sock, text):
    data = text.encode()
    size = len(data)
    header = bytearray([0x81])
    if size < 126:
        header.append(0x80 | size)
    elif size < 65536:
        header.append(0x80 | 126)
        header += struct.pack("!H", size)
    else:
        header.append(0x80 | 127)
        header += struct.pack("!Q", size)
    mask = os.urandom(4)
    header += mask
    sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def recv_text(sock, buf):
    while True:
        while len(buf) < 2:
            buf += sock.recv(65536)
        length = buf[1] & 0x7F
        offset = 2
        if length == 126:
            while len(buf) < 4:
                buf += sock.recv(65536)
            length = struct.unpack("!H", buf[2:4])[0]
            offset = 4
        elif length == 127:
            while len(buf) < 10:
                buf += sock.recv(65536)
            length = struct.unpack("!Q", buf[2:10])[0]
            offset = 10
        while len(buf) < offset + length:
            buf += sock.recv(65536)
        payload = buf[offset:offset + length]
        buf = buf[offset + length:]
        return payload.decode("utf-8", "replace"), buf


def main():
    if len(sys.argv) < 2:
        print("usage: cdp_eval.py <expression>")
        return 2
    page = find_page(sys.argv[2] if len(sys.argv) > 2 else "SharedJSContext")
    if page is None:
        print("NO_PAGE")
        return 1
    sock, tail = connect(page["webSocketDebuggerUrl"])
    send_text(sock, json.dumps({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {"expression": sys.argv[1], "awaitPromise": True, "returnByValue": True},
    }))
    buf = tail
    for _ in range(20):
        text, buf = recv_text(sock, buf)
        try:
            message = json.loads(text)
        except ValueError:
            continue
        if message.get("id") != 1:
            continue
        result = message.get("result", {})
        if "exceptionDetails" in result:
            print("EXCEPTION", json.dumps(result["exceptionDetails"])[:400])
            return 1
        print(json.dumps(result.get("result", {}).get("value"), ensure_ascii=False))
        return 0
    print("NO_RESPONSE")
    return 1


if __name__ == "__main__":
    sys.exit(main())
