import time
import uuid
from sqlalchemy import (
    JSON,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    event,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from .config import settings


def uid():
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created: Mapped[float] = mapped_column(Float, default=time.time)
    preferences: Mapped[dict] = mapped_column(JSON, default=dict)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("sessions.id"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    created: Mapped[float] = mapped_column(Float, default=time.time, index=True)
    source: Mapped[str] = mapped_column(String(2048), default="Upload")
    source_lang: Mapped[str] = mapped_column(String(16), default="auto")
    target_lang: Mapped[str] = mapped_column(String(16), default="en")
    style: Mapped[str] = mapped_column(String(16), default="natural")
    quality: Mapped[str] = mapped_column(String(16), default="quality")
    direction: Mapped[str] = mapped_column(String(8), default="rtl")
    provider: Mapped[str] = mapped_column(String(32), default="deepl")
    cancelled: Mapped[bool] = mapped_column(Boolean, default=False)
    last_page: Mapped[int] = mapped_column(Integer, default=0)


class Page(Base):
    __tablename__ = "pages"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(255))
    digest: Mapped[str] = mapped_column(String(64), index=True)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="imported")
    error: Mapped[str] = mapped_column(Text, default="")
    revision: Mapped[int] = mapped_column(Integer, default=0)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)


class Region(Base):
    __tablename__ = "regions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    page_id: Mapped[str] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    box: Mapped[list] = mapped_column(JSON)
    words: Mapped[list] = mapped_column(JSON, default=list)
    source_text: Mapped[str] = mapped_column(Text)
    translation: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[float] = mapped_column(Float)
    orientation: Mapped[str] = mapped_column(String(16), default="horizontal")
    kind: Mapped[str] = mapped_column(String(32), default="unclassified")
    render: Mapped[dict] = mapped_column(JSON, default=dict)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    restored: Mapped[bool] = mapped_column(Boolean, default=False)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    page_id: Mapped[str] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    kind: Mapped[str] = mapped_column(String(16), default="translate")
    created: Mapped[float] = mapped_column(Float, default=time.time)
    lease_until: Mapped[float] = mapped_column(Float, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")


class Glossary(Base):
    __tablename__ = "glossary"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    source: Mapped[str] = mapped_column(String(200))
    target: Mapped[str] = mapped_column(String(200))


Index(
    "uq_jobs_active_page",
    Job.page_id,
    unique=True,
    sqlite_where=Job.status.in_(["queued", "running"]),
    postgresql_where=Job.status.in_(["queued", "running"]),
)


class Edit(Base):
    __tablename__ = "edits"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    region_id: Mapped[str] = mapped_column(
        ForeignKey("regions.id", ondelete="CASCADE"), index=True
    )
    created: Mapped[float] = mapped_column(Float, default=time.time)
    before: Mapped[dict] = mapped_column(JSON)
    after: Mapped[dict] = mapped_column(JSON)


class Cache(Base):
    __tablename__ = "cache"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("sessions.id"), index=True)
    value: Mapped[dict] = mapped_column(JSON)
    created: Mapped[float] = mapped_column(Float, default=time.time)


class BudgetLock(Base):
    __tablename__ = "budget_locks"
    provider: Mapped[str] = mapped_column(String(32), primary_key=True)


class UsageEvent(Base):
    __tablename__ = "usage_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("sessions.id"), index=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))
    characters: Mapped[int] = mapped_column(Integer, default=0)
    created: Mapped[float] = mapped_column(Float, default=time.time, index=True)


class Feedback(Base):
    __tablename__ = "feedback"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    region_id: Mapped[str] = mapped_column(
        ForeignKey("regions.id", ondelete="CASCADE"), index=True
    )
    category: Mapped[str] = mapped_column(String(32))
    created: Mapped[float] = mapped_column(Float, default=time.time)


engine = create_engine(
    settings.database_url,
    **(
        {"connect_args": {"check_same_thread": False, "timeout": 30}}
        if settings.database_url.startswith("sqlite")
        else {"pool_pre_ping": True}
    )
)
if settings.database_url.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def sqlite_setup(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")


DB = sessionmaker(engine, expire_on_commit=False)
