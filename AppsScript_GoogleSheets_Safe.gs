/**
 * Flow Recorder Safe v3.2 -> Google Sheets
 *
 * 重点：
 * 1. 一次 HTTP 可以批量写多条记录，减少 Apps Script 排队和启动开销。
 * 2. 一次请求只 openById 一次、拿锁一次、flush 一次。
 * 3. recordId 仍然是唯一键，同一条只更新原行。
 * 4. 插件端用 localVersion 防止“旧请求成功后误删更新中的新版本”。
 */

const SPREADSHEET_ID = "请替换成你的Google表格ID";
const SHEET_NAME = "Flow记录";
const API_KEY = "请替换成你的API_KEY";

const HEADERS = [
  "记录ID",
  "时间",
  "名字",
  "批次ID",
  "输出序号",
  "批次数量",
  "批次总积分",
  "项目名称",
  "Prompt",
  "触发方式",
  "模型",
  "图片/视频",
  "比例",
  "请求数量",
  "视频时长",
  "视频分辨率",
  "预估积分",
  "成功数量",
  "失败数量",
  "当前生成中数量",
  "计入积分",
  "生成状态",
  "失败原因",
  "跟踪ID",
  "成功媒体ID",
  "完成时间",
  "最后核对时间",
  "重试次数",
  "最后重试时间",
  "取消次数",
  "最后取消时间",
  "退还积分",
  "生成代次",
  "当前卡片ID",
  "触发前页面完成数",
  "触发前页面生成中数",
  "Agent状态",
  "设置摘要"
];

function doPost(e) {
  let lock = null;
  let locked = false;

  try {
    const payload = JSON.parse(e.postData.contents || "{}");
    checkApiKey_(payload.apiKey || "");

    let records = [];

    if (Array.isArray(payload.records)) {
      records = payload.records;
    } else if (payload.data) {
      // 兼容旧插件的单条格式
      records = [payload.data];
    }

    records = records.filter(r => clean_(r && r.recordId));

    if (!records.length) {
      throw new Error("No valid records");
    }

    lock = LockService.getScriptLock();
    lock.waitLock(15000);
    locked = true;

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
    }

    ensureHeader_(sheet);

    // 优先使用插件保存的 rowHint。
    // rowHint 会先验证 A列记录ID，只有验证失败时才读取整列建立索引。
    const resolvedRows = resolveRows_(sheet, records);

    const ack = [];
    const appendRows = [];
    const updateGroups = [];

    for (const d of records) {
      const recordId = clean_(d.recordId);
      if (!recordId) continue;

      const rowValues = toRow_(d);
      const existingRow = resolvedRows[recordId];

      if (existingRow) {
        updateGroups.push({
          recordId,
          row: existingRow,
          rowValues,
          localVersion: Number(d.localVersion || 0)
        });
      } else {
        appendRows.push({
          recordId,
          rowValues,
          localVersion: Number(d.localVersion || 0)
        });
      }
    }

    // 已存在记录按连续行分组，减少 setValues 调用次数。
    updateGroups.sort((a, b) => a.row - b.row);

    let i = 0;
    while (i < updateGroups.length) {
      const group = [updateGroups[i]];
      let j = i + 1;

      while (
        j < updateGroups.length &&
        updateGroups[j].row === group[group.length - 1].row + 1
      ) {
        group.push(updateGroups[j]);
        j++;
      }

      sheet
        .getRange(
          group[0].row,
          1,
          group.length,
          HEADERS.length
        )
        .setValues(group.map(x => x.rowValues));

      for (const item of group) {
        ack.push({
          recordId: item.recordId,
          localVersion: item.localVersion,
          row: item.row
        });
      }

      i = j;
    }

    if (appendRows.length > 0) {
      const startRow = sheet.getLastRow() + 1;

      sheet
        .getRange(
          startRow,
          1,
          appendRows.length,
          HEADERS.length
        )
        .setValues(appendRows.map(x => x.rowValues));

      for (let k = 0; k < appendRows.length; k++) {
        ack.push({
          recordId: appendRows[k].recordId,
          localVersion: appendRows[k].localVersion,
          row: startRow + k
        });
      }
    }

    SpreadsheetApp.flush();

    return json_({
      ok: true,
      count: ack.length,
      ack
    });

  } catch (err) {
    return json_({
      ok: false,
      error: String(err && err.stack ? err.stack : err)
    });

  } finally {
    if (locked && lock) {
      lock.releaseLock();
    }
  }
}

function doGet(e) {
  try {
    checkApiKey_(String(e.parameter.apiKey || ""));

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
    }

    ensureHeader_(sheet);

    return json_({
      ok: true,
      message: "连接成功：" + ss.getName() + " / " + SHEET_NAME
    });

  } catch (err) {
    return json_({
      ok: false,
      error: String(err && err.stack ? err.stack : err)
    });
  }
}


function resolveRows_(sheet, records) {
  const result = {};
  const unresolved = [];

  const hinted = records.filter(d =>
    clean_(d.recordId) &&
    Number(d.rowHint || 0) > 1
  );

  if (hinted.length > 0) {
    const a1 = hinted.map(d => "A" + Number(d.rowHint));
    const ranges = sheet.getRangeList(a1).getRanges();

    for (let i = 0; i < hinted.length; i++) {
      const id = clean_(hinted[i].recordId);
      const hintedRow = Number(hinted[i].rowHint);
      const actualId = clean_(ranges[i].getValue());

      if (id && actualId === id) {
        result[id] = hintedRow;
      }
    }
  }

  for (const d of records) {
    const id = clean_(d.recordId);

    if (id && !result[id]) {
      unresolved.push(id);
    }
  }

  if (!unresolved.length) {
    return result;
  }

  // 没有 rowHint / rowHint 失效时才读记录ID列。
  const fullMap = buildRowMap_(sheet);

  for (const id of unresolved) {
    if (fullMap[id]) {
      result[id] = fullMap[id];
    }
  }

  return result;
}

function buildRowMap_(sheet) {
  const map = {};

  if (sheet.getLastRow() < 2) {
    return map;
  }

  const values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 1)
    .getValues();

  for (let i = 0; i < values.length; i++) {
    const id = clean_(values[i][0]);

    if (id && !map[id]) {
      map[id] = i + 2;
    }
  }

  return map;
}

function toRow_(d) {
  return [
    clean_(d.recordId),
    clean_(d.time),
    clean_(d.userName),
    clean_(d.batchId),
    d.outputIndex ?? "",
    d.batchCount ?? "",
    d.batchTotalPoints ?? "",
    clean_(d.projectName),
    clean_(d.prompt),
    clean_(d.triggerMethod),
    clean_(d.model),
    clean_(d.mediaType),
    clean_(d.aspectRatio),
    d.requestedCount ?? "",
    d.duration ?? "",
    d.resolution ?? "",
    d.requestedPoints ?? "",
    d.successCount ?? "",
    d.failedCount ?? "",
    d.currentPendingCount ?? "",
    d.countedPoints ?? "",
    clean_(d.generationStatus),
    clean_(d.failureReason),
    clean_(d.trackingIds),
    clean_(d.successMediaIds),
    clean_(d.completedAt),
    clean_(d.lastCheckedAt),
    d.retryCount ?? "",
    clean_(d.lastRetryAt),
    d.cancelCount ?? "",
    clean_(d.lastCancelAt),
    d.refundedPoints ?? "",
    d.generationIndex ?? "",
    clean_(d.currentTileId),
    d.baselineCompleted ?? "",
    d.baselinePending ?? "",
    clean_(d.agent),
    clean_(d.settingsSummary)
  ];
}

function ensureHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet
      .getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }

  const current = sheet
    .getRange(
      1,
      1,
      1,
      Math.max(sheet.getLastColumn(), HEADERS.length)
    )
    .getValues()[0];

  let matches = true;

  for (let i = 0; i < HEADERS.length; i++) {
    if (String(current[i] || "") !== HEADERS[i]) {
      matches = false;
      break;
    }
  }

  if (!matches) {
    sheet
      .getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
}

function checkApiKey_(key) {
  if (!API_KEY || API_KEY === "请替换成你的API_KEY") {
    throw new Error("请先在 Apps Script 中设置 API_KEY");
  }

  if (key !== API_KEY) {
    throw new Error("Invalid API key");
  }
}

function clean_(value) {
  return String(value ?? "")
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
