"""Exceptions raised by the Memnox client."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import Decision


class MemnoxError(Exception):
    """Base class for every error this client raises."""


class MemnoxApiError(MemnoxError):
    """A non-2xx response from the runtime."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class ActionBlockedError(MemnoxError):
    """Raised by guard() when the runtime blocks the action."""

    def __init__(self, decision: Decision) -> None:
        super().__init__(f"Action blocked by Memnox: {decision.reason}")
        self.decision = decision


class ApprovalRequiredError(MemnoxError):
    """Raised by guard() when the runtime requires a human approval first."""

    def __init__(self, decision: Decision) -> None:
        super().__init__(
            f"Action requires approval ({decision.approval_id}): {decision.reason}"
        )
        self.decision = decision
