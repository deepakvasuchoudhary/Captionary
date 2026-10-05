/**
 * Captionary Popup Script
 */

document.addEventListener("DOMContentLoaded", () => {
  const targetLanguageSelect = document.getElementById("targetLanguage");
  const autoScrollToggle = document.getElementById("autoScroll");
  const autoPronounceToggle = document.getElementById("autoPronounce");
  const fontSizeSelect = document.getElementById("fontSize");
  const savedCountBadge = document.getElementById("savedCountBadge");
  const exportCsvBtn = document.getElementById("exportCsvBtn");
  const clearVocabBtn = document.getElementById("clearVocabBtn");
  const statusText = document.getElementById("statusText");

  // Check active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0];
    if (currentTab && currentTab.url && currentTab.url.includes("youtube.com/watch")) {
      statusText.textContent = "YouTube Active";
    } else {
      statusText.textContent = "Open a YouTube Video";
    }
  });

  // Load Settings
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
    if (settings) {
      if (settings.targetLanguage) targetLanguageSelect.value = settings.targetLanguage;
      if (typeof settings.autoScroll === "boolean") autoScrollToggle.checked = settings.autoScroll;
      if (typeof settings.autoPronounce === "boolean") autoPronounceToggle.checked = settings.autoPronounce;
      if (settings.fontSize) fontSizeSelect.value = settings.fontSize;
    }
  });

  // Load Saved Words count
  loadVocabCount();

  // Save Settings Handlers
  function saveCurrentSettings() {
    const settings = {
      targetLanguage: targetLanguageSelect.value,
      autoScroll: autoScrollToggle.checked,
      autoPronounce: autoPronounceToggle.checked,
      fontSize: fontSizeSelect.value
    };

    chrome.storage.local.set({ settings });
  }

  targetLanguageSelect.addEventListener("change", saveCurrentSettings);
  autoScrollToggle.addEventListener("change", saveCurrentSettings);
  autoPronounceToggle.addEventListener("change", saveCurrentSettings);
  fontSizeSelect.addEventListener("change", saveCurrentSettings);

  // Vocabulary handlers
  function loadVocabCount() {
    chrome.runtime.sendMessage({ type: "GET_SAVED_WORDS" }, (words) => {
      const list = words || [];
      savedCountBadge.textContent = `${list.length} ${list.length === 1 ? "word" : "words"}`;
    });
  }

  // Export CSV for Anki / Flashcards
  exportCsvBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "GET_SAVED_WORDS" }, (words) => {
      const list = words || [];
      if (!list.length) {
        alert("No saved words to export yet. Star some words in the video transcript first!");
        return;
      }

      const headers = ["Word", "Phonetic", "Translation", "Definition", "Example / Context", "Video Title", "Video Time"];
      const rows = list.map((item) => [
        escapeCsv(item.word),
        escapeCsv(item.phonetic || ""),
        escapeCsv(item.translation || ""),
        escapeCsv(item.definition || ""),
        escapeCsv(item.contextSentence || ""),
        escapeCsv(item.videoTitle || ""),
        escapeCsv(item.videoTimestamp ? `${Math.floor(item.videoTimestamp)}s` : "")
      ]);

      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
      const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `captionary_vocabulary_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  });

  function escapeCsv(str) {
    if (!str) return '""';
    const clean = str.replace(/"/g, '""');
    return `"${clean}"`;
  }

  // Clear Vocabulary
  clearVocabBtn.addEventListener("click", () => {
    if (confirm("Are you sure you want to clear all saved words from your vocabulary bank?")) {
      chrome.storage.local.set({ vocabulary: [] }, () => {
        loadVocabCount();
      });
    }
  });
});
