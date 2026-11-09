/**
 * Gemini 中継サーバー（Cloudflare Workers）
 * - APIキーをスマホ側に置かないための中継
 * - 店舗パスコード + Origin 制限で第三者利用を防止
 *
 * 必要な Secret / 変数:
 *   GEMINI_API_KEY   (secret)  … Google AI Studio の APIキー
 *   STORE_PASSCODE   (secret)  … 店舗に配るパスコード
 *   ALLOWED_ORIGIN   (var)     … 例 https://<user>.github.io  （カンマ区切りで複数可）
 *   ALLOWED_MODELS   (var)     … 例 gemini-3.8-flash,gemini-3.6-flash
 */
export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Store-Pass",
      "Vary": "Origin"
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/analyze") return json({ error: "not found" }, 404);
    if (!okOrigin) return json({ error: "origin not allowed" }, 403);
    if (!env.STORE_PASSCODE || req.headers.get("X-Store-Pass") !== env.STORE_PASSCODE)
      return json({ error: "パスコードが違います" }, 401);

    const len = Number(req.headers.get("Content-Length") || 0);
    if (len > 12 * 1024 * 1024) return json({ error: "画像サイズが大きすぎます" }, 413);

    let body;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    const models = (env.ALLOWED_MODELS || "gemini-3.8-flash").split(",").map((s) => s.trim());
    const model = models.includes(body.model) ? body.model : models[0];

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(body.payload || {})
      }
    );
    return new Response(r.body, { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  }
};
