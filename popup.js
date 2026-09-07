function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    '"':"&quot;",
    "'":"&#39;"
  }[c]));
}

async function refresh() {
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

  recentCount.textContent = `${recentRecords.length} / 10`;
  activeCount.textContent = activeRecords.length;
  pendingCount.textContent = pendingQueue.length;
  syncedCount.textContent =
    recentRecords.filter(r => r["同步状态"] === "已上传").length;

  rows.innerHTML = recentRecords.slice().reverse().map(r => `
    <tr>
      <td>${esc(r["时间"] || "")}</td>
      <td>${esc(r["名字"] || "")}</td>
      <td>${esc(
        r["批次数量"]
          ? `${String(r["批次ID"] || "").slice(0, 6)} ${r["输出序号"] || "-"}/${r["批次数量"]}`
          : ""
      )}</td>
      <td>${esc(r["项目名称"] || "")}</td>
      <td>${esc(r["模型"] || "")}</td>
      <td>${esc(r["请求数量"] ?? "")}</td>
      <td>${esc(r["成功数量"] ?? 0)} / ${esc(r["失败数量"] ?? 0)} / ${esc(r["当前生成中数量"] ?? 0)}</td>
      <td>${esc(r["计入积分"] ?? "")}</td>
      <td>${esc(r["生成状态"] || "")}</td>
      <td>${esc(r["同步状态"] || "")}</td>
    </tr>
  `).join("");
}

options.onclick = () => chrome.runtime.openOptionsPage();

retry.onclick = async () => {
  retry.disabled = true;
  retry.textContent = "重试中...";

  try {
    const r = await chrome.runtime.sendMessage({ type: "RETRY_UPLOADS" });
    alert(`完成：成功 ${r.success || 0}，失败 ${r.failed || 0}`);
  } catch (e) {
    alert("重试失败：" + e);
  }

  retry.disabled = false;
  retry.textContent = "立即重试上传";
  refresh();
};

refresh();
setInterval(refresh, 2000);
