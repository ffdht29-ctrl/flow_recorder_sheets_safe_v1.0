async function load() {
  const { config = {} } = await chrome.storage.local.get("config");

  userName.value = config.userName || "";
  webAppUrl.value = config.webAppUrl || "";
  apiKey.value = config.apiKey || "";
  autoUpload.checked = config.autoUpload !== false;
}

async function saveConfig() {
  await chrome.storage.local.set({
    config: {
      userName: userName.value.trim(),
      webAppUrl: webAppUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      autoUpload: autoUpload.checked
    }
  });
}

save.onclick = async () => {
  await saveConfig();
  status.textContent = "已保存";
  setTimeout(() => status.textContent = "", 1500);
};

test.onclick = async () => {
  await saveConfig();
  status.textContent = "测试中...";

  const r = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
  status.textContent = r.ok ? r.message : ("失败：" + (r.error || ""));
};

load();
