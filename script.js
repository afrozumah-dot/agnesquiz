/* ---------- Theme ---------- */
const themeSelects = [...document.querySelectorAll(".theme-select")];
const themeColor = document.querySelector('meta[name="theme-color"]');
const themeStorageKey = "agnes-quiz-theme";
let themePreference = "system";

try {
  const savedTheme = localStorage.getItem(themeStorageKey);
  if (["system", "light", "dark"].includes(savedTheme)) themePreference = savedTheme;
} catch (error) {
  console.warn("Unable to read the saved theme preference.", error);
}

function applyTheme(preference, persist = false) {
  themePreference = preference;
  const isDark = preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  if (themeColor) themeColor.content = isDark ? "#090a0b" : "#f8f7fb";
  themeSelects.forEach((select) => { select.value = preference; });

  if (persist) {
    try {
      localStorage.setItem(themeStorageKey, preference);
    } catch (error) {
      console.warn("Unable to save the theme preference.", error);
    }
  }
}

themeSelects.forEach((select) => {
  select.addEventListener("change", () => applyTheme(select.value, true));
});
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
if (systemTheme.addEventListener) {
  systemTheme.addEventListener("change", () => {
    if (themePreference === "system") applyTheme("system");
  });
} else {
  systemTheme.addListener(() => {
    if (themePreference === "system") applyTheme("system");
  });
}
applyTheme(themePreference);

/* ---------- PDF.js setup (worker loaded via blob so it also works from file://) ---------- */
const WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([`importScripts("${WORKER_URL}");`], { type: "text/javascript" })
);

/* ---------- Elements ---------- */
const $ = (id) => document.getElementById(id);
const screens = { upload: $("screen-upload"), quiz: $("screen-quiz"), result: $("screen-result") };
const input = $("pdf-input"), dropzone = $("dropzone"), startBtn = $("btn-start"), statusEl = $("status");
const questionPicker = $("question-picker"), questionToggle = $("question-toggle");
const questionOptions = [...document.querySelectorAll(".question-option")];
const uploadTabs = [...document.querySelectorAll(".upload-tab")];
const uploadFormats = {
  pdf: { accept: "application/pdf,.pdf", label: "PDF", hint: "or drag a PDF here" },
  docx: { accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "DOCX", hint: "or drag a Word document here" },
  txt: { accept: ".txt,text/plain", label: "TXT", hint: "or drag a text file here" },
  image: { accept: "image/*", label: "image", hint: "or drag a clear image with English text" }
};
const browserLibraries = new Map();
let activeFileRequest = 0;

/* ---------- State ---------- */
let bank = [];      // all possible questions built from the PDF
let quiz = [];      // the current random set
let current = 0, score = 0, answers = [];

const STOP = new Set(("about above after again against because before being below between both could does doing down during each "
  + "from further have having here however into itself just more most other over same should some such than that their them then "
  + "there these they this those through under until very were what when where which while with would your also often usually "
  + "called known used using include includes including example examples may might can will shall within without among "
  + "another every either neither whether since thus therefore hence many much several various different differently "
  + "surround surrounds surrounded surrounding objects object distance distances enters enter passes passing "
  + "contains contain helps help carries carry controls control electrical colored adjusts adjust adjusting").split(" "));

/* ---------- Helpers ---------- */
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const escapeHTML = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const show = (name) => Object.entries(screens).forEach(([k, el]) => el.classList.toggle("active", k === name));
const setStatus = (msg, isError = false) => { statusEl.textContent = msg; statusEl.classList.toggle("error", isError); };
function setUploadFormat(format, resetSelection = true) {
  const config = uploadFormats[format];
  if (!config) throw new Error(`Unsupported upload format: ${format}`);

  uploadTabs.forEach((tab) => {
    const active = tab.dataset.format === format;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $("upload-panel").setAttribute("aria-labelledby", `upload-tab-${format}`);
  input.accept = config.accept;

  if (!resetSelection) return;
  activeFileRequest++;
  input.value = "";
  bank = [];
  startBtn.disabled = true;
  dropzone.classList.remove("has-file");
  $("drop-title").textContent = `Choose ${config.label === "image" ? "an image" : `a ${config.label}`}`;
  $("drop-hint").textContent = config.hint;
  setStatus("");
}

async function loadBrowserLibrary(url, globalName, label) {
  if (window[globalName]) return window[globalName];
  if (!browserLibraries.has(url)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => {
        if (window[globalName]) resolve(window[globalName]);
        else {
          browserLibraries.delete(url);
          reject(new Error(`The ${label} did not initialize correctly.`));
        }
      };
      script.onerror = () => {
        browserLibraries.delete(url);
        reject(new Error(`Couldn't load the ${label}. Check your internet connection and try again.`));
      };
      document.head.appendChild(script);
    });
    browserLibraries.set(url, promise);
  }
  return browserLibraries.get(url);
}

const setQuestionPickerOpen = (isOpen) => {
  questionPicker.classList.toggle("open", isOpen);
  questionToggle.setAttribute("aria-expanded", String(isOpen));
};

let pointerOverQuestionPicker = false;
questionPicker.addEventListener("pointerenter", (event) => {
  if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
  pointerOverQuestionPicker = true;
  setQuestionPickerOpen(true);
});
questionPicker.addEventListener("pointerleave", (event) => {
  if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
  pointerOverQuestionPicker = false;
  setQuestionPickerOpen(false);
});
questionToggle.addEventListener("click", () => {
  setQuestionPickerOpen(pointerOverQuestionPicker || !questionPicker.classList.contains("open"));
});
questionToggle.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setQuestionPickerOpen(true);
    questionOptions[0].focus();
  }
});
questionPicker.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && questionPicker.classList.contains("open")) {
    event.preventDefault();
    setQuestionPickerOpen(false);
    questionToggle.focus();
    return;
  }

  const optionIndex = questionOptions.indexOf(event.target);
  if (optionIndex < 0) return;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    event.preventDefault();
    questionOptions[(optionIndex + 1) % questionOptions.length].focus();
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    event.preventDefault();
    questionOptions[(optionIndex - 1 + questionOptions.length) % questionOptions.length].focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    questionOptions[event.key === "Home" ? 0 : questionOptions.length - 1].focus();
  }
});
questionOptions.forEach((option) => {
  option.addEventListener("click", () => {
    const count = option.dataset.count;
    $("q-count").value = count;
    $("question-count-label").textContent = count;
    questionOptions.forEach((item) => item.setAttribute("aria-selected", String(item === option)));
    if (!pointerOverQuestionPicker) {
      setQuestionPickerOpen(false);
      questionToggle.focus();
    }
  });
});
questionPicker.addEventListener("focusout", (event) => {
  if (!questionPicker.contains(event.relatedTarget) && !pointerOverQuestionPicker) setQuestionPickerOpen(false);
});
document.addEventListener("pointerdown", (event) => {
  if (!questionPicker.contains(event.target)) setQuestionPickerOpen(false);
});

/* ---------- Upload ---------- */
uploadTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => setUploadFormat(tab.dataset.format));
  tab.addEventListener("keydown", (event) => {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % uploadTabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + uploadTabs.length) % uploadTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = uploadTabs.length - 1;
    else return;

    event.preventDefault();
    uploadTabs[nextIndex].focus();
    setUploadFormat(uploadTabs[nextIndex].dataset.format);
  });
});
input.addEventListener("change", () => input.files[0] && loadFile(input.files[0]));
["dragenter", "dragover"].forEach((e) => dropzone.addEventListener(e, (ev) => { ev.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach((e) => dropzone.addEventListener(e, (ev) => { ev.preventDefault(); dropzone.classList.remove("drag"); }));
dropzone.addEventListener("drop", (ev) => { const f = ev.dataTransfer.files[0]; if (f) loadFile(f); });

function getFileFormat(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".txt")) return "txt";
  if (file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(name)) return "image";
  return "";
}

async function loadFile(file) {
  const requestId = ++activeFileRequest;
  startBtn.disabled = true;
  bank = [];
  const format = getFileFormat(file);
  input.value = "";
  if (!format) {
    dropzone.classList.remove("has-file");
    const activeTab = uploadTabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    const config = uploadFormats[activeTab.dataset.format];
    $("drop-title").textContent = `Choose ${config.label === "image" ? "an image" : `a ${config.label}`}`;
    $("drop-hint").textContent = config.hint;
    return setStatus("Choose a PDF, DOCX, TXT, or image file.", true);
  }
  setUploadFormat(format, false);
  $("drop-title").textContent = file.name;
  setStatus(`Reading your ${uploadFormats[format].label}…`);

  try {
    const text = await extractFileText(file, format, requestId);
    if (requestId !== activeFileRequest) return;
    bank = buildQuestions(text);
    if (bank.length < 5) {
      const message = format === "image"
        ? "Couldn't find enough readable text. Try a sharper, well-lit image with the text in focus."
        : format === "pdf"
          ? "Couldn't find enough readable text. Scanned PDFs aren't supported; try a text-based PDF or use the Images tab for a picture."
          : "Couldn't find enough readable text in that file. Check the document and try again.";
      return setStatus(message, true);
    }
    $("drop-hint").textContent = "Click to change file";
    dropzone.classList.add("has-file");
    setStatus(`Ready: ${bank.length} possible questions found.`);
    startBtn.disabled = false;
  } catch (err) {
    if (requestId !== activeFileRequest) return;
    console.error(err);
    const messages = {
      pdf: "Couldn't read that PDF. It may be damaged or password-protected.",
      docx: "Couldn't read that Word document. Check that it is a valid DOCX file.",
      txt: "Couldn't read that text file.",
      image: "Couldn't read text from that image."
    };
    const details = err instanceof Error ? ` ${err.message}` : "";
    setStatus(`${messages[format]}${details}`, true);
  }
}

async function extractFileText(file, format, requestId) {
  if (format === "pdf") return extractText(file);
  if (format === "txt") return (await file.text()).replace(/^\uFEFF/, "");
  if (format === "docx") {
    const mammoth = await loadBrowserLibrary(
      "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js",
      "mammoth",
      "DOCX reader"
    );
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  if (format === "image") {
    const tesseract = await loadBrowserLibrary(
      "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
      "Tesseract",
      "image text reader"
    );
    if (requestId === activeFileRequest) setStatus("Preparing image text recognition…");
    const worker = await tesseract.createWorker("eng", 1, {
      logger: (progress) => {
        if (requestId === activeFileRequest && progress.status === "recognizing text" && Number.isFinite(progress.progress)) {
          setStatus(`Reading image text… ${Math.round(progress.progress * 100)}%`);
        }
      }
    });
    try {
      const result = await worker.recognize(file);
      return result.data.text;
    } finally {
      await worker.terminate();
    }
  }
  throw new Error("This file type isn't supported.");
}

async function extractText(file) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((i) => i.str).join(" ") + " ";
  }
  return out;
}

/* ---------- Question generation (runs fully in the browser) ---------- */
function buildQuestions(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();
  const sentences = (text.match(/[^.!?]+(?:[.!?]+|$)/g) || [])
    .map((s) => s.trim())
    .filter((s) => s.length >= 45 && s.length <= 240 && (s.match(/\d/g) || []).length < 8);

  const freq = Object.create(null);
  (text.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).forEach((w) => { if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1; });

  const sentenceFreq = Object.create(null);
  sentences.forEach((sentence) => {
    const terms = new Set((sentence.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).filter((w) => !STOP.has(w)));
    terms.forEach((term) => { sentenceFreq[term] = (sentenceFreq[term] || 0) + 1; });
  });

  const questions = [];
  const pool = new Set();
  const seenSentences = new Set();
  const seenAnswers = new Set();

  sentences.forEach((s) => {
    const sentenceKey = s.toLowerCase();
    if (seenSentences.has(sentenceKey)) return;
    seenSentences.add(sentenceKey);

    const words = [...new Set((s.match(/[A-Za-z][A-Za-z-]{3,}/g) || []).filter((w) => !STOP.has(w.toLowerCase())))];
    if (!words.length) return;

    const articleSubject = sentenceKey.match(/^(?:the|a|an)\s+([a-z][a-z-]{3,})\b/);
    const leadTerm = articleSubject ? articleSubject[1] : "";
    const ranked = words.map((word, index) => {
      const term = word.toLowerCase();
      const technicalEnding = /(ation|ition|sion|ment|ness|ity|osis|ology|graphy|metry|ence|ance|ism|ist|itis|ical)$/i.test(word);
      const acronym = /^[A-Z]{2,}$/.test(word);
      const openingTerm = sentenceKey.indexOf(term) === 0 || leadTerm === term;
      const score =
        Math.log1p(freq[term] || 0) * 0.4 +
        Math.log1p(sentenceFreq[term] || 0) * 0.5 +
        Math.min(word.length, 16) * 0.1 +
        (technicalEnding ? 0.35 : 0) +
        (acronym ? 0.3 : 0) +
        (openingTerm ? 0.8 : 0);
      return { word, index, score };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    const bestCandidate = ranked.find(({ word }) => !seenAnswers.has(word.toLowerCase())) || ranked[0];
    if (!bestCandidate) return;
    const best = bestCandidate.word;

    questions.push({ sentence: s, answer: best });
    pool.add(best.toLowerCase());
    seenAnswers.add(best.toLowerCase());
  });

  const poolArr = [...pool];
  if (poolArr.length < 4) return [];

  return questions.map((q) => {
    const a = q.answer.toLowerCase();
    const distractors = shuffle(
      poolArr.filter((w) => w !== a).sort((x, y) => Math.abs(x.length - a.length) - Math.abs(y.length - a.length)).slice(0, 12)
    ).slice(0, 3);
    const match = (w) => (q.answer[0] === q.answer[0].toUpperCase() ? w[0].toUpperCase() + w.slice(1) : w);
    return { sentence: q.sentence, answer: q.answer, options: shuffle([q.answer, ...distractors.map(match)]) };
  });
}

/* ---------- Quiz flow ---------- */
startBtn.addEventListener("click", startQuiz);
$("btn-retry").addEventListener("click", startQuiz);
$("btn-new").addEventListener("click", () => { show("upload"); });
$("btn-quit").addEventListener("click", () => { if (confirm("Quit this quiz? Your progress will be lost.")) show("upload"); });

function startQuiz() {
  const n = Math.min(parseInt($("q-count").value, 10), bank.length);
  quiz = shuffle(bank).slice(0, n);
  current = 0; score = 0; answers = [];
  show("quiz");
  renderQuestion();
}

function renderQuestion() {
  const q = quiz[current];
  $("search-help").href = `https://www.google.com/search?q=${encodeURIComponent(q.sentence)}`;
  $("progress-text").textContent = `Question ${current + 1} of ${quiz.length}`;
  $("bar-fill").style.width = `${(current / quiz.length) * 100}%`;
  $("q-text").innerHTML = escapeHTML(q.sentence).replace(escapeHTML(q.answer), '<span class="blank"></span>');
  $("feedback").textContent = ""; $("feedback").className = "feedback";
  $("btn-next").disabled = true;
  $("btn-next").textContent = current === quiz.length - 1 ? "See my score" : "Next";

  const box = $("options");
  box.innerHTML = "";
  q.options.forEach((opt) => {
    const b = document.createElement("button");
    b.className = "opt"; b.textContent = opt;
    b.addEventListener("click", () => choose(b, opt));
    box.appendChild(b);
  });
}

function choose(btn, opt) {
  const q = quiz[current];
  const correct = opt.toLowerCase() === q.answer.toLowerCase();
  if (correct) score++;
  answers.push({ q, picked: opt, correct });

  document.querySelectorAll(".opt").forEach((b) => {
    b.disabled = true;
    if (b.textContent.toLowerCase() === q.answer.toLowerCase()) b.classList.add("right");
  });
  if (!correct) btn.classList.add("wrong");

  const fb = $("feedback");
  fb.textContent = correct ? "Correct." : `Not quite. The answer is "${q.answer}".`;
  fb.className = "feedback " + (correct ? "right" : "wrong");
  $("btn-next").disabled = false;
  $("btn-next").focus();
}

$("btn-next").addEventListener("click", () => {
  current++;
  current < quiz.length ? renderQuestion() : showResult();
});

/* ---------- Results ---------- */
function showResult() {
  show("result");
  $("score").textContent = `${score}/${quiz.length}`;
  const pct = score / quiz.length;
  $("score-msg").textContent =
    pct === 1 ? "Perfect score. Nothing missed." :
    pct >= 0.8 ? "Strong. Review the ones you missed below." :
    pct >= 0.5 ? "Getting there. Go back over the missed topics and try a new quiz." :
    "Needs more review. Re-read your notes, then retake a fresh quiz.";

  $("review").innerHTML = answers.map((a) => `
    <li>
      <div>${escapeHTML(a.q.sentence).replace(escapeHTML(a.q.answer), `<strong>${escapeHTML(a.q.answer)}</strong>`)}</div>
      <div class="ans ${a.correct ? "ok" : "no"}">${a.correct ? "Correct" : `You chose "${escapeHTML(a.picked)}"`}</div>
    </li>`).join("");
}
