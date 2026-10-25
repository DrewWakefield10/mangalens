"""Run API, durable worker and Next.js together. Ctrl+C stops owned processes."""

import os
import argparse
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--smoke-seconds",
        type=int,
        default=0,
        help="Stop after a bounded verification run; normally omitted.",
    )
    args = parser.parse_args()
    for port in (3000, 8000):
        with socket.socket() as connection:
            connection.settimeout(0.5)
            if connection.connect_ex(("127.0.0.1", port)) == 0:
                raise SystemExit(
                    f"Port {port} is already in use. Stop the existing service or use the MangaLens instance already running."
                )
    subprocess.run(
        [
            sys.executable,
            "-m",
            "alembic",
            "-c",
            str(ROOT / "backend/alembic.ini"),
            "upgrade",
            "head",
        ],
        cwd=ROOT,
        check=True,
    )
    npm = "npm.cmd" if os.name == "nt" else "npm"
    commands = [
        (
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                "8000",
            ],
            ROOT / "backend",
        ),
        ([sys.executable, "-m", "app.worker"], ROOT / "backend"),
        ([npm, "run", "dev"], ROOT / "frontend"),
    ]
    processes = []
    try:
        for command, cwd in commands:
            processes.append(
                subprocess.Popen(
                    command,
                    cwd=cwd,
                    creationflags=(
                        subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
                    ),
                    start_new_session=os.name != "nt",
                )
            )
        print(
            "\nMangaLens: http://localhost:3000\nAPI documentation: http://localhost:8000/docs\nCtrl+C to stop all services.\n",
            flush=True,
        )
        started = time.monotonic()
        while True:
            if args.smoke_seconds and time.monotonic() - started >= args.smoke_seconds:
                break
            for process in processes:
                if process.poll() is not None:
                    raise RuntimeError("A service stopped; inspect its logs above.")
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is not None:
                continue
            if os.name == "nt":
                subprocess.run(
                    [
                        str(
                            Path(os.environ.get("SystemRoot", "C:/Windows"))
                            / "System32/taskkill.exe"
                        ),
                        "/PID",
                        str(process.pid),
                        "/T",
                        "/F",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                os.killpg(process.pid, signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    main()
