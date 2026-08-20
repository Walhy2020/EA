"use strict";

const toast = document.getElementById("toast");
const editBtn = document.getElementById("editBtn");

function applyDemandH5Links() {
  const context = window.EADemandEntryContext;
  if (!context || typeof context.buildDemandH5Url !== "function") return;
  for (const link of document.querySelectorAll("[data-demand-h5-link]")) {
    link.href = context.buildDemandH5Url(window.location, link.dataset.demandPanel || "");
  }
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 1600);
}

editBtn.addEventListener("click", () => {
  showToast("原型演示：正式入口由企业微信工作台配置");
});

for (const tile of document.querySelectorAll(".app-tile:not(a)")) {
  tile.addEventListener("click", () => {
    showToast("这里是工作台其他应用占位");
  });
}

applyDemandH5Links();
