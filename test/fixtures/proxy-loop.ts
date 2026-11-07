import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function scrapeAndSummarize(urls: string[]) {
  while (true) {
    const page = await fetch("https://proxy-scraping.com/render?url=" + urls[0]);
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: await page.text() }],
    });
    if (res.stop_reason === "end_turn") break;
  }
}

export { scrapeAndSummarize };
