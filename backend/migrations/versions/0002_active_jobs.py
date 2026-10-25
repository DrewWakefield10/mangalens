"""Prevent duplicate paid processing when concurrent requests race."""

from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if "uq_jobs_active_page" not in {
        i["name"] for i in sa.inspect(bind).get_indexes("jobs")
    }:
        op.create_index(
            "uq_jobs_active_page",
            "jobs",
            ["page_id"],
            unique=True,
            postgresql_where=sa.text("status IN ('queued', 'running')"),
            sqlite_where=sa.text("status IN ('queued', 'running')"),
        )


def downgrade():
    op.drop_index("uq_jobs_active_page", table_name="jobs")
