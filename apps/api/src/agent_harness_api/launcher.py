import json
import socket

import uvicorn

from agent_harness_api.config import get_settings
from agent_harness_api.main import app


def main() -> int:
    settings = get_settings()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((settings.host, settings.port))
    listener.listen(2048)
    port = listener.getsockname()[1]

    config = uvicorn.Config(app, host=settings.host, port=port, log_level="info")
    server = uvicorn.Server(config)
    app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
    print(json.dumps({"event": "listening", "host": settings.host, "port": port}), flush=True)
    server.run(sockets=[listener])
    return 0 if server.started else 1


if __name__ == "__main__":
    raise SystemExit(main())
