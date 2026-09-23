from __future__ import annotations

import re
import time
from typing import Any

import httpx


class ModelRequestError(RuntimeError):
    """A provider failure safe to show in activity and save with a run."""


_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_CREDENTIAL_IN_ERROR = re.compile(r"(?i)(?:[?&]key=|x-goog-api-key|api-subscription-key|authorization:)")


def safe_stored_error(error: str) -> str:
    if _CREDENTIAL_IN_ERROR.search(error):
        status = re.search(r"\b([45]\d{2})\b", error)
        code = f" (HTTP {status.group(1)})" if status else ""
        return f"A previous model request failed{code}. Its details were hidden because they contained credentials."
    return error


def post_model_request(provider: str, url: str, **kwargs: Any) -> httpx.Response:
    deadline = time.monotonic() + float(kwargs.get("timeout", 60))
    for attempt in range(3):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ModelRequestError(f"{provider} did not respond in time. Please try again.")
        try:
            response = httpx.post(url, **{**kwargs, "timeout": remaining})
            response.raise_for_status()
            return response
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in _RETRYABLE_STATUS and attempt < 2:
                time.sleep(min(0.5 * (2**attempt), max(0, deadline - time.monotonic())))
                continue
            if status == 429:
                detail = "rate limited the request"
            elif status >= 500:
                detail = "is temporarily unavailable"
            elif status in {401, 403}:
                detail = "rejected the API key"
            else:
                detail = "rejected the request"
            raise ModelRequestError(f"{provider} {detail} (HTTP {status}). Please try again.") from None
        except httpx.RequestError:
            if attempt < 2:
                time.sleep(min(0.5 * (2**attempt), max(0, deadline - time.monotonic())))
                continue
            raise ModelRequestError(f"Could not connect to {provider}. Please try again.") from None

    raise AssertionError("The model request retry loop did not finish.")
