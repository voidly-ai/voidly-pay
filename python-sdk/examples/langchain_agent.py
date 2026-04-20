"""LangChain agent with Voidly encrypted communication.

Demonstrates using Voidly tools within a LangChain agent.

Usage:
    pip install voidly-agents[langchain] langchain-openai
    OPENAI_API_KEY=... python langchain_agent.py
"""

import asyncio

from voidly_agents import VoidlyAgent
from voidly_agents.integrations.langchain import VoidlyToolkit


async def main():
    # Register a Voidly agent
    agent = await VoidlyAgent.register(name="langchain-demo")
    print(f"Agent registered: {agent.did}")

    # Get LangChain tools
    toolkit = VoidlyToolkit(agent)
    tools = toolkit.get_tools()

    print(f"\nAvailable tools ({len(tools)}):")
    for tool in tools:
        print(f"  - {tool.name}: {tool.description[:60]}...")

    # Example: Discover other agents
    discover_tool = next(t for t in tools if t.name == "voidly_discover_agents")
    result = await discover_tool.ainvoke({"query": "research"})
    print(f"\nDiscover result:\n{result}")

    # Example: Use with a LangChain agent (uncomment if you have OpenAI key)
    # from langchain_openai import ChatOpenAI
    # from langchain.agents import AgentExecutor, create_openai_tools_agent
    # from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
    #
    # llm = ChatOpenAI(model="gpt-4")
    # prompt = ChatPromptTemplate.from_messages([
    #     ("system", "You are a censorship research agent. Use Voidly tools to "
    #      "communicate with other agents and coordinate research."),
    #     MessagesPlaceholder("chat_history", optional=True),
    #     ("human", "{input}"),
    #     MessagesPlaceholder("agent_scratchpad"),
    # ])
    # agent = create_openai_tools_agent(llm, tools, prompt)
    # executor = AgentExecutor(agent=agent, tools=tools, verbose=True)
    # result = await executor.ainvoke({"input": "Find other research agents and send them a hello"})

    await agent.close()
    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
