/**
 * Captionary - Background Service Worker
 * Ultra-fast decoupled dictionary and translation engine with caching and prefetching.
 */

const DEFAULT_SETTINGS = {
  targetLanguage: "en",
  autoScroll: true,
  fontSize: "medium",
  autoPronounce: false,
  theme: "auto"
};

// In-memory LRU-like caches for 0ms instant responses
const defCache = new Map();
const transCache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["settings", "vocabulary"]);
  if (!data.settings) {
    const browserLang = navigator.language ? navigator.language.split("-")[0] : "en";
    await chrome.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, targetLanguage: browserLang === "en" ? "hi" : browserLang }
    });
  }
  if (!data.vocabulary) {
    await chrome.storage.local.set({ vocabulary: [] });
  }
  console.log("[Captionary BG] Ready.");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case "LOOKUP_DEFINITION":
      handleLookupDefinition(payload.word, payload.sourceLang || "en")
        .then(sendResponse)
        .catch((err) => sendResponse({ found: false, error: err.message }));
      return true;

    case "LOOKUP_TRANSLATION":
      handleLookupTranslation(payload.word, payload.sourceLang || "en", payload.targetLanguage || "en")
        .then(sendResponse)
        .catch((err) => sendResponse({ translation: null, error: err.message }));
      return true;

    case "LOOKUP_WORD":
      // Parallel fetch for prefetching
      Promise.all([
        handleLookupDefinition(payload.word, payload.sourceLang || "en"),
        handleLookupTranslation(payload.word, payload.sourceLang || "en", payload.targetLanguage || "en")
      ]).then(([defData, transData]) => {
        sendResponse({
          ...defData,
          translation: transData?.translation || null,
          targetLanguage: payload.targetLanguage
        });
      }).catch((err) => sendResponse({ found: false, error: err.message }));
      return true;

    case "GET_SETTINGS":
      chrome.storage.local.get("settings", (res) => {
        sendResponse(res.settings || DEFAULT_SETTINGS);
      });
      return true;

    case "SAVE_SETTINGS":
      chrome.storage.local.set({ settings: payload.settings }, () => {
        sendResponse({ success: true });
      });
      return true;

    case "GET_SAVED_WORDS":
      chrome.storage.local.get("vocabulary", (res) => {
        sendResponse(res.vocabulary || []);
      });
      return true;

    case "SAVE_WORD":
      handleSaveWord(payload.wordData)
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case "REMOVE_WORD":
      handleRemoveWord(payload.wordId)
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    default:
      sendResponse({ error: `Unknown message type: ${type}` });
      return false;
  }
});

/**
 * Fast Definition Lookup via Datamuse API + Wiktionary Fallback
 */
async function handleLookupDefinition(rawWord, sourceLang) {
  const cleanWord = rawWord.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  if (!cleanWord) return { found: false, word: "" };

  const sLang = (sourceLang || "en").toLowerCase();
  const cacheKey = `${cleanWord}_${sLang}`;
  if (defCache.has(cacheKey)) {
    return defCache.get(cacheKey);
  }

  let result;
  if (sLang === "en") {
    result = await fetchDatamuseDefinition(cleanWord);
  } else {
    // Non-English word (e.g. Russian, French, Spanish)
    result = await fetchWiktionaryDefinition(cleanWord, sLang);
  }

  defCache.set(cacheKey, result);
  return result;
}

async function fetchDatamuseDefinition(word) {
  try {
    const url = `https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=dp&max=6`;
    const res = await fetch(url);
    if (!res.ok) return await fetchWiktionaryDefinition(word, "en");

    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
      return await fetchWiktionaryDefinition(word, "en");
    }

    let item = data.find((d) => d.defs && d.defs.length) || data[0];
    let defs = item.defs || [];

    // Fallback: if no direct defs, try base stem
    if (!defs.length) {
      const stem = word.replace(/(ing|ed|es|s|ly)$/, "");
      if (stem && stem !== word && stem.length >= 3) {
        const stemRes = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(stem)}&md=dp&max=2`);
        if (stemRes.ok) {
          const stemData = await stemRes.json();
          const stemItem = stemData?.find((d) => d.defs && d.defs.length);
          if (stemItem) {
            item = stemItem;
            defs = stemItem.defs;
          }
        }
      }
    }

    if (!defs.length) {
      return await fetchWiktionaryDefinition(word, "en");
    }

    // Sort dictionary parts of speech (n, v, adj, adv) before proper nouns (N)
    defs = [...defs].sort((a, b) => (a.startsWith("N	") ? 1 : 0) - (b.startsWith("N	") ? 1 : 0));

    let phonetic = "";
    const ipaTag = (item.tags || []).find((t) => t.startsWith("ipa_pron:"));
    if (ipaTag) phonetic = `/${ipaTag.replace("ipa_pron:", "")}/`;

    const posMap = { n: "noun", v: "verb", adj: "adjective", adv: "adverb", u: "general" };
    const grouped = {};
    for (const d of defs.slice(0, 4)) {
      const parts = d.split("	");
      const tag = parts[0]?.toLowerCase() || "u";
      const pos = posMap[tag] || "general";
      if (!grouped[pos]) grouped[pos] = [];
      const defText = parts[1]?.trim() || "";
      if (defText) {
        grouped[pos].push({ definition: defText, example: null });
      }
    }

    const meanings = Object.keys(grouped).map((pos) => ({
      partOfSpeech: pos,
      definitions: grouped[pos]
    }));

    if (!meanings.length) {
      return await fetchWiktionaryDefinition(word, "en");
    }

    return {
      found: true,
      word: item.word || word,
      phonetic,
      audioUrl: null,
      meanings,
      source: "English Dictionary"
    };
  } catch (err) {
    return await fetchWiktionaryDefinition(word, "en");
  }
}

async function fetchWiktionaryDefinition(word, lang) {
  try {
    const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;
    const res = await fetch(url, { headers: { "User-Agent": "CaptionaryExtension/1.0" } });
    if (!res.ok) {
      return {
        found: true,
        word,
        phonetic: "",
        audioUrl: null,
        meanings: [
          {
            partOfSpeech: "term",
            definitions: [{ definition: `Term: "${word}"`, example: null }]
          }
        ],
        source: "Captionary"
      };
    }

    const data = await res.json();
    const langKey = data[lang] ? lang : Object.keys(data)[0];
    const entries = data[langKey] || [];

    const meanings = [];
    for (const entry of entries.slice(0, 3)) {
      const pos = (entry.partOfSpeech || "general").toLowerCase();
      const definitions = [];
      for (const d of (entry.definitions || []).slice(0, 2)) {
        // Strip HTML tags from Wiktionary definition
        const cleanDef = (d.definition || "").replace(/<[^>]+>/g, "").trim();
        if (cleanDef) {
          definitions.push({ definition: cleanDef, example: null });
        }
      }
      if (definitions.length) {
        meanings.push({ partOfSpeech: pos, definitions });
      }
    }

    return {
      found: true,
      word,
      phonetic: "",
      audioUrl: null,
      meanings: meanings.length ? meanings : [
        {
          partOfSpeech: "term",
          definitions: [{ definition: `Entry for "${word}".`, example: null }]
        }
      ],
      source: "Wiktionary"
    };
  } catch {
    return {
      found: true,
      word,
      phonetic: "",
      audioUrl: null,
      meanings: [
        {
          partOfSpeech: "term",
          definitions: [{ definition: `Entry for "${word}".`, example: null }]
        }
      ],
      source: "Captionary"
    };
  }
}

/**
 * Multi-tier High-Speed Translation: Google Chrome Extension API -> MyMemory fallback
 */
async function handleLookupTranslation(rawWord, sourceLang, targetLanguage) {
  const cleanWord = rawWord.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  if (!cleanWord) return { translation: null };

  const sLang = (sourceLang || "en").toLowerCase();
  const tLang = (targetLanguage || "en").toLowerCase();

  if (tLang === "none" || sLang === tLang) {
    return { translation: null };
  }

  const cacheKey = `${cleanWord}_${sLang}_${tLang}`;
  if (transCache.has(cacheKey)) {
    return { translation: transCache.get(cacheKey) };
  }

  const fetchPromise = (async () => {
    // Tier 1: Official Google Chrome Extension translation endpoint (~200ms)
    try {
      const q = encodeURIComponent(cleanWord);
      const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sLang)}&tl=${encodeURIComponent(tLang)}&q=${q}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        let translated = null;
        if (Array.isArray(data) && data.length && typeof data[0] === "string") {
          translated = data[0].trim();
        } else if (typeof data === "string" && data.trim()) {
          translated = data.trim();
        }
        if (translated && translated.toLowerCase() !== cleanWord) {
          return translated;
        }
      }
    } catch {
      // Fall through to Tier 2
    }

    // Tier 2: MyMemory API Fallback
    try {
      const q = encodeURIComponent(cleanWord);
      const url = `https://api.mymemory.translated.net/get?q=${q}&langpair=${encodeURIComponent(sLang)}|${encodeURIComponent(tLang)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const t = data?.responseData?.translatedText?.trim();
        if (t && t.toLowerCase() !== cleanWord && !t.startsWith("MYMEMORY WARNING")) {
          return t;
        }
      }
    } catch {
      // Fall through
    }

    return null;
  })();

  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 1800));
  const translation = await Promise.race([fetchPromise, timeoutPromise]);

  if (translation) {
    transCache.set(cacheKey, translation);
  }

  return { translation };
}

async function handleSaveWord(wordData) {
  const data = await chrome.storage.local.get("vocabulary");
  const vocabulary = data.vocabulary || [];

  const existingIdx = vocabulary.findIndex(
    (w) => w.word.toLowerCase() === wordData.word.toLowerCase()
  );

  const newEntry = {
    id: `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    date: new Date().toISOString(),
    ...wordData
  };

  if (existingIdx >= 0) {
    vocabulary[existingIdx] = { ...vocabulary[existingIdx], ...newEntry };
  } else {
    vocabulary.unshift(newEntry);
  }

  await chrome.storage.local.set({ vocabulary });
  return { success: true, count: vocabulary.length };
}

async function handleRemoveWord(wordId) {
  const data = await chrome.storage.local.get("vocabulary");
  let vocabulary = data.vocabulary || [];
  vocabulary = vocabulary.filter((w) => w.id !== wordId && w.word !== wordId);
  await chrome.storage.local.set({ vocabulary });
  return { success: true, count: vocabulary.length };
}
