"""Record API use and enforce local monthly budgets."""

from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "usage_events",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("owner", sa.String(length=64), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("characters", sa.Integer(), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
    )
    op.create_index("ix_usage_events_owner", "usage_events", ["owner"])
    op.create_index("ix_usage_events_provider", "usage_events", ["provider"])
    op.create_index("ix_usage_events_created", "usage_events", ["created"])


def downgrade():
    op.drop_index("ix_usage_events_created", table_name="usage_events")
    op.drop_index("ix_usage_events_provider", table_name="usage_events")
    op.drop_index("ix_usage_events_owner", table_name="usage_events")
    op.drop_table("usage_events")
