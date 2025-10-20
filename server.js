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

    // Convert mobile URL to desktop for better scraping
    url = url.replace('m.aliexpress.com', 'www.aliexpress.com');

    // 2) Enhanced headers to avoid bot detection
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "DNT": "1",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Cache-Control": "max-age=0"
    };
    
    const timeout = 25000;

    // 3) Expand short AliExpress links
    let finalUrl = url;
    const host = new URL(url).host.toLowerCase();
    
    if (host === "a.aliexpress.com" || host === "s.click.aliexpress.com") {
      const r = await axios.get(url, {
        headers,
        timeout,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      finalUrl = r.request?.res?.responseUrl || r.request?.responseURL || url;
      // Convert to desktop if needed
      finalUrl = finalUrl.replace('m.aliexpress.com', 'www.aliexpress.com');
    }

    // 4) Load the final product page
    const { data: html } = await axios.get(finalUrl, { 
      headers, 
      timeout,
      maxRedirects: 5
    });

    // 5) Extract data
    const $ = load(html);
    
    // Title extraction - multiple fallbacks
    let title = null;
    title = $('meta[property="og:title"]').attr("content") 
         || $('h1').first().text().trim()
         || $('.product-title').text().trim()
         || $('[class*="title"]').first().text().trim()
         || $('meta[name="keywords"]').attr("content")
         || $("title").text().trim();

    // Price extraction - enhanced
    let price = null;
    let currency = "USD";

    // Try JSON-LD first
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).contents().text());
        const offer = json?.offers || (Array.isArray(json) && json.find((x) => x.offers)?.offers);
        if (offer?.price) {
          price = Number(offer.price);
          currency = offer.priceCurrency || currency;
        }
      } catch (_) {}
    });

    // Fallback: look for price in common selectors
    if (!price) {
      const priceSelectors = [
        '.product-price-value',
        '[class*="price"]',
        '[data-spm-anchor-id*="price"]',
        '.price-current'
      ];
      
      for (const selector of priceSelectors) {
        const text = $(selector).first().text();
        const match = text.match(/[\d.,]+/);
        if (match) {
          price = parseFloat(match[0].replace(',', '.'));
          break;
        }
      }
    }

    // Image extraction
    const images = new Set();
    
    // OG image
    $('meta[property="og:image"]').each((_, el) => {
      const content = $(el).attr("content");
      if (content) images.add(content);
    });
    
    // Product images
    $('img').each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-original");
      if (src && /alicdn|aliexpress|\.jpg|\.png|\.webp/i.test(src)) {
        // Clean up image URL
        const cleanSrc = src.split('?')[0]; // Remove query params
        if (cleanSrc.startsWith('http')) {
          images.add(cleanSrc);
        } else if (cleanSrc.startsWith('//')) {
          images.add('https:' + cleanSrc);
        }
      }
    });

    // Specs extraction
    const specs = {};
    $('[class*="specification"], [class*="specs"], [id*="spec"], [class*="detail"], dl, table')
      .slice(0, 5)
      .each((_, el) => {
        const text = $(el).text().replace(/\s+/g, " ").trim();
        if (text && text.length > 20 && !specs.summary) {
          specs.summary = text.slice(0, 800);
        }
      });

    // Debug info (remove in production)
    const debug = {
      hasTitle: !!title,
      hasPrice: !!price,
      imageCount: images.size,
      hasSpecs: Object.keys(specs).length > 0,
      htmlLength: html.length,
      finalUrl
    };

    return res.json({
      title,
      priceOriginal: price,
      images: Array.from(images).slice(0, 10),
      specs,
      currency,
      finalUrl,
      debug // Remove this in production
    });

  } catch (err) {
    const code = err?.response?.status;
    const msg = err?.message || "unknown";
    return res.status(500).json({
      error: "fetch_failed",
      details: code ? `HTTP_${code}` : msg,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("ALI adapter listening on", port));
