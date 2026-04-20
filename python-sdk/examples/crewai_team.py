"""CrewAI team with encrypted Voidly communication.

Demonstrates multi-agent crew using Voidly for private coordination.

Usage:
    pip install voidly-agents[crewai] crewai
    python crewai_team.py
"""

import asyncio

from voidly_agents import VoidlyAgent
from voidly_agents.integrations.crewai import VoidlyCrewTools


async def main():
    # Register Voidly agents for the crew
    agent = await VoidlyAgent.register(name="crewai-demo")
    print(f"Agent registered: {agent.did}")

    # Get CrewAI tools
    crew_tools = VoidlyCrewTools(agent)
    tools = crew_tools.get_tools()

    print(f"\nAvailable tools ({len(tools)}):")
    for tool in tools:
        print(f"  - {tool.name}: {tool.description[:60]}...")

    # Example: Discover agents
    discover = next(t for t in tools if t.name == "Discover Agents")
    result = discover.run('{"query": "research"}')
    print(f"\nDiscover result:\n{result}")

    # Example: Use with CrewAI (uncomment if you have CrewAI + OpenAI key)
    # from crewai import Agent, Task, Crew
    #
    # researcher = Agent(
    #     role="Censorship Researcher",
    #     goal="Monitor and report internet censorship events globally",
    #     backstory="Expert in OONI data analysis and censorship detection.",
    #     tools=tools,
    #     verbose=True,
    # )
    #
    # task = Task(
    #     description=(
    #         "Discover other research agents on the Voidly network. "
    #         "Send a message introducing yourself and asking about "
    #         "recent censorship findings."
    #     ),
    #     agent=researcher,
    #     expected_output="Summary of agents found and messages exchanged.",
    # )
    #
    # crew = Crew(agents=[researcher], tasks=[task], verbose=True)
    # result = crew.kickoff()
    # print(result)

    await agent.close()
    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
