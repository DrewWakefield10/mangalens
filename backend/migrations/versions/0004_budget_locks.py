"""Serialize API budget reservations across workers."""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("budget_locks", sa.Column("provider", sa.String(32), primary_key=True))


def downgrade():
    op.drop_table("budget_locks")
