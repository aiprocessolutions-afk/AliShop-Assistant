import express from "express";
import axios from "axios";
import cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "1mb" }));

// healthcheck
app.get("/", (_req, res) => res.json({ ok: true }));

// POST /ali/fetch { url: "https://www.aliexpress.com/..." }
app.post("/ali/fetch", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url_required" });

    // 1) получаем HTML страницы
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      },
      timeout: 20000
    });

    // 2) пробуем вынуть данные из meta/JSON-LD
    const $ = cheerio.load(html);

    // title
    const ogTitle = $('meta[property="og:title"]').attr("content");
    const title =
      ogTitle ||
      $('meta[name="keywords"]').attr("content") ||
      $("title").text().trim() ||
      null;

    // цена (на Ali часто в JSON-LD)
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

    // картинки
    const images = new Set();
    $('meta[property="og:image"]').each((_, el) =>
      images.add($(el).attr("content"))
    );
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (src && /alicdn|aliexpress|.jpg|.png/.test(src)) images.add(src);
    });

    // спецификации (простая выжимка)
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
      currency
    });
  } catch (err) {
    return res.status(500).json({
      error: "fetch_failed",
      details: err?.response?.status || err?.message || "unknown"
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("ALI adapter listening on", port));
