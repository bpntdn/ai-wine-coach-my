
const { loadMaenadsSystemPrompt } = require("../ai/system-prompt");
const { retrieveCoachContext } = require("./coach-kb");
const { normalizeHistoryExcludingLatestUser, buildGeminiContents, buildOpenAiMessages, clampHistoryMaxTurns, buildEmergencyReply } = require("./chat");
const { generateGeminiContent } = require("./gemini-generate-content");
const { generateOpenAiChatCompletion } = require("./openai-chat-completions");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const APPROVED_EMAILS = (process.env.APPROVED_EMAILS || "").split(",").filter(Boolean);
const PASSPHRASE = process.env.PASSPHRASE;

module.exports = async (req, res) => {
  const { message, messages, local_context, email, passphrase } = req.body;

  // 身份驗證邏輯
  if (PASSPHRASE) {
    if (passphrase !== PASSPHRASE) {
      return res.status(403).json({ error: 'INVALID_PASSPHRASE' });
    }
    if (APPROVED_EMAILS.length > 0 && !APPROVED_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'EMAIL_NOT_APPROVED' });
    }
  }

  // LLM 金鑰檢查
  if (!GEMINI_API_KEY && !OPENAI_API_KEY) {
    return res.status(500).json({
      error: '未設定 LLM 金鑰',
      detail:
        '請在 Vercel → Environment Variables 設定 GEMINI_API_KEY 或 OPENAI_API_KEY（建議兩者皆設以自動備援），並 Redeploy。',
    });
  }

  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }

  let contextNote = '';
  const frontendLocal = Array.isArray(local_context) ? local_context : [];
  const serverRag = retrieveCoachContext(message, 5); // 增加檢索數量以提供更豐富的上下文

  const mergedContextRows = [
    ...frontendLocal
      .map((c) => (c && typeof c.answer === 'string' ? c.answer.trim() : ''))
      .filter(Boolean),
    ...serverRag.map((r) => r.text),
  ];

  if (mergedContextRows.length > 0) {
    // 優化 RAG 內容的呈現方式，明確告知 LLM 這是補充知識
    contextNote = '\n\n【以下是為您提供的補充知識，請參考這些資訊來回答問題：】\n' + mergedContextRows.join('\n---\n');
  }

  const priorHistory = normalizeHistoryExcludingLatestUser(messages, message);
  const currentUserText = message + contextNote; // 將補充知識併入當前用戶問題

  const maxTurns = clampHistoryMaxTurns(process.env.GEMINI_HISTORY_MAX_TURNS);
  const SYSTEM_PROMPT = loadMaenadsSystemPrompt();

  const maxOut = Math.min(
    8192,
    Math.max(512, parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '2048', 10) || 2048),
  );

  const openaiFirst = /^(1|true|yes)$/i.test(String(process.env.OPENAI_FIRST || '').trim());
  const openaiModel = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

  /** 統一成功回傳形狀，前端可看 provider 判斷是否雲端模型 */
  function respondLive(provider, payload) {
    return res.status(200).json({
      ...payload,
      mode: 'llm_live',
      provider,
      sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
    });
  }

  async function callGemini() {
    if (!GEMINI_API_KEY) return { ok: false, detail: 'NO_GEMINI_KEY' };
    const contents = buildGeminiContents(priorHistory, currentUserText, maxTurns); // 確保 RAG 內容已包含在 currentUserText 中
    return generateGeminiContent(GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        temperature: 0.85, // 略微提高溫度以鼓勵更多樣化的回答
        maxOutputTokens: maxOut,
        topP: 0.95,
      },
    });
  }

  async function callOpenAI() {
    if (!OPENAI_API_KEY) return { ok: false, detail: 'NO_OPENAI_KEY' };
    const openAiMessages = buildOpenAiMessages(priorHistory, currentUserText, maxTurns, SYSTEM_PROMPT); // 傳遞 SYSTEM_PROMPT 以便在 OpenAI 格式中正確使用
    return generateOpenAiChatCompletion(OPENAI_API_KEY, {
      messages: openAiMessages,
      model: openaiModel,
      temperature: 0.85, // 略微提高溫度以鼓勵更多樣化的回答
      maxTokens: Math.min(4096, maxOut),
    });
  }

  try {
    let geminiDetail = '';
    let openaiDetail = '';

    if (openaiFirst && OPENAI_API_KEY) {
      const oFirst = await callOpenAI();
      if (oFirst.ok) {
        return respondLive('openai', {
          reply: oFirst.reply,
          model: oFirst.model,
          finishReason: oFirst.finishReason || undefined,
        });
      }
      openaiDetail = String(oFirst.detail || '');

      const gSecond = await callGemini();
      if (gSecond.ok) {
        const finalReply =
          gSecond.reply ||
          '我需要你多說一點：這次是什麼場合、對象是誰、你希望達成什麼？';
        return respondLive('gemini', {
          reply: finalReply,
          model: gSecond.model,
          finishReason: gSecond.finishReason || undefined,
        });
      }
      geminiDetail = String(gSecond.detail || '');
    } else {
      const gFirst = await callGemini();
      if (gFirst.ok) {
        const finalReply =
          gFirst.reply ||
          '我需要你多說一點：這次是什麼場合、對象是誰、你希望達成什麼？';
        return respondLive('gemini', {
          reply: finalReply,
          model: gFirst.model,
          finishReason: gFirst.finishReason || undefined,
        });
      }
      geminiDetail = String(gFirst.detail || '');

      const oSecond = await callOpenAI();
      if (oSecond.ok) {
        return respondLive('openai', {
          reply: oSecond.reply,
          model: oSecond.model,
          finishReason: oSecond.finishReason || undefined,
        });
      }
      openaiDetail = String(oSecond.detail || '');
    }

    const combinedDetail = [openaiDetail && `OPENAI:${openaiDetail}`, geminiDetail && `GEMINI:${geminiDetail}`]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1600);

    return res.status(200).json({
      reply: buildEmergencyReply(message, priorHistory),
      model: 'emergency-fallback',
      mode: 'fallback',
      provider: 'fallback',
      finishReason: 'UPSTREAM_UNAVAILABLE',
      sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
      detail: combinedDetail,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
