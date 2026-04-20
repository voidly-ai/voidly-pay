"""Runnable demo: a LangChain agent that uses Voidly Pay as its tool set."""
import os

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI

from voidly_pay_langchain import voidly_pay_tools, VoidlyPayConfig


tools = voidly_pay_tools(VoidlyPayConfig(
    did=os.environ["VOIDLY_DID"],
    secret_base64=os.environ["VOIDLY_SECRET"],
))

prompt = ChatPromptTemplate.from_messages([
    ("system",
     "You are an agent that can call paid services on the Voidly Pay marketplace. "
     "Before any hire: (1) search with voidly_capability_search, (2) verify the "
     "price is reasonable, (3) hire with voidly_hire using the capability_id "
     "from the search result. If you're asked to hash text, verify the returned "
     "hash locally by describing what you got back."),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])

agent = create_tool_calling_agent(ChatOpenAI(model="gpt-4o-mini"), tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

print(executor.invoke({
    "input": "Use a cheap hash.sha256 provider to hash the word 'hydra'. "
             "Report the provider's DID and the hash.",
}))
