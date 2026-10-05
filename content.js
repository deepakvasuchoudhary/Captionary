/**
 * Captionary - YouTube Transcript & Vocabulary Companion
 * Content script running inside YouTube watch pages.
 * Aligned with YouTube native Dark & Light mode aesthetics.
 */

(function () {
  "use strict";

  if (window.__captionaryLoaded) return;
  window.__captionaryLoaded = true;

  console.log("[Captionary] Extension initialized");

  // State
  let currentVideoId = null;
  let videoElement = null;
  let availableTracks = [];
  let currentTrack = null;
  let transcriptSegments = [];
  let activeSegmentIndex = -1;
  let isAutoScroll = true;
  let userScrolling = false;
  let userScrollTimeout = null;
  let isLoadingTranscript = false;
  let transcriptLoadedForVideoId = null;
  let fetchRetryCount = 0;
  const MAX_FETCH_RETRIES = 2; // 0, 1, 2 = 3 total attempts

  let currentSettings = {
    targetLanguage: "hi",
    autoScroll: true,
    fontSize: "medium",
    autoPronounce: false
  };
  let savedWordsList = [];
  let currentView = "transcript"; // "transcript" | "saved"
  let isPanelCollapsed = false;
  let isSearchVisible = false;

  // DOM Elements
  let panelContainer = null;
  let contentArea = null;
  let popoverElement = null;
  let searchInput = null;
  let activeWordSpan = null;
  const localWordCache = new Map();

  init();

  function init() {
    loadSettings();
    loadSavedWords();
    createPopoverElement();

    // Listen for YouTube SPA navigation events
    window.addEventListener("yt-navigate-finish", onPageNavigated);
    window.addEventListener("popstate", onPageNavigated);

    // Live sync with settings changes from extension popup
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.settings) {
          const newSettings = changes.settings.newValue || {};
          currentSettings = { ...currentSettings, ...newSettings };
          isAutoScroll = currentSettings.autoScroll;
          localWordCache.clear();
          updateLangSelectorValue();
          console.log("[Captionary] Settings synced in real-time:", currentSettings);
        }
      });
    }

    // Initial check
    const vid = getVideoIdFromUrl();
    if (vid) {
      currentVideoId = vid;
      ensureSetup(vid);
    }

    // Safety watchdog: re-mount if YouTube re-renders the right column, or trigger fetch if missing
    setInterval(() => {
      const vid = getVideoIdFromUrl();
      if (!vid) return;

      if (vid !== currentVideoId) {
        onPageNavigated();
      } else {
        if (!panelContainer || !document.contains(panelContainer)) {
          mountPanel(() => {
            if (transcriptSegments.length > 0) {
              renderTranscript(transcriptSegments);
            } else if (!isLoadingTranscript) {
              fetchTranscript(vid);
            }
          });
        } else if (
          transcriptSegments.length === 0 &&
          !isLoadingTranscript &&
          transcriptLoadedForVideoId !== vid &&
          fetchRetryCount <= MAX_FETCH_RETRIES
        ) {
          fetchTranscript(vid);
        }
      }
    }, 1000);
  }

  function loadSettings() {
    safeSendMessage({ type: "GET_SETTINGS" }, (settings) => {
      if (settings) {
        currentSettings = { ...currentSettings, ...settings };
        isAutoScroll = currentSettings.autoScroll;
      }
    });
  }

  function loadSavedWords() {
    safeSendMessage({ type: "GET_SAVED_WORDS" }, (words) => {
      savedWordsList = words || [];
      updateSavedTabBadge();
      if (currentView === "saved") renderSavedWords();
    });
  }

  function getVideoIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v");
  }

  function onPageNavigated() {
    const vid = getVideoIdFromUrl();
    if (!vid) {
      if (panelContainer) panelContainer.remove();
      currentVideoId = null;
      transcriptSegments = [];
      transcriptLoadedForVideoId = null;
      return;
    }

    if (vid !== currentVideoId || transcriptLoadedForVideoId !== vid) {
      console.log("[Captionary] Navigated to video:", vid);
      currentVideoId = vid;
      transcriptSegments = [];
      transcriptLoadedForVideoId = null;
      fetchRetryCount = 0;
      activeSegmentIndex = -1;
      ensureSetup(vid);
    }
  }

  function ensureSetup(videoId) {
    mountPanel(() => {
      if (transcriptLoadedForVideoId !== videoId && !isLoadingTranscript) {
        fetchTranscript(videoId);
      }
    });
    attachVideoListener();
  }

  /**
   * Mount the panel at the top of YouTube's right column (#secondary-inner)
   */
  function mountPanel(callback) {
    if (!window.location.pathname.startsWith("/watch")) return;

    const secondaryInner =
      document.querySelector("#secondary-inner") ||
      document.querySelector("#secondary");

    if (!secondaryInner) {
      setTimeout(() => mountPanel(callback), 250);
      return;
    }

    // Check if already in DOM
    if (panelContainer && document.contains(panelContainer)) {
      if (callback) callback();
      return;
    }

    if (!panelContainer) {
      panelContainer = document.createElement("div");
      panelContainer.id = "captionary-panel";
    }

    renderPanelSkeleton();
    secondaryInner.prepend(panelContainer);
    console.log("[Captionary] Panel mounted successfully into #secondary-inner");

    if (callback) callback();
  }

  /**
   * Render YouTube-native panel structure
   */
  function renderPanelSkeleton() {
    panelContainer.innerHTML = `
      <div class="lt-header">
        <div class="lt-header-top">
          <div class="lt-title-group">
            <span class="lt-main-title">Transcript</span>
            <span class="lt-track-badge" id="lt-track-badge">Loading...</span>
          </div>
          <div class="lt-header-actions">
            <button class="lt-yt-icon-btn" id="lt-search-toggle-btn" title="Search transcript">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20.87 19.46l-4.57-4.57c1.1-1.4 1.7-3.15 1.7-5.02 0-4.41-3.59-8-8-8s-8 3.59-8 8 3.59 8 8 8c1.87 0 3.62-.6 5.02-1.7l4.57 4.57 1.28-1.28zM4 9.87c0-3.31 2.69-6 6-6s6 2.69 6 6-2.69 6-6 6-6-2.69-6-6z"/></svg>
            </button>
            <button class="lt-yt-icon-btn ${isAutoScroll ? "lt-active" : ""}" id="lt-autoscroll-btn" title="Toggle Auto-Scroll sync">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
            </button>
            <button class="lt-yt-icon-btn" id="lt-collapse-btn" title="Minimize / Expand">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>
            </button>
          </div>
        </div>

        <div class="lt-search-bar" id="lt-search-bar">
          <span class="lt-search-icon">🔍</span>
          <input type="text" class="lt-search-input" id="lt-search-input" placeholder="Search transcript..." />
          <span class="lt-search-clear" id="lt-search-clear">✕</span>
        </div>

        <div class="lt-header-chips">
          <button class="lt-yt-chip lt-active" id="lt-chip-transcript">Transcript</button>
          <button class="lt-yt-chip" id="lt-chip-saved">★ Words (<span id="lt-saved-count">0</span>)</button>
          <select class="lt-track-select" id="lt-lang-select" title="Target Translation Language">
            <option value="en">Translate: English</option>
            <option value="hi">Translate: Hindi (हिन्दी)</option>
            <option value="es">Translate: Spanish (Español)</option>
            <option value="fr">Translate: French (Français)</option>
            <option value="de">Translate: German (Deutsch)</option>
            <option value="zh">Translate: Chinese (中文)</option>
            <option value="ja">Translate: Japanese (日本語)</option>
            <option value="ar">Translate: Arabic (العربية)</option>
            <option value="pt">Translate: Portuguese</option>
            <option value="ru">Translate: Russian (Русский)</option>
            <option value="none">Translate: Off</option>
          </select>
          <select class="lt-track-select" id="lt-track-select" style="display: none;"></select>
        </div>
      </div>
      <div class="lt-content-area" id="lt-content-area">
        <div class="lt-loading-state">
          <div class="lt-spinner"></div>
          <div style="font-size: 13px; font-weight: 500;">Loading transcript...</div>
        </div>
      </div>
    `;

    contentArea = panelContainer.querySelector("#lt-content-area");
    searchInput = panelContainer.querySelector("#lt-search-input");

    panelContainer.querySelector("#lt-autoscroll-btn").addEventListener("click", toggleAutoScroll);
    panelContainer.querySelector("#lt-collapse-btn").addEventListener("click", toggleCollapse);
    panelContainer.querySelector("#lt-search-toggle-btn").addEventListener("click", toggleSearch);
    panelContainer.querySelector("#lt-chip-transcript").addEventListener("click", () => switchView("transcript"));
    panelContainer.querySelector("#lt-chip-saved").addEventListener("click", () => switchView("saved"));

    const langSelect = panelContainer.querySelector("#lt-lang-select");
    if (langSelect) {
      langSelect.value = currentSettings.targetLanguage || "en";
      langSelect.addEventListener("change", (e) => {
        currentSettings.targetLanguage = e.target.value;
        localWordCache.clear();
        chrome.storage.local.set({ settings: currentSettings });
        console.log("[Captionary] Target language changed directly on YouTube:", currentSettings.targetLanguage);
      });
    }

    const clearBtn = panelContainer.querySelector("#lt-search-clear");
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      filterTranscript("");
      searchInput.focus();
    });

    searchInput.addEventListener("input", (e) => {
      filterTranscript(e.target.value.trim().toLowerCase());
    });

    contentArea.addEventListener("wheel", onUserManualScroll);
    contentArea.addEventListener("touchmove", onUserManualScroll);

    updateSavedTabBadge();
  }

  function toggleCollapse() {
    isPanelCollapsed = !isPanelCollapsed;
    panelContainer.classList.toggle("lt-collapsed", isPanelCollapsed);
    const collapseBtn = panelContainer.querySelector("#lt-collapse-btn");
    collapseBtn.innerHTML = isPanelCollapsed
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>`;
  }

  function toggleSearch() {
    isSearchVisible = !isSearchVisible;
    const searchBar = panelContainer.querySelector("#lt-search-bar");
    const toggleBtn = panelContainer.querySelector("#lt-search-toggle-btn");
    searchBar.classList.toggle("lt-show", isSearchVisible);
    toggleBtn.classList.toggle("lt-active", isSearchVisible);
    if (isSearchVisible) {
      searchInput.focus();
    } else {
      searchInput.value = "";
      filterTranscript("");
    }
  }

  function toggleAutoScroll() {
    isAutoScroll = !isAutoScroll;
    const btn = panelContainer.querySelector("#lt-autoscroll-btn");
    btn.classList.toggle("lt-active", isAutoScroll);
    if (isAutoScroll && activeSegmentIndex >= 0) {
      scrollToSegment(activeSegmentIndex);
    }
  }

  function onUserManualScroll() {
    userScrolling = true;
    clearTimeout(userScrollTimeout);
    userScrollTimeout = setTimeout(() => {
      userScrolling = false;
    }, 4000);
  }

  function switchView(view) {
    currentView = view;
    const chipTrans = panelContainer.querySelector("#lt-chip-transcript");
    const chipSaved = panelContainer.querySelector("#lt-chip-saved");

    if (view === "transcript") {
      chipTrans.classList.add("lt-active");
      chipSaved.classList.remove("lt-active");
      if (transcriptSegments.length) {
        renderTranscript(transcriptSegments);
      } else if (transcriptLoadedForVideoId === currentVideoId) {
        showEmptyState(
          "No transcript available for this video",
          "Subtitles or transcript are disabled or not provided for this video.",
          () => {
            fetchRetryCount = 0;
            transcriptLoadedForVideoId = null;
            fetchTranscript(currentVideoId);
          }
        );
      } else {
        fetchTranscript(currentVideoId);
      }
    } else {
      chipTrans.classList.remove("lt-active");
      chipSaved.classList.add("lt-active");
      renderSavedWords();
    }
  }

  
  function updateLangSelectorValue() {
    const langSelect = panelContainer?.querySelector("#lt-lang-select");
    if (langSelect && currentSettings.targetLanguage) {
      langSelect.value = currentSettings.targetLanguage;
    }
  }

  function updateSavedTabBadge() {
    const badge = panelContainer?.querySelector("#lt-saved-count");
    if (badge) {
      badge.textContent = savedWordsList.length;
    }
  }

  /**
   * Fast Same-Origin Transcript Fetching (Instant resolution, zero artificial delays)
   */
  async function fetchTranscript(videoId) {
    if (!panelContainer || !document.contains(panelContainer)) {
      mountPanel(() => fetchTranscript(videoId));
      return;
    }

    // Stop if already resolved for this video or navigated away
    if (transcriptLoadedForVideoId === videoId || videoId !== currentVideoId) {
      return;
    }

    contentArea = panelContainer.querySelector("#lt-content-area");
    if (!contentArea) {
      renderPanelSkeleton();
      contentArea = panelContainer.querySelector("#lt-content-area");
    }

    isLoadingTranscript = true;
    console.log("[Captionary] Fetching transcript for videoId:", videoId);

    if (!contentArea.querySelector(".lt-loading-state")) {
      contentArea.innerHTML = `
        <div class="lt-loading-state">
          <div class="lt-spinner"></div>
          <div style="font-size: 13px; font-weight: 500;">Loading transcript...</div>
        </div>
      `;
    }

    try {
      // Direct same-origin fetch to YouTube InnerTube player endpoint
      const playerPromise = fetch("/youtubei/v1/player", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38"
            }
          },
          videoId: videoId
        })
      }).then((r) => {
        if (!r.ok) throw new Error("InnerTube HTTP " + r.status);
        return r.json();
      });

      // 4-second timeout limit
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 4000)
      );

      const playerData = await Promise.race([playerPromise, timeoutPromise]);
      const captionTracks =
        playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

      console.log("[Captionary] Player response received. Tracks found:", captionTracks.length);

      // Instant check: If video has no captions, show empty message IMMEDIATELY without delay
      if (!captionTracks.length) {
        isLoadingTranscript = false;
        transcriptLoadedForVideoId = videoId; // Crucial: marks video as resolved, stops watchdog
        updateTrackBadge(null);
        showEmptyState(
          "No transcript available",
          "Subtitles or transcript are disabled for this video.",
          () => {
            transcriptLoadedForVideoId = null;
            fetchTranscript(videoId);
          }
        );
        return;
      }

      // Caption tracks available
      availableTracks = captionTracks.map((t) => ({
        name: t.name?.runs?.[0]?.text || t.name?.simpleText || t.languageCode,
        languageCode: t.languageCode,
        baseUrl: t.baseUrl,
        isAuto: t.kind === "asr" || (t.vssId && t.vssId.startsWith("a."))
      }));

      // Sort: English first, manual over auto
      availableTracks.sort((a, b) => {
        const aEn = a.languageCode.startsWith("en");
        const bEn = b.languageCode.startsWith("en");
        if (aEn && !bEn) return -1;
        if (!aEn && bEn) return 1;
        if (!a.isAuto && b.isAuto) return -1;
        if (a.isAuto && !b.isAuto) return 1;
        return 0;
      });

      updateTrackDropdown(availableTracks);

      const selected = availableTracks[0];
      currentTrack = selected;
      updateTrackBadge(selected);
      await loadTimedTextDirect(selected.baseUrl, videoId);
    } catch (err) {
      console.warn("[Captionary] Fetch error:", err);
      isLoadingTranscript = false;
      transcriptLoadedForVideoId = videoId;
      showEmptyState(
        "No transcript available",
        "Subtitles or transcript could not be loaded for this video.",
        () => {
          transcriptLoadedForVideoId = null;
          fetchTranscript(videoId);
        }
      );
    }
  }

  function updateTrackBadge(track) {
    const badge = panelContainer?.querySelector("#lt-track-badge");
    if (!badge) return;
    if (!track) {
      badge.textContent = "No captions";
      badge.style.display = "none";
      return;
    }
    badge.style.display = "inline-block";
    badge.textContent = track.isAuto ? `${track.name} (auto)` : track.name;
  }

  function updateTrackDropdown(tracks) {
    const select = panelContainer?.querySelector("#lt-track-select");
    if (!select) return;

    if (tracks.length > 1) {
      select.innerHTML = tracks
        .map(
          (t, idx) =>
            `<option value="${idx}">${t.name} ${t.isAuto ? "(auto)" : ""}</option>`
        )
        .join("");
      select.style.display = "block";
      select.onchange = (e) => {
        const chosen = availableTracks[e.target.value];
        if (chosen) {
          currentTrack = chosen;
          updateTrackBadge(chosen);
          loadTimedTextDirect(chosen.baseUrl, currentVideoId);
        }
      };
    } else {
      select.style.display = "none";
    }
  }

  /**
   * Fast direct timedtext XML fetch
   */
  async function loadTimedTextDirect(baseUrl, videoId) {
    try {
      console.log("[Captionary] Fetching timedtext XML from baseUrl...");
      const res = await fetch(baseUrl);
      if (!res.ok) throw new Error(`Timedtext HTTP ${res.status}`);
      const xml = await res.text();
      console.log("[Captionary] Timedtext XML received. Length:", xml.length);

      transcriptSegments = parseTimedTextXml(xml);
      console.log("[Captionary] Parsed segments count:", transcriptSegments.length);

      isLoadingTranscript = false;
      transcriptLoadedForVideoId = videoId;

      if (!transcriptSegments.length) {
        showEmptyState("No spoken dialogue found", "");
        return;
      }

      renderTranscript(transcriptSegments);
    } catch (err) {
      console.error("[Captionary] Timedtext load failed:", err);
      isLoadingTranscript = false;
      showErrorState("Failed to load transcript lines", err.message, () =>
        loadTimedTextDirect(baseUrl, videoId)
      );
    }
  }

  /**
   * Parse Format 3 or standard timedtext XML into structured segments
   */
  function parseTimedTextXml(xmlStr) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlStr, "text/xml");
    const pElements = xmlDoc.querySelectorAll("p");
    const segments = [];

    pElements.forEach((p, idx) => {
      const startMs = parseInt(p.getAttribute("t") || "0", 10);
      const durMs = parseInt(p.getAttribute("d") || "0", 10);

      const sTags = p.querySelectorAll("s");
      let text = "";
      if (sTags.length > 0) {
        sTags.forEach((s) => {
          text += s.textContent;
        });
      } else {
        text = p.textContent || "";
      }

      text = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
      if (text) {
        segments.push({
          id: idx,
          start: startMs / 1000,
          dur: durMs / 1000,
          end: (startMs + durMs) / 1000,
          text: decodeHtmlEntities(text)
        });
      }
    });

    return segments;
  }

  function decodeHtmlEntities(str) {
    const txt = document.createElement("textarea");
    txt.innerHTML = str;
    return txt.value;
  }

  function formatTime(seconds) {
    const sec = Math.floor(seconds);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const h = Math.floor(m / 60);
    const mm = m % 60;

    if (h > 0) {
      return `${h}:${mm.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  /**
   * Render transcript list into contentArea (matching YouTube native transcript)
   */
  function renderTranscript(segments) {
    if (!contentArea || currentView !== "transcript") return;

    const frag = document.createDocumentFragment();

    segments.forEach((seg) => {
      const row = document.createElement("div");
      row.className = "lt-row";
      row.dataset.id = seg.id;
      row.dataset.start = seg.start;
      row.dataset.end = seg.end;

      const timeBadge = document.createElement("span");
      timeBadge.className = "lt-timestamp";
      timeBadge.textContent = formatTime(seg.start);
      timeBadge.title = `Jump to ${formatTime(seg.start)}`;
      timeBadge.addEventListener("click", () => seekVideo(seg.start));

      const sentenceSpan = document.createElement("span");
      sentenceSpan.className = "lt-sentence";
      renderClickableWords(sentenceSpan, seg.text, seg);

      row.appendChild(timeBadge);
      row.appendChild(sentenceSpan);
      frag.appendChild(row);
    });

    contentArea.innerHTML = "";
    contentArea.appendChild(frag);

    if (videoElement) {
      syncWithVideoTime(videoElement.currentTime);
    }
  }

  function renderClickableWords(container, fullText, segment) {
    const tokens = fullText.split(/([\p{L}\p{N}'’]+)/u);

    tokens.forEach((token) => {
      if (/^[\p{L}\p{N}'’]+$/u.test(token)) {
        const wordSpan = document.createElement("span");
        wordSpan.className = "lt-word";
        wordSpan.textContent = token;
        wordSpan.dataset.word = token;

        // Hover prefetch (after 100ms hover, preloads definition & translation for 0ms click)
        let hoverTimer = null;
        wordSpan.addEventListener("mouseenter", () => {
          hoverTimer = setTimeout(() => prefetchWord(token), 100);
        });
        wordSpan.addEventListener("mouseleave", () => clearTimeout(hoverTimer));

        wordSpan.addEventListener("click", (e) => {
          e.stopPropagation();
          handleWordClick(token, wordSpan, segment);
        });

        container.appendChild(wordSpan);
      } else {
        container.appendChild(document.createTextNode(token));
      }
    });
  }

  function prefetchWord(rawWord) {
    const cleanWord = rawWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!cleanWord) return;
    const sourceLang = (currentTrack?.languageCode || "en").split("-")[0].toLowerCase();
    const cacheKey = `${cleanWord.toLowerCase()}_${sourceLang}_${currentSettings.targetLanguage || "none"}`;
    if (localWordCache.has(cacheKey)) return;

    safeSendMessage({
      type: "LOOKUP_WORD",
      payload: {
        word: cleanWord,
        sourceLang: sourceLang,
        targetLanguage: currentSettings.targetLanguage
      }
    }, (res) => {
      if (res && res.found) {
        localWordCache.set(cacheKey, res);
      }
    });
  }

  function filterTranscript(query) {
    if (!contentArea) return;
    const rows = contentArea.querySelectorAll(".lt-row");

    rows.forEach((row) => {
      const sentence = row.querySelector(".lt-sentence");
      if (!sentence) return;

      const words = sentence.querySelectorAll(".lt-word");
      let rowMatches = false;

      words.forEach((w) => {
        const wordText = w.dataset.word.toLowerCase();
        if (query && wordText.includes(query)) {
          w.classList.add("lt-word-match");
          rowMatches = true;
        } else {
          w.classList.remove("lt-word-match");
        }
      });

      if (!query || rowMatches || sentence.textContent.toLowerCase().includes(query)) {
        row.style.display = "flex";
      } else {
        row.style.display = "none";
      }
    });
  }

  function attachVideoListener() {
    videoElement = document.querySelector("video");
    if (!videoElement) {
      setTimeout(attachVideoListener, 500);
      return;
    }

    videoElement.removeEventListener("timeupdate", onVideoTimeUpdate);
    videoElement.addEventListener("timeupdate", onVideoTimeUpdate);
  }

  function onVideoTimeUpdate() {
    if (!videoElement || currentView !== "transcript") return;
    syncWithVideoTime(videoElement.currentTime);
  }

  function syncWithVideoTime(currentTime) {
    if (!transcriptSegments.length) return;

    const index = transcriptSegments.findIndex(
      (s) => currentTime >= s.start && currentTime < s.end
    );

    if (index !== -1 && index !== activeSegmentIndex) {
      activeSegmentIndex = index;
      highlightSegment(index);
    }
  }

  function highlightSegment(index) {
    if (!contentArea) return;

    const rows = contentArea.querySelectorAll(".lt-row");
    rows.forEach((r, idx) => {
      if (idx === index) {
        r.classList.add("lt-row-active");
      } else {
        r.classList.remove("lt-row-active");
      }
    });

    if (isAutoScroll && !userScrolling) {
      scrollToSegment(index);
    }
  }

  function scrollToSegment(index) {
    if (!contentArea) return;
    const targetRow = contentArea.querySelectorAll(".lt-row")[index];
    if (targetRow) {
      const areaRect = contentArea.getBoundingClientRect();
      const rowRect = targetRow.getBoundingClientRect();
      const scrollTop =
        contentArea.scrollTop + (rowRect.top - areaRect.top) - (areaRect.height / 2 - rowRect.height / 2);

      contentArea.scrollTo({
        top: Math.max(0, scrollTop),
        behavior: "smooth"
      });
    }
  }

  function seekVideo(seconds) {
    if (!videoElement) {
      videoElement = document.querySelector("video");
    }
    if (videoElement) {
      videoElement.currentTime = seconds;
      videoElement.play();
    }
  }

  function showEmptyState(title, subtitle, retryFn) {
    if (!contentArea) return;
    contentArea.innerHTML = `
      <div class="lt-empty-state">
        <div style="font-size: 28px; margin-bottom: 8px; opacity: 0.85;">💬</div>
        <div style="font-weight: 600; font-size: 14px; margin-bottom: 6px; color: var(--yt-trans-text-primary);">${title}</div>
        <div style="font-size: 12px; color: var(--yt-trans-text-muted); line-height: 1.4; max-width: 260px; margin: 0 auto 14px;">${subtitle}</div>
        ${retryFn ? `<button class="lt-retry-btn" id="lt-empty-retry-btn">Check Again</button>` : ""}
      </div>
    `;
    const btn = contentArea.querySelector("#lt-empty-retry-btn");
    if (btn && retryFn) {
      btn.addEventListener("click", retryFn);
    }
  }

  function showErrorState(title, subtitle, retryFn) {
    if (!contentArea) return;
    contentArea.innerHTML = `
      <div class="lt-empty-state">
        <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
        <div style="font-weight: 500; font-size: 14px; margin-bottom: 4px; color: var(--yt-trans-text-primary);">${title}</div>
        <div style="font-size: 12px; color: var(--yt-trans-text-muted);">${subtitle}</div>
        <button class="lt-retry-btn" id="lt-retry-btn">Retry</button>
      </div>
    `;
    const btn = contentArea.querySelector("#lt-retry-btn");
    if (btn && retryFn) {
      btn.addEventListener("click", retryFn);
    }
  }

  // ==========================================================================
  // Word Click & Floating Definition Popover
  // ==========================================================================

  function createPopoverElement() {
    if (popoverElement) return;

    popoverElement = document.createElement("div");
    popoverElement.id = "lt-definition-popover";
    document.body.appendChild(popoverElement);

    document.addEventListener("click", (e) => {
      if (
        popoverElement &&
        popoverElement.classList.contains("lt-popover-visible") &&
        !popoverElement.contains(e.target) &&
        !e.target.classList.contains("lt-word")
      ) {
        closePopover();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePopover();
    });
  }

  function closePopover() {
    if (!popoverElement) return;
    popoverElement.classList.remove("lt-popover-visible");
    if (activeWordSpan) {
      activeWordSpan.classList.remove("lt-word-selected");
      activeWordSpan = null;
    }
  }

  let activeLookupWord = "";

  function safeSendMessage(msg, callback) {
    if (!chrome?.runtime?.id) return;
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          // Silently consume runtime.lastError to prevent red error badge
          return;
        }
        if (callback) callback(response);
      });
    } catch {
      // Extension context invalidated during reload - ignore safely
    }
  }

  const LANG_NAMES = {
    hi: "Hindi",
    es: "Spanish",
    fr: "French",
    de: "German",
    zh: "Chinese",
    ja: "Japanese",
    ar: "Arabic",
    pt: "Portuguese",
    ru: "Russian",
    en: "English"
  };

  async function handleWordClick(word, spanElement, segment) {
    if (activeWordSpan) {
      activeWordSpan.classList.remove("lt-word-selected");
    }
    activeWordSpan = spanElement;
    activeWordSpan.classList.add("lt-word-selected");

    const cleanWord = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!cleanWord) return;

    positionPopover(spanElement);

    const sourceLang = (currentTrack?.languageCode || "en").split("-")[0].toLowerCase();
    const targetLang = currentSettings.targetLanguage || "none";
    const cacheKey = `${cleanWord.toLowerCase()}_${sourceLang}_${targetLang}`;
    const needsTranslation = targetLang !== "none" && sourceLang !== targetLang;

    // 1. Instant 0ms cache hit (if word was cached or prefetched on hover)
    if (localWordCache.has(cacheKey)) {
      const cached = localWordCache.get(cacheKey);
      renderPopoverContent(cached, segment, false);
      if (currentSettings.autoPronounce) {
        pronounceWord(cleanWord, cached.audioUrl, sourceLang);
      }
      return;
    }

    activeLookupWord = cleanWord;

    // 2. Render initial frame IMMEDIATELY (0ms):
    // Word title, pronunciation button, bookmark star, copy, close, and skeleton loader
    renderPopoverInitial(cleanWord, targetLang, sourceLang, segment, needsTranslation);

    let fullData = {
      found: true,
      word: cleanWord,
      sourceLang,
      targetLanguage: targetLang,
      phonetic: "",
      meanings: [],
      translation: null
    };

    // 3. STEP 1: Fetch and display English definition INSTANTLY (~40ms)
    safeSendMessage(
      {
        type: "LOOKUP_DEFINITION",
        payload: { word: cleanWord, sourceLang }
      },
      (defData) => {
        if (activeLookupWord !== cleanWord) return;

        if (defData && defData.found && defData.meanings?.length) {
          fullData = { ...fullData, ...defData };
        } else {
          fullData.meanings = [
            {
              partOfSpeech: "term",
              definitions: [{ definition: `Definition of "${cleanWord}".`, example: null }]
            }
          ];
        }

        // Show English definition immediately in the popover body
        updatePopoverDefinition(fullData);

        if (currentSettings.autoPronounce) {
          pronounceWord(cleanWord, fullData.audioUrl, sourceLang);
        }

        if (!needsTranslation) {
          localWordCache.set(cacheKey, fullData);
        }
      }
    );

    // 4. STEP 2: Fetch translation SECONDARY in background (~200ms) without blocking
    if (needsTranslation) {
      safeSendMessage(
        {
          type: "LOOKUP_TRANSLATION",
          payload: { word: cleanWord, sourceLang, targetLanguage: targetLang }
        },
        (transRes) => {
          if (activeLookupWord !== cleanWord) return;
          const translation = transRes?.translation || null;
          updatePopoverTranslation(translation);

          fullData.translation = translation;
          localWordCache.set(cacheKey, fullData);
        }
      );
    }
  }

  function renderPopoverInitial(word, targetLang, sourceLang, segment, needsTranslation) {
    const isSaved = savedWordsList.some(
      (w) => w.word.toLowerCase() === word.toLowerCase()
    );

    let translationHtml = "";
    if (needsTranslation) {
      const langLabel = LANG_NAMES[targetLang] || targetLang.toUpperCase();
      translationHtml = `
        <div class="lt-pop-translation" id="lt-pop-trans-container">
          <span class="lt-pop-translation-label">🌐 ${langLabel}</span>
          <span class="lt-pop-translation-text lt-trans-shimmer" id="lt-trans-text">
            <span class="lt-mini-spinner"></span> Translating...
          </span>
        </div>
      `;
    }

    popoverElement.innerHTML = `
      <div class="lt-pop-head">
        <div>
          <div class="lt-pop-word">${word}</div>
          <span class="lt-pop-phonetic" id="lt-pop-phonetic"></span>
        </div>
        <div class="lt-pop-actions">
          <button class="lt-pop-btn" id="lt-pop-speak" title="Pronounce">🔊</button>
          <button class="lt-pop-btn ${isSaved ? "lt-starred" : ""}" id="lt-pop-star" title="${isSaved ? "Saved" : "Save to Word Bank"}">
            ${isSaved ? "★" : "☆"}
          </button>
          <button class="lt-pop-btn" id="lt-pop-copy" title="Copy">📋</button>
          <button class="lt-pop-btn" id="lt-pop-close">✕</button>
        </div>
      </div>
      ${translationHtml}
      <div class="lt-pop-body" id="lt-pop-body">
        <div class="lt-pop-skeleton">
          <div class="lt-skeleton-bar" style="width: 85%;"></div>
          <div class="lt-skeleton-bar" style="width: 65%;"></div>
        </div>
      </div>
      <div class="lt-pop-footer">
        <span id="lt-pop-source">English Dictionary</span>
        <a href="https://en.wiktionary.org/wiki/${encodeURIComponent(word)}" target="_blank" style="color: #3ea6ff; text-decoration: none;">
          Wiktionary ↗
        </a>
      </div>
    `;

    popoverElement.querySelector("#lt-pop-close").addEventListener("click", closePopover);
    popoverElement.querySelector("#lt-pop-speak").addEventListener("click", () => {
      pronounceWord(word, null, sourceLang);
    });

    const starBtn = popoverElement.querySelector("#lt-pop-star");
    starBtn.addEventListener("click", () => {
      toggleSaveWord({ word }, segment, starBtn);
    });

    const copyBtn = popoverElement.querySelector("#lt-pop-copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(word);
      copyBtn.textContent = "✓";
      setTimeout(() => (copyBtn.textContent = "📋"), 1500);
    });
  }

  function updatePopoverDefinition(data) {
    if (!popoverElement) return;

    if (data.phonetic) {
      const phoneticEl = popoverElement.querySelector("#lt-pop-phonetic");
      if (phoneticEl) phoneticEl.textContent = data.phonetic;
    }

    const sourceEl = popoverElement.querySelector("#lt-pop-source");
    if (sourceEl && data.source) {
      sourceEl.textContent = data.source;
    }

    const bodyEl = popoverElement.querySelector("#lt-pop-body");
    if (!bodyEl) return;

    const meaningsHtml = (data.meanings || [])
      .map((m) => {
        const defs = (m.definitions || [])
          .map(
            (d, idx) => `
            <div class="lt-pop-def-item">
              <div><span class="lt-def-num">${idx + 1}.</span> ${d.definition}</div>
              ${d.example ? `<span class="lt-pop-example">“${d.example}”</span>` : ""}
            </div>
          `
          )
          .join("");

        return `
          <div style="margin-bottom: 10px;">
            <span class="lt-pop-pos-badge">${m.partOfSpeech}</span>
            ${defs}
          </div>
        `;
      })
      .join("");

    bodyEl.innerHTML = meaningsHtml || `<div style="font-size: 13px; color: var(--yt-trans-text-secondary);">Meaning: ${data.word}</div>`;

    // Update copy button to copy full definition
    const copyBtn = popoverElement.querySelector("#lt-pop-copy");
    if (copyBtn) {
      copyBtn.onclick = () => {
        const firstDef = data.meanings?.[0]?.definitions?.[0]?.definition || "";
        const textToCopy = `${data.word}: ${firstDef} ${data.translation ? `(${data.translation})` : ""}`;
        navigator.clipboard.writeText(textToCopy);
        copyBtn.textContent = "✓";
        setTimeout(() => (copyBtn.textContent = "📋"), 1500);
      };
    }
  }

  function updatePopoverTranslation(translationText) {
    const textEl = popoverElement?.querySelector("#lt-trans-text");
    const container = popoverElement?.querySelector("#lt-pop-trans-container");
    if (!textEl || !container) return;

    if (translationText) {
      textEl.classList.remove("lt-trans-shimmer");
      textEl.innerHTML = `<b>${translationText}</b>`;
    } else {
      // Gracefully clean up if no translation
      container.style.display = "none";
    }
  }

  function positionPopover(targetSpan) {
    const rect = targetSpan.getBoundingClientRect();
    const popoverWidth = 330;
    const popoverHeight = 280;
    const margin = 12;

    let left = rect.left;
    let top = rect.bottom + 8;

    if (left + popoverWidth > window.innerWidth - margin) {
      left = window.innerWidth - popoverWidth - margin;
    }
    if (left < margin) {
      left = margin;
    }

    if (top + popoverHeight > window.innerHeight - margin) {
      top = rect.top - popoverHeight - 8;
    }

    popoverElement.style.left = `${Math.max(margin, left)}px`;
    popoverElement.style.top = `${Math.max(margin, top)}px`;
    popoverElement.classList.add("lt-popover-visible");
  }

  function renderPopoverContent(data, segment, isTranslating = false) {
    const isSaved = savedWordsList.some(
      (w) => w.word.toLowerCase() === data.word.toLowerCase()
    );

    let translationHtml = "";
    if (data.targetLanguage && data.targetLanguage !== "none" && data.sourceLang !== data.targetLanguage) {
      const langLabel = LANG_NAMES[data.targetLanguage] || data.targetLanguage.toUpperCase();
      if (isTranslating && !data.translation) {
        translationHtml = `
          <div class="lt-pop-translation" id="lt-pop-trans-container">
            <span class="lt-pop-translation-label">🌐 ${langLabel}</span>
            <span class="lt-pop-translation-text lt-trans-shimmer" id="lt-trans-text">
              <span class="lt-mini-spinner"></span> Translating...
            </span>
          </div>
        `;
      } else if (data.translation) {
        translationHtml = `
          <div class="lt-pop-translation" id="lt-pop-trans-container">
            <span class="lt-pop-translation-label">🌐 ${langLabel}</span>
            <span class="lt-pop-translation-text" id="lt-trans-text"><b>${data.translation}</b></span>
          </div>
        `;
      }
    }

    const meaningsHtml = (data.meanings || [])
      .map((m) => {
        const defs = (m.definitions || [])
          .map(
            (d, idx) => `
            <div class="lt-pop-def-item">
              <div><span class="lt-def-num">${idx + 1}.</span> ${d.definition}</div>
              ${d.example ? `<span class="lt-pop-example">“${d.example}”</span>` : ""}
            </div>
          `
          )
          .join("");

        return `
          <div style="margin-bottom: 10px;">
            <span class="lt-pop-pos-badge">${m.partOfSpeech}</span>
            ${defs}
          </div>
        `;
      })
      .join("");

    popoverElement.innerHTML = `
      <div class="lt-pop-head">
        <div>
          <div class="lt-pop-word">${data.word}</div>
          ${data.phonetic ? `<span class="lt-pop-phonetic" id="lt-pop-phonetic">${data.phonetic}</span>` : ""}
        </div>
        <div class="lt-pop-actions">
          <button class="lt-pop-btn" id="lt-pop-speak" title="Pronounce">🔊</button>
          <button class="lt-pop-btn ${isSaved ? "lt-starred" : ""}" id="lt-pop-star" title="${isSaved ? "Saved" : "Save to Word Bank"}">
            ${isSaved ? "★" : "☆"}
          </button>
          <button class="lt-pop-btn" id="lt-pop-copy" title="Copy definition">📋</button>
          <button class="lt-pop-btn" id="lt-pop-close">✕</button>
        </div>
      </div>
      ${translationHtml}
      <div class="lt-pop-body" id="lt-pop-body">
        ${meaningsHtml || '<div style="font-size: 13px;">No definition available.</div>'}
      </div>
      <div class="lt-pop-footer">
        <span id="lt-pop-source">${data.source || "English Dictionary"}</span>
        <a href="https://en.wiktionary.org/wiki/${encodeURIComponent(data.word)}" target="_blank" style="color: #3ea6ff; text-decoration: none;">
          Wiktionary ↗
        </a>
      </div>
    `;

    popoverElement.querySelector("#lt-pop-close").addEventListener("click", closePopover);
    popoverElement.querySelector("#lt-pop-speak").addEventListener("click", () => {
      pronounceWord(data.word, data.audioUrl, data.sourceLang);
    });

    const starBtn = popoverElement.querySelector("#lt-pop-star");
    starBtn.addEventListener("click", () => {
      toggleSaveWord(data, segment, starBtn);
    });

    const copyBtn = popoverElement.querySelector("#lt-pop-copy");
    copyBtn.addEventListener("click", () => {
      const firstDef = data.meanings?.[0]?.definitions?.[0]?.definition || "";
      const textToCopy = `${data.word}: ${firstDef} ${data.translation ? `(${data.translation})` : ""}`;
      navigator.clipboard.writeText(textToCopy);
      copyBtn.textContent = "✓";
      setTimeout(() => (copyBtn.textContent = "📋"), 1500);
    });
  }

  function pronounceWord(word, audioUrl, lang) {
    if (audioUrl) {
      const audio = new Audio(audioUrl);
      audio.play().catch(() => speakWithWebSpeech(word, lang));
    } else {
      speakWithWebSpeech(word, lang);
    }
  }

  function speakWithWebSpeech(text, lang) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = getVoiceLangCode(lang || (currentTrack?.languageCode || "en").split("-")[0]);
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  }

  function getVoiceLangCode(lang) {
    const langMap = {
      ru: "ru-RU",
      en: "en-US",
      es: "es-ES",
      fr: "fr-FR",
      de: "de-DE",
      ja: "ja-JP",
      zh: "zh-CN",
      it: "it-IT",
      pt: "pt-BR",
      hi: "hi-IN",
      ar: "ar-SA",
      ko: "ko-KR",
      tr: "tr-TR",
      nl: "nl-NL",
      pl: "pl-PL"
    };
    return langMap[lang] || `${lang}-${lang.toUpperCase()}`;
  }

    function toggleSaveWord(data, segment, starBtn) {
    const isSaved = savedWordsList.some(
      (w) => w.word.toLowerCase() === data.word.toLowerCase()
    );

    if (isSaved) {
      safeSendMessage(
        { type: "REMOVE_WORD", payload: { wordId: data.word } },
        () => {
          savedWordsList = savedWordsList.filter(
            (w) => w.word.toLowerCase() !== data.word.toLowerCase()
          );
          starBtn.classList.remove("lt-starred");
          starBtn.textContent = "☆";
          updateSavedTabBadge();
          if (currentView === "saved") renderSavedWords();
        }
      );
    } else {
      const firstDef = data.meanings?.[0]?.definitions?.[0]?.definition || "";
      const wordObj = {
        word: data.word,
        phonetic: data.phonetic || "",
        audioUrl: data.audioUrl || "",
        definition: firstDef,
        translation: data.translation || "",
        contextSentence: segment?.text || "",
        videoTimestamp: segment?.start || 0,
        videoId: currentVideoId,
        videoTitle: document.title.replace(" - YouTube", "")
      };

      safeSendMessage(
        { type: "SAVE_WORD", payload: { wordData: wordObj } },
        () => {
          savedWordsList.unshift(wordObj);
          starBtn.classList.add("lt-starred");
          starBtn.textContent = "★";
          updateSavedTabBadge();
          if (currentView === "saved") renderSavedWords();
        }
      );
    }
  }

  // ==========================================================================
  // Saved Words / Vocabulary Bank View
  // ==========================================================================

  function renderSavedWords() {
    if (!contentArea) return;

    if (!savedWordsList.length) {
      contentArea.innerHTML = `
        <div class="lt-empty-state">
          <div style="font-size: 24px; margin-bottom: 8px;">⭐</div>
          <div style="font-weight: 500; font-size: 14px; margin-bottom: 4px; color: var(--yt-trans-text-primary);">No saved words yet</div>
          <div style="font-size: 12px; color: var(--yt-trans-text-muted);">
            Click any word in the transcript and tap the star (★) to save it.
          </div>
        </div>
      `;
      return;
    }

    const container = document.createElement("div");
    container.className = "lt-vocab-list";

    savedWordsList.forEach((w) => {
      const item = document.createElement("div");
      item.className = "lt-vocab-item";

      item.innerHTML = `
        <div class="lt-vocab-row">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="lt-vocab-word">${w.word}</span>
            ${w.phonetic ? `<span class="lt-pop-phonetic">${w.phonetic}</span>` : ""}
            ${w.translation ? `<span class="lt-track-badge">${w.translation}</span>` : ""}
          </div>
          <div class="lt-vocab-actions">
            <button class="lt-btn-sm lt-vocab-speak" title="Pronounce">🔊</button>
            <button class="lt-btn-sm lt-vocab-delete" title="Delete">✕</button>
          </div>
        </div>
        <div class="lt-vocab-def">${w.definition || "No definition available"}</div>
        ${
          w.contextSentence
            ? `<div style="font-style: italic; font-size: 12px; color: var(--yt-trans-text-muted);">“${w.contextSentence}”</div>`
            : ""
        }
        <div class="lt-vocab-meta">
          ${
            w.videoTimestamp
              ? `<span class="lt-vocab-jump" data-time="${w.videoTimestamp}">▶ Jump to ${formatTime(w.videoTimestamp)}</span> •`
              : ""
          }
          <span>${w.videoTitle || "Video"}</span>
        </div>
      `;

      item.querySelector(".lt-vocab-speak").addEventListener("click", () => {
        pronounceWord(w.word, w.audioUrl);
      });

      item.querySelector(".lt-vocab-delete").addEventListener("click", () => {
        safeSendMessage(
          { type: "REMOVE_WORD", payload: { wordId: w.id || w.word } },
          () => {
            savedWordsList = savedWordsList.filter((x) => x.word !== w.word);
            updateSavedTabBadge();
            renderSavedWords();
          }
        );
      });

      const jumpBtn = item.querySelector(".lt-vocab-jump");
      if (jumpBtn) {
        jumpBtn.addEventListener("click", () => {
          seekVideo(w.videoTimestamp);
          switchView("transcript");
        });
      }

      container.appendChild(item);
    });

    contentArea.innerHTML = "";
    contentArea.appendChild(container);
  }
})();
