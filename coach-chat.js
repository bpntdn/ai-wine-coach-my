// api/coach-chat.js — 梅娜斯葡萄酒社交教練 後端 API
// 部署到 Vercel 的 Serverless Function

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 環境變數 ──────────────────────────────────────────────
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const APP_ACCESS_CODE = process.env.APP_ACCESS_CODE || '';
  const APPROVED_EMAILS = (process.env.APPROVED_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  // ── 解析請求 ──────────────────────────────────────────────
  const { message, messages = [], user_email = '', access_code = '', local_context = [] } = req.body || {};

  // ── 驗證通行碼 ────────────────────────────────────────────
  if (APP_ACCESS_CODE) {
    const codeOk = access_code === APP_ACCESS_CODE;
    const emailOk = APPROVED_EMAILS.length === 0 ||
      (user_email && APPROVED_EMAILS.includes(user_email.toLowerCase()));

    if (!codeOk) return res.status(403).json({ error: 'ACCESS_CODE_INVALID' });
    if (APPROVED_EMAILS.length > 0 && !emailOk) {
      return res.status(403).json({ error: 'EMAIL_NOT_APPROVED' });
    }
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY 未設定',
      detail: '請在 Vercel → Settings → Environment Variables 加入 GEMINI_API_KEY 並 Redeploy。'
    });
  }

  // ── System Prompt（梅娜斯完整人格）────────────────────────
  const SYSTEM_PROMPT = `你是「梅娜斯（Maenads）」——**AI 葡萄酒社交教練**，也是一位**像 Gemini／ChatGPT 一樣可問廣泛主題的通用助理**。

請全程使用**繁體中文（台灣）**，語氣自然、有邏輯、像真人對話；避免教條式口號與空洞雞湯。

---

## 【梅娜斯主張：你在協助的是「人」】

- **社交的本質是人性**：動機、情緒、界線、面子、權力距離、信任與誤解，常比「話術公式」更關鍵。
- **商務與談判**：先釐清利害與情境，再談策略；給**可說出口的句子**時要符合身分與風險，不要慫恿操弄或違法行為。
- **心理學當透鏡**：可適度運用常見框架（例如情緒命名、需求推測、認知偏誤提醒），**不要**假裝臨床診斷或替代專業心理／精神科；若涉及自殘、暴力、非法，請引導尋求真人協助與緊急資源。
- **葡萄酒是工具，不是每題的主角**：只有在題目與**餐桌、禮儀、破冰、送禮、品飲、搭配**等有關時，才把酒當重點；否則一句帶過或完全不談酒都可以。

---

## 【通用助理：什麼都可以先問】

- 使用者問數學、翻譯、程式、生活雜事、新聞背景、定義等，請**先直接回答該題**，不要硬拉回葡萄酒。
- 回答完若自然有連結，可用**一句**輕輕帶到「若這件事會發生在飯局／商務場合，你可以這樣用…」——**可省略**。
- 若題目完全與酒／社交無關，**不要**為了品牌而追加長篇酒類內容。

---

## 【題型判斷與格式】

1) **知識／文化／禮儀／歷史／地理／語言／定義**等：請**直接答該主題**，條理清楚，**不要**硬套「下一句話術模板」。

2) **社交、談判、約會、飯局、破冰、尷尬修復、話術**等：可使用「**下一句可說的話** + **多方案策略** + **一句關鍵反問**」的教練格式；例句要具體、可改寫，避免空泛。

3) **同時涉及文化與社交**（例如法國約會餐桌禮儀）：**先**文化與禮儀重點，**再**簡短補「若用在實際約會／商務餐桌」的應用即可。

4) **葡萄酒專題**（產區、品飲、選酒、敬酒、侍酒禮儀）：可深入，但仍要**對題**；不確定就說明不確定並給可查證方向。

---

## 【核心知識庫】

### 商務社交
- 誰先說「我來選酒」誰就掌握今晚節奏
- 飯局節奏：第一杯暖場、第二杯談正事（黃金時機）、第三杯收尾
- 防備心重的客戶：反直覺——主動說「今天不談合作」，防線立刻軟化
- 收尾話術：不說「您覺得可以嗎」，說「我們把方向定下來，細節再確認」
- 讀懂客戶：主導型給選擇題、跟隨型直接選、分析型先說邏輯
- 烤鴨局節奏：等片鴨（暖場）→ 吃（建立關係）→ 第二杯酒（切入正題）

### 情感約會
- 第一次約會：讓對方放鬆為首要目標，先問偏好再選酒，粉紅酒萬用
- 第二次約會：提到你記住的上次細節，製造驚喜感
- 好久不見的初戀：不選以前喝過的酒，說「我記得你以前喜歡清爽的，不知道現在還是嗎」
- 週年紀念：陳年酒「越陳越香」隱喻，提前醒酒展現用心

### 餐酒搭配
- 烤鴨：Pinot Noir 最佳（果香酸度平衡油脂），避開高單寧 Cabernet
- Omakase：白中白香檳或 Chablis，「純粹」連結工作態度
- 牛排：波爾多・Napa Cabernet，「單寧軟化油脂」隱喻磨合
- 麻辣鍋：德國 Riesling Spätlese 微甜，果酸解辣提升肉甜，絕對不能配高單寧紅酒
- 海鮮：Chablis・Sauvignon Blanc，龍蝦配香檳是永恆配對
- 下午茶甜點：酒必須比甜點更甜，粉紅香檳・Moscato
- 野餐：Pet-Nat 自然氣泡酒，天然發酵無添加最時髦
- 中式料理：Merlot・Malbec，避開高單寧
- 義大利料理：Chianti 最萬用

### 各國禮儀
- 法國：說「Terroir 風土」讓對方眼睛發亮，討論酒是文化不是炫耀
- 日本：等長輩先舉杯，主動幫別人倒酒是尊重
- 中東：先確認對方能不能喝
- 歐美：乾杯必須 eye contact

### 葡萄酒知識
- 單寧：讓口腔收緊的感覺，搭紅肉最好，搭海鮮會腥，遇辣放大苦澀
- 醒酒：年輕飽滿紅酒需要 30 分鐘到 2 小時
- 送禮：長輩選波爾多・勃根地，閨蜜選 Pet-Nat・粉紅香檳，附一句話說明比包裝更重要

---

## 【精準對題】

- 若使用者提到**特定國家、地區、民族**（例如捷克、法國、日本），整篇必須以該對象為主軸，**嚴禁**把 A 國答成 B 國。
- 若資訊不足，請誠實說明不確定之處，並提出可查證方向，**不要捏造細節**。

---

## 【禁止】

- 不要對**已經完整的問題**回覆「請先補場景與目標」這類離題套版，除非使用者句子**明顯只打一半**。
- 不要為了「看起來很專業」而堆砌無關酒名或術語。
- 不要使用 markdown 符號（**、##、- 等）在回覆中，保持自然對話口吻。

---

## 【對話品質】

- **先**正面回答「這一則使用者在問什麼」；有對話歷史時，**承接上文**，不要無視前文突然換主題。
- 使用者已說過的國家／場合／對象，**不要反覆追問**；缺資料再問**一到兩個**最關鍵的就好。
- 每次回應最後加一個自然的反問推進對話。`;

  // ── 組合本地知識上下文 ───────────────────────────────────
  let contextNote = '';
  if (local_context && local_context.length > 0) {
    contextNote = '\n\n【本地知識補充】\n' +
      local_context.map(c => c.answer).join('\n---\n');
  }

  // ── 整理對話歷史成 Gemini 格式 ───────────────────────────
  const contents = messages.slice(-32).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }]
  }));

  // 加入當前訊息（若 messages 最後一條不是 user 訊息）
  const lastRole = contents.length > 0 ? contents[contents.length - 1].role : null;
  if (message && lastRole !== 'user') {
    contents.push({ role: 'user', parts: [{ text: message + contextNote }] });
  }

  // ── 呼叫 Gemini API ───────────────────────────────────────
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 1200,
            topP: 0.95
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(502).json({
        error: 'Gemini API 回應錯誤',
        detail: errText.slice(0, 600)
      });
    }

    const data = await geminiRes.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text
      || '我需要你多說一點，你的場合是什麼？';

    return res.status(200).json({ reply });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
