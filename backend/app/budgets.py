"""Serialize reservation checks across API and worker processes sharing a DB."""

from contextlib import contextmanager
from .db import BudgetLock


@contextmanager
def locked_budget(db, provider):
    # Persist pending stage work before acquiring the short quota write lock.
    db.commit()
    dialect = db.get_bind().dialect.name
    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    elif dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        raise ValueError("Hard API budgets require SQLite or PostgreSQL.")
    with db.begin():
        db.execute(insert(BudgetLock).values(provider=provider).on_conflict_do_update(
            index_elements=[BudgetLock.provider], set_={"provider": provider},
        ))
        yield
