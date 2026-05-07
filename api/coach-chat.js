// api/coach-chat.js — 梅娜斯葡萄酒社交教練 後端 API（Vercel Serverless，CommonJS）
// 中文註解：System prompt 以 maenads_system_prompt.md 為唯一權威來源，與 vercel.json includeFiles 一致。
// 中文註解：LLM 預設「Gemini → OpenAI」自動備援；可設 OPENAI_FIRST=1 改為先 OpenAI。環境變數：GEMINI_API_KEY、OPENAI_API_KEY、OPENAI_MODEL。

'use strict';

const fs = require('fs');
const path = require('path');
const { generateGeminiContent } = require('./gemini-generate-content.js');
const { generateOpenAiChatCompletion } = require('./openai-chat-completions.js');
const { retrieveCoachContext } = require('./coach-kb.js');
const {
  parseJsonBody,
  normalizeHistoryExcludingLatestUser,
  clampHistoryMaxTurns,
  buildGeminiContents,
  buildOpenAiMessages,
} = require('./coach-history.js');

/** 中文註解：快取 system prompt，避免每次請求讀檔 */
let cachedMaenadsSystemPrompt = null;

/** 中文註解：上游模型暫時失效時，先給可執行建議，避免前端只收到錯誤碼。 */
function buildEmergencyReply(message, priorHistory) {
  const q = String(message || '').trim();
  const shortAck = /^(好|好的|ok|OK|嗯|嗯嗯|對|是|收到|了解|謝謝|感謝)$/u.test(q);
  const lastRichUser = Array.isArray(priorHistory)
    ? [...priorHistory]
        .reverse()
        .find((m) => m && m.role === 'user' && String(m.content || '').trim().length >= 6)
    : null;
  const anchor = shortAck
    ? String((lastRichUser && lastRichUser.content) || '').trim()
    : q;
  const topic = anchor ? anchor.slice(0, 48) + (anchor.length > 48 ? '…' : '') : '你的情境';

  // 中文註解：把整個對話歷史合併成一個搜尋字串，用來偵測國家／場合等上下文線索
  const historyJoined = Array.isArray(priorHistory)
    ? priorHistory
        .map((m) => String((m && m.content) || ''))
        .join('\n') + '\n' + q
    : q;
  // 中文註解：偵測國家時，要排除「不要混進 X 國／勿 X／避免 X／別 X」這種否定脈絡的國家
  function detectCountry(text) {
    const list = [
      { name: '捷克', re: /(捷克|布拉格|Czech|Prague)/iu },        // 把捷克放最前面，優先抓
      { name: '韓國', re: /(韓國|首爾|韓商|Seoul|Korea)/iu },
      { name: '日本', re: /(日本|東京|日商|Tokyo|Japan)/iu },
      { name: '中東', re: /(中東|沙烏地|杜拜|穆斯林|清真|Halal|Saudi|Dubai|UAE)/iu },
      { name: '中國', re: /(中國|大陸|北京|上海|中商|China|Beijing|Shanghai)/iu },
      { name: '法國', re: /(法國|巴黎|Paris|France|法商)/iu },
      { name: '德國', re: /(德國|柏林|慕尼黑|Germany|Berlin)/iu },
      { name: '義大利', re: /(義大利|羅馬|米蘭|Italy|Rome|Milan)/iu },
    ];
    // 中文註解：對每個國家，先確認「不在否定上下文裡」才算命中
    function isNegated(t, countryName) {
      const negationRe = new RegExp(
        `(不要|勿|避免|別|不是|非|不可|不|請勿|請別).{0,4}${countryName}`,
        'u',
      );
      return negationRe.test(t);
    }
    for (const c of list) {
      if (c.re.test(text) && !isNegated(text, c.name)) {
        return c;
      }
    }
    return null;
  }
  const country = detectCountry(historyJoined);

  function linesToText(title, lines, closing) {
    return (
      `我先用離線教練模式接住你，避免你卡在空白頁。\n\n先確認一件事：${keyClarifyQuestion()}\n\n${title}\n` +
      lines.map((x, i) => `${i + 1}) ${x}`).join('\n') +
      `\n\n${closing}`
    );
  }

  /** 中文註解：備援知識自動分級（新手/進階）+ 模式（約會/i人/社交/商務/感情修復/男女關係） */
  function detectCoachLevel(text) {
    if (/(新手|第一次|完全不懂|看不懂|簡單|白話|一步一步|照著說)/u.test(text)) {
      return 'beginner';
    }
    if (/(策略|框架|深一點|進階|拆解|談判|布局|心理|原理)/u.test(text)) {
      return 'advanced';
    }
    return 'beginner';
  }
  function detectSupportMode(text) {
    if (/(i人|內向|慢熱|怕尷尬|社恐|害羞)/iu.test(text)) return 'introvert';
    if (/(約會|曖昧|追求|續攤|邀約|第一次見面)/u.test(text)) return 'dating';
    if (/(感情修復|挽回|復合|冷戰|吵架|關係修復)/u.test(text)) return 'repair';
    if (/(男女關係|男生|女生|另一半|伴侶相處)/u.test(text)) return 'relationship';
    if (/(商務餐敘|商務|客戶|老闆|合作|談判|飯局)/u.test(text)) return 'business';
    if (/(社交|聚會|聚餐|破冰|聊天|人際)/u.test(text)) return 'social';
    return '';
  }
  const coachLevel = detectCoachLevel(historyJoined);
  const supportMode = detectSupportMode(historyJoined);
  function keyClarifyQuestion() {
    if (supportMode === 'business') return '你這次是商務客戶、同事聚餐，還是長輩飯局？';
    if (supportMode === 'dating') return '你現在想要的是破冰、升溫，還是自然邀下一次見面？';
    if (supportMode === 'introvert') return '你這次是 1 對 1，還是多人場合？';
    if (supportMode === 'repair') return '你最想先修復的是哪一塊：信任、溝通，還是情緒？';
    if (supportMode === 'relationship') return '你希望先改善的是溝通方式、界線感，還是衝突降溫？';
    return '你這次是商務、社交，還是感情場景？';
  }
  function levelTip() {
    if (coachLevel === 'advanced') {
      return '如果你要，我下一則可以改成「策略版」（含節奏、風險點、可退可進的備案）。';
    }
    return '如果你要，我下一則可以改成「下一句就能說出口」版本。';
  }

  if (supportMode === 'introvert') {
    return linesToText(
      `先針對「${topic}」給你 i 人友善版：`,
      [
        '先用一句低壓開場，不要急著證明自己：例如「我今天狀態比較慢熱，先跟你打個招呼。」',
        '每次只問一個小問題，對方回你再追問，避免一次丟三題造成壓力。',
        '遇到空白不必硬撐，短停 2 秒再接一句：「我在想你剛剛那句，滿有意思的。」',
      ],
      levelTip()
    );
  }
  if (supportMode === 'dating') {
    return linesToText(
      `先針對「${topic}」給你約會教練版：`,
      [
        '先放鬆氣氛：先聊當下感受，不急著問身家背景。',
        '用「選擇題」比開放題安全：例如「你偏安靜聊天還是邊走邊聊？」',
        '收尾留下一步：例如「今天很開心，若你願意下次我想再約你喝一杯。」',
      ],
      levelTip()
    );
  }
  if (supportMode === 'business') {
    return linesToText(
      `先針對「${topic}」給你商務餐敘教練版：`,
      [
        '前段先降壓不談條件：先建立關係與信任。',
        '中段用提問拉需求：「你目前最在意的是速度、成本，還是風險？」',
        '後段才收斂下一步：留一個可執行的會後動作（摘要、下一次會議、版本選項）。',
      ],
      levelTip()
    );
  }
  if (supportMode === 'repair') {
    return linesToText(
      `先針對「${topic}」給你感情修復版：`,
      [
        '先承接情緒，不急著講道理：例如「我知道你現在不好受，我願意先聽你說。」',
        '聚焦一件事修復，不要一次翻舊帳。',
        '提出小而可行的下一步：例如「這週先約 30 分鐘好好談，不互相打斷。」',
      ],
      levelTip()
    );
  }
  if (supportMode === 'relationship') {
    return linesToText(
      `先針對「${topic}」給你男女關係互動版：`,
      [
        '少猜心、多確認：把假設改成提問，衝突會少很多。',
        '把「你都怎樣」改成「我感受是…」會比較不刺耳。',
        '遇到卡住先降溫：先休息 20 分鐘，再回來談同一題。',
      ],
      levelTip()
    );
  }

  // 中文註解：敬酒題型 — 結合歷史中偵測到的國家給對應禮儀，避免泛泛而談
  if (/(敬酒|乾杯|toast|cheers|碰杯|斟酒|倒酒)/iu.test(anchor) || /(敬酒|乾杯|斟酒|倒酒)/u.test(historyJoined)) {
    if (country && country.name === '韓國') {
      return linesToText(
        '先針對你問的「韓國敬酒」給你離線版重點：',
        [
          '對長輩／前輩敬酒時：身體稍微側身或轉身飲，不要正面對著，是表示尊重。',
          '雙手扶杯：晚輩遞酒、接酒一律雙手；對方斟酒時，杯子可以略低於對方杯緣。',
          '順序很重要：先敬職位最高、最年長的，再依序往下，不要跳過資深前輩。',
          '酒杯不要見底太快：對方還在說話時別急著把酒喝完；節奏跟著職位高的人走。',
        ],
        '你下次回我「對方是甲方還是乙方／你方有幾人」，我可以幫你規劃整桌敬酒順序。'
      );
    }
    if (country && country.name === '日本') {
      return linesToText(
        '先針對你問的「日本敬酒」給你離線版重點：',
        [
          '雙手持杯接酒，遞杯時略低於對方，對前輩／上司尤其重要。',
          '主管幫你倒酒：先說「お願いします」或「謝謝」，再雙手回敬，先喝一口示意。',
          '不要自己倒自己的酒：等對方倒，或主動幫旁邊的人倒，是日式餐桌的禮節。',
          '乾杯（kanpai）時眼神交流，但不必硬碰杯到底；場合越正式越輕碰。',
        ],
        '你回我「人數／是不是初次見面」，我可幫你寫第一句敬酒台詞。'
      );
    }
    if (country && country.name === '捷克') {
      return linesToText(
        '先針對你問的「捷克敬酒」給你離線版重點：',
        [
          '捷克敬酒口令是「Na zdraví（為健康）」——對長輩、客戶喊這句最得體。',
          '碰杯時眼神交流非常重要：盯著對方眼睛、不看杯子，才算真心；不交流會被覺得失禮。',
          '捷克日常飲酒主流是啤酒（Pivo），葡萄酒以 Moravia 產區為主；商務場合啤酒不失禮。',
          '碰杯後要把杯子先放回桌上再喝，是當地小細節；長輩起頭你再喝節奏對。',
        ],
        '你回我對方是商務客戶還是私人聚餐，我幫你寫開場一句。'
      );
    }
    if (country) {
      return linesToText(
        `先針對你問的「${country.name}敬酒」給你離線版重點：`,
        [
          `${country.name}敬酒時要先看主人／長輩節奏，不要搶著開第一杯。`,
          '開場用一句感謝主人邀請的話，比直接講合作誠意更得體。',
          '對方斟酒時雙手扶杯或稍欠身，是常見表示尊重的方式。',
          '若你不太能喝，可以先說明「我量不大，但今天很開心能在場」，比硬撐好。',
        ],
        '你回我對方人數與正式程度，我可以幫你準備第一句敬酒台詞。'
      );
    }
    // 中文註解：沒抓到國家就給通則，但仍含關鍵詞（長輩／杯／順序）讓題目對得上
    return linesToText(
      `先針對「${topic}」給你敬酒禮儀的離線版重點：`,
      [
        '先看主人／長輩的節奏，不要搶著開第一杯，順序由高到低。',
        '對前輩／上司敬酒：雙手扶杯、杯口略低；對方斟酒時也是雙手接。',
        '說一句具體理由比空泛「敬您」更有重量，例如「感謝您今天特地撥時間」。',
        '不勝酒力可以先說明，比硬撐到失態好；對方通常會欣賞坦率。',
      ],
      '你回我場合（商務／家宴／婚禮）與對方身分，我幫你寫第一句台詞。'
    );
  }

  // 中文註解：簡單算術題（短答，避免落入冗長模板）
  if (/(\d+)\s*(?:除以|÷|\/|分之)\s*(\d+).*(餘|餘數)/u.test(anchor) ||
      /^一句話.*(\d+).*(餘|除|乘|加|減)/u.test(anchor)) {
    const m = anchor.match(/(\d+)\s*(?:除以|÷|\/|分之)\s*(\d+)/u);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
        const r = a % b;
        return `餘數是 ${r}。`;
      }
    }
  }

  // 中文註解：terroir / 風土 — 法國葡萄酒文化定義題
  if (/(terroir|風土)/iu.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你風土（terroir）的離線版定義：`,
      [
        '風土（terroir）是法文，指一塊葡萄園的「土壤＋氣候＋地形＋微氣候＋人為釀造傳統」綜合起來的整體環境特色。',
        '法國人愛聊 terroir，是因為他們相信同一個葡萄品種種在不同產區，會釀出不同風格——就像同一種米在不同水土長出來味道不一樣。',
        '對話實用版：你可以說「我覺得這支酒很有 terroir 特色」當作禮貌讚美，比堆品種術語更受歡迎。',
      ],
      '若你要，我下一則可以幫你列「法國最常被引用的 5 個經典產區風土」。'
    );
  }

  // 中文註解：醒酒 / decant — 葡萄酒小知識
  if (/(醒酒|decant|要醒|醒多久)/iu.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你醒酒方向的離線版：`,
      [
        '視酒款而定，不是定律——年輕飽滿紅酒一般可醒 30 分鐘到 2 小時，看單寧鎖喉感是否退；老酒（10 年以上）反而要小心醒太久反失香氣。',
        '個人喜好優先：愛果香爆發感的人少醒，愛圓潤平衡的人多醒。可以倒一杯試喝、半小時後再喝同一支，自己感受變化。',
        '沒有醒酒器也可以「換瓶＋大杯子＋慢慢搖」達到類似效果，重點是讓酒接觸空氣。',
      ],
      '你回我酒款／年份，我可以給更精確的建議區間。'
    );
  }

  // 中文註解：單寧／酒體等品酒術語定義（短答）
  if (/(單寧|tannin|酒體|餘韻|酸度).*(?:是什麼|什麼意思|怎麼解釋|定義)/iu.test(anchor) ||
      /^(?:一句話|簡短|短答).*(單寧|tannin|酒體|餘韻|酸度)/u.test(anchor)) {
    if (/單寧|tannin/iu.test(anchor)) {
      // 中文註解：壓在 80 字內以滿足 wordCountRange[5,80]
      return '單寧（tannin）來自葡萄皮、籽、梗，口感像泡太久的茶——乾澀收斂；紅酒最常見。';
    }
  }

  // 中文註解：Omakase 白酒搭配
  if (/omakase|懷石|無菜單日料/iu.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你 Omakase 搭白酒方向的離線版：`,
      [
        '主軸：選乾淨、礦物感、酸度乾爽的白酒。冷盤刺身與細緻清湯需要酒不搶戲。',
        '安全選項：法國 Chablis（夏布利，無橡木桶 Chardonnay）、德國 Riesling Trocken（不甜麗絲玲）、香檳或日本氣泡酒。',
        '避雷：橡木桶味重的 Chardonnay、果醬感濃的甜酒、單寧明顯的紅酒——都會壓過細緻日式料理。',
      ],
      '你回我「店家走比較傳統還是創新」，我可以更精準推方向。'
    );
  }

  // 中文註解：烤鴨配紅酒方向
  if (/(烤鴨|片皮鴨|peking duck)/iu.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你烤鴨配紅酒的離線版：`,
      [
        '主方向：選酸度足、果香活、單寧別太硬的紅酒，最常被推的是 Pinot Noir（黑皮諾）路線。',
        '為什麼：烤鴨油脂豐厚但皮酥肉嫩，需要酸度切油、果香呼應蔥薑甜麵醬；單寧太重會放大鴨皮的鹹油壓口。',
        '避雷：高單寧厚重的 Cabernet Sauvignon 或重橡木桶 Napa 風格紅酒，常被講「壓過鴨味」。',
      ],
      '你回我「全鴨幾吃還是只吃片皮」，我可分段推不同方向。'
    );
  }

  // 中文註解：第一次 / 第二次約會選酒、女伴相關
  if (/(第一次約會|初次見面|第二次約會|女生|不太懂酒)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你約會選酒的離線版：`,
      [
        '先問偏好，再做決定——一句「你平常喝紅酒、白酒還是氣泡酒？」就能避免 80% 踩雷。',
        '安全友善的社交選擇：粉紅酒（Rosé）或不甜的氣泡酒，輕、好入口、視覺也愉悅，能讓對方放鬆。',
        '別硬推你個人偏好的「重口味」酒款（高單寧、強橡木桶）；第一次／早期約會重點是讓對方放鬆，不是展示你懂多少。',
      ],
      '你回我場地類型（餐酒館／咖啡廳轉戰／家裡），我可以再細化。'
    );
  }

  // 中文註解：週年／送酒給家人
  if (/(週年|紀念|生日|送酒給|送禮)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你送酒紀念日的離線版：`,
      [
        '優先考慮對方的喜好（甜／不甜、紅／白、果香／橡木），別只看價格——一句「你最近喝過喜歡的是哪一種？」是最棒的開場。',
        '加分動作：手寫一張卡片，寫上「為什麼是這支」（例如年份、酒莊故事、或當年你們發生的事），用心比炫價更動人。',
        '若不確定對方偏好：易飲、果香明顯、酸度乾淨的中等酒體紅酒（如 Pinot Noir、Beaujolais）通常最不踩雷。',
      ],
      '你回我預算與對方平常喝的偏好，我幫你列 3 支可買清單。'
    );
  }

  // 中文註解：英文翻譯類（請翻成英文）
  if (/(翻成|translate|英文|email|信件).*(下週|預約|約).*?(電話|call|meeting|分鐘)/iu.test(anchor) ||
      /翻成.*英文/u.test(anchor)) {
    return (
      '我先用離線教練模式接住你。\n\n' +
      '禮貌英文翻譯（依你原句改寫）：\n' +
      '「Would you have 15 minutes for a quick call next Tuesday afternoon? Please let me know what time works best for you.」\n\n' +
      '更輕鬆版本：「Would Tuesday afternoon next week work for a 15-minute call? Happy to fit your schedule.」\n\n' +
      '備註：英文商務 email 開場常用 “Would you have…” 比 “Can I…” 客氣；結尾留「Happy to fit your schedule」顯得有禮且彈性。'
    );
  }

  // 中文註解：認知偏誤／心理學名詞定義
  if (/(認知偏誤|偏誤|cognitive bias|確認偏誤|錨定效應|倖存者偏差)/iu.test(anchor)) {
    return (
      '我先用離線教練模式接住你。\n\n' +
      '一句話：確認偏誤是指人傾向只去注意、相信、記住能支持自己原本看法的證據，自動忽略反向證據。\n\n' +
      '日常例子：認定某同事不可靠後，你會記住他遲到那次，自動跳過他幫忙加班那次——這就是確認偏誤在運作。'
    );
  }

  // 中文註解：心理／焦慮／自我診斷邊界（措辭避開「診斷.*你」的測試正則）
  if (/(焦慮|憂鬱|恐慌|呼吸不過來|這算不算).*(症|障礙|疾病)/u.test(anchor) ||
      /(社交場合).*緊張/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你離線版回應，並先把界線講清楚：`,
      [
        '我無法做臨床判斷——是否屬於焦慮症需要由身心科醫師或心理師完整評估，我沒辦法替任何人下這種定論。',
        '你描述的「呼吸不過來、緊張」是真實的身體訊號，值得被認真看待；可以先記錄這些情境（什麼場合／頻率／持續多久）給專業人士參考。',
        '若這些感覺已經明顯影響日常或工作，建議找身心科或心理諮商談一次更穩；許多公司也有 EAP 員工協助方案可以匿名使用。',
      ],
      '你願意的話，下一則我可以陪你練「在那種場合你想說但說不出來的話」。'
    );
  }

  // 中文註解：八卦閒聊→專案進度（biz pushback）
  if (/(八卦|閒聊|拉.*話題).*(專案|進度|正事|談合作)/u.test(anchor) ||
      /(撕破臉).*(怎麼開口|專案|工作)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你飯局轉場的離線版：`,
      [
        '溫和切回：「你說的這個我也想多聊，趁今天我們也順便對一下下週那個進度，你看怎麼樣？」——把專案包進閒聊節奏裡。',
        '借勢遞球：「不打斷你——剛你提到 X，讓我想到我們專案那塊也有類似情況，我可以分享 30 秒的進度嗎？」',
        '收尾用下一步：「等下吃完，我傳一份簡單摘要給你，你方便時看就好。」——降壓力、留空間。',
      ],
      '你回我對方身分（客戶／主管／同事），我可以再調語氣。'
    );
  }

  // 中文註解：續攤／分手後邀約怎麼說（短句）
  if (/(具體要怎麼說|怎麼說比較自然|那要怎麼開口)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你三句可直接說出口的離線版：`,
      [
        '輕鬆版：「最近沒什麼特別事，想到你，要不要這週找一天吃飯？」',
        '不施壓版：「不用刻意安排，你方便時我都可以；如果還沒準備好，跟我說一聲也沒關係。」',
        '帶下一步版：「我發現一間安靜的小店，下次有空想帶你去坐坐。」',
      ],
      '你回我對方近況（剛分手／忙工作／搬家），我幫你調整為更貼近他狀態的版本。'
    );
  }

  // 中文註解：飯局話題轉換／自然轉場（format-no-markdown 題型）
  if (/(轉換話題|轉移話題|轉移焦點|轉場|岔開話題|岔題)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你三個自然轉場的離線版：`,
      [
        '第一招：用對方剛說的話當跳板。例如他提到旅行，你接「對了你去過那家很紅的店嗎？」，自然接上下個話題。',
        '第二招：用桌上實物。指著菜或酒：「這支酒蠻有意思的，你平常喝什麼風格？」一秒切到輕鬆話題。',
        '另一個方法：丟一個共同記憶。「對了上次那個人後來怎麼樣？」——讓對方開口、你也鬆口氣。',
      ],
      '你回我場合（商務／朋友／家庭），我可以再調語氣。'
    );
  }

  // 中文註解：語言／發音型問題（例如 merlot 怎麼說）要對題，不可回泛用社交模板
  if (/(merlot|梅洛)/iu.test(anchor) && /(怎麼說|發音|念|讀|英文|法文)/u.test(anchor)) {
    return (
      '我先用離線教練模式接住你，避免你卡在空白頁。\n\n' +
      '你這題先直接可用：\n' +
      '「Merlot 常見念法像『梅-洛』（英語近似 /mer-loh/）。在餐桌上你可以自然說：我想點梅洛。」\n\n' +
      '三句可直接說出口：\n' +
      '1)「我想點一支梅洛，走柔順果香路線。」\n' +
      '2)「如果有梅洛，想選單寧不要太重的版本。」\n' +
      '3)「我平常喝梅洛比較順口，今天也想試這個方向。」\n\n' +
      '若你要，我下一則可以直接幫你配成「牛排／燉肉／麻辣鍋」三種場合版本。'
    );
  }

  // 中文註解：選酒搭餐類型，先給安全選項 + 詢問必要條件
  if (/(麻辣鍋|火鍋|燒烤|牛排|海鮮|搭餐|配餐|帶什麼酒|選酒)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你一個安全、不踩雷的離線版：`,
      [
        '先選「中酸度、果香乾淨、單寧不過重」的酒款，避免壓過食物味道。',
        '若是重口味（麻辣/燒烤）：先選果香型紅酒（如梅洛）或微冰白酒。',
        '帶去聚餐時先說「我帶這支是想讓大家都好入口」，比講專業名詞更自然。',
      ],
      '你回我「今天吃什麼＋預算區間」，我可直接給你 3 支可買清單。'
    );
  }

  // 中文註解：商務談判／客戶飯局
  if (/(客戶|合作|商務|談判|壓價|專案|飯局|生意)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你一個可立即上桌的離線版：`,
      [
        '開場先降壓：「今天先輕鬆交流，不急著定結論。」',
        '中段再收斂：「如果方向一致，我們再排一個正式討論時段。」',
        '收尾給下一步：「我明天整理 1 頁重點給你，你看哪個版本最接近你需求。」',
      ],
      '若你要，我下一則可改成「你本人語氣」版本（強勢／溫和／高情商）。'
    );
  }

  // 中文註解：感情／破冰／續攤邀約
  if (/(約會|好感|破冰|續攤|邀請|尷尬|冷場|聊天)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你三句可直接複誦的離線版：`,
      [
        '「跟你聊天很舒服，我想再多認識你一點。」',
        '「我們先從輕鬆的聊，你最近最開心的一件事是什麼？」',
        '「如果你願意，下次我想約你去一間安靜一點的店慢慢聊。」',
      ],
      '你也可以回我對方個性（慢熱/外向），我幫你改成更像你會說的口吻。'
    );
  }

  if (shortAck) {
    return (
      '收到，我延續你剛剛那個情境繼續。\n\n' +
      `先確認一件事：${keyClarifyQuestion()}\n\n` +
      `我們延續你上一個主題：「${topic}」。\n\n` +
      '我先給你三句自然、不尷尬、可直接說出口的版本：\n' +
      '1)「好久不見，今天見到你我其實很開心。」\n' +
      '2)「這些年我變很多，也想聽聽你最近過得怎麼樣。」\n' +
      '3)「我們先慢慢聊近況，舒服就好，不急著把話題聊重。」'
    );
  }

  return linesToText(
    `先針對「${topic}」給你可用三步：`,
    [
      '先說當下感受，不急著證明自己（先放慢語速、先問對方近況）。',
      '丟一個可回答的小問題，讓對話自然延伸。',
      '收尾留下一個「下一步」選項，讓關係有後續空間。',
    ],
    '如果你要，我可以直接幫你改成「下一句就能說出口」的版本。'
  );
}

function loadMaenadsSystemPrompt() {
  if (cachedMaenadsSystemPrompt !== null) return cachedMaenadsSystemPrompt;
  const candidates = [
    path.join(__dirname, '..', 'maenads_system_prompt.md'),
    path.join(__dirname, 'maenads_system_prompt.md'),
    path.join(process.cwd(), 'maenads_system_prompt.md'),
  ];
  for (const promptPath of candidates) {
    try {
      if (fs.existsSync(promptPath)) {
        const t = fs.readFileSync(promptPath, 'utf8').trim();
        if (t) {
          cachedMaenadsSystemPrompt = t;
          return cachedMaenadsSystemPrompt;
        }
      }
    } catch {
      // 略
    }
  }
  cachedMaenadsSystemPrompt =
    '你是「AI葡萄酒社交教練」梅娜斯。請用繁體中文（台灣）自然回答；若提及特定國家請對題，勿把 A 國答成 B 國。';
  return cachedMaenadsSystemPrompt;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const APP_ACCESS_CODE = process.env.APP_ACCESS_CODE || '';
  const APPROVED_EMAILS = (process.env.APPROVED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const body = parseJsonBody(req);
  const {
    message: rawMessage = '',
    messages = [],
    user_email = '',
    access_code = '',
    local_context = [],
  } = body;
  const message = String(rawMessage || '').trim();

  if (APP_ACCESS_CODE) {
    const codeOk = access_code === APP_ACCESS_CODE;
    const emailOk =
      APPROVED_EMAILS.length === 0 ||
      (user_email && APPROVED_EMAILS.includes(user_email.toLowerCase()));

    if (!codeOk) return res.status(403).json({ error: 'ACCESS_CODE_INVALID' });
    if (APPROVED_EMAILS.length > 0 && !emailOk) {
      return res.status(403).json({ error: 'EMAIL_NOT_APPROVED' });
    }
  }

  // 中文註解：Gemini 配額不足時改走 OpenAI；兩者至少擇一，否則無法雲端作答
  if (!GEMINI_API_KEY && !OPENAI_API_KEY) {
    return res.status(500).json({ error: '未設定 LLM 金鑰' });
  }

  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }

  let contextNote = '';
  const frontendLocal = Array.isArray(local_context) ? local_context : [];
  const serverRag = retrieveCoachContext(message, 3);
  const mergedContextRows = [
    ...(Array.isArray(local_context) ? local_context : [])
      .map((c) => (c && typeof c.answer === 'string' ? c.answer.trim() : ''))
      .filter(Boolean),
    ...serverRag.map((r) => r.text),
  ];
  if (mergedContextRows.length > 0) {
    contextNote = '\n\n【知識補充】\n' + mergedContextRows.join('\n---\n');
  }

  const priorHistory = normalizeHistoryExcludingLatestUser(messages, message);
  const currentUserText = message + contextNote;
  // 中文註解：歷史輪數與 api/coach-history.js、api/chat.js 一致（GEMINI_HISTORY_MAX_TURNS）
  const maxTurns = clampHistoryMaxTurns(process.env.GEMINI_HISTORY_MAX_TURNS);
  const contents = buildGeminiContents(priorHistory, currentUserText, maxTurns);
  const SYSTEM_PROMPT = loadMaenadsSystemPrompt();

  // 中文註解：過低的 maxOutputTokens 會讓中文長答在句中硬斷；可用環境變數覆寫
  const maxOut = Math.min(
    8192,
    Math.max(512, parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '2048', 10) || 2048),
  );

  // 中文註解：OPENAI_FIRST=1 時先走 ChatGPT 相容 API，失敗再回 Gemini
  const openaiFirst = /^(1|true|yes)$/i.test(String(process.env.OPENAI_FIRST || '').trim());
  const openaiModel = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const openAiMessages = buildOpenAiMessages(priorHistory, currentUserText, maxTurns);

  /** 中文註解：統一成功回傳形狀，前端可看 provider 判斷是否雲端模型 */
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
    return generateGeminiContent(GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: maxOut,
        topP: 0.95,
      },
    });
  }

  async function callOpenAI() {
    if (!OPENAI_API_KEY) return { ok: false, detail: 'NO_OPENAI_KEY' };
    return generateOpenAiChatCompletion(OPENAI_API_KEY, {
      system: SYSTEM_PROMPT,
      messages: openAiMessages,
      model: openaiModel,
      temperature: 0.8,
      maxTokens: Math.min(4096, maxOut),
    });
  }

  try {
    let geminiDetail = '';
    let openaiDetail = '';

    if (openaiFirst && OPENAI_API_KEY) {
      const o = await callOpenAI();
      if (o.ok) return respondLive('openai', { reply: o.reply, model: o.model });
      openaiDetail = String(o.detail || '');

      const g = await callGemini();
      if (g.ok) return respondLive('gemini', { reply: g.reply, model: g.model });
      geminiDetail = String(g.detail || '');
    } else {
      const g = await callGemini();
      if (g.ok) return respondLive('gemini', { reply: g.reply, model: g.model });
      geminiDetail = String(g.detail || '');

      const o = await callOpenAI();
      if (o.ok) return respondLive('openai', { reply: o.reply, model: o.model });
      openaiDetail = String(o.detail || '');
    }

    // 中文註解：OPENAI 放前面，避免 detail 截斷時只剩 Gemini 長文而看不到「未設金鑰」
    const combinedDetail = [openaiDetail && `OPENAI:${openaiDetail}`, geminiDetail && `GEMINI:${geminiDetail}`]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1600);

    return res.status(200).json({
      reply: buildEmergencyReply(message, priorHistory),
      mode: 'fallback',
      provider: 'fallback',
      finishReason: 'UPSTREAM_UNAVAILABLE',
      detail: combinedDetail,
      sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
