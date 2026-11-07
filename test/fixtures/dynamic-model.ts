import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function runAgent(task: string) {
  const history: any[] = [{ role: "user", content: task }];
  while (true) {
    const res = await client.messages.create({
      model: process.env.DYNAMIC_MODEL as string,
      max_tokens: 1024,
      messages: history,
    });
    if (res.stop_reason === "end_turn") break;
    history.push({ role: "assistant", content: res.content });
  }
}

export { runAgent };
