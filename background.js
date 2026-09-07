const DEFAULT_CONFIG = {
  userName: "",
  webAppUrl: "",
  apiKey: "",
  autoUpload: true
};

const FAST_FLUSH_DELAY_MS = 40;
const MAX_BATCH_SIZE = 150;

let stateChain = Promise.resolve();
let uploadChain = Promise.resolve();
let flushTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  const state = await chrome.storage.local.get([
    "config",
    "recentRecords",
    "pendingQueue",
    "activeRecords"
  ]);

  await chrome.storage.local.set({
    config: { ...DEFAULT_CONFIG, ...(state.config || {}) },
    recentRecords: Array.isArray(state.recentRecords)
      ? state.recentRecords.slice(-10)
      : [],
    pendingQueue: Array.isArray(state.pendingQueue)
      ? state.pendingQueue
      : [],
    activeRecords: Array.isArray(state.activeRecords)
      ? state.activeRecords
      : []
  });

  chrome.alarms.create("retryUploads", { periodInMinutes: 1 });
  scheduleFastFlush(50);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("retryUploads", { periodInMinutes: 1 });
  scheduleFastFlush(50);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "retryUploads") {
    scheduleFastFlush(0);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CREATE_GENERATION_RECORD") {
    enqueueState(() => createGenerationRecord(message.record))
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === "UPDATE_GENERATION_RECORD") {
    enqueueState(() =>
      updateGenerationRecord(
        message.recordId,
        message.patch || {},
        !!message.final
      )
    )
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === "RETRY_UPLOADS") {
    flushPendingUploads()
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === "TEST_CONNECTION") {
    testConnection()
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === "GET_ACTIVE_RECORDS") {
    getActiveRecords()
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === "SAVE_TRACKER_META") {
    enqueueState(() =>
      saveTrackerMeta(message.recordId, message.meta || {})
    )
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});

function enqueueState(fn) {
  const job = stateChain.then(fn, fn);
  stateChain = job.then(() => undefined, () => undefined);
  return job;
}

function enqueueUpload(fn) {
  const job = uploadChain.then(fn, fn);
  uploadChain = job.then(() => undefined, () => undefined);
  return job;
}

function scheduleFastFlush(delay = FAST_FLUSH_DELAY_MS) {
  if (flushTimer) clearTimeout(flushTimer);

  flushTimer = setTimeout(() => {
    flushTimer = null;
    enqueueUpload(() => flushPendingUploads()).catch(() => {});
  }, Math.max(0, delay));
}

async function getConfig() {
  const { config = {} } = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...config };
}

function makeId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function localTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");

  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());

  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} ${sign}${oh}:${om}`;
}

function upsertById(list, record) {
  const id = record["记录ID"];
  const idx = list.findIndex(r => r["记录ID"] === id);

  if (idx >= 0) list[idx] = record;
  else list.push(record);
}

function nextLocalVersion(record) {
  return Number(record?._localVersion || 0) + 1;
}

async function createGenerationRecord(record) {
  const config = await getConfig();
  const recordId = makeId();

  const fullRecord = {
    "记录ID": recordId,
    "时间": localTimestamp(),
    "名字": config.userName || "",
    "批次ID": record["批次ID"] || "",
    "输出序号": record["输出序号"] ?? "",
    "批次数量": record["批次数量"] ?? "",
    "批次总积分": record["批次总积分"] ?? "",
    "项目名称": record["项目名称"] || "",
    "Prompt": record["Prompt"] || "",
    "触发方式": record["触发方式"] || "",
    "模型": record["模型"] || "",
    "图片/视频": record["图片/视频"] || "",
    "比例": record["比例"] || "",
    "请求数量": record["请求数量"] ?? "",
    "视频时长": record["视频时长"] ?? "",
    "视频分辨率": record["视频分辨率"] ?? "",
    "预估积分": record["预估积分"] ?? "",
    "成功数量": record["成功数量"] ?? "",
    "失败数量": record["失败数量"] ?? "",
    "当前生成中数量": record["当前生成中数量"] ?? "",
    "计入积分": record["计入积分"] ?? "",
    "生成状态": record["生成状态"] ?? "",
    "失败原因": record["失败原因"] || "",
    "跟踪ID": record["跟踪ID"] || "",
    "成功媒体ID": record["成功媒体ID"] || "",
    "完成时间": record["完成时间"] || "",
    "最后核对时间": record["最后核对时间"] || "",
    "重试次数": record["重试次数"] ?? "",
    "最后重试时间": record["最后重试时间"] || "",
    "取消次数": record["取消次数"] ?? "",
    "最后取消时间": record["最后取消时间"] || "",
    "退还积分": record["退还积分"] ?? "",
    "生成代次": record["生成代次"] ?? "",
    "当前卡片ID": record["当前卡片ID"] || "",
    "触发前页面完成数": record["触发前页面完成数"] ?? "",
    "触发前页面生成中数": record["触发前页面生成中数"] ?? "",
    "Agent状态": record["Agent状态"] ?? "",
    "设置摘要": record["设置摘要"] || "",
    "同步状态": "待上传",
    "同步时间": "",
    "同步错误": "",
    "上传尝试次数": 0,
    "_localVersion": 1,
    "_serverRow": 0,
    "_trackerMeta": record["_trackerMeta"] || {}
  };

  const state = await chrome.storage.local.get([
    "recentRecords",
    "pendingQueue",
    "activeRecords"
  ]);

  const recentRecords = Array.isArray(state.recentRecords)
    ? state.recentRecords
    : [];
  const pendingQueue = Array.isArray(state.pendingQueue)
    ? state.pendingQueue
    : [];
  const activeRecords = Array.isArray(state.activeRecords)
    ? state.activeRecords
    : [];

  // 先写本地，再安排网络上传：浏览器突然关闭时仍有保险队列。
  upsertById(pendingQueue, fullRecord);
  upsertById(activeRecords, fullRecord);
  recentRecords.push(fullRecord);

  while (recentRecords.length > 10) recentRecords.shift();

  await chrome.storage.local.set({
    recentRecords,
    pendingQueue,
    activeRecords
  });

  if (config.autoUpload && config.webAppUrl) {
    scheduleFastFlush();
  }

  return {
    ok: true,
    recordId,
    savedLocally: true
  };
}

async function updateGenerationRecord(recordId, patch, final) {
  if (!recordId) return { ok: false, error: "Missing recordId" };

  const config = await getConfig();
  const state = await chrome.storage.local.get([
    "recentRecords",
    "pendingQueue",
    "activeRecords"
  ]);

  const recentRecords = Array.isArray(state.recentRecords)
    ? state.recentRecords
    : [];
  const pendingQueue = Array.isArray(state.pendingQueue)
    ? state.pendingQueue
    : [];
  const activeRecords = Array.isArray(state.activeRecords)
    ? state.activeRecords
    : [];

  const base =
    activeRecords.find(r => r["记录ID"] === recordId) ||
    recentRecords.find(r => r["记录ID"] === recordId) ||
    pendingQueue.find(r => r["记录ID"] === recordId);

  if (!base) {
    return { ok: false, error: "找不到要更新的本地记录：" + recordId };
  }

  const updated = {
    ...base,
    ...patch,
    "同步状态": "待上传",
    "同步错误": "",
    "_localVersion": nextLocalVersion(base)
  };

  for (let i = 0; i < recentRecords.length; i++) {
    if (recentRecords[i]["记录ID"] === recordId) {
      recentRecords[i] = updated;
    }
  }

  upsertById(pendingQueue, updated);

  if (final) {
    const nextActive = activeRecords.filter(r => r["记录ID"] !== recordId);

    await chrome.storage.local.set({
      recentRecords,
      pendingQueue,
      activeRecords: nextActive
    });
  } else {
    upsertById(activeRecords, updated);

    await chrome.storage.local.set({
      recentRecords,
      pendingQueue,
      activeRecords
    });
  }

  if (config.autoUpload && config.webAppUrl) {
    scheduleFastFlush();
  }

  return {
    ok: true,
    recordId,
    savedLocally: true,
    localVersion: updated._localVersion
  };
}


async function getActiveRecords() {
  const { activeRecords = [] } =
    await chrome.storage.local.get("activeRecords");

  return {
    ok: true,
    records: Array.isArray(activeRecords)
      ? activeRecords
      : []
  };
}

async function saveTrackerMeta(recordId, meta) {
  if (!recordId) {
    return { ok: false, error: "Missing recordId" };
  }

  const state = await chrome.storage.local.get([
    "recentRecords",
    "activeRecords",
    "pendingQueue"
  ]);

  let found = false;

  for (const key of ["recentRecords", "activeRecords", "pendingQueue"]) {
    const list = Array.isArray(state[key]) ? state[key] : [];

    for (const record of list) {
      if (record["记录ID"] !== recordId) continue;

      record._trackerMeta = {
        ...(record._trackerMeta || {}),
        ...meta,
        savedAt: Date.now()
      };

      found = true;
    }

    state[key] = list;
  }

  if (found) {
    // 这是纯本地跟踪元数据，不进入Google上传队列，也不增加localVersion。
    await chrome.storage.local.set(state);
  }

  return {
    ok: found,
    recordId
  };
}

function dataFor(record) {
  return {
    recordId: record["记录ID"] || "",
    localVersion: Number(record._localVersion || 0),
    rowHint: Number(record._serverRow || 0),
    time: record["时间"] || "",
    userName: record["名字"] || "",
    batchId: record["批次ID"] || "",
    outputIndex: record["输出序号"] ?? "",
    batchCount: record["批次数量"] ?? "",
    batchTotalPoints: record["批次总积分"] ?? "",
    projectName: record["项目名称"] || "",
    prompt: record["Prompt"] || "",
    triggerMethod: record["触发方式"] || "",
    model: record["模型"] || "",
    mediaType: record["图片/视频"] || "",
    aspectRatio: record["比例"] || "",
    requestedCount: record["请求数量"] ?? "",
    duration: record["视频时长"] ?? "",
    resolution: record["视频分辨率"] ?? "",
    requestedPoints: record["预估积分"] ?? "",
    successCount: record["成功数量"] ?? "",
    failedCount: record["失败数量"] ?? "",
    currentPendingCount: record["当前生成中数量"] ?? "",
    countedPoints: record["计入积分"] ?? "",
    generationStatus: record["生成状态"] || "",
    failureReason: record["失败原因"] || "",
    trackingIds: record["跟踪ID"] || "",
    successMediaIds: record["成功媒体ID"] || "",
    completedAt: record["完成时间"] || "",
    lastCheckedAt: record["最后核对时间"] || "",
    retryCount: record["重试次数"] ?? "",
    lastRetryAt: record["最后重试时间"] || "",
    cancelCount: record["取消次数"] ?? "",
    lastCancelAt: record["最后取消时间"] || "",
    refundedPoints: record["退还积分"] ?? "",
    generationIndex: record["生成代次"] ?? "",
    currentTileId: record["当前卡片ID"] || "",
    baselineCompleted: record["触发前页面完成数"] ?? "",
    baselinePending: record["触发前页面生成中数"] ?? "",
    agent: record["Agent状态"] ?? "",
    settingsSummary: record["设置摘要"] || ""
  };
}

async function flushPendingUploads() {
  const config = await getConfig();

  if (!config.webAppUrl) {
    return {
      ok: false,
      error: "尚未设置 Web App URL",
      total: 0,
      success: 0,
      failed: 0
    };
  }

  const { pendingQueue = [] } =
    await chrome.storage.local.get("pendingQueue");

  const snapshot = Array.isArray(pendingQueue)
    ? pendingQueue.slice(0, MAX_BATCH_SIZE)
    : [];

  if (!snapshot.length) {
    return {
      ok: true,
      total: 0,
      success: 0,
      failed: 0
    };
  }

  const ids = snapshot.map(r => r["记录ID"]);
  await enqueueState(() => incrementAttempts(ids));

  try {
    const response = await fetch(config.webAppUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify({
        apiKey: config.apiKey || "",
        records: snapshot.map(dataFor)
      }),
      redirect: "follow"
    });

    const raw = await response.text();

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }

    if (!parsed || parsed.ok !== true) {
      throw new Error(parsed?.error || "服务器未确认批量写入成功");
    }

    const ack = Array.isArray(parsed.ack) ? parsed.ack : [];

    await enqueueState(() => markBatchUploaded(ack));

    // 如果上传过程中本地又有更新，版本不同的记录仍留在 pendingQueue。
    // 立即继续发送最新版本，不会遗漏。
    const { pendingQueue: remaining = [] } =
      await chrome.storage.local.get("pendingQueue");

    if (Array.isArray(remaining) && remaining.length > 0) {
      scheduleFastFlush(80);
    }

    return {
      ok: true,
      total: snapshot.length,
      success: ack.length,
      failed: Math.max(0, snapshot.length - ack.length)
    };

  } catch (e) {
    const msg = String(e?.message || e);

    await enqueueState(() =>
      markBatchUploadFailed(
        snapshot.map(r => r["记录ID"]),
        msg
      )
    );

    // 保留所有 pending 记录，稍后重试。
    return {
      ok: false,
      total: snapshot.length,
      success: 0,
      failed: snapshot.length,
      error: msg
    };
  }
}

async function incrementAttempts(ids) {
  const idSet = new Set(ids);
  const state = await chrome.storage.local.get([
    "recentRecords",
    "pendingQueue",
    "activeRecords"
  ]);

  for (const key of ["recentRecords", "pendingQueue", "activeRecords"]) {
    const list = Array.isArray(state[key]) ? state[key] : [];

    for (const r of list) {
      if (idSet.has(r["记录ID"])) {
        r["上传尝试次数"] =
          Number(r["上传尝试次数"] || 0) + 1;
      }
    }

    state[key] = list;
  }

  await chrome.storage.local.set(state);
}

async function markBatchUploaded(ack) {
  const ackMap = new Map();

  for (const item of ack) {
    if (!item?.recordId) continue;

    ackMap.set(
      item.recordId,
      Number(item.localVersion || 0)
    );
  }

  const state = await chrome.storage.local.get([
    "recentRecords",
    "pendingQueue",
    "activeRecords"
  ]);

  const syncTime = localTimestamp();

  const ackRowMap = new Map();

  for (const item of ack) {
    if (item?.recordId && Number(item.row || 0) > 1) {
      ackRowMap.set(item.recordId, Number(item.row));
    }
  }

  for (const key of ["recentRecords", "activeRecords", "pendingQueue"]) {
    const list = Array.isArray(state[key]) ? state[key] : [];

    for (const r of list) {
      const ackVersion = ackMap.get(r["记录ID"]);
      const row = ackRowMap.get(r["记录ID"]);

      if (row) {
        r._serverRow = row;
      }

      if (
        ackVersion !== undefined &&
        Number(r._localVersion || 0) === ackVersion
      ) {
        r["同步状态"] = "已上传";
        r["同步时间"] = syncTime;
        r["同步错误"] = "";
      }
    }

    state[key] = list;
  }

  const pendingQueue = Array.isArray(state.pendingQueue)
    ? state.pendingQueue
    : [];

  state.pendingQueue = pendingQueue.filter(r => {
    const ackVersion = ackMap.get(r["记录ID"]);

    // 只有服务器确认的版本和本地当前最新版本完全一致，
    // 才能从保险队列移除。更新过程中产生的新版本绝不会被误删。
    return !(
      ackVersion !== undefined &&
      Number(r._localVersion || 0) === ackVersion
    );
  });

  await chrome.storage.local.set(state);
}

async function markBatchUploadFailed(ids, error) {
  const idSet = new Set(ids);

  const state = await chrome.storage.local.get([
    "recentRecords",
    "pendingQueue",
    "activeRecords"
  ]);

  for (const key of ["recentRecords", "pendingQueue", "activeRecords"]) {
    const list = Array.isArray(state[key]) ? state[key] : [];

    for (const r of list) {
      if (idSet.has(r["记录ID"])) {
        r["同步状态"] = "上传失败";
        r["同步错误"] = error;
      }
    }

    state[key] = list;
  }

  await chrome.storage.local.set(state);
}

async function testConnection() {
  const config = await getConfig();

  if (!config.webAppUrl) {
    return { ok: false, error: "请先填写 Web App URL" };
  }

  try {
    const url = new URL(config.webAppUrl);
    url.searchParams.set("test", "1");
    url.searchParams.set("apiKey", config.apiKey || "");

    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow"
    });

    const raw = await response.text();

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }

    if (!parsed || parsed.ok !== true) {
      throw new Error(parsed?.error || "测试失败");
    }

    return {
      ok: true,
      message: parsed.message || "连接成功"
    };

  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e)
    };
  }
}
