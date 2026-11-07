import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

async function runAgent(task: string) {
  const history: any[] = [{ role: "user", content: task }];
  while (true) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: history,
    });
    if (res.stop_reason === "end_turn") break;
    history.push({ role: "assistant", content: res.content });
  }
}

export { runAgent };
