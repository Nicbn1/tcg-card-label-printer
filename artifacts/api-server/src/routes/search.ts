import { Router } from "express";

const router = Router();

function parsePriceCharting(html: string) {
  // Extract title cells — each contains one product name + console
  const titleCellRe =
    /<td class="title[^"]*">([\s\S]*?)<\/td>/g;
  const nameLinkRe =
    /href="https?:\/\/www\.pricecharting\.com\/game\/([^"]+)"[^>]*title="(\d+)"[^>]*>\s*([\s\S]*?)\s*<\/a>/;
  const consoleLinkRe =
    /console-in-title[\s\S]*?href="\/console\/([^"]+)">\s*([\s\S]*?)\s*<\/a>/;

  // Extract price columns in order: used, cib, new
  const priceCellRe =
    /<td class="price numeric (used_price|cib_price|new_price)">\s*<span class="js-price">\s*([\$\d,\.]+)\s*<\/span>/g;

  const titles: Array<{ id: number; name: string; console: string }> = [];
  let m: RegExpExecArray | null;

  while ((m = titleCellRe.exec(html)) !== null) {
    const cell = m[1];
    const nameMatch = nameLinkRe.exec(cell);
    const consoleMatch = consoleLinkRe.exec(cell);
    if (!nameMatch) continue;
    const id = parseInt(nameMatch[2], 10);
    const name = nameMatch[3]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/\s+/g, " ")
      .trim();
    const consoleName = consoleMatch
      ? consoleMatch[2]
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim()
      : "";
    titles.push({ id, name, console: consoleName });
  }

  // Collect prices in order (3 per product: used/cib/new)
  const prices: Array<{ type: string; value: number }> = [];
  while ((m = priceCellRe.exec(html)) !== null) {
    const raw = m[2].replace(/[\$,]/g, "");
    prices.push({ type: m[1], value: Math.round(parseFloat(raw) * 100) });
  }

  // Zip titles with their 3 prices
  return titles
    .slice(0, Math.floor(prices.length / 3))
    .map((t, i) => {
      const base = i * 3;
      const byType: Record<string, number> = {};
      for (let j = 0; j < 3; j++) {
        if (prices[base + j]) byType[prices[base + j].type] = prices[base + j].value;
      }
      return {
        id: t.id,
        "product-name": t.name,
        "console-name": t.console,
        "loose-price": byType["used_price"] ?? 0,
        "cib-price": byType["cib_price"] ?? 0,
        "new-price": byType["new_price"] ?? 0,
      };
    })
    .filter((p) => p["product-name"].length > 0);
}

router.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "Missing query param: q" });
    return;
  }

  const url = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(q)}&type=prices`;

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36",
        Accept: "text/html",
      },
    });

    if (!upstream.ok) {
      res.status(502).json({ error: `PriceCharting returned ${upstream.status}` });
      return;
    }

    const html = await upstream.text();
    const products = parsePriceCharting(html);
    res.json({ status: "success", products });
  } catch (err) {
    res.status(502).json({ error: "Failed to reach PriceCharting", detail: String(err) });
  }
});

export default router;
