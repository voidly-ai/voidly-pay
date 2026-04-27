"""voidly_pay_crewai — CrewAI tool wrappers over the Voidly Pay SDK."""

from typing import Any, List

from .tools import (
    VoidlyPayConfig,
    VoidlyPaySearchTool,
    VoidlyPayHireTool,
    VoidlyPayWalletTool,
)


def voidly_pay_tools(config: "VoidlyPayConfig | None" = None, **kwargs: Any) -> List[Any]:
    """Return every CrewAI tool wired to a single VoidlyPay client.

    Pass a ``VoidlyPayConfig`` (or kwargs that build one) to bring your own
    DID + secret. With no arguments, the SDK lazily mints a keypair on the
    first call and persists it to ``~/.voidly-pay/keypair.json``.

    Example::

        from voidly_pay_crewai import voidly_pay_tools, VoidlyPayConfig

        cfg = VoidlyPayConfig(did="did:voidly:...", secret_base64="...")
        tools = voidly_pay_tools(cfg)
        # → [VoidlyPaySearchTool, VoidlyPayHireTool, VoidlyPayWalletTool]
    """
    if config is None:
        if kwargs:
            config = VoidlyPayConfig(**kwargs)
        else:
            # Lazy: SDK mints + persists a keypair on first call.
            from voidly_pay import VoidlyPay  # type: ignore

            pay = VoidlyPay()
            secret = getattr(pay, "_secret_base64", None)
            secret_b64 = secret() if callable(secret) else getattr(pay, "secret_base64", "")
            config = VoidlyPayConfig(did=pay.did, secret_base64=secret_b64 or "")
    return [
        VoidlyPaySearchTool(config=config),
        VoidlyPayHireTool(config=config),
        VoidlyPayWalletTool(config=config),
    ]


__all__ = [
    "VoidlyPayConfig",
    "VoidlyPaySearchTool",
    "VoidlyPayHireTool",
    "VoidlyPayWalletTool",
    "voidly_pay_tools",
]
__version__ = "1.0.1"
