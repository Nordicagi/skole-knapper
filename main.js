// Skole-knapper: buttons at the top of notes and notebooks, buttons inside notes (```knapper blocks),
// and commands for the iPad/phone toolbar and hotkeys. BUILT FILE: edit the scripts in Machine/Skript
// and run "node Machine/Skript/bygg-knapper.js" instead of editing this.
const obsidian = require('obsidian');
const { Plugin, Notice, Platform, setIcon } = obsidian;

const VERSION = '1.9.3';

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

// The subject of the note or notebook you're in; asks with a tap list if it can't tell.
async function subjectHere(app, quickAddApi) {
  const file = app.workspace.getActiveFile();
  if (file) {
    const bySubjectFolder = subjectOfPath(file.path);
    if (bySubjectFolder) return bySubjectFolder;
    const fag = String(app.metadataCache.getFileCache(file)?.frontmatter?.fag || '');
    const byFag = SUBJECTS.find((s) => fag.includes(s.label) || fag.includes(s.folder.split('/').pop().replace(/^[\d.]+_/, '')));
    if (byFag) return byFag;
  }
  return quickAddApi.suggester(SUBJECTS.map((s) => s.label), SUBJECTS);
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

// Add a named frame under everything already in the drawing; returns its id.
async function addFrame(leaf, name, size) {
  const api = ea();
  api.reset();
  api.setView(leaf.view);
  const all = api.getViewElements().filter((e) => !e.isDeleted);
  const top = all.length ? Math.max(...all.map((e) => e.y + (e.height || 0))) + 80 : 0;
  const id = api.addFrame(0, top, size.w, size.h, name);
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
  prosjekt: '90_Prosjekter_og_Oppgaver',
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

module.exports = async ({ app, quickAddApi, obsidian }) => {
  const nb = await shared(app);
  const subject = await nb.subjectHere(app, quickAddApi);
  if (!subject) return;

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
    await nb.addFrame(leaf, `Side ${n} · ${now.format('DD.MM')}`, nb.PAGE);
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

// "4.1.1b" -> { base: "4.1.1", letter: "b" }
const split = (num) => {
  const m = String(num).match(/^(\d+(?:\.\d+)*)\s*([a-z])?$/i);
  return m ? { base: m[1], letter: (m[2] || '').toLowerCase() } : { base: String(num), letter: '' };
};
const LETTERS = 'abcdefgh'.split('');

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
      for (const m of text.matchAll(/^###\s+Oppg\s+(\d+(?:\.\d+)*\s*[a-z]?)\b/gim)) done.push(m[1].replace(/\s+/g, ''));
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

  let pick;
  for (;;) {
    const options = [];
    if (lastPart?.letter) {
      const nextLetter = LETTERS[LETTERS.indexOf(lastPart.letter) + 1];
      if (nextLetter) options.push({ label: `Neste del: ${lastPart.base} ${nextLetter}`, num: lastPart.base + nextLetter });
    }
    if (last) options.push({ label: `Neste: ${nextOf(lastPart.base)}   (etter ${last})`, num: nextOf(lastPart.base) });
    if (last) options.push({ label: `Del av ${lastPart.base} (a, b, c …)`, ask: 'letter' });
    options.push({ label: 'Velg med trykk (kapittel → del → nummer)', ask: 'pick' });
    options.push({ label: 'Skriv nummer …', ask: 'number' });
    options.push({ label: 'Egen oppgave (ikke fra boka) …', ask: 'own' });
    if (!inNotebook && !inDrawing) options.push({ label: `Tegne i ${tool}  (bytt til ${tool === 'FineNotes' ? 'Excalidraw' : 'FineNotes'})`, toggle: true });
    pick = await quickAddApi.suggester(options.map((o) => o.label), options);
    if (!pick) return;
    if (!pick.toggle) break;
    tool = tool === 'FineNotes' ? 'Excalidraw' : 'FineNotes';
    try { localStorage.setItem('oppgave-tool', tool); } catch (e) {}
  }

  let num = pick.num || null;
  let title = null;
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
  const chapter = num ? parts(split(num).base)[0] : await (async (items) => quickAddApi.suggester(items.map((x) => `Kapittel ${x}`), items))(Array.from({ length: 15 }, (_, i) => i + 1));

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
    editor.replaceSelection(`\n### ${title}\nLes: \n![[${pageLink}]]\n\n`);
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
// Rask penn: a fast pen for Excalidraw on the iPad (experiment). Nothing to switch on: it wakes up the first time
// a Pencil touches a drawing on a device, and the mouse and phone are never touched.
// - Pencil with Excalidraw's pen tool: the line is drawn only on our own see-through canvas, so Excalidraw is not
//   repainted for every point. When the pen lifts, Excalidraw gets the finished line once, as a normal freedraw
//   element (undo, frames, saving and Sync keep working).
// - Fingers on the drawing: one finger moves the page, two fingers move and zoom. Fingers never draw, and the palm
//   is ignored while writing. (Excalidraw's own pen-mode panning never woke up, because it never sees our Pencil.)
// - Drawings open with the pen tool ready.
// The command "Rask penn i Excalidraw (på/av)" turns the fast ink off on this device (Excalidraw's own pen draws);
// finger moving then still works whenever Excalidraw's pen mode (purple pen symbol) is on.
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
const isOn = () => get(KEY) !== 'av';
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
  const width = (pressure) => stroke.look.size * (0.4 + 0.9 * (pressure || 0.5));
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
      lastTime: e.timeStamp,
      speed: [0, 0],
      look: {
        color: st.currentItemStrokeColor,
        opacity: (st.currentItemOpacity ?? 100) / 100,
        // Excalidraw draws freedraw with perfect-freehand at about 4.25 × strokeWidth; this is close enough for wet ink.
        size: (st.currentItemStrokeWidth || 1) * 2.1 * st.zoom.value,
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
  ea.style.backgroundColor = 'transparent';
  const pts = stroke.points.length > 1 ? stroke.points : [stroke.points[0], stroke.points[0]];
  const id = ea.addLine(pts);
  const el = ea.getElement(id);
  el.type = 'freedraw';
  el.pressures = stroke.pressures.length === pts.length ? stroke.pressures : pts.map(() => 0.5);
  el.simulatePressure = false;
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
  return view.excalidrawAPI.getSceneElements().some((e) => e.id === id && e.type === 'freedraw' && !e.isDeleted);
}

module.exports = function setup(plugin) {
  const { Notice } = require('obsidian');
  const leaves = () => plugin.app.workspace.getLeavesOfType('excalidraw').filter((l) => l.view);
  // Always attached: the switch below only turns the fast ink on/off; finger moving follows Excalidraw's pen mode.
  const refresh = () => leaves().forEach((l) => attach(l.view));

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
};
