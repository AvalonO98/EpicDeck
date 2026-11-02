# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Epic Games Device Code (OAuth 2.0 Device Authorization Grant) flow.

Implements the "sign in from a device with a code shown on screen" flow so
users can authenticate from Steam Gaming Mode without a browser window:

  1. Request a device_code + user_code + verification_uri from Epic.
  2. Show the user_code + URL in the UI (user opens it on their phone/PC).
  3. Poll the token endpoint until the user approves.
  4. On approval, hand the resulting authorization code to Legendary via
     `legendary auth --code <code>` so Legendary stores the session.

Key endpoints (from EpicResearch / community docs):
  - deviceAuthorization:
      https://account-public-service-prod.ol.epicgames.com/account/api/oauth/deviceAuthorization
  - activate URL (user-facing):
      https://epicgames.com/id/activate
  - token (grant_type=device_code):
      https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token

The launcher client id below is a well-known public Epic Games Launcher
client id used by open-source projects (Legendary, Heroic, etc.).
"""

import asyncio
import base64
import time

DEVICE_AUTH_URL = (
    "https://account-public-service-prod.ol.epicgames.com"
    "/account/api/oauth/deviceAuthorization"
)
TOKEN_URL = (
    "https://account-public-service-prod.ol.epicgames.com"
    "/account/api/oauth/token"
)
ACTIVATE_URL = "https://epicgames.com/id/activate"

# Public Epic Games client used for device code authorization. This is the
# Fortnite Switch game client ("fortniteNewSwitchGameClient"), a well-known
# public client that supports the device_code grant (used by console login
# flows). Confirmed working by epicgames-freegames-node and EpicResearch.
# NOTE ON PRIVACY / OPEN-SOURCE:
# The two values below are Epic's PUBLIC client credentials for the Fortnite
# Nintendo Switch game client ("fortniteNewSwitchGameClient"). They are NOT
# personal secrets — they are reverse-engineered public constants that appear
# in many open-source projects (EpicResearch, epicgames-freegames-node,
# Legendary, Heroic, etc.) and are required for Epic's device_code OAuth
# grant. They do not grant access to any user account.
DEVICE_CLIENT_ID = "98f7e42c2e3a4f86a74eb43fbb41ed39"
DEVICE_CLIENT_SECRET = "0a2449a2-001a-451e-afec-3e812901c4d7"


class EpicOAuthError(Exception):
    pass


class DeviceCodeFlow:
    def __init__(self):
        self._client = None
        self._poll_task = None
        self._authorization_code = None

    @property
    def client(self):
        if self._client is None:
            import urllib.request
            # Use a simple opener; aiohttp may not be installed on the deck.
            self._client = urllib.request
        return self._client

    @staticmethod
    def _basic_auth_header(client_id: str, client_secret: str) -> str:
        raw = f"{client_id}:{client_secret}".encode("utf-8")
        return "Basic " + base64.b64encode(raw).decode("ascii")

    @staticmethod
    def _post(url: str, headers: dict, body: str):
        import urllib.request
        import urllib.error
        import json

        req = urllib.request.Request(url, data=body.encode("utf-8"), method="POST")
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8")
            except Exception:
                detail = str(e)
            raise EpicOAuthError(f"HTTP {e.code}: {detail[:300]}")

    def _get_client_credentials_token(self) -> str:
        """Obtain a client_credentials access token for the device client."""
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        body = "grant_type=client_credentials"
        data = self._post(
            TOKEN_URL,
            {
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": self._basic_auth_header(
                    DEVICE_CLIENT_ID, DEVICE_CLIENT_SECRET
                ),
            },
            body,
        )
        token = data.get("access_token")
        if not token:
            raise EpicOAuthError("无法获取 client_credentials token: %s" % data)
        return token

    def start_device_code(self):
        """Request a device code. Returns dict with user_code, verification_uri, etc.

        Note: this endpoint requires a client_credentials Bearer token, NOT
        basic auth directly (that was the original 401 cause).
        """
        cc_token = self._get_client_credentials_token()

        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Bearer {cc_token}",
        }
        body = "prompt=login"
        data = self._post(DEVICE_AUTH_URL, headers, body)

        if "device_code" not in data:
            raise EpicOAuthError("未获取到 device_code: %s" % data)

        return {
            "device_code": data["device_code"],
            "user_code": data.get("user_code", ""),
            "verification_uri": data.get("verification_uri", ACTIVATE_URL),
            "verification_uri_complete": data.get("verification_uri_complete", ""),
            "expires_in": data.get("expires_in", 600),
            "interval": data.get("interval", 5),
        }

    def poll_token(self, device_code: str):
        """Poll the token endpoint once (Basic auth). Returns access_token on success.

        Note: Epic returns HTTP 400 with a JSON body for pending/denied/expired
        states, so we must read the body even on non-200 responses.
        """
        import urllib.request
        import urllib.error
        import json

        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": self._basic_auth_header(
                DEVICE_CLIENT_ID, DEVICE_CLIENT_SECRET
            ),
        }
        body = f"grant_type=device_code&device_code={device_code}"
        req = urllib.request.Request(TOKEN_URL, data=body.encode("utf-8"), method="POST")
        for k, v in headers.items():
            req.add_header(k, v)

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 400 with a JSON body carries the pending/denied/expired state.
            try:
                data = json.loads(e.read().decode("utf-8"))
            except Exception:
                raise EpicOAuthError(f"poll HTTP {e.code}: {e}")
            data = data or {}
            err = data.get("error") or data.get("errorCode", "")
            if err in ("authorization_pending", "slow_down"):
                return {"pending": True}
            if err == "access_denied":
                raise EpicOAuthError("用户拒绝了授权")
            if err in ("expired_token", "expired"):
                raise EpicOAuthError("授权码已过期,请重新发起登录")
            # 18115 = authorization_pending numeric code
            if data.get("numericErrorCode") == 18115:
                return {"pending": True}
            raise EpicOAuthError(
                "device code 错误: %s" % (data.get("errorMessage") or err or data)
            )

        if "error" in data:
            err = data["error"]
            if err in ("authorization_pending", "slow_down"):
                return {"pending": True}
            if err == "access_denied":
                raise EpicOAuthError("用户拒绝了授权")
            if err == "expired_token":
                raise EpicOAuthError("授权码已过期,请重新发起登录")
            raise EpicOAuthError("device code 错误: %s" % err)

        if "access_token" in data:
            return {
                "pending": False,
                "access_token": data.get("access_token", ""),
                "account_id": data.get("account_id", ""),
                "display_name": data.get("displayName", ""),
                "refresh_token": data.get("refresh_token", ""),
                "code": data.get("code", ""),
            }

        raise EpicOAuthError("未知响应: %s" % data)

    def exchange_for_code(self, access_token: str) -> str:
        """Exchange an access_token for an authorization code (for Legendary)."""
        import urllib.request
        import urllib.error
        import json

        url = (
            "https://account-public-service-prod.ol.epicgames.com"
            "/account/api/oauth/exchange"
        )
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise EpicOAuthError(f"exchange HTTP {e.code}: {detail[:200]}")
        code = data.get("code")
        if not code:
            raise EpicOAuthError("exchange 未返回 code: %s" % data)
        return code


async def run_device_code_poll(flow: DeviceCodeFlow, device_code: str,
                               on_pending, on_success, on_error,
                               poll_interval: float = 5.0,
                               max_wait: float = 600.0):
    """Async wrapper: poll in a thread until approved/denied/expired.

    Callbacks:
      on_pending()          - called each poll while still pending
      on_success(result)    - called with the token result dict
      on_error(exc)         - called with an EpicOAuthError
    """
    start = time.time()

    def _poll():
        return flow.poll_token(device_code)

    loop = asyncio.get_event_loop()
    while True:
        if time.time() - start > max_wait:
            on_error(EpicOAuthError("等待授权超时"))
            return
        try:
            result = await loop.run_in_executor(None, _poll)
        except EpicOAuthError as e:
            on_error(e)
            return
        if result.get("pending"):
            on_pending()
            await asyncio.sleep(poll_interval)
            continue
        on_success(result)
        return
