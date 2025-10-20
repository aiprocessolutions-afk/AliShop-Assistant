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
    if (typeof url !== 'string') {
      return res.status(400).json({ error: 'invalid_url_type' });
    }

    // 1) Normalize URL
    url = decodeURIComponent(url).trim().replace(/^[<«""]+|[>»""]+$/g, '');
    if (!/^https?:\/\//i.test(url)) {
      if (/^(?:[a-z0-9.-]+\.)?aliexpress\.com/i.test(url)
       || /^a\.aliexpress\.com/i.test(url)
       || /^s\.click\.aliexpress\.com/i.test(url)) {
        url = 'https://' + url;
      } else {
        return res.status(400).json({ error: 'invalid_url_protocol' });
      }
    }

    // 2) User-Agent + options
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };
    const timeout = 20000;

    // 3) Expand short AliExpress links (a.aliexpress.com/...)
    let finalUrl = url;
    const host = new URL(url).host.toLowerCase();
    if (host === "a.aliexpress.com" || host === "s.click.aliexpress.com") {
      // Separate request to get the final URL
      const r = await axios.get(url, {
        headers,
        timeout,
        // Allow redirects
        maxRedirects: 5,
        // Don't treat 3xx as error
        validateStatus: (s) => s >= 200 && s < 400,
      });
      // axios follows redirects automatically; final url can be extracted like this:
      finalUrl = r.request?.res?.responseUrl || url;
    }

    // 4) Load the final product page
    const { data: html } = await axios.get(finalUrl, { headers, timeout });

    // 5) Extract data
    const $ = load(html);

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
    // More clear error message
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
