import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

// GOOD: hoisted once, not recomputed/rebilled per iteration
const SYSTEM_PROMPT = "You are a helpful assistant.";

const MAX_STEPS = 10;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function researcher(task: string, attempt = 0): Promise<string> {
  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: task }],
    });
    return res.content.map((c: any) => c.text).join("");
  } catch (err) {
    // GOOD: bounded retry with exponential backoff
    if (attempt >= 3) throw err;
    await sleep(2 ** attempt * 1000);
    return researcher(task, attempt + 1);
  }
}

async function runAgent(task: string) {
  const history: any[] = [{ role: "user", content: task }];
  let steps = 0;
  // GOOD: hard numeric step ceiling, independent of model behavior
  while (steps < MAX_STEPS) {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });
    if (res.stop_reason === "end_turn") break;
    history.push({ role: "assistant", content: res.content });
    steps++;
  }
}

export { researcher, runAgent };
