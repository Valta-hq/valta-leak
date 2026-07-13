import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

async function runAgent(task: string) {
  const history: any[] = [{ role: "user", content: task }];
  // BAD: no step counter, no timeout, no AbortController
  while (true) {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: history,
    });
    if (res.stop_reason === "end_turn") break;
    history.push({ role: "assistant", content: res.content });
  }
}

export { runAgent };
