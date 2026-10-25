"""Durable database queue: atomic claims, leases, subprocess timeouts, bounded memory."""

import logging
import subprocess
import sys
import time
from sqlalchemy import delete, select, update
from .config import settings
from .db import DB, Cache, Job, Page, Project, Session, UsageEvent
from .storage import remove_project


def claim():
    with DB() as db:
        expired = db.scalars(
            select(Job).where(Job.status == "running", Job.lease_until < time.time())
        ).all()
        for job in expired:
            job.status = "queued" if job.attempts < 3 else "failed"
            page = db.get(Page, job.page_id)
            if page:
                page.status = job.status
                page.error = (
                    "Worker lease expired; retry limit reached."
                    if job.status == "failed"
                    else ""
                )
        db.commit()
        job_id = db.scalar(
            select(Job.id)
            .join(Page)
            .join(Project)
            .where(Job.status == "queued", Project.cancelled == False)
            .order_by(Job.created, Page.position)
            .limit(1)
        )
        if not job_id:
            return None
        result = db.execute(
            update(Job)
            .where(Job.id == job_id, Job.status == "queued")
            .values(
                status="running",
                lease_until=time.time() + settings.job_timeout + 60,
                attempts=Job.attempts + 1,
            )
        )
        db.commit()
        return job_id if result.rowcount else None


def cleanup():
    with DB() as db:
        active = (
            select(Page.project_id)
            .join(Job)
            .where(Job.status.in_(["queued", "running"]))
        )
        expired = db.scalars(
            select(Project).where(
                Project.created < time.time() - settings.retention_days * 86400,
                Project.id.not_in(active),
            )
        ).all()
        for project in expired:
            remove_project(project.id)
            db.delete(project)
        db.execute(
            delete(Cache).where(
                Cache.created < time.time() - settings.retention_days * 86400
            )
        )
        db.execute(delete(UsageEvent).where(UsageEvent.created < time.time() - 45 * 86400))
        db.execute(
            delete(Session).where(
                Session.created < time.time() - settings.session_days * 86400,
                Session.id.not_in(select(Project.owner)),
                Session.id.not_in(select(Cache.owner)),
                Session.id.not_in(select(UsageEvent.owner)),
            )
        )
        db.commit()


def main():
    logging.basicConfig(level=logging.INFO)
    last_cleanup = 0
    while True:
        if time.time() - last_cleanup > 3600:
            cleanup()
            last_cleanup = time.time()
        job_id = claim()
        if not job_id:
            time.sleep(1)
            continue
        try:
            result = subprocess.run(
                [sys.executable, "-m", "app.process", job_id],
                timeout=settings.job_timeout,
            )
            if result.returncode:
                raise RuntimeError("Worker subprocess exited unexpectedly.")
        except (subprocess.TimeoutExpired, RuntimeError) as exc:
            with DB() as db:
                job = db.get(Job, job_id)
                if job:
                    job.status = "failed"
                    job.error = type(exc).__name__
                    page = db.get(Page, job.page_id)
                    if page:
                        page.status = "failed"
                        page.error = (
                            "Processing timed out or worker exited; retry this page."
                        )
                    db.commit()


if __name__ == "__main__":
    main()
