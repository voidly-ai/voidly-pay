"""voidly_pay_autogen — Microsoft AutoGen FunctionTool wrappers for Voidly Pay."""

from .tools import VoidlyPayConfig, voidly_pay_functions

# Cross-framework alias: every Voidly Pay adapter exposes a `voidly_pay_tools`
# factory that takes a config (or kwargs) and returns the framework-native
# tool list. Keeps consumer code uniform across LangChain, CrewAI, AutoGen.
voidly_pay_tools = voidly_pay_functions

__all__ = ["VoidlyPayConfig", "voidly_pay_functions", "voidly_pay_tools"]
__version__ = "1.0.1"
