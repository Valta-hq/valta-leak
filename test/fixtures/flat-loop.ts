import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// No history array is appended to: every call sends the same prompt, so cost is linear.
async function pollForever(task: string) {
  while (true) {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: task }],
    });
    if (res.stop_reason === "end_turn") break;
  }
}

export { pollForever };
