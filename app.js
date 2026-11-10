/* 修繕AI判定 - フロントエンド本体（ビルド不要の素のJS） */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const C = window.REPAIR_CRITERIA;
  const MAX_PHOTOS = 4;
  const LS_SETTINGS = "repairai.settings";
  const LS_HISTORY = "repairai.history";
  const DEFAULT_MODEL = "gemini-3.8-flash";

  // ---------------- 状態 ----------------
  const state = {
    photos: [],          // {dataUrl, base64, mime, thumb}
    turns: [],           // Gemini 会話履歴（再判定用）
    result: null,
    input: null,
    createdAt: null,
    doneActions: new Set()
  };

  // ---------------- 安全な localStorage ----------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  };
  const settings = () => Object.assign(
    { tel: "", mail: "", mode: "direct", proxy: "", pass: "", key: "", model: DEFAULT_MODEL },
    store.get(LS_SETTINGS, {})
  );

  const noGuess = (s) => String(s ?? "").replace(/[（(]\s*(AI)?推測\s*[)）]/g, "").trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
  }

  // ---------------- 写真 ----------------
  async function resizeImage(file, max, quality) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      return cv.toDataURL("image/jpeg", quality);
    } finally { URL.revokeObjectURL(url); }
  }

  $("#photoInput").addEventListener("change", async (e) => {
    const files = [...e.target.files].slice(0, MAX_PHOTOS - state.photos.length);
    if (e.target.files.length > files.length) toast(`写真は最大${MAX_PHOTOS}枚までです`);
    for (const f of files) {
      try {
        const dataUrl = await resizeImage(f, 1280, 0.82);
        const thumb = await resizeImage(f, 240, 0.6);
        state.photos.push({ dataUrl, thumb, base64: dataUrl.split(",")[1], mime: "image/jpeg" });
      } catch { toast("画像を読み込めませんでした"); }
    }
    e.target.value = "";
    renderThumbs();
  });

  function renderThumbs() {
    $("#thumbs").innerHTML = state.photos.map((p, i) =>
      `<div><img src="${p.thumb}" alt="写真${i + 1}"><button type="button" data-del="${i}" aria-label="削除">×</button></div>`).join("");
  }
  $("#thumbs").addEventListener("click", (e) => {
    const i = e.target.dataset.del; if (i === undefined) return;
    state.photos.splice(+i, 1); renderThumbs();
  });

  // ---------------- チップ選択 ----------------
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip"); if (!chip) return;
    const group = chip.parentElement;
    if (group.classList.contains("single")) $$(".chip", group).forEach((c) => c !== chip && c.classList.remove("on"));
    chip.classList.toggle("on");
  });
  const chipVal = (name, root = document) => $$(`[data-name="${name}"] .chip.on`, root).map((c) => c.textContent).join("、");

  function collectInput() {
    return {
      area: chipVal("area"), memo: $("#memo").value.trim(), danger: chipVal("danger"),
      impact: chipVal("impact"), since: chipVal("since"), trend: chipVal("trend")
    };
  }

  // ---------------- プロンプト ----------------
  function systemPrompt() {
    const cat = C.categories.map((c) => `・${c.name}（${c.summary}）\n  事例: ${c.examples.join("／")}`).join("\n");
    const q = C.quoteRoutes.map((r) => `・${r.name}: ${r.when}`).join("\n");
    return `あなたは小売チェーン「店舗部」の修繕判定アシスタントです。店舗スタッフが撮影した修繕箇所の写真とメモを見て、社内の「修繕稟議基準」に沿って一次判定を支援します。

# 社内基準（必ずこれに従う）
## 重要度区分
${cat}

## 緊急案件の基準
定義: ${C.emergency.definition}
過去事例:
${C.emergency.pastCases.map((s) => "・" + s).join("\n")}

## 見積取得ルート
${q}
※1万円未満は3社見積の人件費を加味して1社で進める。

## 運用原則
・基準表は網羅的列挙ではない。同等のリスクを持つ案件には同じ基準を適用する。
・基準表に該当しない場合は、category を「基準表に該当なし」とし、類似事例と判断理由を reason に書く。
・責任区分: ${C.roles.first} / ${C.roles.final}。あなたの判定はあくまで一次判断の補助。
・${C.exception}

# 判定の考え方
1. 写真から読み取れる事実（observation）と推測を区別する。写真で確認できないことを断定しない。
2. 人的安全（感電・火災・転倒・落下・ケガ）と営業継続への影響を最優先で評価する。少しでも重大事故の可能性があり、かつ情報が不足している場合は「安全側」に倒して判定し、confidence を下げる。
3. is_emergency=true のときは、immediate_actions に店舗スタッフが「今この場で」できる具体的行動を優先順に3〜6個（例: 周囲を立入禁止にする、ブレーカーを落とす、止水栓を閉める、バケツで受ける、写真で記録、本社へ電話）。専門業者でなければできない作業は書かない。
4. dont_do には危険な素人対応を書く（例: 濡れたコンセントに触れない、脚立で天井を開けない）。
5. 緊急でなくても、放置した場合の将来リスク（future_risks）を必ず1〜3件、時間軸・発生可能性・影響・放置時の費用感とともに明示する。「今は小さいが放置すると高くつく」ことが伝わる書き方にする。
6. missing_info: 判定精度を上げるために店舗に追加で聞くべき質問を最大4件。選択肢で答えられるよう options を2〜4個付ける。十分な情報がある場合は空配列。
7. photo_requests: 追加で撮影すべき写真があれば具体的に（例:「コンセント周辺の焦げ跡を10cmの距離で」）。
8. cost_estimate は概算レンジのみ（例: 1〜3万円）。「推測」等の注記は付けない（画面側で付与する）。
9. headline は店舗スタッフが一目で行動できる30字以内の結論。
10. 出力は日本語、店舗スタッフにも分かる平易な言葉で。`;
  }

  const schema = {
    type: "OBJECT",
    properties: {
      item: { type: "STRING", description: "対象設備・箇所の名称（例: トイレ前天井の漏水）" },
      observation: { type: "STRING", description: "写真とメモから読み取れる事実" },
      headline: { type: "STRING", description: "店舗スタッフ向けの30字以内の結論" },
      is_emergency: { type: "BOOLEAN" },
      urgency_level: { type: "STRING", enum: ["緊急", "高", "中", "低"] },
      reason: { type: "STRING", description: "判定理由（基準のどれに該当するか）" },
      category: { type: "STRING", enum: ["必ず実施", "程度により変動", "必須でない修繕", "基準表に該当なし"] },
      matched_example: { type: "STRING", description: "基準表で最も近い事例名" },
      risk_types: { type: "ARRAY", items: { type: "STRING", enum: ["営業継続", "人的安全", "法令リスク", "ブランド毀損"] } },
      implementation: { type: "STRING", enum: ["実施前提", "部長判断", "費用対効果で判断"] },
      hq_request: { type: "STRING", enum: ["今すぐ電話", "本日中に依頼", "通常依頼", "店舗で対応・経過観察"] },
      hq_request_reason: { type: "STRING" },
      immediate_actions: { type: "ARRAY", items: { type: "STRING" } },
      dont_do: { type: "ARRAY", items: { type: "STRING" } },
      quote_route: { type: "STRING", enum: ["1社", "3社", "概算"] },
      quote_reason: { type: "STRING" },
      cost_estimate: { type: "STRING" },
      future_risks: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            risk: { type: "STRING" },
            timeframe: { type: "STRING", description: "例: 1週間以内 / 数ヶ月 / 次の夏" },
            likelihood: { type: "STRING", enum: ["高", "中", "低"] },
            impact: { type: "STRING" },
            cost_if_left: { type: "STRING" }
          },
          required: ["risk", "timeframe", "likelihood", "impact"]
        }
      },
      missing_info: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            question: { type: "STRING" },
            why: { type: "STRING" },
            options: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["question", "why"]
        }
      },
      photo_requests: { type: "ARRAY", items: { type: "STRING" } },
      confidence: { type: "STRING", enum: ["高", "中", "低"] }
    },
    required: ["item", "observation", "headline", "is_emergency", "urgency_level", "reason", "category",
      "risk_types", "implementation", "hq_request", "immediate_actions", "quote_route", "future_risks",
      "missing_info", "confidence"]
  };

  function firstUserTurn(input) {
    const lines = [
      `場所: ${input.area || "未入力"}`,
      `状況メモ: ${input.memo || "未入力"}`,
      `お客様・スタッフへの危険: ${input.danger || "未入力"}`,
      `営業への影響: ${input.impact || "未入力"}`,
      `いつから: ${input.since || "未入力"}`,
      `状態の変化: ${input.trend || "未入力"}`,
      `報告時刻: ${new Date().toLocaleString("ja-JP")}`
    ];
    return {
      role: "user",
      parts: [
        ...state.photos.map((p) => ({ inlineData: { mimeType: p.mime, data: p.base64 } })),
        { text: `以下の修繕箇所を判定してください。\n${lines.join("\n")}` }
      ]
    };
  }

  // ---------------- Gemini 呼び出し ----------------
  async function callGemini(contents) {
    const s = settings();
    const model = (s.model || DEFAULT_MODEL).trim();
    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents,
      generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema }
    };
    let res;
    if (s.mode === "direct") {
      if (!s.key) throw new Error("設定で Gemini APIキーを入力してください。");
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": s.key },
        body: JSON.stringify(payload)
      });
    } else {
      if (!s.proxy) throw new Error("設定で中継サーバーURLを入力してください。");
      res = await fetch(s.proxy.replace(/\/$/, "") + "/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Store-Pass": s.pass || "" },
        body: JSON.stringify({ model, payload })
      });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || body?.error || res.statusText;
      if (res.status === 401 || res.status === 403) throw new Error(`認証エラー：APIキーまたはパスコードを確認してください（${msg}）`);
      if (res.status === 429) throw new Error("利用上限に達しました。少し待ってから再実行してください。");
      throw new Error(`AI呼び出しに失敗しました（${res.status}）：${msg}`);
    }
    const cand = body.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) throw new Error(`AIから回答がありませんでした（${cand?.finishReason || body.promptFeedback?.blockReason || "不明"}）`);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("AIの回答形式が不正でした。もう一度お試しください。"); }
    return { text, json };
  }

  async function run(contents) {
    const btn = $("#btnAnalyze");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>AIが判定中…（10〜20秒）`;
    try {
      const { text, json } = await callGemini(contents);
      state.turns = [...contents, { role: "model", parts: [{ text }] }];
      state.result = json;
      saveHistory();
      renderResult();
      if (json.is_emergency && navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      btn.disabled = false;
      updateFooter();
    }
  }

  // ---------------- 実行ボタン ----------------
  $("#btnAnalyze").addEventListener("click", () => {
    if (state.result || state.handoff) return resetAll();
    const input = collectInput();
    if (settings().mode === "nokey") return handoff(input);
    if (!state.photos.length && !input.memo) return toast("写真を撮るか、状況を入力してください");
    if (!state.photos.length && !confirm("写真なしで判定しますか？（精度が下がります）")) return;
    const s0 = settings();
    if (s0.mode === "direct" ? !s0.key : !s0.proxy) { toast("最初にAIの接続設定をしてください"); return $("#btnSettings").click(); }
    state.input = input;
    state.createdAt = new Date().toISOString();
    state.doneActions = new Set();
    run([firstUserTurn(input)]);
  });

  function updateFooter() {
    const done = state.result || state.handoff;
    $("#btnAnalyze").textContent = done ? "＋ 新しい案件を登録" : (settings().mode === "nokey" ? "Geminiで判定する" : "AIに判定してもらう");
    $("#btnAnalyze").className = done ? "btn sub" : "btn";
  }

  function resetAll() {
    if (!confirm("入力内容をクリアして新しい案件を始めますか？")) return;
    Object.assign(state, { handoff: null, photos: [], turns: [], result: null, input: null, createdAt: null, doneActions: new Set() });
    $("#memo").value = ""; $$(".chip.on").forEach((c) => c.classList.remove("on"));
    renderThumbs();
    $("#resultView").classList.add("hidden"); $("#inputView").classList.remove("hidden");
    updateFooter(); scrollTo(0, 0);
  }

  // ---------------- 結果表示 ----------------
  const LEVEL = {
    "緊急": { cls: "v-emergency", label: "🚨 緊急案件" },
    "高": { cls: "v-high", label: "⚠️ 優先度：高" },
    "中": { cls: "v-mid", label: "📋 優先度：中" },
    "低": { cls: "v-low", label: "✅ 優先度：低" }
  };
  const likeColor = { "高": "var(--red)", "中": "var(--orange)", "低": "var(--yellow)" };

  function renderResult() {
    const r = state.result, s = settings();
    const lvKey = r.is_emergency ? "緊急" : (LEVEL[r.urgency_level] ? r.urgency_level : "中");
    const lv = LEVEL[lvKey];
    const telBtn = s.tel
      ? `<a class="btn danger" href="tel:${esc(s.tel.replace(/[^\d+]/g, ""))}">📞 本社に今すぐ電話（${esc(s.tel)}）</a>`
      : `<p class="muted">※設定で本社の緊急連絡先を登録すると、ここに発信ボタンが出ます。</p>`;

    const actions = (r.immediate_actions || []).map((a, i) =>
      `<li><input type="checkbox" data-act="${i}" ${state.doneActions.has(i) ? "checked" : ""}><span>${esc(a)}</span></li>`).join("");

    const html = [];

    // --- 判定バナー ---
    html.push(`<div class="verdict ${lv.cls}">
      <div class="lv ${r.is_emergency ? "blink" : ""}">${lv.label}</div>
      <div class="ttl">${esc(r.headline)}</div>
      <div style="font-size:14px">${esc(r.reason)}</div>
      ${r.is_emergency ? `<div style="margin-top:14px">${telBtn}</div>` : ""}
    </div>`);

    // --- 今すぐやること ---
    if (actions) {
      html.push(`<div class="card"><h2>${r.is_emergency ? "🔥 今すぐやること（上から順に）" : "📝 店舗でやっておくこと"}</h2>
        <p class="muted" style="margin:0">完了したらチェック → 依頼文に「実施済み応急処置」として載ります</p>
        <ol class="actions">${actions}</ol>
        ${(r.dont_do || []).length ? `<div style="margin-top:10px;color:var(--red);font-size:14px"><b>⛔ やってはいけないこと</b><br>${r.dont_do.map(esc).join("<br>")}</div>` : ""}
      </div>`);
    }

    // --- 不足情報 ---
    const qs = r.missing_info || [];
    const pr = r.photo_requests || [];
    if (qs.length || pr.length) {
      html.push(`<div class="card" id="followCard"><h2>❓ 判定精度を上げるために教えてください</h2>
        ${qs.map((q, i) => `<div class="q" data-q="${i}">
          <div><b>${esc(q.question)}</b></div><div class="why">${esc(q.why)}</div>
          ${(q.options || []).length ? `<div class="chips single" data-name="q${i}" style="margin-top:6px">${q.options.map((o) => `<button type="button" class="chip">${esc(o)}</button>`).join("")}</div>` : ""}
          <input data-qtext="${i}" placeholder="自由回答（任意）" style="margin-top:6px">
        </div>`).join("")}
        ${pr.length ? `<div class="q"><b>📷 追加で撮ってほしい写真</b><div class="why">${pr.map(esc).join("<br>")}</div>
          <label class="btn sub" for="addPhoto" style="margin-top:8px">写真を追加</label>
          <input id="addPhoto" type="file" accept="image/*" capture="environment" multiple class="hidden">
          <div id="addThumbs" class="thumbs"></div></div>` : ""}
        <button class="btn" type="button" id="btnReanalyze">回答して再判定</button>
      </div>`);
    }

    // --- 稟議に必要な判定 ---
    html.push(`<div class="card"><h2>📑 基準に基づく判定（稟議記載事項）</h2>
      <dl class="kv">
        <dt>対象</dt><dd>${esc(r.item)}</dd>
        <dt>重要度区分</dt><dd>${esc(r.category)}${r.matched_example ? `<br><span class="muted">近い事例：${esc(r.matched_example)}</span>` : ""}</dd>
        <dt>リスク区分</dt><dd>${(r.risk_types || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("") || "該当なし"}</dd>
        <dt>緊急案件</dt><dd>${r.is_emergency ? "該当" : "非該当"}</dd>
        <dt>実施前提</dt><dd>${esc(r.implementation)}</dd>
        <dt>見積取得</dt><dd>${esc(r.quote_route)}<br><span class="muted">${esc(r.quote_reason)}</span></dd>
        <dt>費用感</dt><dd>${esc(noGuess(r.cost_estimate) || "不明")}<span class="muted">（推測）</span></dd>
        <dt>本社依頼</dt><dd>${esc(r.hq_request)}<br><span class="muted">${esc(r.hq_request_reason)}</span></dd>
        <dt>AI確信度</dt><dd>${esc(r.confidence)}</dd>
      </dl></div>`);

    // --- 将来リスク ---
    if ((r.future_risks || []).length) {
      html.push(`<div class="card"><h2>🔮 放置した場合の将来リスク</h2>
        ${r.future_risks.map((f) => `<div class="risk" style="border-left-color:${likeColor[f.likelihood] || "var(--orange)"}">
          <b>${esc(f.risk)}</b>
          <div class="meta">時期：${esc(f.timeframe)} ／ 可能性：${esc(f.likelihood)}</div>
          <div style="font-size:14px">${esc(f.impact)}</div>
          ${f.cost_if_left ? `<div class="meta">放置時の費用感：${esc(noGuess(f.cost_if_left))}（推測）</div>` : ""}
        </div>`).join("")}
      </div>`);
    }

    // --- 写真から読み取れたこと ---
    html.push(`<div class="card"><h2>👀 AIが読み取った状況</h2><div style="font-size:14px">${esc(r.observation)}</div></div>`);

    // --- 依頼文 ---
    html.push(`<div class="card"><h2>📨 本社への依頼文</h2>
      <pre class="draft" id="draft">${esc(buildRequestText())}</pre>
      <div style="margin-top:12px">
        <button class="btn" type="button" id="btnShare">📤 写真付きで共有（メール・LINE・Teams等）</button>
        <button class="btn sub" type="button" id="btnCopy">📋 依頼文をコピー</button>
        ${s.mail ? `<a class="btn sub" id="btnMail" href="#">✉️ 本社にメール（写真は手動添付）</a>` : ""}
        ${!r.is_emergency && s.tel && (r.hq_request === "本日中に依頼") ? `<a class="btn sub" href="tel:${esc(s.tel.replace(/[^\d+]/g, ""))}">📞 本社に電話</a>` : ""}
      </div>
      <p class="muted">※AIによる一次判定です。最終判断・承認は部門長が行います（第4条）。</p>
    </div>`);

    const view = $("#resultView");
    view.innerHTML = html.join("");
    view.classList.remove("hidden");
    $("#inputView").classList.add("hidden");
    scrollTo(0, 0);
  }

  // 結果画面のイベント（委譲）
  $("#resultView").addEventListener("change", async (e) => {
    if (e.target.dataset.act !== undefined) {
      const i = +e.target.dataset.act;
      e.target.checked ? state.doneActions.add(i) : state.doneActions.delete(i);
      $("#draft").textContent = buildRequestText();
      saveHistory();
    }
    if (e.target.id === "addPhoto") {
      for (const f of [...e.target.files].slice(0, MAX_PHOTOS)) {
        const dataUrl = await resizeImage(f, 1280, 0.82), thumb = await resizeImage(f, 240, 0.6);
        (state.extraPhotos ||= []).push({ dataUrl, thumb, base64: dataUrl.split(",")[1], mime: "image/jpeg" });
      }
      $("#addThumbs").innerHTML = state.extraPhotos.map((p) => `<div><img src="${p.thumb}" alt=""></div>`).join("");
      e.target.value = "";
    }
  });

  $("#resultView").addEventListener("click", async (e) => {
    const id = e.target.closest("[id]")?.id;
    if (id === "btnReanalyze") {
      const qs = state.result.missing_info || [];
      const answers = qs.map((q, i) => {
        const sel = chipVal(`q${i}`, $("#followCard"));
        const txt = $(`[data-qtext="${i}"]`)?.value.trim();
        const a = [sel, txt].filter(Boolean).join(" / ");
        return a ? `Q: ${q.question}\nA: ${a}` : null;
      }).filter(Boolean);
      const extra = state.extraPhotos || [];
      if (!answers.length && !extra.length) return toast("どれか1つ以上回答してください");
      state.photos.push(...extra); state.extraPhotos = [];
      const turn = {
        role: "user",
        parts: [
          ...extra.map((p) => ({ inlineData: { mimeType: p.mime, data: p.base64 } })),
          { text: `追加情報です。これを踏まえて再判定してください。${extra.length ? `（追加写真${extra.length}枚あり）` : ""}\n${answers.join("\n")}` }
        ]
      };
      state.input.followups = [...(state.input.followups || []), ...answers];
      state.doneActions = new Set();
      run([...state.turns, turn]);
    }
    if (id === "btnCopy") {
      try { await navigator.clipboard.writeText(buildRequestText()); toast("コピーしました"); }
      catch { toast("コピーできませんでした。長押しで選択してください"); }
    }
    if (id === "btnMail") {
      e.preventDefault();
      const s = settings();
      location.href = `mailto:${encodeURIComponent(s.mail)}?subject=${encodeURIComponent(subjectLine())}&body=${encodeURIComponent(buildRequestText())}`;
    }
    if (id === "btnShare") shareWithPhotos();
  });

  async function shareWithPhotos() {
    const text = buildRequestText();
    const files = await Promise.all(state.photos.map(async (p, i) => {
      const blob = await (await fetch(p.dataUrl)).blob();
      return new File([blob], `修繕写真_${i + 1}.jpg`, { type: "image/jpeg" });
    }));
    const data = { title: subjectLine(), text, files };
    try {
      if (navigator.canShare && navigator.canShare(data)) await navigator.share(data);
      else if (navigator.share) { await navigator.share({ title: data.title, text }); toast("写真は別途添付してください"); }
      else { await navigator.clipboard.writeText(text); toast("共有非対応のため依頼文をコピーしました"); }
    } catch (err) { if (err.name !== "AbortError") toast("共有に失敗しました"); }
  }


  // ---------------- APIキーなしモード：Geminiアプリに引き継ぐ ----------------
  const GEMINI_URL = "https://gemini.google.com/app";
  let gemText = "";
  fetch("gem/GEM_INSTRUCTIONS.md").then((r) => (r.ok ? r.text() : "")).then((t) => (gemText = t)).catch(() => {});

  function buildHandoffPrompt(input) {
    const base = gemText || systemPrompt() +
      "\n\n# 回答のしかた\n1行目に緊急度（🚨緊急／⚠️高／📋中／✅低）と30字以内の結論。緊急なら「今すぐやること」「やってはいけないこと」を最初に。続けて、写真から見えること、稟議記載事項（重要度区分・リスク区分・緊急案件該当・実施前提か・見積取得1社/3社/概算・費用感（推測））、放置した場合の将来リスク、追加で確認したい質問（番号と選択肢つき、最大3問）。「依頼文」と言われたら本社への依頼文をコードブロックで出す。";
    const lines = [
      `場所：${input.area || "未入力"}`,
      `状況メモ：${input.memo || "未入力"}`,
      `お客様・スタッフへの危険：${input.danger || "未入力"}`,
      `営業への影響：${input.impact || "未入力"}`,
      `いつから：${input.since || "未入力"}`,
      `状態の変化：${input.trend || "未入力"}`,
      `報告日時：${new Date().toLocaleString("ja-JP")}`
    ];
    return `${base}\n\n---\n# 今回の案件\n${lines.join("\n")}\n\n添付した写真を見て、上の指示どおりに判定してください。写真がない場合は、まず撮影を促してください。`;
  }

  function handoff(input) {
    state.input = input;
    state.handoff = buildHandoffPrompt(input);
    const hasPhotos = state.photos.length > 0;
    $("#resultView").innerHTML = `
      <div class="verdict v-low" style="border-color:var(--primary);background:var(--card)">
        <div class="lv" style="color:var(--primary)">APIキーなしモード</div>
        <div class="ttl">Geminiで判定します</div>
        <div style="font-size:14px">判定用の指示文をコピーして、Geminiを開きます。</div>
      </div>
      <div class="card">
        <button class="btn" type="button" id="btnGoGemini">📋 指示文をコピーしてGeminiを開く</button>
        <ol style="padding-left:1.3em;margin:14px 0 0;font-size:15px">
          <li>Geminiの入力欄を<b>長押し →「ペースト」</b></li>
          <li><b>📷（または＋）</b>で修繕箇所を撮影・添付${hasPhotos ? "<br><span class='muted'>このページで撮った写真は端末に保存されていないことがあります。その場合はGeminiで撮り直すか、下の「写真ごと共有」を使ってください</span>" : ""}</li>
          <li><b>送信</b> → 1行目に緊急度が出ます。🚨なら表示された行動を今すぐ実行</li>
          <li>質問に答え終わったら「<b>依頼文</b>」と送ると、本社への依頼文が出ます</li>
        </ol>
        ${hasPhotos ? `<button class="btn sub" type="button" id="btnShareGemini">📤 写真ごとGeminiアプリに共有</button>
          <p class="muted">共有先の一覧にGeminiが出ない場合は、上のボタンを使ってください。</p>` : ""}
        <details style="margin-top:12px"><summary class="muted">コピーされる指示文を見る</summary>
          <pre class="draft" id="handoffText" style="max-height:260px;overflow:auto;font-size:12px">${esc(state.handoff)}</pre></details>
      </div>
      ${settings().tel ? `<a class="btn danger" href="tel:${esc(settings().tel.replace(/[^\d+]/g, ""))}">📞 緊急なら本社に電話（${esc(settings().tel)}）</a>` : ""}`;
    $("#resultView").classList.remove("hidden");
    $("#inputView").classList.add("hidden");
    updateFooter(); scrollTo(0, 0);
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); return ok;
  }

  $("#resultView").addEventListener("click", async (e) => {
    const id = e.target.closest("[id]")?.id;
    if (id === "btnGoGemini") {
      const p = copyText(state.handoff);            // クリック直後にコピー開始
      const w = window.open(GEMINI_URL, "_blank");  // iOSのポップアップ制限を避けるため同期で開く
      const ok = await p;
      if (!ok) { if (w) w.close(); $("#handoffText").parentElement.open = true; return alert("コピーできませんでした。下の指示文を長押しで全選択してコピーしてください。"); }
      if (!w) location.href = GEMINI_URL;
    }
    if (id === "btnShareGemini") {
      const files = await Promise.all(state.photos.map(async (ph, i) =>
        new File([await (await fetch(ph.dataUrl)).blob()], `修繕写真_${i + 1}.jpg`, { type: "image/jpeg" })));
      await copyText(state.handoff);
      const data = { text: state.handoff, files };
      try {
        if (navigator.canShare && navigator.canShare(data)) { await navigator.share(data); toast("指示文はコピー済みです。文字が入っていなければ貼り付けてください"); }
        else toast("この端末は写真の共有に対応していません。上のボタンを使ってください");
      } catch (err) { if (err.name !== "AbortError") toast("共有に失敗しました"); }
    }
  });

  // ---------------- 依頼文生成（第3条①の記載事項を必ず含める） ----------------
  function subjectLine() {
    const r = state.result, s = settings();
    return `【${r.is_emergency ? "緊急" : "修繕依頼"}】${r.item}`;
  }
  function buildRequestText() {
    const r = state.result, s = settings(), inp = state.input || {};
    const done = (r.immediate_actions || []).filter((_, i) => state.doneActions.has(i));
    const L = [];
    L.push(subjectLine(), "");
    L.push(`報告日時：${new Date(state.createdAt || Date.now()).toLocaleString("ja-JP")}`);
    L.push("");
    L.push("■ 判定（修繕稟議基準 第3条①）");
    L.push(`・リスク区分：${(r.risk_types || []).join("、") || "該当なし"}`);
    L.push(`・緊急案件該当：${r.is_emergency ? "該当" : "非該当"}（緊急度：${r.urgency_level}）`);
    L.push(`・実施前提か否か：${r.implementation}（重要度区分：${r.category}${r.matched_example ? "／近い事例：" + r.matched_example : ""}）`);
    L.push(`・見積取得基準：${r.quote_route}（${r.quote_reason || ""}）`);
    L.push(`・概算費用：${noGuess(r.cost_estimate) || "不明"}（AI推測）`);
    if (r.category === "基準表に該当なし") L.push(`・類似事例・判断理由：${r.reason}`);
    L.push("");
    L.push("■ 状況");
    L.push(`・場所：${inp.area || "-"}`);
    L.push(`・内容：${r.observation}`);
    if (inp.memo) L.push(`・店舗メモ：${inp.memo}`);
    L.push(`・危険性：${inp.danger || "-"}／営業影響：${inp.impact || "-"}`);
    L.push(`・発生：${inp.since || "-"}／状態：${inp.trend || "-"}`);
    (inp.followups || []).forEach((f) => L.push("・" + f.replace(/\n/g, " → ")));
    L.push("");
    L.push("■ 店舗で実施済みの応急処置");
    L.push(done.length ? done.map((d) => "・" + d).join("\n") : "・なし");
    L.push("");
    if ((r.future_risks || []).length) {
      L.push("■ 放置時の将来リスク");
      r.future_risks.forEach((f) => L.push(`・${f.risk}（${f.timeframe}／可能性${f.likelihood}）：${f.impact}`));
      L.push("");
    }
    L.push("■ 判定理由");
    L.push(r.reason);
    L.push("");
    L.push(`写真：${state.photos.length}枚`);
    L.push("※AIによる一次判定です。最終判断は部門長にお願いします。");
    return L.join("\n");
  }

  // ---------------- 履歴 ----------------
  function saveHistory() {
    if (!state.result) return;
    const list = store.get(LS_HISTORY, []);
    const rec = {
      id: state.createdAt, createdAt: state.createdAt, input: state.input, result: state.result,
      done: [...state.doneActions], thumbs: state.photos.map((p) => p.thumb)
    };
    const idx = list.findIndex((h) => h.id === rec.id);
    idx >= 0 ? (list[idx] = rec) : list.unshift(rec);
    // 容量対策：30件まで、失敗したら古いものから削る
    let trimmed = list.slice(0, 30);
    while (!store.set(LS_HISTORY, trimmed) && trimmed.length > 1) trimmed = trimmed.slice(0, -1);
  }

  $("#btnHistory").addEventListener("click", () => {
    const list = store.get(LS_HISTORY, []);
    const col = { "緊急": "var(--red)", "高": "var(--orange)", "中": "var(--yellow)", "低": "var(--green)" };
    $("#histList").innerHTML = list.length ? list.map((h, i) => `<div class="hist-item" data-h="${i}">
        ${h.thumbs?.[0] ? `<img src="${h.thumbs[0]}" alt="">` : `<div style="width:52px;height:52px;border-radius:8px;background:var(--bg)"></div>`}
        <div style="min-width:0"><div><span class="dot" style="background:${col[h.result.is_emergency ? "緊急" : h.result.urgency_level] || "gray"}"></span><b>${esc(h.result.item)}</b></div>
        <div class="muted">${new Date(h.createdAt).toLocaleString("ja-JP")}／${esc(h.result.hq_request)}</div></div>
      </div>`).join("") : `<p class="muted">まだ履歴はありません</p>`;
    $("#dlgHistory").showModal();
  });
  $("#histList").addEventListener("click", (e) => {
    const el = e.target.closest("[data-h]"); if (!el) return;
    const h = store.get(LS_HISTORY, [])[+el.dataset.h]; if (!h) return;
    Object.assign(state, {
      result: h.result, input: h.input, createdAt: h.createdAt, doneActions: new Set(h.done || []),
      photos: (h.thumbs || []).map((t) => ({ dataUrl: t, thumb: t, base64: t.split(",")[1], mime: "image/jpeg" })),
      turns: [] // 履歴からの再判定は不可（元画像を保持していないため）
    });
    $("#dlgHistory").close();
    renderResult(); updateFooter();
    $("#followCard")?.remove();
  });

  // ---------------- 設定 ----------------
  const F = ["tel", "mail", "mode", "proxy", "pass", "key", "model"];
  function syncModeUI() {
    const m = $("#s_mode").value;
    $("#s_keyWrap").classList.toggle("hidden", m !== "direct");
    $("#s_proxyWrap").classList.toggle("hidden", m !== "proxy");
  }
  $("#btnSettings").addEventListener("click", () => {
    const s = settings();
    F.forEach((k) => ($(`#s_${k}`).value = s[k] || ""));
    $("#criteriaVer").textContent = `判定基準：${C.version}`;
    syncModeUI();
    $("#dlgSettings").showModal();
  });
  $("#s_mode").addEventListener("change", syncModeUI);
  $("#btnCloseSettings").addEventListener("click", () => $("#dlgSettings").close());
  $("#btnSaveSettings").addEventListener("click", () => {
    const s = {}; F.forEach((k) => (s[k] = $(`#s_${k}`).value.trim()));
    if (!s.model) s.model = DEFAULT_MODEL;
    store.set(LS_SETTINGS, s); $("#dlgSettings").close(); updateFooter(); toast("保存しました");
  });

  // URLパラメータで初期設定を配布できるようにする（例: ?proxy=https://...&tel=03...）
  // キーは # 以降（フラグメント）で受け取る：サーバーやアクセスログに送られない
  (function bootstrapFromUrl() {
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams(location.hash.replace(/^#/, ""));
    const s = settings(); let changed = false;
    for (const src of [q, h]) for (const k of ["tel", "mail", "proxy", "model", "key", "pass"]) {
      if (src.has(k)) { s[k] = src.get(k); changed = true; }
    }
    if (!changed) return;
    if (h.has("key")) s.mode = "direct"; else if (q.has("proxy") || h.has("proxy")) s.mode = "proxy";
    store.set(LS_SETTINGS, s);
    history.replaceState(null, "", location.pathname);
    toast("設定を読み込みました。すぐ使えます");
  })();

  $("#btnShareSetup").addEventListener("click", async () => {
    const key = $("#s_key").value.trim();
    if (!key) return toast("先にAPIキーを入力してください");
    const p = new URLSearchParams({ key });
    const tel = $("#s_tel").value.trim(), mail = $("#s_mail").value.trim();
    if (tel) p.set("tel", tel); if (mail) p.set("mail", mail);
    const url = `${location.origin}${location.pathname}#${p.toString()}`;
    const text = "修繕AI判定ツールの設定リンクです。スマホで開くと設定が終わります（社外秘：転送しないでください）。開いたら「ホーム画面に追加」してください。";
    try {
      if (navigator.share) await navigator.share({ title: "修繕AI判定 設定リンク", text, url });
      else { await navigator.clipboard.writeText(`${text}\n${url}`); toast("リンクをコピーしました"); }
    } catch (err) { if (err.name !== "AbortError") toast("共有できませんでした"); }
  });

  updateFooter();

  // テスト用フック
  window.__repairai = { state, renderResult, buildRequestText, systemPrompt, schema };
})();
