import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

async function researcher(task: string): Promise<string> {
  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: task }],
    });
    return res.content.map((c: any) => c.text).join("");
  } catch (err) {
    // BAD: retries itself immediately, no backoff, no attempt limit
    return researcher(task);
  }
}

export { researcher };
