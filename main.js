// Skole-knapper: buttons at the top of notes and notebooks, buttons inside notes (```knapper blocks),
// and commands for the iPad/phone toolbar and hotkeys. BUILT FILE: edit the scripts in Machine/Skript
// and run "node Machine/Skript/bygg-knapper.js" instead of editing this.
const obsidian = require('obsidian');
const { Plugin, Notice, Platform, setIcon } = obsidian;

const VERSION = '1.13.0';

const FELLES = (function () {
  const module = { exports: {} };
// Shared by the Notatbok and Oppgave buttons: subjects, the term notebook, and opening it beside.

const SUBJECTS = [
  ['Matte', '01_Realfaglige_Redskap/01.01_Matematikk'],
  ['Fysikk', '01_Realfaglige_Redskap/01.02_Fysikk'],
  ['Norsk', '02_Kommunikasjon/02.01_Norsk'],
  ['Engelsk', '02_Kommunikasjon/02.02_Engelsk'],
  ['Ledelse', '03_Ledelse_og_Økonomi/03.01_Ledelse'],
  ['Økonomi', '03_Ledelse_og_Økonomi/03.02_Økonomistyring'],
  ['Markedsføring', '03_Ledelse_og_Økonomi/03.03_Markedsføring'],
  ['Mekanikk', '04_Tekniske_fag/04.01_Mekanikk'],
  ['Elektro', '04_Tekniske_fag/04.02_Elektroteknikk'],
  ['Automasjon', '04_Tekniske_fag/04.03_Automasjon'],
  ['Material', '04_Tekniske_fag/04.04_Materiallære'],
  ['TekDok', '04_Tekniske_fag/04.05_Teknisk_dokumentasjon'],
  ['HMS', '05_HMS_Prosjekt_og_Kvalitet/05.01_HMS'],
  ['Prosjekt', '05_HMS_Prosjekt_og_Kvalitet/05.02_Prosjektledelse'],
  ['Kvalitet', '05_HMS_Prosjekt_og_Kvalitet/05.03_Kvalitetsledelse'],
].map(([label, folder]) => ({ label, folder }));

const NOTEBOOK_VIEW = 'goodobsidian-view';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Aug–Dec is autumn, Jan–Jul spring.
function term(date = window.moment()) {
  return `${date.month() >= 7 ? 'høst' : 'vår'} ${date.year()}`;
}

function subjectOfPath(path) {
  return SUBJECTS.find((s) => path === s.folder || path.startsWith(s.folder + '/'));
}

// Own learning (languages and the like): one folder per topic in 06_Læring, lessons are boards (.canvas).
const LEARNING = '06_Læring';
function learningTopics(app) {
  const root = app.vault.getAbstractFileByPath(LEARNING);
  return (root?.children || []).filter((c) => c.children).map((c) => ({ label: c.name, folder: c.path, kind: 'læring' }));
}

// Subjects you picked most recently come first in the list (remembered per device).
const RECENT = 'skole-fag-sist';
function recent() {
  try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch (e) { return []; }
}
function remember(label) {
  try { localStorage.setItem(RECENT, JSON.stringify([label, ...recent().filter((l) => l !== label)].slice(0, 20))); } catch (e) {}
}

// Make a new learning topic: its folder and main note from the "Læring" template.
async function newLearningTopic(app, quickAddApi) {
  const name = (await quickAddApi.inputPrompt('Hva vil du lære?', 'f.eks. Kinesisk'))?.trim();
  if (!name) return null;
  const folder = `${LEARNING}/${name}`;
  if (!app.vault.getAbstractFileByPath(LEARNING)) await app.vault.createFolder(LEARNING);
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  const main = `${folder}/${name}.md`;
  if (!app.vault.getAbstractFileByPath(main)) {
    const tpl = app.vault.getAbstractFileByPath('99_Maler_og_Ressurser/Maler/Læring.md');
    const body = tpl ? await app.vault.read(tpl) : `---\ntype: læring\ncssclasses: [laering]\n---\n# {{title}}\n`;
    await app.vault.create(main, body
      .replace(/\{\{date\}\}/g, window.moment().format('YYYY-MM-DD'))
      .replace(/\{\{title\}\}/g, name)
      .replace(/\{\{folder\}\}/g, folder));
  }
  return { label: name, folder, kind: 'læring' };
}

// The subject of the note or notebook you're in; asks with a tap list if it can't tell.
async function subjectHere(app, quickAddApi) {
  const file = app.workspace.getActiveFile();
  const topics = learningTopics(app);
  if (file) {
    const bySubjectFolder = subjectOfPath(file.path) || topics.find((t) => file.path.startsWith(t.folder + '/'));
    if (bySubjectFolder) return bySubjectFolder;
    const fag = String(app.metadataCache.getFileCache(file)?.frontmatter?.fag || '');
    const byFag = SUBJECTS.find((s) => fag.includes(s.label) || fag.includes(s.folder.split('/').pop().replace(/^[\d.]+_/, '')));
    if (byFag) return byFag;
  }
  // Recently used first, then the rest in the usual order; new learning topic last.
  const all = [...SUBJECTS, ...topics];
  const order = recent();
  const rank = (s) => (order.includes(s.label) ? order.indexOf(s.label) : 100 + all.indexOf(s));
  const sorted = [...all].sort((a, b) => rank(a) - rank(b));
  const options = [...sorted, { label: '＋ Nytt læringsområde …', create: true }];
  const pick = await quickAddApi.suggester(options.map((s) => (s.kind === 'læring' ? '📘 ' : '') + s.label), options);
  if (!pick) return null;
  const subject = pick.create ? await newLearningTopic(app, quickAddApi) : pick;
  if (subject) remember(subject.label);
  return subject;
}

function notebookPath(subject) {
  const name = `${subject.label} – ${term()}`;
  return { name, folder: `${subject.folder}/${name}`, file: `${subject.folder}/${name}/${name}.notebook.md` };
}

// The subject's notebook for this term. FineNotes has no API, so the first time we run its
// "Create notebook with last settings" command, catch what it makes, and move and rename it.
async function ensureNotebook(app, subject) {
  const want = notebookPath(subject);
  const have = app.vault.getAbstractFileByPath(want.file);
  if (have) return have;

  const made = [];
  const ref = app.vault.on('create', (f) => { if (f.path.endsWith('.notebook.md')) made.push(f); });
  try {
    app.commands.executeCommandById('finenotes:create-notebook-with-last-settings');
    for (let i = 0; i < 60 && !made.length; i++) await sleep(100);
  } finally {
    app.vault.offref(ref);
  }
  const file = made[0];
  if (!file) return null;

  // Close whatever FineNotes opened; we open it beside the note ourselves.
  app.workspace.getLeavesOfType(NOTEBOOK_VIEW).filter((l) => l.view?.file?.path === file.path).forEach((l) => l.detach());

  const oldBase = file.name.replace(/\.notebook\.md$/, '');
  let current = file;
  if (file.parent && file.parent.name === oldBase && !app.vault.getAbstractFileByPath(want.folder)) {
    await app.fileManager.renameFile(file.parent, want.folder);
    current = app.vault.getAbstractFileByPath(`${want.folder}/${file.name}`) || file;
  }
  if (!app.vault.getAbstractFileByPath(want.file)) await app.fileManager.renameFile(current, want.file);
  return app.vault.getAbstractFileByPath(want.file);
}

function notebookLeaf(app, file) {
  return app.workspace.getLeavesOfType(NOTEBOOK_VIEW).find((l) => l.view?.file?.path === file.path);
}

// Open beside what you're in (split right), or reuse the open tab. page: 'last' or a 0-based index.
async function openBeside(app, file, page) {
  let leaf = notebookLeaf(app, file);
  if (!leaf) {
    leaf = app.workspace.getLeaf('split', 'vertical');
    await leaf.openFile(file);
  }
  app.workspace.revealLeaf(leaf);
  for (let i = 0; i < 30 && !leaf.view?.surface; i++) await sleep(100);
  const surface = leaf.view?.surface;
  if (surface && page !== undefined) {
    surface.goToPage(page === 'last' ? surface.pageCount - 1 : page);
  }
  return leaf;
}

// FineNotes' own page tools (the ones its built-in assistant uses): add_page, set_page_title,
// add_section, go_to_page. Not an official API, so every call is allowed to fail quietly.
async function pageTool(view, args) {
  try {
    return await view?.runAskTool?.(args);
  } catch (e) {
    console.warn('FineNotes page tool failed', args, e);
    return null;
  }
}

// Where you're looking on the current page, from 0 (top) to 1 (bottom).
function visibleTop(view) {
  const s = view?.surface;
  try {
    const page = s.document.pages[s.currentPage];
    const rect = s.visiblePageRect(s.currentPage);
    return Math.min(0.9, Math.max(0, rect.y / page.geometry.height));
  } catch (e) {
    return 0.05;
  }
}

// ---- Excalidraw: one drawing per subject and week; pages and oppgaver are frames in it ----

const DRAWING_VIEW = 'excalidraw';
const PAGE = { w: 800, h: 1130 };   // A4-shaped page frame
const TASK = { w: 800, h: 520 };    // oppgave frame; drag it bigger or smaller as you like

// The drawing tool chosen in the Oppgave menu, remembered per device.
function tool() {
  try { return localStorage.getItem('oppgave-tool') || 'FineNotes'; } catch (e) { return 'FineNotes'; }
}

function ea() {
  const api = window.ExcalidrawAutomate?.getAPI?.() ?? window.ExcalidrawAutomate;
  if (!api) throw new Error('Excalidraw er ikke på');
  return api;
}

async function ensureWeekDrawing(app, subject) {
  const name = `${subject.label} – uke ${window.moment().isoWeek()}`;
  const folder = `${subject.folder}/Tegninger`;
  const path = `${folder}/${name}.excalidraw.md`;
  const have = app.vault.getAbstractFileByPath(path);
  if (have) return have;
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  const api = ea();
  api.reset();
  await api.create({ filename: name, foldername: folder, onNewPane: false, silent: true });
  for (let i = 0; i < 30 && !app.vault.getAbstractFileByPath(path); i++) await sleep(100);
  return app.vault.getAbstractFileByPath(path);
}

// Any open tab showing this file (notebook, drawing or note).
function leafFor(app, file) {
  let found = null;
  app.workspace.iterateAllLeaves((l) => { if (!found && l.view?.file?.path === file.path) found = l; });
  return found;
}

async function openDrawingBeside(app, file) {
  let leaf = leafFor(app, file);
  if (!leaf) {
    leaf = app.workspace.getLeaf('split', 'vertical');
    await leaf.openFile(file);
  }
  app.workspace.revealLeaf(leaf);
  for (let i = 0; i < 40 && !leaf.view?.excalidrawAPI; i++) await sleep(100);
  return leaf;
}

function frames(leaf) {
  const api = ea();
  api.setView(leaf.view);
  return api.getViewElements().filter((e) => e.type === 'frame' && !e.isDeleted);
}

// Notebook look (test): pages are white paper on a soft grey canvas; you can still write outside them.
const CANVAS_GREY = '#eceae4';

// Add a named frame under everything already in the drawing; returns its id.
// With paper: true, a locked white sheet lies inside the frame, so the page looks like paper.
async function addFrame(leaf, name, size, paper = false) {
  const api = ea();
  api.reset();
  api.setView(leaf.view);
  const all = api.getViewElements().filter((e) => !e.isDeleted);
  const top = all.length ? Math.max(...all.map((e) => e.y + (e.height || 0))) + 80 : 0;
  const id = api.addFrame(0, top, size.w, size.h, name);
  // Don't trim lines at page edges: with many lines inside frames, that trimming makes the iPad lag.
  leaf.view.excalidrawAPI?.updateScene({ appState: { frameRendering: { enabled: true, name: true, outline: true, clip: false } } });
  if (paper) {
    api.style.strokeColor = '#d6d3cc';
    api.style.backgroundColor = '#ffffff';
    api.style.fillStyle = 'solid';
    api.style.strokeWidth = 1;
    api.style.roughness = 0;
    const sheet = api.getElement(api.addRect(0, top, size.w, size.h));
    sheet.locked = true;
    sheet.frameId = id;
    leaf.view.excalidrawAPI?.updateScene({ appState: { viewBackgroundColor: CANVAS_GREY } });
  }
  await api.addElementsToView(false, true, false);
  zoomTo(leaf, id);
  return id;
}

function zoomTo(leaf, id) {
  try {
    const api = ea();
    api.setView(leaf.view);
    const el = api.getViewElements().filter((e) => e.id === id);
    if (el.length) api.viewZoomToElements(false, el);
  } catch (e) { /* zooming is a nicety */ }
}

// ---- New notes from templates (Ny-menu, Lag notat) ----

const TEMPLATES = '99_Maler_og_Ressurser/Maler';

// Core-template placeholders: {{date}}, {{date:FORMAT}}, {{time}}, {{title}}.
function fill(text, title) {
  return text
    .replace(/\{\{date(?::([^}]+))?\}\}/gi, (_, fmt) => window.moment().format(fmt || 'YYYY-MM-DD'))
    .replace(/\{\{time\}\}/gi, window.moment().format('HH:mm'))
    .replace(/\{\{title\}\}/gi, title);
}

async function ensureFolder(app, folder) {
  let path = '';
  for (const part of folder.split('/')) {
    path = path ? `${path}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
  }
}

// A file name that is safe on every device.
const safeName = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);

// Create "<folder>/<title>.md" from a template (or reuse it if it exists) and open it.
async function newFromTemplate(app, folder, title, template, extra = '') {
  await ensureFolder(app, folder);
  const path = `${folder}/${safeName(title)}.md`;
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    const tpl = template && app.vault.getAbstractFileByPath(`${TEMPLATES}/${template}.md`);
    const body = tpl ? fill(await app.vault.read(tpl), title) : `# ${title}\n\n`;
    file = await app.vault.create(path, body + extra);
  }
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  // Cursor to the end, ready to write.
  const editor = app.workspace.activeEditor?.editor;
  if (editor) editor.setCursor(editor.lastLine(), editor.getLine(editor.lastLine()).length);
  return file;
}

module.exports = {
  fill, ensureFolder, safeName, newFromTemplate,
  SUBJECTS, NOTEBOOK_VIEW, DRAWING_VIEW, PAGE, TASK, term, subjectOfPath, subjectHere, ensureNotebook, notebookLeaf,
  openBeside, pageTool, visibleTop, tool, ensureWeekDrawing, openDrawingBeside, frames, addFrame, zoomTo, leafFor,
};

  return module.exports;
})();

// Chapter list per subject (Machine/System/kapitler.json), built in so the iPad has it too.
const KAPITLER = {
  "HMS": [
    "1 Fra plikt til ressurs",
    "2 Begreper, rammer og reguleringer",
    "3 Roller, ansvar og samarbeid",
    "4 Kartlegging av HMS-utfordringer",
    "5 Systematisk HMS-arbeid",
    "6 Risikostyring og proaktive tiltak",
    "7 Praksis og fokusområder",
    "8 Håndtering av avvik og hendelser",
    "9 HMS-ledelse og organisasjonsutvikling",
    "10 HMS-kultur og bærekraft",
    "11 Refleksjoner"
  ],
  "Elektro": [
    "1 Elektriske grunnbegreper og størrelser",
    "2 Seriekretser og parallellkretser",
    "Kap 3",
    "Kap 4",
    "Kap 5"
  ],
  "Markedsføring": [
    "Kap 1",
    "Kap 2",
    "Kap 3",
    "Kap 4",
    "Kap 5",
    "Kap 6",
    "Kap 7",
    "Kap 8",
    "Kap 9",
    "Kap 10",
    "Kap 11",
    "Kap 12",
    "Kap 13",
    "Kap 14",
    "Kap 15",
    "Kap 16",
    "Kap 17"
  ],
  "Prosjekt": [
    "Kap 1",
    "Kap 2",
    "Kap 3",
    "Kap 4",
    "Kap 5",
    "Kap 6",
    "Kap 7",
    "Kap 8",
    "Kap 9",
    "Kap 10",
    "Kap 11",
    "Kap 12",
    "Kap 13",
    "Kap 14",
    "Kap 15",
    "Kap 16"
  ],
  "Norsk": [
    "1 Studieteknikk",
    "2 Kommunikasjonsprosessen",
    "3 Retorikk og argumentasjon",
    "4 Kulturmøter og flerspråklighet",
    "5 Muntlige presentasjoner",
    "6 Møter og formelle samtaler",
    "7 Å skrive gode tekster",
    "8 Godt språk",
    "9 Kilder",
    "10 Skriftlige sjangre",
    "11 English in the Workplace",
    "12 International Work and Collaboration",
    "13 Writing Professional English",
    "14 Quick Guide to Improving English",
    "15 Technical Vocabulary",
    "16 Technical Vocabulary del 2"
  ],
  "Material": [
    "1 Hvordan materialene er oppbygd",
    "2 Legeringer, deformasjon og varmebehandling",
    "3 Materialprøving",
    "Kap 4",
    "Kap 5",
    "Kap 6",
    "Kap 7"
  ],
  "Økonomi": [
    "1 Økonomistyring og forretningsplan",
    "2 Regneark og privatøkonomi",
    "3 Lover, forskrifter og standarder",
    "4 Bedriftsetablering og avvikling",
    "5 Inntekter og kostnader",
    "6 Regnskap og bokføring",
    "7 Årsregnskapet",
    "8 Regnskapsanalyse",
    "9 Kalkylegrunnlag",
    "10 Budsjett som styringsverktøy",
    "11 Kalkylemetoder",
    "12 Dekningspunktanalyse og produktvalg",
    "13 Investeringsanalyse",
    "14 Kapitalbinding i omløpsmidler",
    "15 Økonomistyring i prosjekter",
    "16 Økonomistyring, en enkel oppgave",
    "17 Eksamensoppgave Vår 2018"
  ],
  "Matte": [
    "1 Tall og algebra",
    "2 Likninger, formler og ulikheter",
    "3 Geometri",
    "4 Trigonometri",
    "5 Rette linjer",
    "6 Polynomfunksjoner",
    "7 Derivasjon og integrasjon",
    "8 Eksponentialfunksjoner og logaritmer",
    "9 Statistikk",
    "10 Utdypende trigonometri og komplekse tall",
    "11 Totallsystemet og logiske kretser"
  ]
};

// The books' real oppgave sets (Machine/System/oppgaver.json), built in for the Oppgave button.
const OPPGAVER = {
 "laget": "2026-11-03",
 "sett": [
  {
   "fag": "Matte",
   "navn": "Leksjon 01 (1.1, 1.3, 1.6)",
   "kapittel": "1",
   "uker": [
    34
   ],
   "oppgaver": [
    {
     "nr": "1.1.1",
     "side": 18,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=14"
    },
    {
     "nr": "1.1.2",
     "side": 18,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=14"
    },
    {
     "nr": "1.1.3",
     "side": 19,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=15"
    },
    {
     "nr": "1.1.4",
     "side": 19,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=15"
    },
    {
     "nr": "1.1.5",
     "side": 20,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=16"
    },
    {
     "nr": "1.1.6",
     "side": 20,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=16"
    },
    {
     "nr": "1.1.7",
     "side": 20,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=16"
    },
    {
     "nr": "1.1.8",
     "side": 20,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=16"
    },
    {
     "nr": "1.1.9",
     "side": 21,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=17"
    },
    {
     "nr": "1.1.10",
     "side": 21,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=17"
    },
    {
     "nr": "1.3.1",
     "side": 29,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=25"
    },
    {
     "nr": "1.3.2",
     "side": 29,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=25"
    },
    {
     "nr": "1.3.3",
     "side": 29,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=25"
    },
    {
     "nr": "1.3.4",
     "side": 31,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=27"
    },
    {
     "nr": "1.3.5",
     "side": 31,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=27"
    },
    {
     "nr": "1.3.6",
     "side": 32,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=28"
    },
    {
     "nr": "1.3.7",
     "side": 32,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=28"
    },
    {
     "nr": "1.3.8",
     "side": 32,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=28"
    },
    {
     "nr": "1.3.9",
     "side": 32,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=28"
    },
    {
     "nr": "1.3.10",
     "side": null,
     "lenke": null
    },
    {
     "nr": "1.6.3",
     "side": 51,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=47"
    },
    {
     "nr": "1.6.4",
     "side": 51,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=47"
    },
    {
     "nr": "1.6.7",
     "side": 54,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=50"
    }
   ]
  },
  {
   "fag": "Matte",
   "navn": "Leksjon 02 (1.4)",
   "kapittel": "1",
   "uker": [
    35
   ],
   "oppgaver": [
    {
     "nr": "1.4.1",
     "side": 34,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=30"
    },
    {
     "nr": "1.4.2",
     "side": 34,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=30"
    },
    {
     "nr": "1.4.3",
     "side": 35,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=31"
    },
    {
     "nr": "1.4.4",
     "side": 35,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=31"
    },
    {
     "nr": "1.4.5",
     "side": 36,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=32"
    },
    {
     "nr": "1.4.6",
     "side": 36,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=32"
    },
    {
     "nr": "1.4.7",
     "side": 37,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=33"
    },
    {
     "nr": "1.4.8",
     "side": 37,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=33"
    },
    {
     "nr": "1.4.9",
     "side": 39,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=35"
    },
    {
     "nr": "1.4.10",
     "side": 39,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=35"
    },
    {
     "nr": "1.4.11",
     "side": 40,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=36"
    },
    {
     "nr": "1.4.12",
     "side": 40,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=36"
    },
    {
     "nr": "1.4.13",
     "side": 40,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=36"
    },
    {
     "nr": "1.4.14",
     "side": 40,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=36"
    },
    {
     "nr": "1.4.15",
     "side": 41,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=37"
    },
    {
     "nr": "1.4.16",
     "side": 41,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=37"
    },
    {
     "nr": "1.4.17",
     "side": 42,
     "lenke": "zotero://open-pdf/library/items/HE3JUHV8?page=38"
    },
    {
     "nr": "1.4.18",
     "side": null,
     "lenke": null
    },
    {
     "nr": "1.4.19",
     "side": null,
     "lenke": null
    }
   ]
  },
  {
   "fag": "Matte",
   "navn": "Leksjon 03 (2.1, 2.2)",
   "kapittel": "2",
   "uker": [
    36
   ],
   "oppgaver": [
    {
     "nr": "2.1.1",
     "side": 80,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=5"
    },
    {
     "nr": "2.1.2",
     "side": 80,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=5"
    },
    {
     "nr": "2.1.4",
     "side": 80,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=5"
    },
    {
     "nr": "2.1.5",
     "side": 80,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=5"
    },
    {
     "nr": "2.1.6",
     "side": 80,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=5"
    },
    {
     "nr": "2.1.8",
     "side": 81,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=6"
    },
    {
     "nr": "2.1.9",
     "side": 81,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=6"
    },
    {
     "nr": "2.1.13",
     "side": 83,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=8"
    },
    {
     "nr": "2.1.15",
     "side": 83,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=8"
    },
    {
     "nr": "2.1.18",
     "side": 86,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=11"
    },
    {
     "nr": "2.2.1",
     "side": 86,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=11"
    },
    {
     "nr": "2.2.2",
     "side": 87,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=12"
    },
    {
     "nr": "2.2.5",
     "side": 87,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=12"
    },
    {
     "nr": "2.2.7",
     "side": 87,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=12"
    },
    {
     "nr": "2.2.8",
     "side": 88,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=13"
    },
    {
     "nr": "2.2.13",
     "side": 89,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=14"
    }
   ]
  },
  {
   "fag": "Matte",
   "navn": "Leksjon 04 (2.3, 2.5, 5.3)",
   "kapittel": "2",
   "uker": [
    37
   ],
   "oppgaver": [
    {
     "nr": "2.3.3",
     "side": 97,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=22"
    },
    {
     "nr": "2.3.4",
     "side": 97,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=22"
    },
    {
     "nr": "2.3.5",
     "side": 97,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=22"
    },
    {
     "nr": "2.3.6",
     "side": 97,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=22"
    },
    {
     "nr": "2.3.7",
     "side": 97,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=22"
    },
    {
     "nr": "2.3.8",
     "side": 98,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=23"
    },
    {
     "nr": "2.3.9",
     "side": 98,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=23"
    },
    {
     "nr": "2.3.12",
     "side": 100,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=25"
    },
    {
     "nr": "2.3.13",
     "side": 102,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=27"
    },
    {
     "nr": "2.3.14",
     "side": null,
     "lenke": null
    },
    {
     "nr": "2.5.1",
     "side": 107,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=32"
    },
    {
     "nr": "2.5.2",
     "side": 107,
     "lenke": "zotero://open-pdf/library/items/SHJJ693P?page=32"
    },
    {
     "nr": "5.3.1",
     "side": 223,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=17"
    },
    {
     "nr": "5.3.2",
     "side": 223,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=17"
    },
    {
     "nr": "5.3.3",
     "side": 224,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=18"
    },
    {
     "nr": "5.3.4",
     "side": 226,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=20"
    },
    {
     "nr": "5.3.5",
     "side": 226,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=20"
    },
    {
     "nr": "5.3.9",
     "side": 227,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=21"
    }
   ]
  },
  {
   "fag": "Matte",
   "navn": "Leksjon 05 (3.1, 3.2, 3.3, 3.4)",
   "kapittel": "3",
   "uker": [
    38
   ],
   "oppgaver": [
    {
     "nr": "3.1.5",
     "side": 132,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=6"
    },
    {
     "nr": "3.1.6",
     "side": 132,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=6"
    },
    {
     "nr": "3.1.7",
     "side": 132,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=6"
    },
    {
     "nr": "3.1.9",
     "side": 132,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=6"
    },
    {
     "nr": "3.2.1",
     "side": 134,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=8"
    },
    {
     "nr": "3.2.3",
     "side": 134,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=8"
    },
    {
     "nr": "3.2.5",
     "side": 136,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=10"
    },
    {
     "nr": "3.2.7",
     "side": 137,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=11"
    },
    {
     "nr": "3.2.11",
     "side": 137,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=11"
    },
    {
     "nr": "3.2.12",
     "side": 137,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=11"
    },
    {
     "nr": "3.2.14",
     "side": 139,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=13"
    },
    {
     "nr": "3.2.15",
     "side": 139,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=13"
    },
    {
     "nr": "3.3.7",
     "side": 144,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=18"
    },
    {
     "nr": "3.4.5",
     "side": 146,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=20"
    },
    {
     "nr": "3.4.9",
     "side": 147,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=21"
    },
    {
     "nr": "3.4.10",
     "side": 148,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=22"
    }
   ]
  },
  {
   "fag": "Matte",
   "navn": "Leksjon 06 (3.5, 5.6)",
   "kapittel": "3",
   "uker": [
    39
   ],
   "oppgaver": [
    {
     "nr": "3.5.1",
     "side": 153,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=27"
    },
    {
     "nr": "3.5.2",
     "side": 153,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=27"
    },
    {
     "nr": "3.5.4",
     "side": 154,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=28"
    },
    {
     "nr": "3.5.6",
     "side": 154,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=28"
    },
    {
     "nr": "3.5.8",
     "side": 154,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=28"
    },
    {
     "nr": "3.5.10",
     "side": 154,
     "lenke": "zotero://open-pdf/library/items/YCHQPSPB?page=28"
    },
    {
     "nr": "5.6.1",
     "side": 238,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=32"
    },
    {
     "nr": "5.6.2",
     "side": 239,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=33"
    },
    {
     "nr": "5.6.3",
     "side": 239,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=33"
    },
    {
     "nr": "5.6.4",
     "side": 241,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=35"
    },
    {
     "nr": "5.6.6",
     "side": 243,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=37"
    },
    {
     "nr": "5.6.7",
     "side": 243,
     "lenke": "zotero://open-pdf/library/items/HN7N6CLM?page=37"
    }
   ]
  },
  {
   "fag": "Matte",
   "navn": "Leksjon 07 (4.1)",
   "kapittel": "4",
   "uker": [
    41
   ],
   "oppgaver": [
    {
     "nr": "4.1.2",
     "side": 162,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=4"
    },
    {
     "nr": "4.1.11",
     "side": 168,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=10"
    },
    {
     "nr": "4.1.12",
     "side": 168,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=10"
    },
    {
     "nr": "4.1.13",
     "side": 168,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=10"
    },
    {
     "nr": "4.1.14",
     "side": 170,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=12"
    },
    {
     "nr": "4.1.15",
     "side": 171,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=13"
    },
    {
     "nr": "4.1.16",
     "side": 171,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=13"
    },
    {
     "nr": "4.1.17",
     "side": 171,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=13"
    },
    {
     "nr": "4.1.18",
     "side": 172,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=14"
    },
    {
     "nr": "4.1.19",
     "side": 172,
     "lenke": "zotero://open-pdf/library/items/PF8GLY6S?page=14"
    }
   ]
  },
  {
   "fag": "Fysikk",
   "navn": "Kap 1 Regning med fysiske størrelser · Repetisjonsoppgaver",
   "kapittel": "1",
   "uker": [
    42
   ],
   "oppgaver": [
    {
     "nr": "R1.1",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.2",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.3",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.4",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.5",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.6",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.7",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.8",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.9",
     "side": 30,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=22"
    },
    {
     "nr": "R1.10",
     "side": 31,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=23"
    },
    {
     "nr": "R1.11",
     "side": 31,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=23"
    },
    {
     "nr": "R1.12",
     "side": 31,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=23"
    },
    {
     "nr": "R1.13",
     "side": 31,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.01%20(Regning%20med%20fysiske%20st%C3%B8rrelser).pdf#page=23"
    }
   ]
  },
  {
   "fag": "Fysikk",
   "navn": "Kap 2 Rettlinjet bevegelse · Repetisjonsoppgaver",
   "kapittel": "2",
   "uker": [
    42,
    43
   ],
   "oppgaver": [
    {
     "nr": "R2.1",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.2",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.3",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.4",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.5",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.6",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.7",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.8",
     "side": 60,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=28"
    },
    {
     "nr": "R2.9",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.10",
     "side": 60,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=28"
    },
    {
     "nr": "R2.11",
     "side": 61,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=29"
    },
    {
     "nr": "R2.12",
     "side": 61,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=29"
    },
    {
     "nr": "R2.13",
     "side": 61,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=29"
    },
    {
     "nr": "R2.14",
     "side": 61,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=29"
    },
    {
     "nr": "R2.15",
     "side": 61,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=29"
    },
    {
     "nr": "R2.16",
     "side": 61,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=29"
    },
    {
     "nr": "R2.17",
     "side": 59,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=27"
    },
    {
     "nr": "R2.18",
     "side": 62,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=30"
    },
    {
     "nr": "R2.19",
     "side": 62,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=30"
    },
    {
     "nr": "R2.20",
     "side": 62,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=30"
    },
    {
     "nr": "R2.21",
     "side": 63,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=31"
    },
    {
     "nr": "R2.22",
     "side": 63,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=31"
    },
    {
     "nr": "R2.23",
     "side": 63,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.02%20(Rettlinjet%20bevegelse).pdf#page=31"
    }
   ]
  },
  {
   "fag": "Fysikk",
   "navn": "Kap 3 Kraft og bevegelse · Repetisjonsoppgaver",
   "kapittel": "3",
   "uker": [
    44,
    45
   ],
   "oppgaver": [
    {
     "nr": "R3.1",
     "side": 99,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=35"
    },
    {
     "nr": "R3.2",
     "side": 99,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=35"
    },
    {
     "nr": "R3.3",
     "side": 99,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=35"
    },
    {
     "nr": "R3.4",
     "side": 99,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=35"
    },
    {
     "nr": "R3.5",
     "side": 99,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=35"
    },
    {
     "nr": "R3.6",
     "side": 100,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=36"
    },
    {
     "nr": "R3.7",
     "side": 100,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=36"
    },
    {
     "nr": "R3.8",
     "side": 100,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=36"
    },
    {
     "nr": "R3.9",
     "side": 99,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=35"
    },
    {
     "nr": "R3.10",
     "side": 101,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=37"
    },
    {
     "nr": "R3.11",
     "side": 101,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=37"
    },
    {
     "nr": "R3.12",
     "side": 101,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=37"
    },
    {
     "nr": "R3.13",
     "side": 101,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=37"
    },
    {
     "nr": "R3.14",
     "side": 101,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=37"
    },
    {
     "nr": "R3.15",
     "side": 102,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=38"
    },
    {
     "nr": "R3.16",
     "side": 102,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=38"
    },
    {
     "nr": "R3.17",
     "side": 102,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=38"
    },
    {
     "nr": "R3.18",
     "side": 102,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=38"
    },
    {
     "nr": "R3.19",
     "side": 102,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=38"
    },
    {
     "nr": "R3.20",
     "side": 103,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.03%20(Kraft%20og%20bevegelse).pdf#page=39"
    }
   ]
  },
  {
   "fag": "Fysikk",
   "navn": "Kap 5 Statikk · Repetisjonsoppgaver",
   "kapittel": "5",
   "uker": [
    44,
    46,
    47
   ],
   "oppgaver": [
    {
     "nr": "R5.1",
     "side": 160,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=24"
    },
    {
     "nr": "R5.2",
     "side": 160,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=24"
    },
    {
     "nr": "R5.3",
     "side": 160,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=24"
    },
    {
     "nr": "R5.4",
     "side": 160,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=24"
    },
    {
     "nr": "R5.5",
     "side": 160,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=24"
    },
    {
     "nr": "R5.6",
     "side": 160,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=24"
    },
    {
     "nr": "R5.7",
     "side": 161,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=25"
    },
    {
     "nr": "R5.8",
     "side": 161,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=25"
    },
    {
     "nr": "R5.9",
     "side": 161,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=25"
    },
    {
     "nr": "R5.10",
     "side": 161,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=25"
    },
    {
     "nr": "R5.11",
     "side": 161,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=25"
    },
    {
     "nr": "R5.12",
     "side": 162,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=26"
    },
    {
     "nr": "R5.13",
     "side": 162,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=26"
    },
    {
     "nr": "R5.14",
     "side": 161,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=25"
    },
    {
     "nr": "R5.15",
     "side": 161,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=25"
    },
    {
     "nr": "R5.16",
     "side": 163,
     "lenke": "file:///G:/My%20Drive/Skole/01_Realfaglige_Redskap/01.02_Fysikk/01.02.05%20(Statikk).pdf#page=27"
    }
   ]
  },
  {
   "fag": "Elektro",
   "navn": "Kap 4 Effekt og energi · Kontrolloppgaver",
   "kapittel": "4",
   "uker": [
    43
   ],
   "oppgaver": [
    {
     "nr": "1",
     "side": 56,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/FJF36YC2?page=10"
    },
    {
     "nr": "2",
     "side": 56,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/FJF36YC2?page=10"
    },
    {
     "nr": "3",
     "side": 56,
     "deler": [
      "a",
      "b",
      "c",
      "d"
     ],
     "lenke": "zotero://open-pdf/library/items/FJF36YC2?page=10"
    },
    {
     "nr": "4",
     "side": 57,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/FJF36YC2?page=11"
    },
    {
     "nr": "5",
     "side": 57,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/FJF36YC2?page=11"
    },
    {
     "nr": "6",
     "side": 57,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/FJF36YC2?page=11"
    }
   ]
  },
  {
   "fag": "Elektro",
   "navn": "Kap 5 Spoler, magnetisme og induktans · Kontrolloppgaver",
   "kapittel": "5",
   "uker": [
    44,
    45,
    46
   ],
   "oppgaver": [
    {
     "nr": "1",
     "side": 81,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/LDXKP9UV?page=23"
    },
    {
     "nr": "2",
     "side": 81,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/LDXKP9UV?page=23"
    },
    {
     "nr": "3",
     "side": 81,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/LDXKP9UV?page=23"
    },
    {
     "nr": "4",
     "side": 82,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/LDXKP9UV?page=24"
    },
    {
     "nr": "5",
     "side": 82,
     "deler": [
      "a",
      "b",
      "c",
      "d"
     ],
     "lenke": "zotero://open-pdf/library/items/LDXKP9UV?page=24"
    },
    {
     "nr": "6",
     "side": 82,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/LDXKP9UV?page=24"
    },
    {
     "nr": "7",
     "side": 82,
     "deler": [
      "a",
      "b",
      "c",
      "d",
      "e"
     ],
     "lenke": "zotero://open-pdf/library/items/LDXKP9UV?page=24"
    },
    {
     "nr": "8",
     "side": 83,
     "deler": [
      "a",
      "b",
      "c",
      "d"
     ],
     "lenke": "zotero://open-pdf/library/items/LDXKP9UV?page=25"
    }
   ]
  }
 ]
};

const SCRIPTS = {
  'ny.js': (function () {
  const module = { exports: {} };
// QuickAdd script for the "Ny…" button: one menu for every kind of new note.
// Each lands in its place with its template, named for you, cursor ready to write.

// All small thoughts go in one big note; ideas worth their own note go in Ideer.
const TANKER = '06_Tanker_og_Ideer/Tanker.md';
const PLACES = {
  ide: '06_Tanker_og_Ideer/Ideer',
  ai: '06_Tanker_og_Ideer/AI-chatter',
  prosjekt: '90_Prosjekter_og_Oppgaver/Prosjekter',
};

async function shared() { return FELLES; }

module.exports = async ({ app, quickAddApi, obsidian, kind }) => {
  const nb = await shared(app);
  const options = [
    { kind: 'tanke', label: '💭 Tanke (i den store Tanker-notatet)' },
    { kind: 'ide', label: '💡 Idé' },
    { kind: 'prosjekt', label: '🛠 Prosjekt' },
    { kind: 'time', label: '📚 Ny time (skole)' },
    { kind: 'ai', label: '🤖 AI-chat' },
  ];
  const pick = kind ? options.find((o) => o.kind === kind) : await quickAddApi.suggester(options.map((o) => o.label), options);
  if (!pick) return;
  const now = window.moment();

  if (pick.kind === 'tanke') {
    // One tap: the one big Tanker note, a heading per day, a new line ready to write.
    // Ideas that grow get lifted out with "Lag notat".
    await nb.ensureFolder(app, PLACES.ide.split('/')[0]);
    const path = TANKER;
    let file = app.vault.getAbstractFileByPath(path);
    if (!file) file = await app.vault.create(path, '# Tanker\nSmå ideer, ord og nattetanker. Det som blir stort, løftes ut med «Lag notat».\n');
    const day = `## ${now.format('YYYY-MM-DD')}`;
    const text = await app.vault.read(file);
    const add = (text.includes(day) ? '' : `\n${day}\n`) + `- ${now.format('HH:mm')} `;
    await app.vault.append(file, (text.endsWith('\n') ? '' : '\n') + add);
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const editor = app.workspace.activeEditor?.editor;
    if (editor) {
      const last = editor.lastLine();
      editor.setCursor(last, editor.getLine(last).length);
      editor.focus();
    }
    return;
  }
  if (pick.kind === 'time') {
    return app.commands.executeCommandById('skole-knapper:ny-time');
  }
  if (pick.kind === 'ide') {
    const name = (await quickAddApi.inputPrompt('Idé', 'f.eks. Biomimicry'))?.trim();
    if (!name) return;
    return nb.newFromTemplate(app, PLACES.ide, name, 'Idé');
  }
  if (pick.kind === 'ai') {
    const topic = (await quickAddApi.inputPrompt('Hva handler chatten om?', 'f.eks. Kvantesammenfiltring'))?.trim();
    if (!topic) return;
    return nb.newFromTemplate(app, PLACES.ai, `${now.format('YYYY-MM-DD')} ${topic}`, 'AI-chat');
  }
  if (pick.kind === 'prosjekt') {
    const name = (await quickAddApi.inputPrompt('Prosjektnavn', 'f.eks. Gripper'))?.trim();
    if (!name) return;
    // Each project gets its own folder, with the project page inside.
    return nb.newFromTemplate(app, `${PLACES.prosjekt}/${nb.safeName(name)}`, name, 'Prosjekt');
  }
};

  return module.exports;
})(),
  'nytime.js': (function () {
  const module = { exports: {} };
// QuickAdd script for the "Ny time" button.
// Picks the subject (the one you're in, else a tap list), then the chapter from THAT subject only:
// the book's chapters (Machine/System/kapitler.json) plus chapters you have used before in that
// subject. Creates "<Fag> YYYY-MM-DD" in the subject folder from its lesson template, with
// "kapittel" filled in. If today's lesson already exists, it opens it (and fills an empty chapter).

const TEMPLATES = '99_Maler_og_Ressurser/Maler';

async function shared() { return FELLES; }

// Inside the plugin the chapter list is built in; elsewhere it is read from the vault.
async function bookChapters(app) {
  if (typeof KAPITLER !== 'undefined') return KAPITLER;
  try { return JSON.parse(await app.vault.adapter.read('Machine/System/kapitler.json')); } catch (e) { return {}; }
}

// Core-template placeholders: {{date}}, {{date:FORMAT}}, {{title}}.
function fill(text, title) {
  return text
    .replace(/\{\{date(?::([^}]+))?\}\}/gi, (_, fmt) => window.moment().format(fmt || 'YYYY-MM-DD'))
    .replace(/\{\{title\}\}/gi, title);
}

// Own learning (06_Læring/<topic>): the lesson is a board "<Topic> – YYYY-MM-DD.canvas" from the "Time – Læring" board.
async function learningLesson(app, subject) {
  const title = `${subject.label} – ${window.moment().format('YYYY-MM-DD')}`;
  const path = `${subject.folder}/${title}.canvas`;
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    const tpl = app.vault.getAbstractFileByPath(`${TEMPLATES}/Time – Læring.canvas`);
    const body = tpl ? await app.vault.read(tpl) : '{"nodes":[],"edges":[]}';
    file = await app.vault.create(path, fill(body, title));
  }
  await app.workspace.getLeaf(false).openFile(file);
}

module.exports = async ({ app, quickAddApi, obsidian }) => {
  const nb = await shared(app);
  const subject = await nb.subjectHere(app, quickAddApi);
  if (!subject) return;
  if (subject.kind === 'læring') return learningLesson(app, subject);

  // Chapters: the book's, then any others used before in this subject (newest kept as written).
  const used = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(subject.folder + '/')) continue;
    const k = app.metadataCache.getFileCache(f)?.frontmatter?.kapittel;
    if (k && !used.includes(String(k))) used.push(String(k));
  }
  const book = (await bookChapters(app))[subject.label] || [];
  const list = [...book, ...used.filter((u) => !book.includes(u))];
  const options = [...list.map((l) => ({ label: l, value: l })), { label: 'Annet kapittel …', ask: true }, { label: 'Hopp over', value: '' }];
  const pick = await quickAddApi.suggester(options.map((o) => o.label), options);
  if (!pick) return;
  let chapter = pick.value;
  if (pick.ask) {
    chapter = (await quickAddApi.inputPrompt(`Kapittel i ${subject.label}`, 'f.eks. 3 Materialprøving'))?.trim();
    if (chapter === undefined || chapter === null) return;
  }

  const title = `${subject.label} ${window.moment().format('YYYY-MM-DD')}`;
  const path = `${subject.folder}/${title}.md`;
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    const tpl = app.vault.getAbstractFileByPath(`${TEMPLATES}/Time – ${subject.label}.md`);
    const body = tpl ? await app.vault.read(tpl) : `---\ntype: time\nfag: ${subject.label}\ndato: {{date}}\nkapittel:\n---\n# {{title}}\n\n## Notater fra timen\n\n`;
    file = await app.vault.create(path, fill(body, title));
  }
  if (chapter) {
    await app.fileManager.processFrontMatter(file, (fm) => {
      if (!fm.kapittel) fm.kapittel = chapter;
    });
  }
  await app.workspace.getLeaf(false).openFile(file);
};

  return module.exports;
})(),
  'notatbok.js': (function () {
  const module = { exports: {} };
// QuickAdd script for the "Notatbok" button.
// Opens this subject's writing space beside what you're in, ready to write:
// - FineNotes: the notebook for the term ("<Fag> – høst 2026"), at the last page.
// - Excalidraw: the drawing for this week ("<Fag> – uke 44", in the subject's Tegninger folder),
//   zoomed to the last frame. The tool is the one chosen in the Oppgave menu (per device).

async function shared() { return FELLES; }

module.exports = async ({ app, quickAddApi, obsidian }) => {
  const nb = await shared(app);
  const subject = await nb.subjectHere(app, quickAddApi);
  if (!subject) return;

  // One tap: which tool. The one used last comes first, and the choice is remembered.
  const last = nb.tool();
  const choices = [
    { tool: 'FineNotes', label: `📓 FineNotes – ${subject.label} – ${nb.term()} (sider)` },
    { tool: 'Excalidraw', label: `✏️ Excalidraw – ${subject.label} – uke ${window.moment().isoWeek()} (rammer)` },
  ].sort((a, b) => (a.tool === last ? -1 : b.tool === last ? 1 : 0));
  const chosen = await quickAddApi.suggester(choices.map((c) => c.label), choices);
  if (!chosen) return;
  try { localStorage.setItem('oppgave-tool', chosen.tool); } catch (e) {}

  if (chosen.tool === 'Excalidraw') {
    const file = await nb.ensureWeekDrawing(app, subject);
    if (!file) return new obsidian.Notice('Kunne ikke lage tegningen. Er Excalidraw på?');
    const leaf = await nb.openDrawingBeside(app, file);
    const last = nb.frames(leaf).sort((a, b) => a.y - b.y).pop();
    if (last) nb.zoomTo(leaf, last.id);
    return;
  }

  const file = await nb.ensureNotebook(app, subject);
  if (!file) {
    new obsidian.Notice('Fant ikke FineNotes. Er den slått på?');
    return;
  }
  await nb.openBeside(app, file, 'last');
};

  return module.exports;
})(),
  'nyside.js': (function () {
  const module = { exports: {} };
// QuickAdd script for the "Ny side" button (also on the iPad).
// Adds a page at the END of the subject's notebook (never in the middle, so page links stay right),
// titles it "Uke 44 · 28.10" in the notebook's contents, and goes to it.

async function shared() { return FELLES; }

module.exports = async ({ app, quickAddApi, obsidian }) => {
  const nb = await shared(app);
  let leaf = app.workspace.activeLeaf;
  const now = window.moment();

  // Excalidraw: a new A4-shaped page frame under the last one, in this week's drawing.
  const inDrawing = leaf?.view?.getViewType?.() === nb.DRAWING_VIEW;
  if (inDrawing || (nb.tool() === 'Excalidraw' && leaf?.view?.getViewType?.() !== nb.NOTEBOOK_VIEW)) {
    if (!inDrawing) {
      const subject = await nb.subjectHere(app, quickAddApi);
      if (!subject) return;
      const file = await nb.ensureWeekDrawing(app, subject);
      if (!file) return new obsidian.Notice('Kunne ikke lage tegningen. Er Excalidraw på?');
      leaf = await nb.openDrawingBeside(app, file);
    }
    const n = nb.frames(leaf).filter((f) => /^Side \d+/.test(f.name || '')).length + 1;
    await nb.addFrame(leaf, `Side ${n} · ${now.format('DD.MM')}`, nb.PAGE, true);
    return;
  }

  if (leaf?.view?.getViewType?.() !== nb.NOTEBOOK_VIEW) {
    const subject = await nb.subjectHere(app, quickAddApi);
    if (!subject) return;
    const file = await nb.ensureNotebook(app, subject);
    if (!file) {
      new obsidian.Notice('Fant ikke FineNotes. Er den slått på?');
      return;
    }
    leaf = await nb.openBeside(app, file, 'last');
  }
  const view = leaf.view;
  const count = view?.surface?.pageCount;
  if (!count) {
    new obsidian.Notice('Fant ikke sidene i notatboka.');
    return;
  }

  const added = await nb.pageTool(view, { tool: 'add_page', after: count });
  if (!added || added.isError) {
    new obsidian.Notice('Kunne ikke legge til side. Trykk + i FineNotes i stedet.');
    return;
  }
  const page = count + 1;
  await nb.pageTool(view, { tool: 'set_page_title', page, title: `Uke ${now.isoWeek()} · ${now.format('DD.MM')}` });
  await nb.pageTool(view, { tool: 'go_to_page', page });
};

  return module.exports;
})(),
  'oppgave.js': (function () {
  const module = { exports: {} };
// QuickAdd script for the "Oppgave" button.
// Works in a lesson note or inside the subject's FineNotes notebook.
// - In the notebook or drawing: records it there (FineNotes: this page; Excalidraw: a new frame). You stay.
// - In a note: inserts "### Oppg …", "Les:" and the notebook page, and opens the notebook beside it.
// Each oppgave gets a small record in Machine/Sider (subject, chapter, week, date, page, lesson),
// which the filter view reads. Tool: FineNotes (pages) or Excalidraw (frames in this week's drawing).
// The book's oppgave list comes with the book breakdown.

const RECORDS = 'Machine/Sider';

// "4.2.5" -> [4, 2, 5]
const parts = (num) => num.split('.').map((p) => parseInt(p, 10) || 0);

function compare(a, b) {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The next oppgave after "4.1.1" or "4.1.1b" is "4.1.2".
function nextOf(num) {
  const p = parts(num);
  p[p.length - 1] += 1;
  return p.join('.');
}

// "4.1.1b" -> { base: "4.1.1", letter: "b" }; also "R3.6" (physics) and "1 b" (Elektro).
const split = (num) => {
  const m = String(num).match(/^([A-Z]?\d+(?:\.\d+)*)\s*([a-z])?$/i);
  return m ? { base: m[1], letter: (m[2] || '').toLowerCase() } : { base: String(num), letter: '' };
};
const LETTERS = 'abcdefgh'.split('');

// The real oppgave sets per subject (Machine/System/oppgaver.json, made from the books and the fremdriftsplaner).
// Inside the plugin the list is built in; elsewhere it is read from the vault.
async function bookSets(app) {
  if (typeof OPPGAVER !== 'undefined') return OPPGAVER.sett || [];
  try { return JSON.parse(await app.vault.adapter.read('Machine/System/oppgaver.json')).sett || []; } catch (e) { return []; }
}

// The set for this week; else the latest one before it; else the first.
function currentSet(sets, week) {
  return sets.find((s) => s.uker.includes(week))
    || sets.filter((s) => Math.min(...s.uker) <= week).sort((a, b) => Math.max(...b.uker) - Math.max(...a.uker))[0]
    || sets[0];
}

// One entry per oppgave, or per part when the book gives parts: "1 a", "1 b", … / "R3.6" / "4.1.2".
const entries = (set) => set.oppgaver.flatMap((o) => (o.deler && o.deler.length
  ? o.deler.map((d) => ({ num: o.nr + d, label: `${o.nr} ${d}`, o }))
  : [{ num: o.nr, label: o.nr, o }]));

// "require" of vault files doesn't work on the iPad, so the shared code is read and run directly.
async function shared() { return FELLES; }

module.exports = async ({ app, quickAddApi, obsidian }) => {
  const nb = await shared(app);
  const leaf = app.workspace.activeLeaf;
  const inNotebook = leaf?.view?.getViewType?.() === nb.NOTEBOOK_VIEW;
  const inDrawing = leaf?.view?.getViewType?.() === nb.DRAWING_VIEW;
  const editor = inNotebook || inDrawing ? null : app.workspace.activeEditor?.editor;
  const here = app.workspace.getActiveFile();
  if (!inNotebook && !inDrawing && (!here || !editor)) {
    new obsidian.Notice('Åpne et timenotat (og trykk i teksten) eller fagets notatbok først.');
    return;
  }

  const subject = await nb.subjectHere(app, quickAddApi);
  if (!subject) return;

  // Every oppgave already done in this subject: records plus headings in its notes.
  const done = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith(RECORDS + '/')) {
      const fm = app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm?.fag === subject.label && fm.oppgave) done.push(String(fm.oppgave));
    } else if (f.path.startsWith(subject.folder + '/') && f.name.endsWith('.md') && !/\.(notebook|page|ink|excalidraw)\.md$/.test(f.name)) {
      const text = await app.vault.cachedRead(f);
      for (const m of text.matchAll(/^###\s+Oppg\s+([A-Z]?\d+(?:\.\d+)*\s*[a-z]?)\b/gim)) done.push(m[1].replace(/\s+/g, ''));
    }
  }
  // Highest number, and for that number the highest letter (4.1.1 < 4.1.1a < 4.1.1b < 4.1.2).
  const numbered = done.filter((n) => /^\d+(\.\d+)*[a-z]?$/i.test(n));
  const last = numbered.sort((a, b) => compare(split(a).base, split(b).base) || split(a).letter.localeCompare(split(b).letter)).pop();
  const lastPart = last ? split(last) : null;

  // The drawing tool is remembered per device; FineNotes unless changed. Not offered inside a notebook.
  let tool = 'FineNotes';
  try { tool = localStorage.getItem('oppgave-tool') || tool; } catch (e) {}
  if (inNotebook) tool = 'FineNotes';
  if (inDrawing) tool = 'Excalidraw';

  // The book's own list for this subject: this week's set, the next oppgave first, then the rest of the set.
  const sets = (await bookSets(app)).filter((s) => s.fag === subject.label);
  let set = sets.length ? currentSet(sets, window.moment().isoWeek()) : null;
  // If you're still working on another set (say you're behind the plan), stay in the set you used last.
  let lastUsed = null;
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(RECORDS + '/')) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (fm?.fag === subject.label && fm.sett && (!lastUsed || (f.stat?.mtime || 0) > lastUsed.t)) lastUsed = { t: f.stat?.mtime || 0, sett: fm.sett };
  }
  const lastSet = lastUsed && sets.find((s) => s.navn === lastUsed.sett);
  const doneIn = (s) => {
    const list = [];
    for (const f of app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(RECORDS + '/')) continue;
      const fm = app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm?.fag === subject.label && fm.sett === s.navn && fm.oppgave) list.push(String(fm.oppgave).replace(/\s+/g, ''));
    }
    return list;
  };
  if (lastSet && entries(lastSet).some((e) => !doneIn(lastSet).includes(e.num))) set = lastSet;

  let pick;
  for (;;) {
    const options = [];
    if (set) {
      const all = entries(set);
      const doneHere = doneIn(set);
      const lastIdx = Math.max(-1, ...doneHere.map((d) => all.findIndex((e) => e.num === d)));
      const next = all[lastIdx + 1];
      if (next) options.push({ label: `Neste: ${next.label}${next.o.side ? `  · s. ${next.o.side}` : ''}   (${set.navn})`, entry: next });
      for (const e of all) if (e !== next) options.push({ label: `${doneHere.includes(e.num) ? '✓ ' : ''}${e.label}${e.o.side ? `  · s. ${e.o.side}` : ''}`, entry: e });
      if (sets.length > 1) options.push({ label: 'Annet sett …', ask: 'set' });
    }
    if (lastPart?.letter) {
      const nextLetter = LETTERS[LETTERS.indexOf(lastPart.letter) + 1];
      if (nextLetter) options.push({ label: `Neste del: ${lastPart.base} ${nextLetter}`, num: lastPart.base + nextLetter });
    }
    if (last && !set) options.push({ label: `Neste: ${nextOf(lastPart.base)}   (etter ${last})`, num: nextOf(lastPart.base) });
    if (last) options.push({ label: `Del av ${lastPart.base} (a, b, c …)`, ask: 'letter' });
    if (!set) options.push({ label: 'Velg med trykk (kapittel → del → nummer)', ask: 'pick' });
    options.push({ label: 'Skriv nummer …', ask: 'number' });
    options.push({ label: 'Egen oppgave (ikke fra boka) …', ask: 'own' });
    if (!inNotebook && !inDrawing) options.push({ label: `Tegne i ${tool}  (bytt til ${tool === 'FineNotes' ? 'Excalidraw' : 'FineNotes'})`, toggle: true });
    pick = await quickAddApi.suggester(options.map((o) => o.label), options);
    if (!pick) return;
    if (pick.ask === 'set') {
      const chosen = await quickAddApi.suggester(sets.map((s) => `${s.navn}  (uke ${s.uker.join(', ')})`), sets);
      if (chosen) set = chosen;
      continue;
    }
    if (!pick.toggle) break;
    tool = tool === 'FineNotes' ? 'Excalidraw' : 'FineNotes';
    try { localStorage.setItem('oppgave-tool', tool); } catch (e) {}
  }

  let num = pick.entry ? pick.entry.num : pick.num || null;
  let title = pick.entry ? `Oppg ${pick.entry.label}` : null;
  const book = pick.entry ? pick.entry.o : null;
  if (pick.ask === 'pick') {
    // Three taps, no keyboard. The chapter and part you worked in last come first.
    const [lc, ls] = last ? parts(last) : [];
    const range = (n, first) => {
      const list = Array.from({ length: n }, (_, i) => i + 1);
      return first ? [first, ...list.filter((x) => x !== first)] : list;
    };
    const kap = await (async (items) => quickAddApi.suggester(items.map((x) => `Kapittel ${x}`), items))(range(15, lc));
    if (!kap) return;
    const del = await (async (items) => quickAddApi.suggester(items.map((x) => `${kap}.${x}`), items))(range(12, kap === lc ? ls : undefined));
    if (!del) return;
    const nr = await (async (items) => quickAddApi.suggester(items.map((x) => `${kap}.${del}.${x}`), items))(range(30));
    if (!nr) return;
    num = `${kap}.${del}.${nr}`;
  }
  if (pick.ask === 'letter') {
    const letter = await quickAddApi.suggester(LETTERS.map((l) => `${lastPart.base} ${l}`), LETTERS);
    if (!letter) return;
    num = lastPart.base + letter;
  }
  if (pick.ask === 'number') {
    num = (await quickAddApi.inputPrompt('Oppgavenummer', 'f.eks. 4.2.5'))?.trim();
    if (!num) return;
  }
  if (pick.ask === 'own') {
    title = (await quickAddApi.inputPrompt('Navn på oppgaven', 'f.eks. Lærer-oppgave 1'))?.trim();
    if (!title) return;
  }
  title = title || `Oppg ${split(num).base}${split(num).letter ? ' ' + split(num).letter : ''}`;
  const chapter = book ? set.kapittel : num ? parts(split(num).base.replace(/^[A-Z]/i, ''))[0] : await (async (items) => quickAddApi.suggester(items.map((x) => `Kapittel ${x}`), items))(Array.from({ length: 15 }, (_, i) => i + 1));

  const cursor = editor?.getCursor();
  let pageLink, where;

  if (tool === 'Excalidraw') {
    // Excalidraw: a frame named after the oppgave, under the last one in this week's drawing.
    let dLeaf = leaf;
    if (!inDrawing) {
      const drawing = await nb.ensureWeekDrawing(app, subject);
      if (!drawing) return new obsidian.Notice('Kunne ikke lage tegningen. Er Excalidraw på?');
      dLeaf = await nb.openDrawingBeside(app, drawing);
    }
    const id = await nb.addFrame(dLeaf, title, nb.TASK);
    pageLink = `${dLeaf.view.file.path.replace(/\.md$/, '')}#^frame=${id}`;
    where = 'som egen ramme';
  } else {
    // FineNotes: the subject's notebook for this term, at the page you're on (or its last page).
    const notebook = inNotebook && here.path.endsWith('.notebook.md') ? here : await nb.ensureNotebook(app, subject);
    if (!notebook) {
      new obsidian.Notice('Fant ikke FineNotes. Er den slått på?');
      return;
    }
    const nbLeaf = inNotebook ? leaf : await nb.openBeside(app, notebook, 'last');
    const surface = nbLeaf?.view?.surface;
    const page = (surface ? surface.currentPage : 0) + 1; // links count pages from 1
    pageLink = `${notebook.path.replace(/\.md$/, '')}#page=${page}`;
    where = `på side ${page}`;

    // Put "Oppg 4.1.1" on the page as a text box where you're looking. This uses FineNotes' own
    // insert function (the one its calculator uses); it isn't an official API, so failure is quiet.
    try {
      nbLeaf?.view?.insertCalculation?.(title);
    } catch (e) {
      console.warn('Oppgave button: could not put the label on the page', e);
    }
    // And a section in the notebook's contents at that height, so it can be jumped to.
    await nb.pageTool(nbLeaf?.view, { tool: 'add_section', page, title, y: nb.visibleTop(nbLeaf?.view) });
  }

  // The lesson: the note you're in, or today's lesson note for the subject.
  const today = window.moment().format('YYYY-MM-DD');
  const lesson = inNotebook || inDrawing ? app.vault.getAbstractFileByPath(`${subject.folder}/${subject.label} ${today}.md`) : here;

  if (!app.vault.getAbstractFileByPath(RECORDS)) await app.vault.createFolder(RECORDS);
  const base = `${RECORDS}/${subject.label} ${title}`.replace(/[\\:*?"<>|#^[\]]/g, '-');
  let recordPath = `${base}.md`;
  for (let i = 2; app.vault.getAbstractFileByPath(recordPath); i++) recordPath = `${base} (${i}).md`;
  await app.vault.create(recordPath, [
    '---',
    'type: side',
    `fag: ${subject.label}`,
    `oppgave: "${num || title}"`,
    `kapittel: ${chapter || ''}`,
    ...(book ? [`sett: "${set.navn}"`, `bokside: ${book.side || ''}`] : []),
    `uke: ${window.moment().isoWeek()}`,
    `dato: ${today}`,
    `side: "[[${pageLink}]]"`,
    `time: ${lesson ? `"[[${lesson.basename}]]"` : ''}`,
    '---',
    `![[${pageLink}]]`,
    '',
  ].join('\n'));

  if (inNotebook || inDrawing) {
    new obsidian.Notice(`${title} lagret ${where}.`);
  } else {
    editor.setCursor(cursor);
    const les = book && book.lenke ? `[s. ${book.side}](${book.lenke})` : '';
    editor.replaceSelection(`\n### ${title}\nLes: ${les}\n![[${pageLink}]]\n\n`);
  }
};

  return module.exports;
})(),
  'hjelp.js': (function () {
  const module = { exports: {} };
// QuickAdd script for the "Hjelp" button.
// Puts a help request in the queue (Machine/Hjelp). Your note is not changed.
// The request links back to your note, so it shows under Backlinks at the bottom of it.
// The Machine answers in the same file when you say "svar på hjelp" in a Claude chat.

const QUEUE = 'Machine/Hjelp';

module.exports = async ({ app, quickAddApi, obsidian }) => {
  const file = app.workspace.getActiveFile();
  const editor = app.workspace.activeEditor?.editor;
  if (!file || file.extension !== 'md') {
    new obsidian.Notice('Åpne notatet du trenger hjelp med først.');
    return;
  }

  const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
  const fag = String(fm.fag || file.parent?.name || '').replace(/[[\]]/g, '').trim();

  // The nearest heading above the cursor, e.g. "Oppg 4.2.5".
  let heading = '';
  if (editor) {
    for (let line = editor.getCursor().line; line >= 0; line--) {
      const m = editor.getLine(line).match(/^#{2,4}\s+(.+)/);
      if (m) { heading = m[1].trim(); break; }
    }
  }

  const question = (await quickAddApi.inputPrompt(
    heading ? `Hjelp med ${heading}` : 'Hjelp',
    'Hva lurer du på? (kan stå tomt)'
  )) ?? null;
  if (question === null) return; // cancelled

  const stamp = window.moment().format('YYYY-MM-DD HHmm');
  const title = `${stamp} ${file.basename}${heading ? ' – ' + heading : ''}`.replace(/[\\/:*?"<>|#^[\]]/g, '-');
  const target = heading ? `[[${file.basename}#${heading}]]` : `[[${file.basename}]]`;

  if (!app.vault.getAbstractFileByPath(QUEUE)) await app.vault.createFolder(QUEUE);
  await app.vault.create(`${QUEUE}/${title}.md`, [
    '---',
    'type: hjelp',
    'status: venter',
    `fag: "${fag}"`,
    `notat: "${target}"`,
    `laget: ${window.moment().format('YYYY-MM-DDTHH:mm')}`,
    '---',
    `⏳ Venter på svar: ${target}`,
    '',
    '## Spørsmål',
    question.trim() || '(ingen tekst: forklar oppgaven og begrepet som trengs)',
    '',
    '## Svar',
    '',
  ].join('\n'));

  new obsidian.Notice('Lagt i hjelpekøen. Si «svar på hjelp» i en Claude-chat.');
};

  return module.exports;
})(),
  'lagnotat.js': (function () {
  const module = { exports: {} };
// QuickAdd script for "Lag notat": the selected text becomes its own note.
// The selection moves into a new note next to this one, and a link takes its place.
// Nothing selected: the current line is used.

async function shared() { return FELLES; }

module.exports = async ({ app, quickAddApi, obsidian }) => {
  const nb = await shared(app);
  const editor = app.workspace.activeEditor?.editor;
  const here = app.workspace.getActiveFile();
  if (!editor || !here) return new obsidian.Notice('Marker teksten i et notat først.');

  let text = editor.getSelection();
  let fromLine = null;
  let prefix = '';
  if (!text.trim()) {
    // The current line; a list bullet and a time like "- 07:49 " stay in front of the link.
    fromLine = editor.getCursor().line;
    const line = editor.getLine(fromLine);
    prefix = (line.match(/^\s*(?:[-*+]\s+)?(?:\d\d:\d\d\s+)?/) || [''])[0];
    text = line.slice(prefix.length);
  }
  text = text.trim();
  if (!text) return new obsidian.Notice('Marker teksten i et notat først.');

  // Suggest the first words as the name; you can change it.
  const guess = text.replace(/^[-*>#\s]+/, '').replace(/\[\[|\]\]/g, '').split(/\s+/).slice(0, 6).join(' ');
  const name = (await quickAddApi.inputPrompt('Navn på det nye notatet', guess, guess))?.trim();
  if (!name) return;

  // From the Tanker note, lifted-out ideas go to Ideer; from anywhere else, next to the note.
  const folder = here.path === '06_Tanker_og_Ideer/Tanker.md' ? '06_Tanker_og_Ideer/Ideer'
    : here.parent?.path && here.parent.path !== '/' ? here.parent.path : '00_Innboks';
  await nb.ensureFolder(app, folder);
  const safe = nb.safeName(name);
  const path = `${folder}/${safe}.md`;
  if (app.vault.getAbstractFileByPath(path)) return new obsidian.Notice(`"${safe}" finnes allerede. Velg et annet navn.`);
  await app.vault.create(path, `# ${name}\n\n${text}\n\nFra: [[${here.basename}]]\n`);

  const link = `[[${safe}]]`;
  if (fromLine !== null) editor.setLine(fromLine, prefix + link);
  else editor.replaceSelection(link);
  new obsidian.Notice(`Nytt notat: ${safe}`);
};

  return module.exports;
})(),
  'lenk.js': (function () {
  const module = { exports: {} };
// QuickAdd script for "Lenk": turn the selected word (or the word at the cursor) into a link.
// Shows the notes whose name or alias matches, plus "make a new note", one tap to link.

module.exports = async ({ app, quickAddApi, obsidian }) => {
  const editor = app.workspace.activeEditor?.editor;
  const here = app.workspace.getActiveFile();
  if (!editor || !here) return new obsidian.Notice('Trykk i et notat først.');

  let from = editor.getCursor('from');
  let to = editor.getCursor('to');
  let word = editor.getSelection();
  if (!word.trim()) {
    // The word under the cursor (letters, digits, æøå, hyphen).
    const line = editor.getLine(from.line);
    let a = from.ch, b = from.ch;
    while (a > 0 && /[\p{L}\p{N}-]/u.test(line[a - 1])) a--;
    while (b < line.length && /[\p{L}\p{N}-]/u.test(line[b])) b++;
    word = line.slice(a, b);
    from = { line: from.line, ch: a };
    to = { line: from.line, ch: b };
  }
  word = word.trim();
  if (!word) return new obsidian.Notice('Marker et ord først.');

  const q = word.toLowerCase();
  const hits = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith('Machine/') || f.path === here.path) continue;
    const aliases = [].concat(app.metadataCache.getFileCache(f)?.frontmatter?.aliases || []).map(String);
    const names = [f.basename, ...aliases].map((n) => n.toLowerCase());
    const score = names.some((n) => n === q) ? 0 : names.some((n) => n.startsWith(q) || q.startsWith(n)) ? 1 : names.some((n) => n.includes(q)) ? 2 : -1;
    if (score >= 0) hits.push({ f, score });
  }
  hits.sort((a, b) => a.score - b.score || a.f.basename.localeCompare(b.f.basename));
  const options = [
    ...hits.slice(0, 12).map(({ f }) => ({ label: `🔗 ${f.basename}   (${f.parent?.path || ''})`, file: f })),
    { label: `＋ Nytt notat «${word}»`, create: true },
  ];
  const pick = await quickAddApi.suggester(options.map((o) => o.label), options);
  if (!pick) return;

  const target = pick.file ? pick.file.basename : word;
  const link = target.toLowerCase() === q ? `[[${target}]]` : `[[${target}|${word}]]`;
  editor.replaceRange(link, from, to);
};

  return module.exports;
})(),
};

// Rask penn: fast wet-ink sheet over Excalidraw (raskpenn.js), off until switched on per device.
const RASK_PENN = (function () {
  const module = { exports: {} };
// Rask penn: Excalidraw with the Pencil on the iPad. Nothing to switch on: it wakes up the first time a Pencil
// touches a drawing on a device, and the mouse and phone are never touched.
// - Fingers in drawing mode (with Excalidraw's pen mode, the purple pen symbol): one finger moves the page, two move
//   and zoom; the palm is ignored while writing. Excalidraw skips both in drawing mode, so we do them.
// - Drawings open with the pen tool ready.
// - Fast ink (opt-in, command "Rask penn i Excalidraw (på/av)"): the line is drawn on our own see-through canvas and
//   handed to Excalidraw on pen-up as one freedraw element. Off by default: Excalidraw's own pen looks right.
// Bundled into the Skole-knapper plugin by bygg-knapper.js; the plugin calls setup(plugin).

// Test readout (command "Rask penn: testvisning"): a small box listing the touch signals the device sends.
let readout = null;
const lines = [];
function log(msg) {
  if (!readout) return;
  lines.push(msg);
  if (lines.length > 14) lines.shift();
  readout.textContent = lines.join('\n');
}

const KEY = 'skole-rask-penn';
const PEN_SEEN = 'skole-penn-sett';
// How far ahead (in ms) the ink is guessed from the pen's speed, to hide the web view's delay. 0 = off.
const PREDICT_MS = 25;

const get = (k) => {
  try { return localStorage.getItem(k); } catch (e) { return null; }
};
const put = (k, v) => {
  try { localStorage.setItem(k, v); } catch (e) {}
};
// The fast ink is opt-in: Excalidraw's own pen draws by default (the owner found that looks right every time),
// while finger moving and zooming always work. The command switches the fast ink on for this device.
const isOn = () => get(KEY) === 'på';
const setOn = (on) => put(KEY, on ? 'på' : 'av');
// Only on a device where a Pencil has been used, so touch-only devices keep Excalidraw as it is.
const penSeen = () => get(PEN_SEEN) === 'ja';

function sheet(host) {
  const c = document.createElement('canvas');
  c.className = 'skole-rask-penn';
  host.appendChild(c);
  return c;
}

// Pen mode on (fingers move the page, Excalidraw's own setting) and the pen tool ready.
function readyPen(view) {
  const api = view.excalidrawAPI;
  const st = api?.getAppState();
  if (!penSeen() || !st) return;
  if (!st.penMode) api.updateScene({ appState: { penMode: true, penDetected: true } });
  if (st.activeTool?.type === 'selection') api.setActiveTool?.({ type: 'freedraw' });
}

// One pair of sheets per Excalidraw drawing: "ink" holds the line so far, "tail" holds only the guessed bit ahead.
// Excalidraw can replace its drawing element (another file in the same tab), so we follow the element, not the tab.
function attach(view) {
  const host = view.contentEl.querySelector('.excalidraw');
  if (!host || host.raskPenn) return;
  view.raskPenn?.();
  host.raskPenn = true;
  const inkEl = sheet(host);
  const tailEl = sheet(host);
  const ink = inkEl.getContext('2d', { desynchronized: true });
  const tail = tailEl.getContext('2d', { desynchronized: true });

  const fit = () => {
    const r = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const [el, ctx] of [[inkEl, ink], [tailEl, tail]]) {
      el.width = Math.round(r.width * dpr);
      el.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  };
  const resize = new ResizeObserver(fit);
  resize.observe(host);
  fit();
  setTimeout(() => readyPen(view), 500);

  let stroke = null; // the pen line in progress
  let penDown = null; // pointerId of a pen line Excalidraw draws itself (fast ink off)
  const fingers = new Map(); // pointerId → screen point, for moving and zooming
  let pinch = null; // the zoom and the scene point under the fingers when the gesture (re)started

  const api = () => view.excalidrawAPI;
  const local = (e) => {
    const r = host.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toScene = (p, st) => [p[0] / st.zoom.value - st.scrollX, p[1] / st.zoom.value - st.scrollY];
  // Same thickness as Excalidraw's finished line (perfect-freehand): size × (1 − 2·thinning·(0.5 − pressure)).
  const width = (pressure) => {
    const p = stroke.look.constant ? 0.5 : pressure || 0.5;
    return Math.max(0.5, stroke.look.size * (1 - 2 * stroke.look.thinning * (0.5 - p)));
  };
  // Only the drawing itself; toolbars and menus keep working as normal.
  const onDrawing = (e) => e.target && e.target.tagName === 'CANVAS';
  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const clear = (ctx) => ctx.clearRect(0, 0, inkEl.width, inkEl.height);
  const segment = (ctx, a, b, w) => {
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  };
  const style = (ctx) => {
    ctx.strokeStyle = stroke.look.color;
    ctx.fillStyle = stroke.look.color;
    ctx.globalAlpha = stroke.look.opacity;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };

  // ---- Fingers: one moves the page, two move and zoom ----
  const midOf = () => {
    const pts = [...fingers.values()];
    const mid = pts.length > 1 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : pts[0];
    const dist = pts.length > 1 ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) : 0;
    return { mid, dist };
  };
  const startGesture = () => {
    const st = api().getAppState();
    const { mid, dist } = midOf();
    pinch = { zoom: st.zoom.value, dist, sceneMid: toScene(mid, st) };
  };
  const fingerDown = (e) => {
    swallow(e);
    host.setPointerCapture?.(e.pointerId);
    fingers.set(e.pointerId, local(e));
    log('vi: finger ' + fingers.size + ' tatt');
    startGesture();
  };
  const clampZoom = (z) => Math.min(30, Math.max(0.1, z));
  // Keep the scene point that was under the fingers under the fingers.
  const showAt = (zoom, mid) => {
    api().updateScene({
      appState: { zoom: { value: zoom }, scrollX: mid[0] / zoom - pinch.sceneMid[0], scrollY: mid[1] / zoom - pinch.sceneMid[1] },
    });
    if (fingers.size > 1 || gestureZoom != null) log('vi: zoom ' + zoom.toFixed(2) + ' → er nå ' + api().getAppState().zoom.value.toFixed(2));
  };
  const fingerMove = (e) => {
    swallow(e);
    fingers.set(e.pointerId, local(e));
    const { mid, dist } = midOf();
    // The iPad reports pinches as "gesture" events (below); use their zoom when there is one, else the finger distance.
    const zoom = gestureZoom ?? (fingers.size > 1 && pinch.dist > 0 ? clampZoom(pinch.zoom * dist / pinch.dist) : pinch.zoom);
    showAt(zoom, mid);
  };

  // ---- Pinch zoom from the iPad's gesture events ----
  // Excalidraw switches pinch zoom off in pen mode (against palm zooms), so with pen mode on we zoom here, in every tool.
  let gestureZoom = null;
  let lastScale = 1;
  const gestureStart = (e) => {
    if (!api()?.getAppState()?.penMode) return;
    swallow(e);
    lastScale = 1;
    gestureZoom = pinch ? pinch.zoom : null;
  };
  const gestureChange = (e) => {
    const st = api()?.getAppState();
    if (!st?.penMode) return;
    swallow(e);
    if (pinch) {
      // Our fingers (drawing mode): zoom from where the pinch started, the finger code places it.
      gestureZoom = clampZoom(pinch.zoom * e.scale);
      showAt(gestureZoom, midOf().mid);
      return;
    }
    // Other tools: Excalidraw moves the page, we only zoom around the middle of the pinch.
    const zoom = clampZoom(st.zoom.value * e.scale / lastScale);
    lastScale = e.scale;
    const c = local(e);
    const sc = toScene(c, st);
    api().updateScene({ appState: { zoom: { value: zoom }, scrollX: c[0] / zoom - sc[0], scrollY: c[1] / zoom - sc[1] } });
  };
  const gestureEnd = (e) => {
    if (gestureZoom == null && !api()?.getAppState()?.penMode) return;
    swallow(e);
    gestureZoom = null;
    if (pinch) startGesture();
  };
  const fingerUp = (e) => {
    swallow(e);
    fingers.delete(e.pointerId);
    if (fingers.size) startGesture();
    else pinch = null;
  };

  // Fingers move the page in drawing mode whenever Excalidraw's pen mode (the purple pen symbol) is on, with or without
  // the fast ink. Other tools (select, eraser, hand) already move the page with a finger in Excalidraw itself.
  const penMode = () => {
    const st = api()?.getAppState();
    return !!st?.penMode && st.activeTool?.type === 'freedraw';
  };

  const down = (e) => {
    if (!onDrawing(e)) return;
    if (e.pointerType === 'touch') {
      if (stroke || penDown != null) return swallow(e); // palm while writing: ignore
      if (penMode() && fingers.size < 2) fingerDown(e);
      return;
    }
    if (e.pointerType !== 'pen' || stroke) return;
    if (!penSeen()) {
      put(PEN_SEEN, 'ja');
      readyPen(view);
    }
    // Fast ink off: Excalidraw draws this line itself; we only note the pen is down, to ignore the palm.
    if (!isOn()) {
      penDown = e.pointerId;
      return;
    }
    const st = api()?.getAppState();
    if (!st || st.activeTool?.type !== 'freedraw') return;
    // Excalidraw never sees this pen stroke; we hand it the finished line on pen-up.
    swallow(e);
    host.setPointerCapture?.(e.pointerId);
    const p = local(e);
    stroke = {
      id: e.pointerId,
      st,
      points: [toScene(p, st)],
      pressures: [e.pressure || 0.5],
      last: p,
      kept: p,
      lastTime: e.timeStamp,
      speed: [0, 0],
      look: {
        color: st.currentItemStrokeColor,
        opacity: (st.currentItemOpacity ?? 100) / 100,
        // Excalidraw draws freedraw with perfect-freehand at 4.25 × strokeWidth, shaped by the chosen pen's options.
        size: (st.currentItemStrokeWidth || 1) * 4.25 * st.zoom.value,
        thinning: st.currentStrokeOptions?.options?.thinning ?? 0.6,
        constant: !!st.currentStrokeOptions?.constantPressure,
      },
    };
    style(ink);
    style(tail);
    ink.beginPath();
    ink.arc(p[0], p[1], width(e.pressure) / 2, 0, Math.PI * 2);
    ink.fill();
  };

  const move = (e) => {
    if (fingers.has(e.pointerId)) return fingerMove(e);
    if ((stroke || penDown != null) && e.pointerType === 'touch') return swallow(e);
    if (!stroke || e.pointerId !== stroke.id) return;
    swallow(e);
    // Coalesced events give every pen sample since the last frame, not just one.
    const samples = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    for (const s of samples.length ? samples : [e]) {
      const p = local(s);
      const dt = Math.max(1, s.timeStamp - stroke.lastTime);
      // Smoothed pen speed (px per ms), used to guess where the pen is going.
      stroke.speed = [0.6 * stroke.speed[0] + 0.4 * (p[0] - stroke.last[0]) / dt, 0.6 * stroke.speed[1] + 0.4 * (p[1] - stroke.last[1]) / dt];
      segment(ink, stroke.last, p, width(s.pressure));
      stroke.last = p;
      stroke.lastTime = s.timeStamp;
      // The saved line keeps a point every 2 screen pixels: the ink on screen uses all of them, but a drawing
      // with thousands of points per line gets heavy (Excalidraw's own pen keeps a few dozen).
      if (Math.hypot(p[0] - stroke.kept[0], p[1] - stroke.kept[1]) < 2) continue;
      stroke.kept = p;
      stroke.points.push(toScene(p, stroke.st));
      stroke.pressures.push(s.pressure || 0.5);
    }
    // The guessed bit ahead lives on its own sheet and is redrawn every time, so a wrong guess just disappears.
    clear(tail);
    if (PREDICT_MS > 0) {
      const ahead = [stroke.last[0] + stroke.speed[0] * PREDICT_MS, stroke.last[1] + stroke.speed[1] * PREDICT_MS];
      segment(tail, stroke.last, ahead, width(e.pressure));
    }
  };

  const up = async (e) => {
    if (fingers.has(e.pointerId)) return fingerUp(e);
    if (e.pointerId === penDown) penDown = null;
    if (!stroke || e.pointerId !== stroke.id) return;
    swallow(e);
    const done = stroke;
    stroke = null;
    // Always keep the very end of the line, even if it was closer than 2 px to the last kept point.
    if (done.kept !== done.last) {
      done.points.push(toScene(done.last, done.st));
      done.pressures.push(done.pressures[done.pressures.length - 1]);
    }
    clear(tail);
    let ok = false;
    try {
      ok = await handOver(view, done);
    } catch (err) {
      console.error('Rask penn', err);
    }
    if (!ok) return giveUp(view);
    clear(ink);
  };

  // Capture phase on the Excalidraw root, so we run before Excalidraw's own listeners.
  const opts = { capture: true, passive: false };
  const events = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up]];
  // iOS also sends touch and gesture events; hide them from Excalidraw while we move the page, so it doesn't zoom too.
  // preventDefault stops iOS's own pinch, which otherwise cancels our two fingers (pointercancel) before we can zoom.
  const touch = (e) => {
    if (!fingers.size && !stroke) return;
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };
  const touchEvents = ['touchstart', 'touchmove', 'touchend'];
  events.push(['gesturestart', gestureStart], ['gesturechange', gestureChange], ['gestureend', gestureEnd]);
  for (const [n, f] of events) host.addEventListener(n, f, opts);
  for (const n of touchEvents) host.addEventListener(n, touch, opts);

  view.raskPenn = () => {
    resize.disconnect();
    for (const [n, f] of events) host.removeEventListener(n, f, opts);
    for (const n of touchEvents) host.removeEventListener(n, touch, opts);
    inkEl.remove();
    tailEl.remove();
    delete host.raskPenn;
    delete view.raskPenn;
  };
}

// If Excalidraw did not take the line, never lose more than that one stroke: switch Rask penn off on this device
// (plain Excalidraw from the next stroke) and leave the wet ink on screen so the owner sees what to redraw.
function giveUp(view) {
  setOn(false);
  const { Notice } = require('obsidian');
  new Notice('Rask penn klarte ikke å lagre streken og er slått av. Tegn den siste streken på nytt.', 10000);
  setTimeout(() => view.raskPenn?.(), 4000);
}

// Give Excalidraw the finished line as one normal freedraw element. Returns true only if it is really in the drawing.
async function handOver(view, stroke) {
  const ea = window.ExcalidrawAutomate.getAPI(view);
  const st = stroke.st;
  ea.style.strokeColor = st.currentItemStrokeColor;
  ea.style.strokeWidth = st.currentItemStrokeWidth;
  ea.style.opacity = st.currentItemOpacity ?? 100;
  ea.style.roughness = st.currentItemRoughness ?? 0;
  ea.style.strokeStyle = 'solid';
  ea.style.backgroundColor = st.currentItemBackgroundColor ?? 'transparent';
  ea.style.fillStyle = st.currentItemFillStyle ?? 'solid';
  const pts = stroke.points.length > 1 ? stroke.points : [stroke.points[0], stroke.points[0]];
  const id = ea.addLine(pts);
  const el = ea.getElement(id);
  el.type = 'freedraw';
  el.pressures = stroke.pressures.length === pts.length ? stroke.pressures : pts.map(() => 0.5);
  el.simulatePressure = false;
  // The chosen Excalidraw pen (thin, fine tip, highlighter…) is stored on each line; without it the line is drawn fat.
  if (st.currentStrokeOptions) el.customData = { ...(el.customData || {}), strokeOptions: st.currentStrokeOptions };
  el.lastCommittedPoint = null;
  el.roundness = null;
  for (const k of ['startBinding', 'endBinding', 'startArrowhead', 'endArrowhead', 'polygon']) delete el[k];
  // Put the line in the frame it was drawn in, like Excalidraw's own pen does.
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const frame = view.excalidrawAPI.getSceneElements().filter((f) => f.type === 'frame' && !f.isDeleted
    && Math.min(...xs) >= f.x && Math.max(...xs) <= f.x + f.width
    && Math.min(...ys) >= f.y && Math.max(...ys) <= f.y + f.height).pop();
  if (frame) el.frameId = frame.id;
  // Last argument: let Excalidraw "restore" the element, which fills in anything a freedraw line needs.
  await ea.addElementsToView(false, false, true, true);
  ea.destroy?.();
  // Adding the line can drop the pen settings and change the width (seen in a real iPad drawing: width 2, no pen
  // settings → drawn fat). Put them back on the line in the drawing itself, exactly as Excalidraw's own pen saves them.
  const api = view.excalidrawAPI;
  const scene = api.getSceneElements();
  const added = scene.find((e) => e.id === id && e.type === 'freedraw' && !e.isDeleted);
  if (!added) return false;
  const width = st.currentItemStrokeWidth ?? added.strokeWidth;
  const options = st.currentStrokeOptions;
  if (added.strokeWidth !== width || (options && !added.customData?.strokeOptions)) {
    const fixed = {
      ...added,
      strokeWidth: width,
      customData: options ? { ...(added.customData || {}), strokeOptions: options } : added.customData,
      version: added.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
    api.updateScene({ elements: scene.map((e) => (e.id === id ? fixed : e)) });
  }
  return true;
}

module.exports = function setup(plugin) {
  const { Notice } = require('obsidian');
  const leaves = () => plugin.app.workspace.getLeavesOfType('excalidraw').filter((l) => l.view);
  // Only on devices where a Pencil has been used: a mouse-only PC gets nothing of ours on its drawings.
  // The switch below only turns the fast ink on/off; finger moving follows Excalidraw's pen mode.
  const refresh = () => penSeen() && leaves().forEach((l) => attach(l.view));

  plugin.addCommand({
    id: 'rask-penn',
    name: 'Rask penn i Excalidraw (på/av)',
    icon: 'pen-tool',
    callback: () => {
      setOn(!isOn());
      new Notice('Rask penn ' + (isOn() ? 'på' : 'av (Excalidraws egen penn)') + ' på denne enheten');
    },
  });
  plugin.app.workspace.onLayoutReady(refresh);
  plugin.registerEvent(plugin.app.workspace.on('layout-change', refresh));
  plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', () => setTimeout(refresh, 300)));
  // Safety net: Excalidraw can finish loading after the events above, so also attach on the first touch of a drawing.
  // Added to the window (runs first), so the drawing's own listeners are in place before the touch reaches them.
  plugin.registerDomEvent(window, 'pointerdown', (e) => {
    if (!penSeen() && e.pointerType !== 'pen') return;
    const host = e.target?.closest?.('.excalidraw');
    if (!host || host.raskPenn) return;
    const leaf = leaves().find((l) => l.view.contentEl.contains(host));
    if (leaf) attach(leaf.view);
  }, { capture: true });
  plugin.register(() => leaves().forEach((l) => l.view.raskPenn?.()));

  // Test readout: everything that reaches the window, before anyone (us or Excalidraw) handles it.
  plugin.addCommand({
    id: 'rask-penn-test',
    name: 'Rask penn: testvisning (på/av)',
    icon: 'bug',
    callback: () => {
      if (readout) {
        readout.remove();
        readout = null;
        return;
      }
      readout = document.body.createDiv({ cls: 'skole-rask-test' });
      lines.length = 0;
      const st = leaves()[0]?.view.excalidrawAPI?.getAppState();
      log('Testvisning på. Penn-modus: ' + (st ? st.penMode : '?') + ', verktøy: ' + (st ? st.activeTool?.type : '?'));
      log('Klyp med to fingre i tegningen, ta skjermbilde.');
    },
  });
  const spy = (name, describe) => plugin.registerDomEvent(window, name, (e) => readout && log(name + ' ' + describe(e)), { capture: true });
  spy('pointerdown', (e) => e.pointerType + ' på ' + (e.target?.tagName || '?'));
  spy('pointercancel', (e) => e.pointerType);
  spy('touchstart', (e) => e.touches.length + ' finger');
  spy('gesturestart', () => '');
  spy('gesturechange', (e) => 'skala ' + (e.scale ? e.scale.toFixed(2) : '?'));
  spy('gestureend', () => '');
};

  return module.exports;
})();

const BUTTONS = [
  {
    "name": "ny",
    "icon": "plus-circle",
    "label": "Ny…",
    "file": "ny.js",
    "where": [],
    "input": {}
  },
  {
    "name": "ny-tanke",
    "icon": "lightbulb",
    "label": "Ny tanke",
    "file": "ny.js",
    "where": [],
    "input": {
      "kind": "tanke"
    }
  },
  {
    "name": "ny-ide",
    "icon": "sparkles",
    "label": "Ny idé",
    "file": "ny.js",
    "where": [],
    "input": {
      "kind": "ide"
    }
  },
  {
    "name": "nytt-prosjekt",
    "icon": "folder-plus",
    "label": "Nytt prosjekt",
    "file": "ny.js",
    "where": [],
    "input": {
      "kind": "prosjekt"
    }
  },
  {
    "name": "ny-ai-chat",
    "icon": "bot",
    "label": "Ny AI-chat",
    "file": "ny.js",
    "where": [],
    "input": {
      "kind": "ai"
    }
  },
  {
    "name": "ny-time",
    "icon": "calendar-plus",
    "label": "Ny time",
    "file": "nytime.js",
    "where": [
      "note"
    ],
    "input": {}
  },
  {
    "name": "notatbok",
    "icon": "notebook-pen",
    "label": "Notatbok",
    "file": "notatbok.js",
    "where": [
      "note"
    ],
    "input": {}
  },
  {
    "name": "ny-side",
    "icon": "file-plus",
    "label": "Ny side",
    "file": "nyside.js",
    "where": [
      "notebook"
    ],
    "input": {}
  },
  {
    "name": "oppgave",
    "icon": "list-plus",
    "label": "Oppgave",
    "file": "oppgave.js",
    "where": [
      "note",
      "notebook"
    ],
    "input": {}
  },
  {
    "name": "hjelp",
    "icon": "help-circle",
    "label": "Hjelp",
    "file": "hjelp.js",
    "where": [
      "note",
      "notebook"
    ],
    "input": {}
  },
  {
    "name": "lag-notat",
    "icon": "file-output",
    "label": "Lag notat",
    "file": "lagnotat.js",
    "where": [],
    "input": {}
  },
  {
    "name": "lenk",
    "icon": "link",
    "label": "Lenk",
    "file": "lenk.js",
    "where": [],
    "input": {}
  }
];
const VIEWS = { markdown: 'note', 'goodobsidian-view': 'notebook', excalidraw: 'notebook' };
const PHONE_START = "Mobil-start.md";
const PHONE_TOOLBAR = ["ny-tanke","ny","lag-notat","lenk","hjelp"];
const PULL_DOWN = "ny";

module.exports = class SkoleKnapper extends Plugin {
  onload() {
    new Notice('Skole-knapper ' + VERSION + ' lastet');
    for (const b of BUTTONS) {
      this.addCommand({ id: b.name, name: b.label, icon: b.icon, callback: () => this.run(b.name) });
    }
    RASK_PENN(this);

    // ```knapper block in any note: one button name per line, e.g. "ny-tanke".
    this.registerMarkdownCodeBlockProcessor('knapper', (source, el) => {
      const row = el.createDiv({ cls: 'skole-knapper-rad' });
      for (const name of source.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const b = BUTTONS.find((x) => x.name === name);
        if (!b) continue;
        const btn = row.createEl('button', { cls: 'skole-stor-knapp' });
        setIcon(btn.createSpan({ cls: 'skole-stor-knapp-ikon' }), b.icon);
        btn.createSpan({ text: b.label });
        btn.addEventListener('click', () => this.run(b.name));
      }
    });

    this.app.workspace.onLayoutReady(() => {
      this.decorate();
      if (Platform.isPhone) this.phoneSetup();
    });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.decorate()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.decorate()));
    // A drawing made outside Obsidian (by the Machine) can arrive on a device before Excalidraw knows it,
    // and then opens as text. Switch any ".excalidraw.md" that opens as text to the drawing view.
    this.registerEvent(this.app.workspace.on('file-open', (file) => this.openAsDrawing(file)));
  }

  openAsDrawing(file) {
    if (!file || !file.path.endsWith('.excalidraw.md') || !this.app.plugins.plugins['obsidian-excalidraw-plugin']) return;
    const leaf = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.leaf;
    if (!leaf || leaf.view.file?.path !== file.path) return;
    leaf.setViewState({ type: 'excalidraw', state: { file: file.path } });
  }

  // Phone only: open the phone start page, and set the toolbar and swipe-down to our buttons.
  async phoneSetup() {
    try {
      const start = this.app.vault.getAbstractFileByPath(PHONE_START);
      if (start) await this.app.workspace.getLeaf(false).openFile(start);
      const toolbar = PHONE_TOOLBAR.map((n) => 'skole-knapper:' + n);
      const current = this.app.vault.getConfig?.('mobileToolbarCommands') || [];
      if (JSON.stringify(current.slice(0, toolbar.length)) !== JSON.stringify(toolbar)) {
        this.app.vault.setConfig?.('mobileToolbarCommands', [...toolbar, ...current.filter((c) => !toolbar.includes(c))]);
      }
      if (this.app.vault.getConfig?.('mobilePullAction') !== 'skole-knapper:' + PULL_DOWN) {
        this.app.vault.setConfig?.('mobilePullAction', 'skole-knapper:' + PULL_DOWN);
      }
    } catch (e) {
      console.warn('Skole-knapper phone setup', e);
    }
  }

  async run(name) {
    const b = BUTTONS.find((x) => x.name === name);
    try {
      const quickAddApi = this.app.plugins.plugins.quickadd?.api;
      if (!quickAddApi) return new Notice('QuickAdd må være på for knappene.');
      await SCRIPTS[b.file]({ app: this.app, quickAddApi, obsidian, ...b.input });
    } catch (e) {
      console.error('Skole-knapper', name, e);
      new Notice('Knappen "' + (b ? b.label : name) + '" feilet: ' + (e && e.message ? e.message : e));
    }
  }

  decorate() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      const kind = view && VIEWS[view.getViewType()];
      if (!kind || !view.addAction || view.skoleKnapper) return;
      view.skoleKnapper = true;
      // On the phone the top bar is too narrow; the toolbar and the start page have the buttons.
      if (Platform.isPhone) return;
      // Drawings: the buttons float inside the drawing (bottom right), not in Obsidian's top bar.
      if (view.getViewType() === 'excalidraw') return this.floatingButtons(view, kind);
      // addAction puts each new button leftmost, so add them in reverse to keep the order.
      for (const b of BUTTONS.filter((b) => b.where.includes(kind)).reverse()) {
        const el = view.addAction(b.icon, b.label, () => {
          this.app.workspace.setActiveLeaf(leaf, { focus: true });
          this.run(b.name);
        });
        el.addClass('skole-knapp');
        el.createSpan({ cls: 'skole-knapp-tekst', text: b.label });
      }
    });
  }

  // Round buttons floating over the drawing. They sit outside Excalidraw's canvas, so they never draw or move the page.
  floatingButtons(view, kind) {
    const bar = view.contentEl.createDiv({ cls: 'skole-flyt' });
    for (const b of BUTTONS.filter((b) => b.where.includes(kind))) {
      const btn = bar.createEl('button', { cls: 'skole-flyt-knapp' + (b.name === 'oppgave' ? ' skole-flyt-hoved' : '') });
      setIcon(btn.createSpan({ cls: 'skole-flyt-ikon' }), b.icon);
      btn.createSpan({ text: b.label });
      btn.addEventListener('click', () => {
        this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
        this.run(b.name);
      });
    }
    this.pageBar(view, bar);
    this.register(() => bar.remove());
  }

  // "◀ Side 2/3 ▶": the "Side N" page frames in this drawing, top to bottom. Hidden when there are none.
  pageBar(view, bar) {
    const row = bar.createDiv({ cls: 'skole-sidelinje' });
    const prev = row.createEl('button', { cls: 'skole-flyt-knapp', text: '◀' });
    const label = row.createSpan({ cls: 'skole-sidelinje-tekst' });
    const next = row.createEl('button', { cls: 'skole-flyt-knapp', text: '▶' });
    const pages = () => (view.excalidrawAPI?.getSceneElements() || [])
      .filter((e) => e.type === 'frame' && !e.isDeleted && /^Side \d+/.test(e.name || ''))
      .sort((a, b) => a.y - b.y);
    // The page whose middle is closest to the middle of the screen.
    const current = (list) => {
      const st = view.excalidrawAPI.getAppState();
      const cx = st.width / 2 / st.zoom.value - st.scrollX;
      const cy = st.height / 2 / st.zoom.value - st.scrollY;
      let best = 0;
      list.forEach((p, i) => {
        const d = Math.hypot(p.x + p.width / 2 - cx, p.y + p.height / 2 - cy);
        const b = list[best];
        if (d < Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy)) best = i;
      });
      return best;
    };
    const go = (step) => {
      const list = pages();
      if (!list.length) return;
      const i = Math.min(list.length - 1, Math.max(0, current(list) + step));
      view.excalidrawAPI.scrollToContent(list[i], { fitToContent: true, animate: true });
    };
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    const update = () => {
      const list = view.excalidrawAPI ? pages() : [];
      row.toggleClass('skole-skjult', !list.length);
      if (list.length) label.setText('Side ' + (current(list) + 1) + ' / ' + list.length);
    };
    update();
    this.registerInterval(window.setInterval(update, 1000));
  }
};
