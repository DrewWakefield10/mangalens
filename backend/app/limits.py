import tempfile
from starlette.responses import JSONResponse


class BodyLimitMiddleware:
    """Bound chunked and multipart bodies before Starlette parses them."""

    def __init__(self, app, max_bytes):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as body:
            total = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                total += len(chunk)
                if total > self.max_bytes:
                    return await JSONResponse(
                        {"detail": "Request exceeds upload size limit."},
                        status_code=413,
                    )(scope, receive, send)
                body.write(chunk)
                if not message.get("more_body", False):
                    break
            body.seek(0)
            remaining = total

            async def replay():
                nonlocal remaining
                chunk = body.read(65536)
                remaining -= len(chunk)
                return {
                    "type": "http.request",
                    "body": chunk,
                    "more_body": remaining > 0,
                }

            await self.app(scope, replay, send)
