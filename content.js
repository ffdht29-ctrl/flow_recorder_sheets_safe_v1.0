(() => {
  const ROOT_SELECTOR =
    'flow-prompt-box, flow-base-prompt-box, .prompt-box-container, .base-prompt-box';

  const GRID_TILE_SELECTOR = 'flow-grid-tile-container';
  const PENDING_SELECTOR = 'flow-pending-tile';

  // 按用户要求：每 2 秒重新扫描当前页面，不依赖旧 DOM 节点是否被 Angular 复用。
  const POLL_INTERVAL_MS = 2000;
  const TRACK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

  const trackers = new Map();
  const batches = new Map();
  const actionIntents = new Map();

  // 成功结果使用稳定媒体 key 全局占用，避免不同请求互相抢同一个结果。
  const claimedSuccessKeys = new Set();
  const claimedFailureKeys = new Set();
  const claimedCancellationKeys = new Set();

  let pollTimer = null;
  let pollRunning = false;
  let cachedCredit = { value: "", fingerprint: "", at: 0 };
  let cachedModel = { value: "", at: 0 };
  let creditProbePromise = null;
  let creditProbeFingerprint = "";
  let lastTrigger = null;
  let realtimeTimer = null;
  let realtimeRunning = false;
  let restoreRunning = false;
  let restoreCompletedOnce = false;
  const detachedBindings = [];

  function clean(v) {
    return String(v ?? "").replace(/\s+/g, " ").trim();
  }

  function attr(el, name) {
    try {
      return clean(el?.getAttribute?.(name));
    } catch {
      return "";
    }
  }

  function text(el) {
    return clean(el?.innerText || el?.textContent || "");
  }

  function normalizePrompt(v) {
    return clean(v).toLowerCase();
  }

  function promptMatches(candidate, prompt) {
    const a = normalizePrompt(candidate);
    const b = normalizePrompt(prompt);

    if (!a || !b) return false;
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;

    // Prompt 很长时，Flow 卡片可能只保留一部分文本。
    const aa = a.slice(0, 48);
    const bb = b.slice(0, 48);

    return aa.length >= 8 && bb.length >= 8 &&
      (aa.includes(bb) || bb.includes(aa));
  }

  function simpleHash(value) {
    const s = String(value || "");
    let h = 2166136261;

    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }

    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function findRoot(el) {
    return el?.closest?.(ROOT_SELECTOR) || document.querySelector(ROOT_SELECTOR);
  }

  function currentProjectKey() {
    const m = String(location.pathname || "").match(/\/project\/([^/?#]+)/i);
    return m ? `project:${m[1]}` : `path:${location.pathname || ""}`;
  }

  function getPrompt(root) {
    const el = root?.querySelector(
      'flow-rich-text-editor .ProseMirror, .ProseMirror[contenteditable="true"], .ProseMirror'
    );

    return el ? text(el) : "";
  }

  function getSettingsSummary(root) {
    const el =
      root?.querySelector('span.settings-summary[settingstriggercontent]') ||
      root?.querySelector('.settings-summary');

    return el ? clean(el.textContent || el.innerText || "") : "";
  }

  function getAgent(root) {
    const el = root?.querySelector(".agent-mode-chip");
    if (!el) return "";

    const pressed = attr(el, "aria-pressed");
    if (pressed === "true") return "开启";
    if (pressed === "false") return "关闭";
    return "";
  }

  function parseSettingsSummary(summary) {
    const s = clean(summary);

    let mediaType = "";
    let resolution = "";
    let duration = "";
    let ratio = "";
    let count = "";
    let modelFromSummary = "";

    if (/(^|[·\s])影片([·\s]|$)|(^|[·\s])视频([·\s]|$)|\bvideo\b/i.test(s)) {
      mediaType = "视频";
    } else if (
      /(^|[·\s])图片([·\s]|$)|(^|[·\s])圖像([·\s]|$)|\bimage\b/i.test(s)
    ) {
      mediaType = "图片";
    }

    const resMatch = s.match(/\b(\d{3,4})p\b/i);
    if (resMatch) resolution = Number(resMatch[1]);

    const durMatch = s.match(/\b(\d{1,3})\s*(?:秒|s|sec(?:ond)?s?)\b/i);
    if (durMatch) duration = Number(durMatch[1]);

    const ratioMatch =
      s.match(/crop[_\-\s]?(\d+)[_:\-\s](\d+)/i) ||
      s.match(/\b(\d+)\s*:\s*(\d+)\b/);

    if (ratioMatch) ratio = `${ratioMatch[1]}:${ratioMatch[2]}`;

    const countMatch = s.match(/(?:\bx|×)\s*(\d+)\b/i);
    if (countMatch) count = Number(countMatch[1]);

    const modelPatterns = [
      /Veo\s*3(?:\.\d+)?\s*-\s*Lite\s*\[\s*Lower\s*Priority\s*\]/i,
      /Veo\s*3(?:\.\d+)?\s*-\s*Quality/i,
      /Veo\s*3(?:\.\d+)?\s*-\s*Fast/i,
      /Veo\s*3(?:\.\d+)?\s*-\s*Lite/i,
      /Omni\s*1(?:\.\d+)?\s*Flash/i,
      /Nano\s*Banana\s*(?:Pro|2)/i,
      /Imagen(?:\s*\d+(?:\.\d+)?)?/i
    ];

    for (const pattern of modelPatterns) {
      const m = s.match(pattern);
      if (m) {
        modelFromSummary = clean(m[0]);
        break;
      }
    }

    return {
      mediaType,
      resolution,
      duration,
      ratio,
      count,
      modelFromSummary
    };
  }

  function normalizeModelLabel(raw) {
    const s = clean(raw)
      .replace(/arrow_drop_down/ig, "")
      .replace(/expand_more/ig, "")
      .replace(/keyboard_arrow_down/ig, "")
      .trim();

    if (!s) return "";

    const knownPatterns = [
      /Veo\s*3(?:\.\d+)?\s*-\s*Lite\s*\[\s*Lower\s*Priority\s*\]/i,
      /Veo\s*3(?:\.\d+)?\s*-\s*Quality/i,
      /Veo\s*3(?:\.\d+)?\s*-\s*Fast/i,
      /Veo\s*3(?:\.\d+)?\s*-\s*Lite/i,
      /Omni\s*1(?:\.\d+)?\s*Flash/i,
      /Nano\s*Banana\s*(?:Pro|2)/i,
      /Imagen(?:\s*\d+(?:\.\d+)?)?/i
    ];

    for (const pattern of knownPatterns) {
      const m = s.match(pattern);
      if (m) return clean(m[0]);
    }

    return s;
  }

  function detectModel(root, parsed) {
    if (parsed.modelFromSummary) return parsed.modelFromSummary;

    const selectors = [
      'button[aria-label*="選取模型系列"] .model-select-trigger-content',
      'button[aria-label*="选择模型系列"] .model-select-trigger-content',
      '.model-select-trigger-content'
    ];

    for (const selector of selectors) {
      const el = root?.querySelector(selector) || document.querySelector(selector);
      if (!el) continue;

      const candidate = normalizeModelLabel(text(el));
      if (candidate) {
        cachedModel = { value: candidate, at: Date.now() };
        return candidate;
      }
    }

    return cachedModel.value || "";
  }


  function isVideoEditMode() {
    // 用户明确指定：页面出现时间线元素，就视为进入视频编辑模式。
    return !!document.querySelector("flow-scene-timeline");
  }

  function getEditPromptBox(root) {
    return (
      root?.closest?.("flow-edit-video-prompt-box") ||
      root?.querySelector?.("flow-edit-video-prompt-box") ||
      document.querySelector("flow-edit-video-prompt-box")
    );
  }

  function getEditModeModelBesideGenerate(root) {
    if (!isVideoEditMode()) return "";

    const editBox = getEditPromptBox(root);
    if (!editBox) return "";

    const generateButton =
      editBox.querySelector(
        'flow-generate-icon-button button, .generate-icon-button, button[aria-label*="開始生成"], button[aria-label*="开始生成"]'
      );

    if (!generateButton) return "";

    const controls =
      generateButton.closest(".submit-controls") ||
      editBox.querySelector(".submit-controls") ||
      editBox;

    // 编辑模式二：延续镜头。
    // 按用户要求，模型字段记录“运行按钮旁边元素显示的完整名称”，
    // 例如：延续镜头（Veo 3.1 - Lite）
    const extendChip =
      controls.querySelector("button.extend-mode-chip") ||
      editBox.querySelector("button.extend-mode-chip");

    if (extendChip) {
      const value = clean(text(extendChip));
      if (value) return value;
    }

    // 编辑模式一：修改已生成视频。
    // 例如：Omni 1.1 Flash
    const modelChip =
      controls.querySelector(".model-chip") ||
      editBox.querySelector(".model-chip");

    if (modelChip) {
      const value = clean(text(modelChip));
      if (value) return value;
    }

    return "";
  }

  function inferMediaType(model, parsedType) {
    if (parsedType) return parsedType;

    const s = clean(model);
    if (/Veo|Omni/i.test(s)) return "视频";
    if (/Nano\s*Banana|Imagen/i.test(s)) return "图片";

    return "";
  }

  function parseCreditCostNumber(raw) {
    const s = clean(raw);
    if (!s) return "";

    const match =
      s.match(/(\d+(?:\.\d+)?)\s*(?:點數|点数|credits?)/i) ||
      s.match(/(\d+(?:\.\d+)?)/);

    if (!match) return "";

    const n = Number(match[1]);
    return Number.isFinite(n) ? n : "";
  }

  function settingsFingerprint(model, summary) {
    return `${clean(model)}||${clean(summary)}`;
  }

  function readCreditFromPage() {
    const selectors = [
      'flow-credit-cost-label .credit-cost-link',
      'flow-credit-cost-label .credit-cost-label',
      '.settings-credit-cost .credit-cost-link',
      '.settings-credit-cost .credit-cost-label',
      '.credit-cost-link',
      '.credit-cost-label'
    ];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const value = parseCreditCostNumber(text(el));
        if (value !== "") return value;
      }
    }

    return "";
  }

  function refreshSettingsCache(root) {
    if (!root) return;

    const summary = getSettingsSummary(root);
    const parsed = parseSettingsSummary(summary);
    const model = detectModel(root, parsed);
    const credit = readCreditFromPage();

    if (credit !== "") {
      cachedCredit = {
        value: credit,
        fingerprint: settingsFingerprint(model, summary),
        at: Date.now()
      };
      return;
    }

    // 新工程默认状态通常还没有积分DOM；
    // 这里静默预取一次，不阻塞界面。
    probeCreditForCurrentSettings(root, { waitMs: 220 }).catch(() => {});
  }

  function getCreditForCurrentSettings(root, model, summary) {
    const live = readCreditFromPage();
    const fp = settingsFingerprint(model, summary);

    if (live !== "") {
      cachedCredit = {
        value: live,
        fingerprint: fp,
        at: Date.now()
      };
      return live;
    }

    if (cachedCredit.fingerprint === fp) {
      return cachedCredit.value;
    }

    return "";
  }


  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function dispatchCreditRevealEvents(el) {
    if (!el) return;

    const events = [
      "pointerenter",
      "mouseenter",
      "mouseover",
      "pointermove",
      "mousemove"
    ];

    for (const type of events) {
      try {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window
          })
        );
      } catch {}
    }
  }

  async function probeCreditForCurrentSettings(root, options = {}) {
    if (!root) return "";

    const waitMs = Math.max(120, Number(options.waitMs || 320));
    const summary = getSettingsSummary(root);
    const parsed = parseSettingsSummary(summary);
    const model = detectModel(root, parsed);
    const fp = settingsFingerprint(model, summary);

    const liveNow = readCreditFromPage();
    if (liveNow !== "") {
      cachedCredit = {
        value: liveNow,
        fingerprint: fp,
        at: Date.now()
      };
      return liveNow;
    }

    if (cachedCredit.fingerprint === fp && cachedCredit.value !== "") {
      return cachedCredit.value;
    }

    if (
      creditProbePromise &&
      creditProbeFingerprint === fp
    ) {
      try {
        return await creditProbePromise;
      } catch {
        return "";
      }
    }

    creditProbeFingerprint = fp;

    creditProbePromise = (async () => {
      const generateButton = findGenerateButton(root);
      const settingsButton =
        root?.querySelector?.(".settings-trigger-button") ||
        root?.querySelector?.('button[aria-label*="設定觸發條件"]') ||
        root?.querySelector?.('button[aria-label*="设置触发条件"]') ||
        root?.querySelector?.('button[aria-label*="设置触发器"]') ||
        root?.querySelector?.('button[aria-label*="設定觸發器"]');

      // 按用户要求，不改其它逻辑。
      // 这里只做“积分预取”：
      // 新工程默认页面只有 x2 等设置，没有积分元素；
      // 把鼠标放到运行按钮附近时，Flow才会把积分DOM渲染出来。
      dispatchCreditRevealEvents(generateButton);
      dispatchCreditRevealEvents(settingsButton);

      const end = Date.now() + waitMs;

      while (Date.now() < end) {
        const live = readCreditFromPage();

        if (live !== "") {
          cachedCredit = {
            value: live,
            fingerprint: fp,
            at: Date.now()
          };
          return live;
        }

        await sleep(40);
      }

      if (cachedCredit.fingerprint === fp) {
        return cachedCredit.value;
      }

      return "";
    })();

    try {
      return await creditProbePromise;
    } finally {
      creditProbePromise = null;
      creditProbeFingerprint = "";
    }
  }

  async function getCreditForCurrentSettingsWithPrefetch(root, model, summary) {
    const direct = getCreditForCurrentSettings(root, model, summary);
    if (direct !== "") return direct;

    const probed = await probeCreditForCurrentSettings(root, {
      waitMs: 360
    });

    if (probed !== "") return probed;

    const fp = settingsFingerprint(model, summary);
    if (cachedCredit.fingerprint === fp) {
      return cachedCredit.value;
    }

    return "";
  }

  function getProjectName() {
    const title = clean(document.title);
    const match = title.match(/^Google Flow\s*-\s*(.+)$/i);

    return match ? clean(match[1]) : title;
  }

  function findGenerateButton(root) {
    return (
      root?.querySelector('flow-generate-icon-button button') ||
      root?.querySelector('.generate-icon-button') ||
      root?.querySelector('button[aria-label*="開始生成"]') ||
      root?.querySelector('button[aria-label*="开始生成"]') ||
      root?.querySelector('button[aria-label*="Generate" i]')
    );
  }

  function isGenerateButton(el) {
    return !!(
      el?.closest?.('flow-generate-icon-button button') ||
      el?.closest?.('.generate-icon-button') ||
      el?.closest?.('button[aria-label*="開始生成"]') ||
      el?.closest?.('button[aria-label*="开始生成"]') ||
      el?.closest?.('button[aria-label*="Generate" i]')
    );
  }

  function isPromptEnter(event) {
    if (event.key !== "Enter") return false;
    if (event.isComposing) return false;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;

    return !!event.target?.closest?.(
      'flow-rich-text-editor .ProseMirror, .ProseMirror[contenteditable="true"], .prompt-input'
    );
  }

  function getTilePrompt(tile) {
    return clean(
      attr(tile, "aria-label") ||
      text(tile.querySelector('flow-pending-tile .subtitle')) ||
      text(tile.querySelector('.footer-title')) ||
      text(tile.querySelector('.prompt-text .text-part'))
    );
  }

  function ensureTileUid(tile) {
    if (!tile) return "";

    const existing = clean(tile.dataset?.flowRecorderTileUid || "");
    if (existing) return existing;

    const uid = crypto.randomUUID
      ? crypto.randomUUID()
      : `tile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      tile.dataset.flowRecorderTileUid = uid;
    } catch {}

    return uid;
  }

  function tileRecordId(tile) {
    return clean(tile?.dataset?.flowRecorderRecordId || "");
  }

  function tileGeneration(tile) {
    const n = Number(tile?.dataset?.flowRecorderGeneration || 0);
    return Number.isFinite(n) ? n : 0;
  }

  function markTileForTracker(tile, tracker, ordinal = null) {
    if (!tile || !tracker) return "";

    const uid = ensureTileUid(tile);

    try {
      tile.dataset.flowRecorderRecordId = tracker.recordId;
      tile.dataset.flowRecorderBatchId = tracker.batchId;
      tile.dataset.flowRecorderOutputIndex = String(tracker.outputIndex);
      tile.dataset.flowRecorderGeneration = String(tracker.generationIndex);
    } catch {}

    tracker.boundTileUid = uid;
    tracker.currentTileId = uid;

    if (Number.isInteger(ordinal)) {
      tracker.boundOrdinal = ordinal;
    }

    tracker.expectNewTile = false;

    persistTrackerMeta(tracker);
    return uid;
  }


  function collectGridTilesFromNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return [];

    const out = [];

    if (node.matches?.(GRID_TILE_SELECTOR)) {
      out.push(node);
    }

    for (const tile of node.querySelectorAll?.(GRID_TILE_SELECTOR) || []) {
      out.push(tile);
    }

    return out;
  }

  function rememberDetachedBinding(tile) {
    if (!tile) return;

    const recordId = tileRecordId(tile);
    if (!recordId) return;

    const tracker = trackers.get(recordId);
    if (!tracker || tracker.done) return;

    const entry = {
      recordId,
      projectKey: tracker.projectKey || currentProjectKey(),
      batchId: tracker.batchId,
      outputIndex: tracker.outputIndex,
      generationIndex: tracker.generationIndex,
      prompt: getTilePrompt(tile) || tracker.prompt || "",
      oldUid: ensureTileUid(tile),
      ordinal: Number.isInteger(tracker.boundOrdinal)
        ? tracker.boundOrdinal
        : visibleOrdinalOfTile(tile),
      at: Date.now()
    };

    detachedBindings.push(entry);

    while (detachedBindings.length > 100) {
      detachedBindings.shift();
    }

    for (let i = detachedBindings.length - 1; i >= 0; i--) {
      if (Date.now() - detachedBindings[i].at > 15000) {
        detachedBindings.splice(i, 1);
      }
    }
  }

  function adoptAddedTileFromDetached(tile) {
    if (!tile || tileRecordId(tile)) return null;

    const ordinal = visibleOrdinalOfTile(tile);
    const prompt = getTilePrompt(tile);
    const now = Date.now();

    const candidates = detachedBindings
      .filter(x => {
        if (now - x.at > 15000) return false;

        const tracker = trackers.get(x.recordId);
        if (!tracker || tracker.done) return false;
        if (tracker.generationIndex !== x.generationIndex) return false;

        const promptOk =
          !prompt ||
          !x.prompt ||
          promptMatches(prompt, x.prompt);

        if (!promptOk) return false;

        const ordinalOk =
          Number.isInteger(ordinal) &&
          Number.isInteger(x.ordinal) &&
          ordinal === x.ordinal;

        return ordinalOk;
      })
      .sort((a, b) => b.at - a.at);

    if (candidates.length !== 1) return null;

    const picked = candidates[0];
    const tracker = trackers.get(picked.recordId);
    if (!tracker) return null;

    markTileForTracker(tile, tracker, ordinal);

    const idx = detachedBindings.indexOf(picked);
    if (idx >= 0) detachedBindings.splice(idx, 1);

    console.log(
      "[Flow Recorder Safe v3.2] Flow替换DOM后已把新tile身份交接回原输出",
      {
        recordId: tracker.recordId,
        batchId: tracker.batchId,
        outputIndex: tracker.outputIndex,
        generationIndex: tracker.generationIndex,
        ordinal
      }
    );

    return tracker;
  }

  function itemBelongsToTracker(item, tracker) {
    if (!item || !item.tile || !tracker) return false;

    const rid = item.recordId || tileRecordId(item.tile);
    const gen = Number(item.generation || tileGeneration(item.tile) || 0);
    const uid = item.uid || ensureTileUid(item.tile);

    if (
      rid &&
      rid === tracker.recordId &&
      gen === tracker.generationIndex
    ) {
      return true;
    }

    if (
      tracker.boundTileUid &&
      uid &&
      uid === tracker.boundTileUid
    ) {
      return true;
    }

    // Angular 若只重建当前 tile，但保留同一个可见位置，则用本代绑定序号兜底。
    // 只有在该 item 没被其它记录绑定时才允许。
    if (
      Number.isInteger(tracker.boundOrdinal) &&
      Number.isInteger(item.ordinal) &&
      tracker.boundOrdinal === item.ordinal &&
      !rid
    ) {
      return true;
    }

    return false;
  }

  function isPendingTile(tile) {
    return !!tile?.querySelector?.(PENDING_SELECTOR);
  }

  function pendingProgress(tile) {
    return text(tile?.querySelector?.('.loading-percentage'));
  }


  const CANCEL_TITLE_RE =
    /^(?:此生成操作已取消|生成操作已取消|已取消生成|已取消生成此內容|已取消生成此内容|取消生成此內容|取消生成此内容|用户取消|使用者取消|generation\s+(?:was\s+)?cancel(?:led|ed)|cancelled|canceled)(?:$|[：:，,。.!！\s])/i;

  const FAILURE_TITLE_RE =
    /^(?:失败|失敗|生成失败|生成失敗|生成失敗了|生成失败了|failed|generation\s+failed)(?:$|[：:，,。.!！\s])/i;

  const RETRY_LABEL_RE =
    /(?:重试|重試|重新生成|重新產生|retry|refresh|replay|restart)/i;

  const REUSE_LABEL_RE =
    /(?:重复使用提示|重複使用提示|重复使用提示词|重複使用提示詞|reuse\s*prompt|redo|undo)/i;

  function errorTileParts(tile) {
    const errorTile = tile?.querySelector?.("flow-error-tile");

    if (!errorTile) {
      return {
        errorTile: null,
        title: "",
        message: "",
        disclaimer: "",
        allText: ""
      };
    }

    const title = clean(
      text(errorTile.querySelector(".error-title")) ||
      text(errorTile.querySelector("[class*='error-title']"))
    );

    const message = clean(
      text(errorTile.querySelector(".error-message-text"))
    );

    const disclaimer = clean(
      text(errorTile.querySelector(".disclaimer-message"))
    );

    const allText = clean(
      errorTile.innerText || errorTile.textContent || ""
    );

    return { errorTile, title, message, disclaimer, allText };
  }

  function cancellationFeatures(tile) {
    if (!tile || isPendingTile(tile)) {
      return { canceled: false, refundPoints: "", reason: "" };
    }

    const parts = errorTileParts(tile);

    if (!parts.errorTile) {
      return { canceled: false, refundPoints: "", reason: "" };
    }

    const canceled =
      CANCEL_TITLE_RE.test(parts.title) ||
      /generation.*cancel(?:led|ed)/i.test(parts.title);

    if (!canceled) {
      return { canceled: false, refundPoints: "", reason: "" };
    }

    const refundMatch = parts.allText.match(
      /(?:退还|退回|退還|系統將退回|系统将退回|refund(?:ed)?)\s*(\d+(?:\.\d+)?)\s*(?:个|個)?\s*(?:点数|點數|credits?)/i
    );

    const refundPoints = refundMatch ? Number(refundMatch[1]) : "";

    return {
      canceled: true,
      refundPoints:
        Number.isFinite(refundPoints) ? refundPoints : "",
      reason: parts.title || "已取消生成"
    };
  }

  function isCanceledTile(tile) {
    return cancellationFeatures(tile).canceled;
  }

  function failureFeatures(tile) {
    if (!tile || isPendingTile(tile)) {
      return {
        failed: false,
        reason: "",
        score: 0,
        noCharge: false
      };
    }

    const parts = errorTileParts(tile);

    if (!parts.errorTile) {
      return {
        failed: false,
        reason: "",
        score: 0,
        noCharge: false
      };
    }

    if (
      CANCEL_TITLE_RE.test(parts.title) ||
      /generation.*cancel(?:led|ed)/i.test(parts.title)
    ) {
      return {
        failed: false,
        reason: "",
        score: 0,
        noCharge: false
      };
    }

    // 严格：只有Flow error tile的明确失败标题才算失败。
    // 同时兼容简体“失败”和繁体“失敗”。
    if (!FAILURE_TITLE_RE.test(parts.title)) {
      return {
        failed: false,
        reason: "",
        score: 0,
        noCharge: false
      };
    }

    const noCharge =
      /(?:本次生成不會收費|本次生成不会收费|不會收費|不会收费|no\s+charge|won't\s+be\s+charged|will\s+not\s+be\s+charged)/i
        .test(parts.disclaimer || parts.allText);

    const reason = clean(
      [parts.message, parts.disclaimer]
        .filter(Boolean)
        .join(" ")
    ) || parts.title || "失败";

    return {
      failed: true,
      reason,
      score: 10,
      noCharge
    };
  }

  function isFailureTile(tile) {
    return failureFeatures(tile).failed;
  }

  function getActualMediaId(tile) {
    const el = tile?.querySelector?.('[data-media-id]');
    return attr(el, 'data-media-id');
  }

  function mediaSuccessInfo(tile) {
    if (!tile || isPendingTile(tile)) return null;

    // 错误卡片永不作为成功。
    if (tile.querySelector?.("flow-error-tile")) return null;

    const mediaId = getActualMediaId(tile);

    if (mediaId) {
      return {
        key: `media:${mediaId}`,
        displayId: mediaId,
        source: "data-media-id"
      };
    }

    const video = tile.querySelector(
      'flow-video-tile video[src], video[aria-label*="生成"][src], video[src]'
    );

    if (video) {
      const src = attr(video, "src");

      if (src) {
        const key = `video:${simpleHash(src)}`;
        return {
          key,
          displayId: `video-${key.slice(6)}`,
          source: "video-src"
        };
      }
    }

    const videoThumb =
      tile.querySelector('flow-video-tile img.thumbnail[src]') ||
      tile.querySelector('flow-video-tile img[alt*="影片縮圖"][src]') ||
      tile.querySelector('flow-video-tile img[alt*="视频缩略图"][src]') ||
      tile.querySelector('flow-video-tile img[alt*="生成"][src]');

    if (videoThumb) {
      const src = attr(videoThumb, "src");

      if (src) {
        const key = `video:${simpleHash(src)}`;
        return {
          key,
          displayId: `video-${key.slice(6)}`,
          source: "video-thumbnail-src"
        };
      }
    }

    return null;
  }

  function successKey(tile) {
    return mediaSuccessInfo(tile)?.key || "";
  }

  function successDisplayId(tile) {
    return mediaSuccessInfo(tile)?.displayId || "";
  }

  function isSuccessTile(tile) {
    return !!mediaSuccessInfo(tile);
  }

  function classifyTile(tile, index) {
    const prompt = getTilePrompt(tile);
    const uid = ensureTileUid(tile);
    const recordId = tileRecordId(tile);
    const generation = tileGeneration(tile);

    const base = {
      tile,
      uid,
      recordId,
      generation,
      ordinal: index,
      prompt
    };

    if (isPendingTile(tile)) {
      return {
        ...base,
        kind: "pending",
        progress: pendingProgress(tile)
      };
    }

    const cancel = cancellationFeatures(tile);

    if (cancel.canceled) {
      return {
        ...base,
        kind: "canceled",
        refundPoints: cancel.refundPoints,
        reason: cancel.reason
      };
    }

    const failure = failureFeatures(tile);

    if (failure.failed) {
      return {
        ...base,
        kind: "failed",
        reason: failure.reason,
        noCharge: failure.noCharge,
        score: failure.score
      };
    }

    const success = mediaSuccessInfo(tile);

    if (success) {
      return {
        ...base,
        kind: "success",
        key: success.key,
        displayId: success.displayId,
        successSource: success.source
      };
    }

    return {
      ...base,
      kind: "unknown"
    };
  }

  function stateEventKey(item) {
    if (!item) return "";

    const owner =
      item.recordId
        ? `${item.recordId}:g${Number(item.generation || 0)}`
        : `uid:${item.uid || ""}`;

    if (item.kind === "success") {
      return item.key || `success:${owner}`;
    }

    if (item.kind === "failed") {
      return `failure:${owner}:${simpleHash(item.reason || "failed")}`;
    }

    if (item.kind === "canceled") {
      return `cancel:${owner}:${simpleHash(
        `${item.reason || ""}|${item.refundPoints ?? ""}`
      )}`;
    }

    if (item.kind === "pending") {
      return `pending:${owner}`;
    }

    return `unknown:${owner}:${item.ordinal}`;
  }

  function tileScanKey(tile, index) {
    return stateEventKey(classifyTile(tile, index));
  }

  function scanPage() {
    const tiles = Array.from(document.querySelectorAll(GRID_TILE_SELECTOR));

    const pending = [];
    const successes = [];
    const failures = [];
    const cancellations = [];
    const unknown = [];
    const ordered = [];

    tiles.forEach((tile, index) => {
      const item = classifyTile(tile, index);
      item.scanKey = stateEventKey(item);
      ordered.push(item);

      if (item.kind === "pending") pending.push(item);
      else if (item.kind === "success") successes.push(item);
      else if (item.kind === "failed") failures.push(item);
      else if (item.kind === "canceled") cancellations.push(item);
      else unknown.push(item);
    });

    return {
      tiles,
      pending,
      successes,
      failures,
      cancellations,
      unknown,
      ordered
    };
  }

  function countMatching(items, prompt) {
    return items.filter(item => promptMatches(item.prompt, prompt)).length;
  }

  function successKeysMatching(items, prompt) {
    return new Set(
      items
        .filter(item => promptMatches(item.prompt, prompt))
        .map(item => item.key)
        .filter(Boolean)
    );
  }

  function failureCountMatching(items, prompt) {
    return items.filter(item => promptMatches(item.prompt, prompt)).length;
  }



  function buttonDescriptor(target) {
    const button = target?.closest?.("button");
    if (!button) return "";

    return clean([
      attr(button, "aria-label"),
      attr(button, "title"),
      text(button),
      text(button.querySelector("mat-icon"))
    ].join(" "));
  }

  function isCancelGenerationButton(target) {
    const label = buttonDescriptor(target);
    if (!label) return false;

    // 用户提供的真实排队 DOM：button.cancel-button aria-label="取消" + close 图标
    return /(^|\s)(取消|取消生成|停止生成|中止|cancel|stop|abort)(\s|$)/i.test(label);
  }

  function isRepeatPromptButton(target) {
    const label = buttonDescriptor(target);
    if (!label) return false;

    return REUSE_LABEL_RE.test(label);
  }


  function findTrackerForTile(tile, mode = "active") {
    if (!tile) return null;

    const rid = tileRecordId(tile);
    const gen = tileGeneration(tile);
    const uid = ensureTileUid(tile);

    let tracker = null;

    if (rid && trackers.has(rid)) {
      const candidate = trackers.get(rid);

      if (
        !candidate.done &&
        (!gen ||
         gen === candidate.generationIndex ||
         uid === candidate.boundTileUid)
      ) {
        tracker = candidate;
      }
    }

    if (!tracker && uid) {
      const matches = Array.from(trackers.values()).filter(t =>
        !t.done &&
        t.boundTileUid &&
        t.boundTileUid === uid
      );

      if (matches.length === 1) {
        tracker = matches[0];
      }
    }

    // 绝不再用“同 Prompt + 最早记录”来猜多个视频中的某一个。
    // 如果 tile 没有明确绑定，就宁可暂时不判断，也不串记录。
    if (!tracker) {
      const ordinal = visibleOrdinalOfTile(tile);

      for (const type of ["cancel", "retry", "reuse"]) {
        for (const intent of actionIntents.values()) {
          if (intent.type !== type) continue;

          const candidate = trackers.get(intent.recordId);
          if (!candidate || candidate.done) continue;

          const uidMatch =
            uid &&
            intent.tileUid &&
            uid === intent.tileUid;

          const ordinalMatch =
            Number.isInteger(ordinal) &&
            Number.isInteger(intent.ordinal) &&
            ordinal === intent.ordinal &&
            Date.now() - Number(intent.at || 0) <= 15000;

          if (uidMatch || ordinalMatch) {
            tracker = candidate;
            markTileForTracker(tile, tracker, ordinal);
            break;
          }
        }

        if (tracker) break;
      }
    }

    if (!tracker) return null;

    if (mode === "canceled" && !tracker.canceled) return null;
    if (mode === "failure" && !tracker.waitingRetry) return null;
    if (mode === "active" && tracker.canceled) return null;

    return tracker;
  }



  function rememberActionIntent(type, tile, tracker) {
    if (!type || !tile || !tracker) return null;

    const uid = ensureTileUid(tile);
    const ordinal = visibleOrdinalOfTile(tile);
    const intent = {
      type,
      recordId: tracker.recordId,
      batchId: tracker.batchId,
      outputIndex: tracker.outputIndex,
      generationIndex: tracker.generationIndex,
      tileUid: uid,
      ordinal,
      at: Date.now()
    };

    actionIntents.set(`${type}:${tracker.recordId}`, intent);

    // 防止长期堆积
    for (const [key, value] of actionIntents.entries()) {
      if (Date.now() - Number(value.at || 0) > 10 * 60 * 1000) {
        actionIntents.delete(key);
      }
    }

    return intent;
  }

  function recentActionIntent(type, tracker) {
    if (!type || !tracker) return null;
    const intent = actionIntents.get(`${type}:${tracker.recordId}`) || null;
    if (!intent) return null;
    if (Date.now() - Number(intent.at || 0) > 2 * 60 * 1000) return null;
    return intent;
  }

  function itemMatchesActionIntent(item, intent) {
    if (!item || !intent) return false;

    if (item.uid && intent.tileUid && item.uid === intent.tileUid) {
      return true;
    }

    // Angular替换整个tile时，插件dataset可能消失。
    // 此时只在“刚刚点击动作后的短时间窗口”使用同一可见位置恢复。
    if (
      Number.isInteger(item.ordinal) &&
      Number.isInteger(intent.ordinal) &&
      item.ordinal === intent.ordinal &&
      Date.now() - Number(intent.at || 0) <= 15000
    ) {
      return true;
    }

    return false;
  }

  function visibleOrdinalOfTile(tile) {
    if (!tile) return -1;

    const tiles = Array.from(document.querySelectorAll(GRID_TILE_SELECTOR));
    return tiles.indexOf(tile);
  }

  function bindActionTileToTracker(tile, mode = "active") {
    if (!tile) return null;

    // 1. 已经有精确绑定，直接使用。
    let tracker = findTrackerForTile(tile, mode);
    if (tracker) return tracker;

    // 2. 当前动作发生时立即做一次页面扫描和批次逐项绑定，
    //    不等待下一次2秒轮询。
    try {
      const scan = scanPage();
      rebindRestoredTrackers(scan);
      bindNewTilesToTrackers(scan);
    } catch {}

    tracker = findTrackerForTile(tile, mode);
    if (tracker) return tracker;

    // 3. 如果 Flow 重建了外层 tile，dataset/uid 都丢失，
    //    只允许使用“同一可见位置且候选唯一”来恢复绑定。
    //    不使用 Prompt 猜。
    const ordinal = visibleOrdinalOfTile(tile);
    if (ordinal < 0) return null;

    const candidates = Array.from(trackers.values())
      .filter(t => {
        if (t.done || t.zeroCredit) return false;
        if (!Number.isInteger(t.boundOrdinal)) return false;
        if (t.boundOrdinal !== ordinal) return false;

        if (mode === "canceled") return t.canceled === true;
        if (mode === "failure") return t.waitingRetry === true;

        return (
          !t.canceled &&
          !t.waitingRetry &&
          t.successKeys.size === 0
        );
      });

    if (candidates.length !== 1) return null;

    tracker = candidates[0];
    markTileForTracker(tile, tracker, ordinal);

    return tracker;
  }

  function scheduleRealtimeReconcile(delay = 20) {
    if (realtimeTimer) {
      clearTimeout(realtimeTimer);
    }

    realtimeTimer = setTimeout(() => {
      realtimeTimer = null;

      if (realtimeRunning) return;
      realtimeRunning = true;

      Promise.resolve()
        .then(() => pollAllTrackers())
        .catch(e => {
          console.warn(
            "[Flow Recorder Safe v3.2] 实时状态核对失败",
            e
          );
        })
        .finally(() => {
          realtimeRunning = false;
        });
    }, Math.max(0, delay));
  }

  function noteManualCancel(tile) {
    if (!tile) return;

    const tracker = bindActionTileToTracker(tile, "active");
    if (!tracker) {
      console.warn(
        "[Flow Recorder Safe v3.2] 取消点击未能唯一绑定到具体输出，暂不误判",
        tile
      );
      return;
    }

    // 点击“取消”只代表用户发出了取消请求。
    // 必须后续页面明确出现“此生成操作已取消”，才最终判定为用户取消。
    tracker.cancelRequested = true;
    tracker.cancelRequestedAt = currentLocalIso();
    markTileForTracker(tile, tracker, visibleOrdinalOfTile(tile));
    rememberActionIntent("cancel", tile, tracker);
    persistTrackerMeta(tracker);

    try {
      tile.dataset.flowRecorderCancelRequested = "true";
    } catch {}

    chrome.runtime.sendMessage({
      type: "UPDATE_GENERATION_RECORD",
      recordId: tracker.recordId,
      patch: {
        "生成状态": "取消确认中",
        "最后核对时间": tracker.cancelRequestedAt
      },
      final: false
    }).catch(e => {
      console.warn("[Flow Recorder Safe v3.2] 记录取消点击失败", e);
    });

    // Flow通常会在点击取消后很快把pending tile替换成取消卡片。
    // 立刻开始实时核对，不等2秒保险轮询。
    scheduleRealtimeReconcile(20);
  }

  function noteReuseErrorTile(tile) {
    if (!tile?.querySelector?.("flow-error-tile")) return false;

    let tracker = null;

    if (isCanceledTile(tile)) {
      tracker = bindActionTileToTracker(tile, "canceled");
    } else if (isFailureTile(tile)) {
      tracker = bindActionTileToTracker(tile, "failure");
    }

    if (!tracker || tracker.zeroCredit || tracker.done) {
      console.warn(
        "[Flow Recorder Safe v3.2] 重复使用提示词未能唯一绑定到错误输出",
        tile
      );
      return false;
    }

    if (!tracker.canceled && !tracker.waitingRetry) {
      return false;
    }

    tracker.reuseArmed = true;
    tracker.reuseArmedAt = currentLocalIso();
    tracker.lastRetryAt = tracker.reuseArmedAt;

    markTileForTracker(
      tile,
      tracker,
      visibleOrdinalOfTile(tile)
    );

    rememberActionIntent("reuse", tile, tracker);
    persistTrackerMeta(tracker);

    chrome.runtime.sendMessage({
      type: "UPDATE_GENERATION_RECORD",
      recordId: tracker.recordId,
      patch: {
        "计入积分": 0,
        "生成状态": "已重复使用提示",
        "最后重试时间": tracker.lastRetryAt,
        "最后核对时间": tracker.lastRetryAt
      },
      final: false
    }).catch(e => {
      console.warn("[Flow Recorder Safe v3.2] 记录重复使用提示词失败", e);
    });

    scheduleRealtimeReconcile(20);
    return true;
  }

  function isRetryButton(target) {
    const button = target?.closest?.("button");
    if (!button) return false;

    const label = clean([
      attr(button, "aria-label"),
      attr(button, "title"),
      text(button),
      text(button.querySelector("mat-icon"))
    ].join(" "));

    return RETRY_LABEL_RE.test(label);
  }

  function findFailureTileFromTarget(target) {
    const tile = target?.closest?.(GRID_TILE_SELECTOR);
    if (!tile) return null;
    return isFailureTile(tile) ? tile : null;
  }


  function noteRetryClick(tile) {
    if (!tile) return;

    let tracker = bindActionTileToTracker(tile, "failure");
    if (!tracker || tracker.zeroCredit || tracker.done) {
      console.warn(
        "[Flow Recorder Safe v3.2] 重试点击未能唯一绑定到失败输出",
        tile
      );
      return;
    }

    // “重试/重新生成”是新的一次尝试。
    // 先记住用户具体点了哪个失败tile，即使Flow随后重建DOM也可恢复。
    rememberActionIntent("retry", tile, tracker);

    // 旧失败卡片保留在页面里时，也不能再影响新的结果判断。
    tracker.retryCount = Number(tracker.retryCount || 0) + 1;
    tracker.lastRetryAt = currentLocalIso();
    tracker.waitingRetry = false;
    tracker.retryActive = true;
    tracker.failedCount = 0;
    tracker.failureReasons = [];
    tracker.generationIndex = Number(tracker.generationIndex || 1) + 1;
    tracker.expectNewTile = true;
    tracker.boundTileUid = "";
    tracker.currentTileId = "";
    tracker.boundOrdinal = null;
    tracker.attemptStartedAt = Date.now();

    const retryScan = scanPage();
    tracker.baseline = createBaseline(retryScan, tracker.prompt);
    persistTrackerMeta(tracker);

    chrome.runtime.sendMessage({
      type: "UPDATE_GENERATION_RECORD",
      recordId: tracker.recordId,
      patch: {
        "失败数量": 0,
        "当前生成中数量": 1,
        "计入积分": 0,
        "生成状态": "重试中",
        "失败原因": "",
        "重试次数": tracker.retryCount,
        "最后重试时间": tracker.lastRetryAt,
        "生成代次": tracker.generationIndex,
        "当前卡片ID": "",
        "最后核对时间": tracker.lastRetryAt
      },
      final: false
    }).catch(e => {
      console.warn("[Flow Recorder Safe v3.2] 记录重试失败", e);
    });

    setTimeout(() => {
      pollAllTrackers().catch(e => {
        console.warn("[Flow Recorder Safe v3.2] 重试后状态核对失败", e);
      });
    }, 80);
  }

  function createBaseline(scan, prompt) {
    return {
      allTileUids: new Set(
        scan.ordered.map(item => item.uid).filter(Boolean)
      ),
      pendingCount: countMatching(scan.pending, prompt),
      successKeys: successKeysMatching(scan.successes, prompt),
      failureKeys: new Set(
        scan.failures
          .filter(item => promptMatches(item.prompt, prompt))
          .map(item => item.scanKey)
      ),
      cancellationKeys: new Set(
        scan.cancellations
          .filter(item => promptMatches(item.prompt, prompt))
          .map(item => item.scanKey)
      )
    };
  }

  function ensurePollTimer() {
    if (pollTimer) return;

    pollTimer = setInterval(() => {
      pollAllTrackers().catch(e => {
        console.warn("[Flow Recorder Safe v3.2] 2秒状态核对失败", e);
      });
    }, POLL_INTERVAL_MS);
  }

  function stopPollTimerIfIdle() {
    if (trackers.size !== 0 || !pollTimer) return;

    clearInterval(pollTimer);
    pollTimer = null;
  }

  function currentLocalIso() {
    return new Date().toISOString();
  }


  function trackerMetaSnapshot(tracker) {
    return {
      batchId: tracker.batchId,
      outputIndex: tracker.outputIndex,
      batchCount: tracker.batchCount,
      prompt: tracker.prompt,
      requestCount: tracker.requestCount,
      requestedPoints: tracker.requestedPoints,
      totalBatchPoints: tracker.totalBatchPoints,
      generationIndex: tracker.generationIndex,
      boundOrdinal: Number.isInteger(tracker.boundOrdinal)
        ? tracker.boundOrdinal
        : null,
      boundTileUid: tracker.boundTileUid || "",
      startedAt: Number(tracker.startedAt || Date.now()),
      attemptStartedAt: Number(tracker.attemptStartedAt || Date.now()),
      retryCount: Number(tracker.retryCount || 0),
      lastRetryAt: tracker.lastRetryAt || "",
      cancelCount: Number(tracker.cancelCount || 0),
      lastCancelAt: tracker.lastCancelAt || "",
      refundPoints: tracker.refundPoints ?? "",
      canceled: !!tracker.canceled,
      cancelRequested: !!tracker.cancelRequested,
      cancelRequestedAt: tracker.cancelRequestedAt || "",
      reuseArmed: !!tracker.reuseArmed,
      reuseArmedAt: tracker.reuseArmedAt || "",
      waitingRetry: !!tracker.waitingRetry,
      retryActive: !!tracker.retryActive,
      currentFailureKey: tracker.currentFailureKey || "",
      currentCancellationKey: tracker.currentCancellationKey || "",
      currentTileId: tracker.currentTileId || "",
      restored: !!tracker.restored
    };
  }

  function persistTrackerMeta(tracker) {
    if (!tracker?.recordId) return;

    chrome.runtime.sendMessage({
      type: "SAVE_TRACKER_META",
      recordId: tracker.recordId,
      meta: trackerMetaSnapshot(tracker)
    }).catch(e => {
      console.warn(
        "[Flow Recorder Safe v3.2] 保存本地tracker元数据失败",
        e
      );
    });
  }

  function emptyResumeBaseline() {
    return {
      allTileUids: new Set(),
      pendingCount: 0,
      successKeys: new Set(),
      failureKeys: new Set(),
      cancellationKeys: new Set()
    };
  }

  function reconstructTrackerFromRecord(record) {
    const meta = record?._trackerMeta || {};

    const status = clean(record?.["生成状态"] || "");
    const canceled =
      meta.canceled === true ||
      status === "用户取消" ||
      status === "已重复使用提示";

    const waitingRetry =
      meta.waitingRetry === true ||
      status === "失败";

    const retryActive =
      meta.retryActive === true ||
      status === "重试中" ||
      status === "重新生成中";

    const generationIndex = Math.max(
      1,
      Number(
        meta.generationIndex ??
        record?.["生成代次"] ??
        1
      ) || 1
    );

    const tracker = {
      recordId: clean(record?.["记录ID"]),
      projectKey: clean(meta.projectKey || ""),
      batchId: clean(meta.batchId || record?.["批次ID"]),
      outputIndex: Number(meta.outputIndex ?? record?.["输出序号"] ?? 1) || 1,
      batchCount: Number(meta.batchCount ?? record?.["批次数量"] ?? 1) || 1,
      prompt: clean(meta.prompt || record?.["Prompt"]),
      requestCount: Number(meta.requestCount ?? record?.["请求数量"] ?? 1) || 1,
      requestedPoints: meta.requestedPoints ?? record?.["预估积分"] ?? "",
      totalBatchPoints: meta.totalBatchPoints ?? record?.["批次总积分"] ?? "",
      baseline: emptyResumeBaseline(),
      successKeys: new Set(),
      successDisplayIds: new Map(),
      failedCount: waitingRetry ? 1 : 0,
      failureReasons: record?.["失败原因"]
        ? [clean(record["失败原因"])]
        : [],
      currentPendingCount:
        Number(record?.["当前生成中数量"] ?? 1) || 0,
      retryCount: Number(meta.retryCount ?? record?.["重试次数"] ?? 0) || 0,
      lastRetryAt: clean(meta.lastRetryAt || record?.["最后重试时间"]),
      cancelCount: Number(meta.cancelCount ?? record?.["取消次数"] ?? 0) || 0,
      lastCancelAt: clean(meta.lastCancelAt || record?.["最后取消时间"]),
      refundPoints: meta.refundPoints ?? record?.["退还积分"] ?? "",
      canceled,
      cancelRequested: meta.cancelRequested === true || status === "取消确认中",
      cancelRequestedAt: clean(meta.cancelRequestedAt || ""),
      reuseArmed: meta.reuseArmed === true || status === "已重复使用提示",
      reuseArmedAt: clean(meta.reuseArmedAt || ""),
      currentCancellationKey: clean(meta.currentCancellationKey || ""),
      generationIndex,
      boundTileUid: "",
      currentTileId: "",
      boundOrdinal: Number.isInteger(meta.boundOrdinal)
        ? meta.boundOrdinal
        : null,
      expectNewTile: false,
      attemptStartedAt: Number(meta.attemptStartedAt || Date.now()),
      waitingRetry,
      retryActive,
      currentFailureKey: clean(meta.currentFailureKey || ""),
      slotIds: [`${clean(record?.["记录ID"])}-slot-1`],
      zeroCredit: false,
      timeoutNoted: false,
      lastSyncSignature: "",
      startedAt: Number(meta.startedAt || Date.now()),
      done: false,
      restored: true
    };

    return tracker;
  }

  function candidatePromptMatches(item, tracker) {
    if (!item || !tracker) return false;

    const p = clean(item.prompt);
    const t = clean(tracker.prompt);

    // 有Prompt时必须一致/近似一致；pending有时外层aria-label为空，
    // getTilePrompt会读取subtitle，所以通常仍可匹配。
    if (p && t) return promptMatches(p, t);

    return true;
  }

  function rebindRestoredTrackers(scan) {
    const restored = Array.from(trackers.values())
      .filter(t =>
        !t.done &&
        t.restored &&
        !t.boundTileUid
      )
      .sort((a, b) =>
        (a.startedAt - b.startedAt) ||
        (a.outputIndex - b.outputIndex)
      );

    if (!restored.length) return;

    const claimedUids = new Set(
      Array.from(trackers.values())
        .map(t => t.boundTileUid)
        .filter(Boolean)
    );

    for (const tracker of restored) {
      let item = null;

      // 第一优先：刷新前保存的可见tile序号。
      if (
        Number.isInteger(tracker.boundOrdinal) &&
        tracker.boundOrdinal >= 0
      ) {
        const exact = scan.ordered.find(x =>
          x.ordinal === tracker.boundOrdinal &&
          !claimedUids.has(x.uid) &&
          candidatePromptMatches(x, tracker)
        );

        if (exact) {
          item = exact;
        }
      }

      // 第二优先：附近位置 + 同Prompt，且候选必须唯一。
      if (!item && Number.isInteger(tracker.boundOrdinal)) {
        const radius = Math.max(
          3,
          Number(tracker.batchCount || 1) * 2
        );

        const nearby = scan.ordered.filter(x =>
          !claimedUids.has(x.uid) &&
          candidatePromptMatches(x, tracker) &&
          Math.abs(x.ordinal - tracker.boundOrdinal) <= radius
        );

        if (nearby.length === 1) {
          item = nearby[0];
        }
      }

      // 第三优先：整个当前可见区域里同Prompt只有唯一候选。
      // 多个重复Prompt时绝不猜。
      if (!item) {
        const samePrompt = scan.ordered.filter(x =>
          !claimedUids.has(x.uid) &&
          candidatePromptMatches(x, tracker)
        );

        if (samePrompt.length === 1) {
          item = samePrompt[0];
        }
      }

      if (!item) continue;

      markTileForTracker(
        item.tile,
        tracker,
        item.ordinal
      );

      tracker.restored = false;
      claimedUids.add(item.uid);
      persistTrackerMeta(tracker);

      console.log(
        "[Flow Recorder Safe v3.2] 页面刷新后已重新绑定单个输出",
        {
          recordId: tracker.recordId,
          batchId: tracker.batchId,
          outputIndex: tracker.outputIndex,
          generationIndex: tracker.generationIndex,
          ordinal: item.ordinal,
          kind: item.kind
        }
      );
    }
  }

  async function restoreTrackersFromStorage() {
    if (restoreRunning) return;
    restoreRunning = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_ACTIVE_RECORDS"
      });

      const records = Array.isArray(response?.records)
        ? response.records
        : [];

      if (!records.length) {
        restoreCompletedOnce = true;
        return;
      }

      for (const record of records) {
        const recordId = clean(record?.["记录ID"]);
        if (!recordId || trackers.has(recordId)) continue;

        const points = Number(record?.["预估积分"]);
        const explicitZero =
          record?.["预估积分"] !== "" &&
          Number.isFinite(points) &&
          points === 0;

        if (explicitZero) continue;

        const status = clean(record?.["生成状态"]);
        if (status === "成功") continue;

        const metaProjectKey = clean(record?._trackerMeta?.projectKey || "");

        if (
          metaProjectKey &&
          metaProjectKey !== currentProjectKey()
        ) {
          continue;
        }

        const tracker = reconstructTrackerFromRecord(record);
        trackers.set(recordId, tracker);
      }

      if (trackers.size > 0) {
        ensurePollTimer();

        const scan = scanPage();
        rebindRestoredTrackers(scan);

        // 重新绑定后立刻检查当前真实页面状态：
        // 刷新前是pending，刷新后若已经是video，就会立即认定成功。
        await pollAllTrackers();
        scheduleRealtimeReconcile(30);
      }

      restoreCompletedOnce = true;

    } catch (e) {
      console.warn(
        "[Flow Recorder Safe v3.2] 页面刷新后恢复tracker失败",
        e
      );
    } finally {
      restoreRunning = false;
    }
  }


  function trackerResult(tracker, scan) {
    const matchingPending = scan.pending.filter(item =>
      itemBelongsToTracker(item, tracker)
    );

    const matchingSuccess = scan.successes.filter(item =>
      itemBelongsToTracker(item, tracker)
    );

    const matchingFailures = scan.failures.filter(item =>
      itemBelongsToTracker(item, tracker)
    );

    const cancelIntent = recentActionIntent("cancel", tracker);

    const matchingCancellations = scan.cancellations.filter(item =>
      itemBelongsToTracker(item, tracker) ||
      itemMatchesActionIntent(item, cancelIntent)
    );

    // “用户取消”必须同时满足：
    // 1) 确实点击了该视频/图片自己对应的取消按钮；
    // 2) 该同一条记录对应的 tile 明确显示“此生成操作已取消”。
    if (
      tracker.successKeys.size === 0 &&
      !tracker.canceled &&
      tracker.cancelRequested === true
    ) {
      const cancellation = matchingCancellations.find(item => {
        const exactCurrentOwner =
          item.recordId === tracker.recordId &&
          Number(item.generation || 0) === tracker.generationIndex;

        return (
          (exactCurrentOwner ||
           !tracker.baseline.cancellationKeys.has(item.scanKey)) &&
          !claimedCancellationKeys.has(item.scanKey)
        );
      });

      if (cancellation) {
        tracker.canceled = true;
        tracker.cancelRequested = false;
        tracker.reuseArmed = false;
        tracker.retryActive = false;
        tracker.waitingRetry = false;
        tracker.failedCount = 0;
        tracker.failureReasons = [];
        tracker.currentPendingCount = 0;
        tracker.cancelCount = Number(tracker.cancelCount || 0) + 1;
        tracker.lastCancelAt = currentLocalIso();
        tracker.currentCancellationKey = cancellation.scanKey;
        tracker.refundPoints = cancellation.refundPoints;
        claimedCancellationKeys.add(cancellation.scanKey);
        markTileForTracker(
          cancellation.tile,
          tracker,
          cancellation.ordinal
        );
        actionIntents.delete(`cancel:${tracker.recordId}`);
        persistTrackerMeta(tracker);
      }
    }

    if (tracker.canceled && !tracker.retryActive) {
      return {
        successCount: 0,
        failedCount: 0,
        currentPendingCount: 0,
        status: tracker.reuseArmed ? "已重复使用提示" : "用户取消",
        countedPoints: 0,
        successMediaIds: "",
        failureReasons: "",
        lastCheckedAt: currentLocalIso()
      };
    }

    if (tracker.cancelRequested && tracker.successKeys.size === 0) {
      if (matchingSuccess.length === 0 && matchingFailures.length === 0) {
        return {
          successCount: 0,
          failedCount: 0,
          currentPendingCount: 1,
          status: "取消确认中",
          countedPoints: 0,
          successMediaIds: "",
          failureReasons: "",
          lastCheckedAt: currentLocalIso()
        };
      }
    }

    // 同一记录当前代次只允许认领一个成功结果。
    if (!tracker.waitingRetry && tracker.successKeys.size === 0) {
      const success = matchingSuccess.find(item => {
        const exactCurrentOwner =
          item.recordId === tracker.recordId &&
          Number(item.generation || 0) === tracker.generationIndex;

        return (
          (exactCurrentOwner ||
           !tracker.baseline.successKeys.has(item.key)) &&
          !claimedSuccessKeys.has(item.key)
        );
      });

      if (success) {
        tracker.successKeys.add(success.key);
        tracker.successDisplayIds.set(
          success.key,
          success.displayId || success.key
        );
        claimedSuccessKeys.add(success.key);
        tracker.failedCount = 0;
        tracker.failureReasons = [];
        tracker.waitingRetry = false;
        tracker.retryActive = false;
        tracker.cancelRequested = false;
        markTileForTracker(success.tile, tracker, success.ordinal);
        persistTrackerMeta(tracker);
      }
    }

    // 同一记录当前代次只允许认领一个明确失败卡片。
    if (
      tracker.successKeys.size === 0 &&
      !tracker.waitingRetry
    ) {
      const failure = matchingFailures.find(item => {
        const exactCurrentOwner =
          item.recordId === tracker.recordId &&
          Number(item.generation || 0) === tracker.generationIndex;

        return (
          (exactCurrentOwner ||
           !tracker.baseline.failureKeys.has(item.scanKey)) &&
          !claimedFailureKeys.has(item.scanKey)
        );
      });

      if (failure) {
        tracker.failedCount = 1;
        tracker.failureReasons = [failure.reason || "失败"];
        tracker.waitingRetry = true;
        tracker.retryActive = false;
        tracker.currentFailureKey = failure.scanKey;
        claimedFailureKeys.add(failure.scanKey);
        markTileForTracker(failure.tile, tracker, failure.ordinal);
        persistTrackerMeta(tracker);
      }
    }

    const successCount = tracker.successKeys.size > 0 ? 1 : 0;
    const failedCount = tracker.waitingRetry ? 1 : 0;

    let currentPendingCount = 0;
    let status = "生成中";

    if (successCount === 1) {
      status = "成功";
      currentPendingCount = 0;
    } else if (tracker.waitingRetry) {
      status = "失败";
      currentPendingCount = 0;
    } else if (tracker.retryActive) {
      status = "重试中";
      currentPendingCount = 1;
    } else if (tracker.expectNewTile || matchingPending.length > 0) {
      status = "生成中";
      currentPendingCount = 1;
    } else {
      status = "生成中";
      currentPendingCount = 1;
    }

    let countedPoints = 0;
    const unitPoints = Number(tracker.requestedPoints);

    if (successCount === 1 && Number.isFinite(unitPoints)) {
      countedPoints = unitPoints;
    }

    return {
      successCount,
      failedCount,
      currentPendingCount,
      status,
      countedPoints,
      successMediaIds: Array.from(
        tracker.successDisplayIds.values()
      ).join(", "),
      failureReasons: tracker.failureReasons.join(" | "),
      lastCheckedAt: currentLocalIso()
    };
  }

  async function updateTrackerRecord(tracker, result, final = false) {
    const patch = {
      "成功数量": result.successCount,
      "失败数量": result.failedCount,
      "当前生成中数量": result.currentPendingCount,
      "计入积分": result.countedPoints,
      "生成状态": result.status,
      "失败原因": result.failureReasons,
      "跟踪ID": tracker.slotIds.join(", "),
      "成功媒体ID": result.successMediaIds,
      "最后核对时间": result.lastCheckedAt,
      "重试次数": Number(tracker.retryCount || 0),
      "最后重试时间": tracker.lastRetryAt || "",
      "取消次数": Number(tracker.cancelCount || 0),
      "最后取消时间": tracker.lastCancelAt || "",
      "退还积分": tracker.refundPoints ?? "",
      "生成代次": Number(tracker.generationIndex || 1),
      "当前卡片ID": tracker.currentTileId || tracker.boundTileUid || ""
    };

    if (final) {
      patch["完成时间"] = result.lastCheckedAt;
    }

    return chrome.runtime.sendMessage({
      type: "UPDATE_GENERATION_RECORD",
      recordId: tracker.recordId,
      patch,
      final
    });
  }





  function currentUidSet(scan) {
    return new Set(
      scan.ordered.map(item => item.uid).filter(Boolean)
    );
  }

  function isItemOwnedByOtherTracker(item, tracker) {
    return Array.from(trackers.values()).some(t =>
      t !== tracker &&
      !t.done &&
      (
        (t.boundTileUid && t.boundTileUid === item.uid) ||
        (
          item.recordId &&
          item.recordId === t.recordId
        )
      )
    );
  }

  function repairLiveTrackerBindings(scan) {
    const uids = currentUidSet(scan);

    const broken = Array.from(trackers.values())
      .filter(t =>
        !t.done &&
        !t.zeroCredit &&
        !t.canceled &&
        t.successKeys.size === 0 &&
        t.boundTileUid &&
        !uids.has(t.boundTileUid)
      )
      .sort((a, b) =>
        (a.startedAt - b.startedAt) ||
        (a.outputIndex - b.outputIndex)
      );

    for (const tracker of broken) {
      let candidate = null;

      // 1. Flow最常见行为：替换同一个视觉位置的整个tile。
      if (Number.isInteger(tracker.boundOrdinal)) {
        const exact = scan.ordered.filter(item =>
          item.ordinal === tracker.boundOrdinal &&
          !isItemOwnedByOtherTracker(item, tracker) &&
          candidatePromptMatches(item, tracker)
        );

        if (exact.length === 1) {
          candidate = exact[0];
        }
      }

      // 2. 同批次如果还有兄弟输出保持绑定，
      //    用兄弟输出的位置推断本输出的相对slot。
      if (!candidate) {
        const siblings = Array.from(trackers.values())
          .filter(t =>
            t !== tracker &&
            !t.done &&
            t.batchId === tracker.batchId &&
            Number.isInteger(t.boundOrdinal) &&
            t.boundTileUid &&
            uids.has(t.boundTileUid)
          );

        const inferred = [];

        for (const sibling of siblings) {
          const expected =
            sibling.boundOrdinal +
            (tracker.outputIndex - sibling.outputIndex);

          const hit = scan.ordered.find(item =>
            item.ordinal === expected &&
            !isItemOwnedByOtherTracker(item, tracker) &&
            candidatePromptMatches(item, tracker)
          );

          if (hit) inferred.push(hit);
        }

        const unique = [
          ...new Map(inferred.map(x => [x.uid, x])).values()
        ];

        if (unique.length === 1) {
          candidate = unique[0];
        }
      }

      // 3. 最后只在旧位置附近存在唯一候选时修复。
      //    多个重复Prompt候选时不猜。
      if (!candidate && Number.isInteger(tracker.boundOrdinal)) {
        const nearby = scan.ordered.filter(item =>
          Math.abs(item.ordinal - tracker.boundOrdinal) <=
            Math.max(2, Number(tracker.batchCount || 1)) &&
          !isItemOwnedByOtherTracker(item, tracker) &&
          candidatePromptMatches(item, tracker)
        );

        if (nearby.length === 1) {
          candidate = nearby[0];
        }
      }

      if (!candidate) continue;

      markTileForTracker(
        candidate.tile,
        tracker,
        candidate.ordinal
      );

      console.log(
        "[Flow Recorder Safe v3.2] 实时修复已丢失的单视频tile绑定",
        {
          recordId: tracker.recordId,
          batchId: tracker.batchId,
          outputIndex: tracker.outputIndex,
          generationIndex: tracker.generationIndex,
          ordinal: candidate.ordinal,
          kind: candidate.kind
        }
      );
    }
  }

  function bindNewTilesToTrackers(scan) {
    const unownedNewItems = scan.ordered.filter(item => {
      if (item.recordId) return false;

      // 只认当前页面中还没有被任何记录绑定的结果位。
      return !Array.from(trackers.values()).some(t =>
        !t.done &&
        t.boundTileUid &&
        t.boundTileUid === item.uid
      );
    });

    // A. 先处理“重试 / 取消后重新生成”的单条 tracker。
    // 每个 tracker 有自己的 attempt baseline，只能领取点击重试之后新出现的 tile。
    const attemptTrackers = Array.from(trackers.values())
      .filter(t =>
        !t.done &&
        !t.zeroCredit &&
        !t.canceled &&
        !t.waitingRetry &&
        t.successKeys.size === 0 &&
        t.expectNewTile &&
        Number(t.generationIndex || 1) > 1
      )
      .sort((a, b) =>
        (a.attemptStartedAt - b.attemptStartedAt) ||
        (a.startedAt - b.startedAt) ||
        (a.outputIndex - b.outputIndex)
      );

    for (const tracker of attemptTrackers) {
      const item = unownedNewItems.find(x =>
        !tileRecordId(x.tile) &&
        !tracker.baseline.allTileUids.has(x.uid)
      );

      if (!item) continue;

      markTileForTracker(item.tile, tracker, item.ordinal);
    }

    // B. 再处理首次批量生成。
    // 一个批次生成 N 个，就把“本次点击之后新出现的 N 个 tile”
    // 按 DOM 出现顺序一一绑定给输出 1..N。
    const activeBatches = Array.from(batches.values())
      .filter(b => !b.done)
      .sort((a, b) => a.startedAt - b.startedAt);

    for (const batch of activeBatches) {
      const batchTrackers = batch.trackerIds
        .map(id => trackers.get(id))
        .filter(Boolean)
        .filter(t =>
          !t.done &&
          t.generationIndex === 1 &&
          t.expectNewTile &&
          !t.boundTileUid
        )
        .sort((a, b) => a.outputIndex - b.outputIndex);

      if (!batchTrackers.length) {
        const remaining = batch.trackerIds
          .map(id => trackers.get(id))
          .filter(t => t && !t.done);

        if (!remaining.length) {
          batch.done = true;
        }

        continue;
      }

      const allCandidates = unownedNewItems
        .filter(item => {
          if (tileRecordId(item.tile)) return false;

          const existedBefore = batch.baselineTileUids.has(item.uid);
          const oldKind = batch.baselineStateByUid?.get(item.uid) || "";

          return (
            !existedBefore ||
            (item.kind === "pending" && oldKind !== "pending")
          );
        })
        .sort((a, b) => a.ordinal - b.ordinal);

      const pendingCandidates = allCandidates.filter(
        item => item.kind === "pending"
      );

      // 首次绑定优先绑定真实pending，避免Angular重绘旧成功tile时
      // 因uid变化而被误当成这个新批次的输出。
      const candidates =
        pendingCandidates.length >= batchTrackers.length
          ? pendingCandidates
          : allCandidates;

      for (const tracker of batchTrackers) {
        const item = candidates.find(x =>
          !tileRecordId(x.tile)
        );

        if (!item) break;

        markTileForTracker(item.tile, tracker, item.ordinal);
      }
    }
  }

  async function pollAllTrackers() {
    if (pollRunning || trackers.size === 0) return;

    pollRunning = true;

    try {
      const scan = scanPage();
      rebindRestoredTrackers(scan);
      repairLiveTrackerBindings(scan);
      bindNewTilesToTrackers(scan);

      // 旧请求优先领取成功结果，避免多个同时生成的请求互相影响。
      const ordered = Array.from(trackers.values())
        .filter(t =>
          !t.projectKey ||
          t.projectKey === currentProjectKey()
        )
        .sort((a, b) =>
          (a.startedAt - b.startedAt) ||
          (a.outputIndex - b.outputIndex)
        );

      for (const tracker of ordered) {
        if (tracker.done) continue;

        const result = trackerResult(tracker, scan);

        // 每2秒检查一次，但只有“可见状态真正变化”时才提交到后台。
        // 这样减少 Apps Script 无意义重复写入，Google Sheet 会更快追上本地状态。
        const final = result.status === "成功";

        const syncSignature = JSON.stringify({
          successCount: result.successCount,
          failedCount: result.failedCount,
          currentPendingCount: result.currentPendingCount,
          status: result.status,
          countedPoints: result.countedPoints,
          successMediaIds: result.successMediaIds,
          failureReasons: result.failureReasons,
          retryCount: tracker.retryCount || 0,
          cancelCount: tracker.cancelCount || 0,
          canceled: tracker.canceled || false,
          cancelRequested: tracker.cancelRequested || false,
          reuseArmed: tracker.reuseArmed || false,
          generationIndex: tracker.generationIndex || 1,
          currentTileId: tracker.currentTileId || "",
          boundOrdinal: Number.isInteger(tracker.boundOrdinal)
            ? tracker.boundOrdinal
            : ""
        });

        if (syncSignature !== tracker.lastSyncSignature || final) {
          tracker.lastSyncSignature = syncSignature;
          await updateTrackerRecord(tracker, result, final);
        }

        if (final) {
          tracker.done = true;
          trackers.delete(tracker.recordId);

          const batch = batches.get(tracker.batchId);
          if (batch) {
            const stillActive = batch.trackerIds.some(id => {
              const t = trackers.get(id);
              return !!(t && !t.done);
            });

            if (!stillActive) {
              batch.done = true;
            }
          }

          continue;
        }

        if (
          Date.now() - tracker.startedAt > TRACK_TIMEOUT_MS &&
          !tracker.timeoutNoted
        ) {
          tracker.timeoutNoted = true;

          const timeoutResult = {
            ...result,
            status:
              result.status === "失败" ||
              result.status === "重试中"
                ? result.status
                : "长期跟踪中",
            failureReasons:
              result.failureReasons ||
              "已持续跟踪超过24小时；只要页面仍打开，插件仍会继续核对",
            lastCheckedAt: currentLocalIso()
          };

          await updateTrackerRecord(tracker, timeoutResult, false);
        }
      }

    } finally {
      pollRunning = false;
      stopPollTimerIfIdle();
    }
  }

  async function startCapture(triggerMethod, root) {
    if (!root) return;

    const button = findGenerateButton(root);

    if (
      button?.disabled ||
      attr(button, "aria-disabled") === "true"
    ) {
      return;
    }

    refreshSettingsCache(root);

    const prompt = getPrompt(root);
    if (!prompt) return;

    const summaryText = getSettingsSummary(root);
    const parsed = parseSettingsSummary(summaryText);
    const model = detectModel(root, parsed);

    // v3.2：只修正“记录到Google表格中的模型名称”。
    // 编辑模式下，以点击生成/按Enter这一刻，
    // 生成按钮旁边可见元素的文字为准。
    // 其它积分、状态、媒体类型逻辑保持v3.0不变。
    const recordedModel =
      getEditModeModelBesideGenerate(root) ||
      model;

    const mediaType = inferMediaType(model, parsed.mediaType);
    const batchCount = Math.max(1, Number(parsed.count || 1));
    const totalPoints = await getCreditForCurrentSettingsWithPrefetch(
      root,
      model,
      summaryText
    );

    const totalPointsNumber = Number(totalPoints);
    const zeroCredit =
      totalPoints !== "" &&
      Number.isFinite(totalPointsNumber) &&
      totalPointsNumber === 0;

    const unitPoints =
      totalPoints !== "" &&
      Number.isFinite(totalPointsNumber) &&
      batchCount > 0
        ? Math.round((totalPointsNumber / batchCount) * 1000) / 1000
        : "";

    const beforeScan = scanPage();
    const baseline = createBaseline(beforeScan, prompt);

    const dedupeSignature = [
      prompt,
      recordedModel,
      summaryText,
      batchCount,
      totalPoints
    ].join("||");

    const now = Date.now();

    if (
      lastTrigger &&
      lastTrigger.signature === dedupeSignature &&
      lastTrigger.method !== triggerMethod &&
      now - lastTrigger.at < 1200
    ) {
      return;
    }

    lastTrigger = {
      signature: dedupeSignature,
      method: triggerMethod,
      at: now
    };

    const batchId = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 如果用户先在“用户取消”的卡片上点击了“重复使用提示”，
    // 随后又点击生成/按Enter，则优先恢复原来的那条记录，而不是创建重复的新行。
    const armedReuse = Array.from(trackers.values())
      .filter(t =>
        !t.done &&
        !t.zeroCredit &&
        t.reuseArmed &&
        (t.canceled || t.waitingRetry)
      )
      .sort((a, b) =>
        String(b.reuseArmedAt || "").localeCompare(
          String(a.reuseArmedAt || "")
        )
      );

    if (!zeroCredit && armedReuse.length > 0) {
      const tracker = armedReuse[0];

      tracker.canceled = false;
      tracker.cancelRequested = false;
      tracker.reuseArmed = false;
      tracker.retryActive = true;
      tracker.waitingRetry = false;
      tracker.failedCount = 0;
      tracker.failureReasons = [];
      tracker.currentPendingCount = 1;
      tracker.retryCount = Number(tracker.retryCount || 0) + 1;
      tracker.lastRetryAt = currentLocalIso();
      tracker.generationIndex = Number(tracker.generationIndex || 1) + 1;
      tracker.expectNewTile = true;
      tracker.boundTileUid = "";
      tracker.currentTileId = "";
      tracker.boundOrdinal = null;
      tracker.attemptStartedAt = Date.now();

      // 重新生成前重新建立基线，旧取消卡片永久属于上一代。
      tracker.baseline = createBaseline(beforeScan, tracker.prompt);
      persistTrackerMeta(tracker);

      await chrome.runtime.sendMessage({
        type: "UPDATE_GENERATION_RECORD",
        recordId: tracker.recordId,
        patch: {
          "成功数量": 0,
          "失败数量": 0,
          "当前生成中数量": 1,
          "计入积分": 0,
          "生成状态": "重新生成中",
          "失败原因": "",
          "重试次数": tracker.retryCount,
          "最后重试时间": tracker.lastRetryAt,
          "生成代次": tracker.generationIndex,
          "当前卡片ID": "",
          "最后核对时间": tracker.lastRetryAt
        },
        final: false
      });

      ensurePollTimer();
      scheduleRealtimeReconcile(35);
      setTimeout(() => {
        pollAllTrackers().catch(e => {
          console.warn(
            "[Flow Recorder Safe v3.2] 取消后重新生成首次核对失败",
            e
          );
        });
      }, 100);

      console.log(
        "[Flow Recorder Safe v3.2] 已恢复用户取消的原记录",
        {
          recordId: tracker.recordId,
          outputIndex: tracker.outputIndex,
          originalUnitPoints: tracker.requestedPoints
        }
      );

      return;
    }

    // 0积分：只保存一次请求记录。
    // 不显示生成状态，不跟踪成功/失败，不拆分成多条结果记录。
    if (zeroCredit) {
      const record = {
        "批次ID": batchId,
        "输出序号": "",
        "批次数量": batchCount,
        "批次总积分": 0,
        "项目名称": getProjectName(),
        "Prompt": prompt,
        "触发方式": triggerMethod,
        "模型": recordedModel,
        "图片/视频": mediaType,
        "比例": parsed.ratio,
        "请求数量": batchCount,
        "视频时长": parsed.duration,
        "视频分辨率": parsed.resolution,
        "预估积分": 0,
        "成功数量": "",
        "失败数量": "",
        "当前生成中数量": "",
        "计入积分": 0,
        "生成状态": "",
        "失败原因": "",
        "跟踪ID": "",
        "成功媒体ID": "",
        "完成时间": "",
        "最后核对时间": "",
        "重试次数": "",
        "最后重试时间": "",
        "取消次数": "",
        "最后取消时间": "",
        "退还积分": "",
        "生成代次": "",
        "当前卡片ID": "",
        "触发前页面完成数": beforeScan.successes.length,
        "触发前页面生成中数": beforeScan.pending.length,
        "Agent状态": getAgent(root),
        "设置摘要": summaryText
      };

      try {
        await chrome.runtime.sendMessage({
          type: "CREATE_GENERATION_RECORD",
          record
        });

        console.log(
          "[Flow Recorder Safe v3.2] 0积分任务仅记录一次，不跟踪状态",
          { batchId, batchCount, prompt }
        );
      } catch (e) {
        console.warn("[Flow Recorder Safe v3.2] 0积分记录失败", e);
      }

      return;
    }

    // 使用积分：生成几个结果，就创建几条独立记录。
    // 每条记录的积分 = 页面显示总积分 / 生成数量。
    const createdTrackers = [];

    for (let i = 1; i <= batchCount; i++) {
      const record = {
        "批次ID": batchId,
        "输出序号": i,
        "批次数量": batchCount,
        "批次总积分": totalPoints,
        "项目名称": getProjectName(),
        "Prompt": prompt,
        "触发方式": triggerMethod,
        "模型": recordedModel,
        "图片/视频": mediaType,
        "比例": parsed.ratio,
        "请求数量": 1,
        "视频时长": parsed.duration,
        "视频分辨率": parsed.resolution,
        "预估积分": unitPoints,
        "成功数量": 0,
        "失败数量": 0,
        "当前生成中数量": 1,
        "计入积分": 0,
        "生成状态": "生成中",
        "失败原因": "",
        "跟踪ID": "",
        "成功媒体ID": "",
        "完成时间": "",
        "最后核对时间": currentLocalIso(),
        "重试次数": 0,
        "最后重试时间": "",
        "取消次数": 0,
        "最后取消时间": "",
        "退还积分": "",
        "生成代次": 1,
        "当前卡片ID": "",
        "触发前页面完成数": beforeScan.successes.length,
        "触发前页面生成中数": beforeScan.pending.length,
        "Agent状态": getAgent(root),
        "设置摘要": summaryText,
        "_trackerMeta": {
          projectKey: currentProjectKey(),
          batchId,
          outputIndex: i,
          batchCount,
          prompt,
          requestCount: 1,
          requestedPoints: unitPoints,
          totalBatchPoints: totalPoints,
          generationIndex: 1,
          boundOrdinal: null,
          startedAt: Date.now(),
          attemptStartedAt: Date.now()
        }
      };

      try {
        const result = await chrome.runtime.sendMessage({
          type: "CREATE_GENERATION_RECORD",
          record
        });

        if (!result?.ok || !result.recordId) {
          console.warn(
            "[Flow Recorder Safe v3.2] 创建单项记录失败",
            { batchId, outputIndex: i, result }
          );
          continue;
        }

        const tracker = {
          recordId: result.recordId,
          projectKey: currentProjectKey(),
          batchId,
          outputIndex: i,
          batchCount,
          prompt,
          requestCount: 1,
          requestedPoints: unitPoints,
          totalBatchPoints: totalPoints,
          baseline,
          successKeys: new Set(),
          successDisplayIds: new Map(),
          failedCount: 0,
          failureReasons: [],
          currentPendingCount: 1,
          retryCount: 0,
          lastRetryAt: "",
          cancelCount: 0,
          lastCancelAt: "",
          refundPoints: "",
          canceled: false,
          cancelRequested: false,
          cancelRequestedAt: "",
          reuseArmed: false,
          reuseArmedAt: "",
          currentCancellationKey: "",
          generationIndex: 1,
          boundTileUid: "",
          currentTileId: "",
          boundOrdinal: null,
          expectNewTile: true,
          attemptStartedAt: Date.now(),
          waitingRetry: false,
          retryActive: false,
          currentFailureKey: "",
          slotIds: [`${result.recordId}-slot-1`],
          zeroCredit: false,
          timeoutNoted: false,
          lastSyncSignature: "",
          startedAt: Date.now(),
          done: false
        };

        trackers.set(tracker.recordId, tracker);
        createdTrackers.push(tracker);
        persistTrackerMeta(tracker);

      } catch (e) {
        console.warn(
          "[Flow Recorder Safe v3.2] 创建单项跟踪失败",
          { batchId, outputIndex: i, error: e }
        );
      }
    }

    if (createdTrackers.length > 0) {
      batches.set(batchId, {
        batchId,
        startedAt: Date.now(),
        expectedCount: batchCount,
        trackerIds: createdTrackers.map(t => t.recordId),
        baselineTileUids: new Set(
          beforeScan.ordered.map(item => item.uid).filter(Boolean)
        ),
        baselineStateByUid: new Map(
          beforeScan.ordered
            .filter(item => item.uid)
            .map(item => [item.uid, item.kind])
        ),
        done: false
      });

      ensurePollTimer();
      scheduleRealtimeReconcile(35);

      setTimeout(() => {
        pollAllTrackers().catch(e => {
          console.warn(
            "[Flow Recorder Safe v3.2] 首次状态核对失败",
            e
          );
        });
      }, 120);
    }

    console.log("[Flow Recorder Safe v3.2] 已按结果数量拆分记录", {
      batchId,
      batchCount,
      totalPoints,
      unitPoints,
      createdRows: createdTrackers.length
    });
  }

  document.addEventListener("input", event => {
    const target = event.target;
    if (
      !target?.closest?.(
        'flow-rich-text-editor .ProseMirror, .ProseMirror[contenteditable="true"], .prompt-input'
      )
    ) {
      return;
    }

    const root =
      findRoot(target) ||
      document.querySelector(ROOT_SELECTOR);

    if (!root) return;

    setTimeout(() => {
      refreshSettingsCache(root);
    }, 80);
  }, true);

  document.addEventListener("pointerover", event => {
    const target = event.target;
    const root =
      findRoot(target) ||
      document.querySelector(ROOT_SELECTOR);

    if (!root) return;

    if (
      isGenerateButton(target) ||
      target?.closest?.(".settings-trigger-button") ||
      target?.closest?.(".settings-summary")
    ) {
      probeCreditForCurrentSettings(root, { waitMs: 220 }).catch(() => {});
    }
  }, true);

  document.addEventListener("click", event => {
    const clicked = event.target;
    const root = findRoot(clicked) || document.querySelector(ROOT_SELECTOR);

    if (
      clicked?.closest?.(".settings-trigger-button") ||
      clicked?.closest?.('button[aria-label*="設定觸發條件"]') ||
      clicked?.closest?.('button[aria-label*="设置触发条件"]') ||
      clicked?.closest?.(".settings-summary") ||
      clicked?.closest?.(".model-select-trigger-content") ||
      clicked?.closest?.("flow-credit-cost-label") ||
      clicked?.closest?.(".settings-credit-cost")
    ) {
      setTimeout(() => refreshSettingsCache(root), 120);
    }

    if (isCancelGenerationButton(clicked)) {
      const tile = clicked?.closest?.(GRID_TILE_SELECTOR);
      if (tile) {
        // 鼠标点到哪个取消按钮，就立即绑定这个按钮所在的具体输出tile。
        bindActionTileToTracker(tile, "active");
        noteManualCancel(tile);
        return;
      }
    }

    if (isRepeatPromptButton(clicked)) {
      const tile = clicked?.closest?.(GRID_TILE_SELECTOR);

      // 取消卡片上的“重复使用提示词”：
      // 直接从按钮所在tile恢复recordId，不再因为取消标题语言不同而漏记。
      if (tile && tile.querySelector("flow-error-tile")) {
        if (isCanceledTile(tile)) {
          bindActionTileToTracker(tile, "canceled");
        } else if (isFailureTile(tile)) {
          bindActionTileToTracker(tile, "failure");
        }

        if (noteReuseErrorTile(tile)) {
          return;
        }
      }
    }

    if (isRetryButton(clicked)) {
      const failureTile = findFailureTileFromTarget(clicked);
      if (failureTile) {
        // 鼠标点到哪个失败卡片的重试按钮，就只推进这一条输出。
        bindActionTileToTracker(failureTile, "failure");
        noteRetryClick(failureTile);
        return;
      }
    }

    if (!root || !isGenerateButton(clicked)) return;

    startCapture("点击按钮", root);
  }, true);

  document.addEventListener("keydown", event => {
    if (!isPromptEnter(event)) return;

    const root =
      findRoot(event.target) ||
      document.querySelector(ROOT_SELECTOR);

    if (!root) return;

    const button = findGenerateButton(root);

    if (
      button?.disabled ||
      attr(button, "aria-disabled") === "true"
    ) {
      return;
    }

    startCapture("回车键", root);
  }, true);

  // MutationObserver 是实时主检测。
  // v3.2额外负责“身份交接”：
  // Flow经常不是在原tile内部改pending->video，
  // 而是直接把整个flow-grid-tile-container换掉。
  // 如果不把旧tile的recordId交给新tile，插件就会一直显示生成中。
  const observer = new MutationObserver(mutations => {
    let shouldReconcile = false;
    let shouldRefreshSettings = false;
    const addedTiles = [];

    for (const mutation of mutations) {
      const target = mutation.target;

      if (mutation.type === "childList") {
        for (const node of mutation.removedNodes || []) {
          for (const tile of collectGridTilesFromNode(node)) {
            rememberDetachedBinding(tile);
          }
        }

        for (const node of mutation.addedNodes || []) {
          for (const tile of collectGridTilesFromNode(node)) {
            addedTiles.push(tile);
          }
        }
      }

      if (
        target?.closest?.(GRID_TILE_SELECTOR) ||
        mutation.addedNodes?.length ||
        mutation.removedNodes?.length
      ) {
        shouldReconcile = true;
      }

      if (
        target?.closest?.(ROOT_SELECTOR) ||
        target?.closest?.(".model-select-trigger-content") ||
        target?.closest?.("flow-credit-cost-label") ||
        target?.closest?.(".settings-credit-cost")
      ) {
        shouldRefreshSettings = true;
      }
    }

    // 新tile进入DOM以后，先尝试把刚刚被移除的旧tile身份交接回来。
    for (const tile of addedTiles) {
      adoptAddedTileFromDetached(tile);
    }

    if (shouldRefreshSettings) {
      const root = document.querySelector(ROOT_SELECTOR);
      if (root) {
        refreshSettingsCache(root);
      }
    }

    if (shouldReconcile && trackers.size > 0) {
      scheduleRealtimeReconcile(20);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "class",
      "aria-label",
      "aria-disabled",
      "src",
      "data-media-id"
    ]
  });

  // 页面刷新后的恢复保险。
  setTimeout(() => {
    restoreTrackersFromStorage();
  }, 250);

  setTimeout(() => {
    if (!restoreCompletedOnce || trackers.size > 0) {
      restoreTrackersFromStorage();
      scheduleRealtimeReconcile(30);
    }
  }, 1200);


  window.FlowRecorderSafe = {
    inspectCurrentSettings() {
      const root = document.querySelector(ROOT_SELECTOR);

      if (!root) {
        return { error: "未找到 Flow prompt box" };
      }

      refreshSettingsCache(root);

      const summaryText = getSettingsSummary(root);
      const parsed = parseSettingsSummary(summaryText);
      const model = detectModel(root, parsed);
      const scan = scanPage();

      return {
        prompt: getPrompt(root),
        model,
        mediaType: inferMediaType(model, parsed.mediaType),
        ratio: parsed.ratio,
        count: parsed.count,
        duration: parsed.duration,
        resolution: parsed.resolution,
        requestedPoints: getCreditForCurrentSettings(
          root,
          model,
          summaryText
        ),
        currentPageSuccess: scan.successes.length,
        currentPagePending: scan.pending.length,
        currentPageFailure: scan.failures.length,
        currentPageCanceled: scan.cancellations.length,
        settingsSummary: summaryText
      };
    },

    activeTrackers() {
      return Array.from(trackers.values()).map(t => ({
        recordId: t.recordId,
        batchId: t.batchId,
        outputIndex: t.outputIndex,
        batchCount: t.batchCount,
        prompt: t.prompt,
        requestCount: t.requestCount,
        successCount: t.successKeys.size,
        failedCount: t.failedCount,
        currentPendingCount: t.currentPendingCount,
        retryCount: t.retryCount,
        lastRetryAt: t.lastRetryAt,
        cancelCount: t.cancelCount,
        lastCancelAt: t.lastCancelAt,
        canceled: t.canceled,
        cancelRequested: t.cancelRequested,
        cancelRequestedAt: t.cancelRequestedAt,
        reuseArmed: t.reuseArmed,
        generationIndex: t.generationIndex,
        boundTileUid: t.boundTileUid,
        currentTileId: t.currentTileId,
        boundOrdinal: t.boundOrdinal,
        attemptStartedAt: t.attemptStartedAt,
        expectNewTile: t.expectNewTile,
        slotIds: t.slotIds
      }));
    },

    editModelInfo() {
      const root =
        document.querySelector("flow-edit-video-prompt-box flow-base-prompt-box") ||
        document.querySelector("flow-edit-video-prompt-box");

      return {
        editMode: isVideoEditMode(),
        modelBesideGenerate: getEditModeModelBesideGenerate(root)
      };
    },

    creditInfo() {
      const root =
        document.querySelector(ROOT_SELECTOR);

      const summary = root ? getSettingsSummary(root) : "";
      const parsed = parseSettingsSummary(summary);
      const model = root ? detectModel(root, parsed) : "";

      return {
        liveCredit: readCreditFromPage(),
        cachedCredit,
        settingsSummary: summary,
        settingsFingerprint: settingsFingerprint(model, summary),
        probeInFlight: !!creditProbePromise,
        probeFingerprint: creditProbeFingerprint
      };
    },

    diagnose() {
      const scan = scanPage();

      return scan.ordered.map(item => ({
        ordinal: item.ordinal,
        kind: item.kind,
        recordId: item.recordId,
        generation: item.generation,
        prompt: item.prompt,
        scanKey: item.scanKey,
        reason: item.reason || "",
        refundPoints: item.refundPoints ?? "",
        successId: item.displayId || "",
        successSource: item.successSource || ""
      }));
    },

    realtimeStatus() {
      return {
        pollIntervalMs: POLL_INTERVAL_MS,
        refreshRestoreEnabled: true,
        domIdentityHandoffEnabled: true,
        liveBindingRepairEnabled: true,
        detachedBindingCount: detachedBindings.length,
        restoreCompletedOnce,
        mutationObserverRealtime: true,
        reconcileDebounceMs: 20
      };
    },

    activeBatches() {
      return Array.from(batches.values()).map(b => ({
        batchId: b.batchId,
        expectedCount: b.expectedCount,
        trackerIds: b.trackerIds,
        done: b.done
      }));
    },

    forcePoll() {
      return pollAllTrackers();
    }
  };
})();
