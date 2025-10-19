import express from "express";
import axios from "axios";
import { load } from "cheerio";

const app = express();
app.use(express.json({ limit: "1mb" }));

// healthcheck
app.get("/", (_req, res) => res.json({ ok: true }));

// POST /ali/fetch { url: "https://www.aliexpress.com/..." }
app.post("/ali/fetch", async (req, res) => {
  try {
    let { url } = req.body || {};
    if (typeof url !== "string") {
      return res.status(400).json({ error: "invalid_url_type" });
    }

    // 1) Нормализация
    url = decodeURIComponent(url).trim();
    // иногда Telegram присылает с угловыми скобками
    url = url.replace(/^<|>$/g, "");
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "invalid_url_protocol" });
    }

    // 2) User-Agent + опции
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };
    const timeout = 20000;

    // 3) Разворачиваем короткие ссылки AliExpress (a.aliexpress.com/...)
    let finalUrl = url;
    const host = new URL(url).host.toLowerCase();
    if (host === "a.aliexpress.com" || host === "s.click.aliexpress.com") {
      // отдельный запрос, чтобы получить финальный URL
      const r = await axios.get(url, {
        headers,
        timeout,
        // позволяем редиректы
        maxRedirects: 5,
        // не считать 3xx ошибкой
        validateStatus: (s) => s >= 200 && s < 400,
      });
      // axios сам следует редиректам; финальный урл можно достать так:
      finalUrl = r.request?.res?.responseUrl || url;
    }

    // 4) Грузим финальную страницу товара
    const { data: html } = await axios.get(finalUrl, { headers, timeout });

    // 5) Достаём данные (как у тебя было)
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content");
    const title =
      ogTitle || $('meta[name="keywords"]').attr("content") || $("title").text().trim() || null;

    let price = null;
    let currency = "USD";
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).contents().text());
        const offer =
          json?.offers ||
          (Array.isArray(json) && json.find((x) => x.offers)?.offers);
        if (offer?.price) {
          price = Number(offer.price);
          currency = offer.priceCurrency || currency;
        }
      } catch (_) {}
    });

    const images = new Set();
    $('meta[property="og:image"]').each((_, el) => images.add($(el).attr("content")));
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (src && /alicdn|aliexpress|\.jpg|\.png/i.test(src)) images.add(src);
    });

    const specs = {};
    $('[class*="specs"], [id*="spec"], [class*="product"], dl, table')
      .slice(0, 3)
      .each((_, el) => {
        const text = $(el).text().replace(/\s+/g, " ").trim();
        if (text && !specs.summary) specs.summary = text.slice(0, 600);
      });

    return res.json({
      title,
      priceOriginal: price,
      images: Array.from(images).slice(0, 10),
      specs,
      currency,
      finalUrl,
    });
  } catch (err) {
    // более ясное сообщение
    const code = err?.response?.status;
    const msg = err?.message || "unknown";
    return res.status(500).json({
      error: "fetch_failed",
      details: code ? `HTTP_${code}` : msg,
    });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log("ALI adapter listening on", port));
