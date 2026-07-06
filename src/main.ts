import {
	App,
	Component,
	Editor,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	SuggestModal,
	TAbstractFile,
	TFile,
	setIcon,
} from 'obsidian';
import { EditorState, Prec } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { EmbeddedEditor, ExitInfo, createEmbeddedEditor } from './editor';
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
} from './settings';

// portal fences open one shared markdown file wherever they are embedded

const PORTAL_FOLDER = 'portals';
const FENCE = (id: string) => '```portal\n' + id + '\n```';

// only settings are saved here since portal content lives in markdown files

interface PluginData {
	version: 2;
	settings: MyPluginSettings;
}

// each rendered block either opens its file or waits until that file exists

class PortalEmbed extends MarkdownRenderChild {
	private editor: EmbeddedEditor | null = null;
	private file: TFile | null = null;
	private dirty = false;
	private saveTimer: number | null = null;
	// our saves also fire modify events, so count the ones to ignore
	private expecting = 0;

	constructor(
		containerEl: HTMLElement,
		private plugin: PortalPlugin,
		private id: string,
		private ctx: MarkdownPostProcessorContext,
	) {
		super(containerEl);
		this.app = plugin.app;
	}

	private app: App;

	onload() {
		this.plugin.embeds.add(this);

		const file = this.plugin.backingFile(this.id);
		if (file) {
			void this.mountEditor(file);
			return;
		}

		this.renderMissing();
		// listen for the missing file so this block can turn into an editor
		this.registerEvent(
			this.app.vault.on('create', f => {
				if (this.file) return;
				if (!(f instanceof TFile)) return;
				if (f.path !== this.plugin.backingPath(this.id)) return;
				this.containerEl.empty();
				void this.mountEditor(f);
			}),
		);
	}

	private renderMissing() {
		this.containerEl.createDiv({ cls: 'portal-error' }, div => {
			div.createSpan({ text: 'Portal ' });
			div.createEl('code', { text: this.id || '(unnamed)' });
			div.createSpan({ text: ' has no backing file. ' });
			if (this.id && /^[\w-]+$/.test(this.id)) {
				const a = div.createEl('a', { text: 'Create it' });
				a.addEventListener('click', () => {
					// creating the file lets the create listener handle the redraw
					void this.plugin.createBackingFile(this.id, '');
				});
			}
		});
	}

	private async mountEditor(file: TFile) {
		this.file = file;
		this.containerEl.addClass('portal-embed');

		const content = await this.app.vault.cachedRead(file);

		this.editor = createEmbeddedEditor(this.app, this.containerEl, {
			value: content,
			onChange: () => this.scheduleSave(),
			onExit: (dir, info) => this.exitTo(dir, info),
		});

		// use our own button so raw fences only show when deliberately opened
		const btn = this.containerEl.createDiv({
			cls: 'portal-edit-button',
			attr: { 'aria-label': 'Edit block' },
		});
		setIcon(btn, 'code-2');
		btn.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.revealSource();
		});

		if (!this.editor) {
			// fall back to opening the file if an embedded editor cannot be made
			this.containerEl.createDiv({ cls: 'portal-error' }, div => {
				div.createSpan({
					text: 'Portal could not embed an editor in this Obsidian version. ',
				});
				const a = div.createEl('a', { text: `Open ${file.basename}` });
				a.addEventListener('click', () => {
					void this.app.workspace.getLeaf('tab').openFile(file);
				});
			});
			return;
		}

		this.addChild(this.editor as unknown as Component);

		// reload outside changes unless this editor is the one being edited
		this.registerEvent(
			this.app.vault.on('modify', f => {
				if (!this.file || f.path !== this.file.path) return;
				if (this.expecting > 0) {
					this.expecting--;
					return;
				}
				void this.refreshFromDisk();
			}),
		);
	}

	private scheduleSave() {
		this.dirty = true;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 400);
	}

	private async save() {
		if (!this.editor || !this.file || !this.dirty) return;
		this.dirty = false;
		const value = this.editor.value;
		const current = await this.app.vault.cachedRead(this.file);
		if (current === value) return;
		this.expecting++;
		await this.app.vault.process(this.file, () => value);
	}

	private async refreshFromDisk() {
		if (!this.editor || !this.file) return;
		const content = await this.app.vault.cachedRead(this.file);
		if (this.editor.hasFocus()) return; // leave focused edits alone
		if (this.editor.value !== content) this.editor.setContent(content);
	}

	// send the cursor back to the note either on the fence or past it
	private exitTo(dir: 'up' | 'down', info: ExitInfo) {
		const view = this.hostView();
		if (!view) return;
		const editor = view.editor;
		const section = this.ctx.getSectionInfo(this.containerEl);
		if (!section) return;

		let line: number;
		let ch: number;
		if (info.revealFence) {
			line = dir === 'up' ? Math.max(0, section.lineStart) : Math.min(editor.lastLine(), section.lineEnd);
			ch = dir === 'up' ? 0 : editor.getLine(line).length;
		} else {
			line = dir === 'up' ? section.lineStart - 1 : section.lineEnd + 1;
			if (line < 0 || line > editor.lastLine()) return; // stay put at the edge of the note
			ch = Math.min(info.column, editor.getLine(line).length);
		}

		editor.focus();
		this.app.workspace.activeEditor = view;
		editor.setCursor({ line, ch });
	}

	// find the markdown view that owns this block
	private hostView(): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(this.containerEl)) {
				return view;
			}
		}
		return null;
	}

	// return this block's fence lines for the given host editor
	rangeIn(cmView: EditorView): { start: number; end: number } | null {
		const view = this.hostView();
		if (!view) return null;
		const hostCm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (hostCm !== cmView) return null;
		const section = this.ctx.getSectionInfo(this.containerEl);
		return section ? { start: section.lineStart, end: section.lineEnd } : null;
	}

	// return this block's fence lines while codemirror is filtering a change
	rangeInState(state: EditorState): { start: number; end: number } | null {
		const view = this.hostView();
		if (!view) return null;
		const hostCm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (!hostCm || hostCm.state !== state) return null;
		const section = this.ctx.getSectionInfo(this.containerEl);
		return section ? { start: section.lineStart, end: section.lineEnd } : null;
	}

	// focus the first or last editable line inside this block
	focusEdge(edge: 'start' | 'end', column: number) {
		this.editor?.focusAt(edge, column);
	}

	// return this portal's command target when focus is inside it
	ownerIfContains(node: Node): unknown | null {
		return this.editor?.ownerIfContains(node) ?? null;
	}

	// put the note cursor on the fence so the raw block appears
	revealSource() {
		const view = this.hostView();
		const section = this.ctx.getSectionInfo(this.containerEl);
		if (!view || !section) return;
		this.plugin.allowReveal = true;
		try {
			view.editor.focus();
			this.app.workspace.activeEditor = view;
			view.editor.setCursor({ line: section.lineStart, ch: 0 });
		} finally {
			this.plugin.allowReveal = false;
		}
	}

	onunload() {
		this.plugin.embeds.delete(this);
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		// save any pending text before the block is removed
		if (this.dirty && this.editor && this.file) {
			const file = this.file;
			const value = this.editor.value;
			void this.app.vault.process(file, () => value);
		}
	}
}

// helpers for turning selected note text into a portal

const LIST_LINE_RE = /^(\s*)([-*+])\s+(?:\[[ xX]\]\s+)?/;

function indentWidth(line: string): number {
	const ws = line.match(/^\s*/)?.[0] ?? '';
	let w = 0;
	for (const ch of ws) w += ch === '\t' ? 4 : 1;
	return w;
}

interface CaptureRange {
	fromLine: number;
	toLine: number;
	text: string;
}

function getCaptureRange(editor: Editor): CaptureRange | null {
	let fromLine: number;
	let toLine: number;

	const sel = editor.listSelections()[0];
	if (sel && editor.somethingSelected()) {
		fromLine = Math.min(sel.anchor.line, sel.head.line);
		toLine = Math.max(sel.anchor.line, sel.head.line);
		const end = sel.anchor.line > sel.head.line ? sel.anchor : sel.head;
		if (toLine > fromLine && end.ch === 0) toLine--;
	} else {
		fromLine = toLine = editor.getCursor().line;
	}

	// include child list items when capturing a parent item
	if (LIST_LINE_RE.test(editor.getLine(toLine))) {
		const base = indentWidth(editor.getLine(toLine));
		while (toLine + 1 <= editor.lastLine()) {
			const next = editor.getLine(toLine + 1);
			if (!LIST_LINE_RE.test(next) || indentWidth(next) <= base) break;
			toLine++;
		}
	}

	const rows: string[] = [];
	for (let l = fromLine; l <= toLine; l++) rows.push(editor.getLine(l));
	const text = rows.join('\n');

	if (text.trim() === '') return null;
	if (text.includes('```')) return null; // skip text that already contains a fence
	return { fromLine, toLine, text };
}

function slugify(text: string): string {
	return text
		.replace(/^[\s\-*+[\]xX]+/, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
}

// plugin wiring for commands, menus, and portal rendering

export default class PortalPlugin extends Plugin {
	settings!: MyPluginSettings;
	// keep mounted blocks around so keyboard movement can find them
	readonly embeds = new Set<PortalEmbed>();
	// allow the source reveal path to place the cursor inside the fence
	allowReveal = false;

	async onload() {
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings);

		this.addSettingTab(new SampleSettingTab(this.app, this));

		// make command targeting follow the real focused editor instead of stale state
		this.installActiveEditorGetter();

		// let arrow keys move into a portal when the next line is its fence
		this.registerEditorExtension(
			Prec.high(
				keymap.of([
					{ key: 'ArrowDown', run: cm => this.arrowInto(cm, 'down') },
					{ key: 'ArrowUp', run: cm => this.arrowInto(cm, 'up') },
				]),
			),
		);

		// keep accidental cursor moves out of hidden portal fences
		this.registerEditorExtension(
			EditorState.transactionFilter.of(tr => {
				if (this.allowReveal || tr.docChanged || !tr.selection) return tr;
				const next = tr.newSelection.main;
				if (!next.empty) return tr; // let selections behave normally

				const nextLine = tr.newDoc.lineAt(next.head).number - 1;
				const prevHead = tr.startState.selection.main.head;
				const prevLine = tr.startState.doc.lineAt(prevHead).number - 1;

				for (const embed of this.embeds) {
					const range = embed.rangeInState(tr.startState);
					if (!range) continue;
					if (nextLine < range.start || nextLine > range.end) continue;
					if (prevLine >= range.start && prevLine <= range.end) return tr; // allow editing once the fence is already shown

					const edge = prevLine < range.start ? 'start' : 'end';
					queueMicrotask(() =>
						embed.focusEdge(edge, edge === 'start' ? 0 : Number.MAX_SAFE_INTEGER),
					);
					return []; // block the move into the hidden fence
				}
				return tr;
			}),
		);

		// render portal fences as embedded editors
		this.registerMarkdownCodeBlockProcessor('portal', (source, el, ctx) => {
			ctx.addChild(new PortalEmbed(el, this, source.trim(), ctx));
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				menu.addItem(item =>
					item
						.setTitle('Create portal')
						.setIcon('list-plus')
						.onClick(() => this.createFromEditor(editor)),
				);
				if (this.listIds().length > 0) {
					menu.addItem(item =>
						item
							.setTitle('Insert portal')
							.setIcon('list-plus')
							.onClick(() => this.insertIntoEditor(editor)),
					);
					menu.addItem(item =>
						item
							.setTitle('Insert most recent portal')
							.setIcon('history')
							.onClick(() => this.insertMostRecentIntoEditor(editor)),
					);
				}
			}),
		);

		this.addCommand({
			id: 'create',
			name: 'Create portal',
			editorCallback: (editor: Editor) => this.createFromEditor(editor),
		});
		this.addCommand({
			id: 'insert',
			name: 'Insert portal',
			editorCallback: (editor: Editor) => this.insertIntoEditor(editor),
		});
		this.addCommand({
			id: 'insert-most-recent',
			name: 'Insert most recent portal',
			editorCallback: (editor: Editor) => this.insertMostRecentIntoEditor(editor),
		});
	}

	// persistence helpers

	// resolve the active editor from dom focus when commands ask for it
	private installActiveEditorGetter() {
		const ws = this.app.workspace as unknown as Record<string, unknown>;
		let stored: unknown = ws['activeEditor'] ?? null;
		const embeds = this.embeds;

		Object.defineProperty(ws, 'activeEditor', {
			configurable: true,
			get() {
				const focused = document.activeElement;
				if (focused) {
					for (const embed of embeds) {
						const owner = embed.ownerIfContains(focused);
						if (owner) return owner;
					}
				}
				return stored;
			},
			set(v: unknown) {
				stored = v;
			},
		});

		// restore the normal property shape when unloading
		this.register(() => {
			delete ws['activeEditor'];
			ws['activeEditor'] = stored;
		});
	}

	// enter a portal when the next arrow-key move would hit its fence
	private arrowInto(cmView: EditorView, dir: 'up' | 'down'): boolean {
		const sel = cmView.state.selection.main;
		if (!sel.empty) return false;
		const line = cmView.state.doc.lineAt(sel.head);
		// convert codemirror's line number to the target note line
		const target = dir === 'down' ? line.number : line.number - 2;
		const column = sel.head - line.from;

		for (const embed of this.embeds) {
			const range = embed.rangeIn(cmView);
			if (!range) continue;
			if (target >= range.start && target <= range.end) {
				embed.focusEdge(dir === 'down' ? 'start' : 'end', column);
				return true;
			}
		}
		return false;
	}

	async saveAll() {
		const data: PluginData = { version: 2, settings: this.settings };
		await this.saveData(data);
	}

	// keep the settings tab call working
	async saveSettings() {
		await this.saveAll();
	}

	// backing file helpers

	backingPath(id: string): string {
		return `${PORTAL_FOLDER}/${id}.md`;
	}

	backingFile(id: string): TFile | null {
		if (!/^[\w-]+$/.test(id)) return null;
		const af: TAbstractFile | null = this.app.vault.getAbstractFileByPath(this.backingPath(id));
		return af instanceof TFile ? af : null;
	}

	async createBackingFile(id: string, content: string): Promise<TFile> {
		if (!this.app.vault.getAbstractFileByPath(PORTAL_FOLDER)) {
			await this.app.vault.createFolder(PORTAL_FOLDER);
		}
		return this.app.vault.create(this.backingPath(id), content);
	}

	private listIds(): string[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter(f => f.path.startsWith(PORTAL_FOLDER + '/'))
			.map(f => f.basename)
			.sort();
	}

	// commands for making and inserting portals

	private createFromEditor(editor: Editor) {
		const range = getCaptureRange(editor);
		const text = range?.text ?? '';
		const firstLine = text.split('\n').find(l => l.trim() !== '') ?? '';
		const suggested = this.uniqueId(slugify(firstLine) || 'portal');

		new NameModal(this.app, suggested, async id => {
			if (this.backingFile(id)) {
				new Notice(`A portal named "${id}" already exists.`);
				return;
			}
			await this.createBackingFile(id, text);
			if (range) {
				editor.replaceRange(
					FENCE(id),
					{ line: range.fromLine, ch: 0 },
					{ line: range.toLine, ch: editor.getLine(range.toLine).length },
				);
			} else {
				this.insertFenceAtCursor(editor, id);
			}
			new Notice(`Portal "${id}" created.`);
		}).open();
	}

	private insertIntoEditor(editor: Editor) {
		const ids = this.listIds();
		if (ids.length === 0) {
			new Notice('No portals yet. Create one first.');
			return;
		}
		new PickModal(this.app, ids, id => this.insertFenceAtCursor(editor, id)).open();
	}

	private insertMostRecentIntoEditor(editor: Editor) {
		const recent = this.mostRecentId();
		if (!recent) {
			new Notice('No portals yet. Create one first.');
			return;
		}
		this.insertFenceAtCursor(editor, recent);
	}

	private insertFenceAtCursor(editor: Editor, id: string) {
		const cursor = editor.getCursor();
		const lineText = editor.getLine(cursor.line);
		const prefix = lineText.trim() === '' ? '' : '\n';
		editor.replaceRange(`${prefix}${FENCE(id)}\n`, {
			line: cursor.line,
			ch: lineText.length,
		});
	}

	private mostRecentId(): string | null {
		const file = this.app.vault
			.getMarkdownFiles()
			.filter(f => f.path.startsWith(PORTAL_FOLDER + '/'))
			.sort((a, b) => b.stat.mtime - a.stat.mtime)[0];
		return file?.basename ?? null;
	}

	private uniqueId(base: string): string {
		if (!this.backingFile(base)) return base;
		for (let n = 2; ; n++) {
			const candidate = `${base}-${n}`;
			if (!this.backingFile(candidate)) return candidate;
		}
	}
}

// small modals for naming and picking portals

class NameModal extends Modal {
	private input!: HTMLInputElement;

	constructor(
		app: App,
		private suggested: string,
		private onSubmit: (id: string) => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle('Name this portal');
		const { contentEl } = this;

		contentEl.createEl('p', {
			text: 'This ID is how you insert the portal into other notes.',
			cls: 'portal-modal-hint',
		});

		this.input = contentEl.createEl('input', {
			type: 'text',
			cls: 'portal-modal-input',
			value: this.suggested,
		});
		this.input.addEventListener('keydown', e => {
			if (e.key === 'Enter') this.submit();
		});

		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		buttons
			.createEl('button', { text: 'Create', cls: 'mod-cta' })
			.addEventListener('click', () => this.submit());

		window.setTimeout(() => {
			this.input.focus();
			this.input.select();
		}, 0);
	}

	private submit() {
		const id = this.input.value.trim();
		if (!id) {
			new Notice('Enter an ID.');
			return;
		}
		if (!/^[\w-]+$/.test(id)) {
			new Notice('IDs can contain letters, numbers, hyphens and underscores.');
			return;
		}
		this.close();
		this.onSubmit(id);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class PickModal extends SuggestModal<string> {
	constructor(
		app: App,
		private ids: string[],
		private onPick: (id: string) => void,
	) {
		super(app);
		this.setPlaceholder('Search portals...');
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		return this.ids.filter(id => id.toLowerCase().includes(q));
	}

	renderSuggestion(id: string, el: HTMLElement) {
		el.createDiv({ text: id, cls: 'portal-pick-id' });
	}

	onChooseSuggestion(id: string) {
		this.onPick(id);
	}
}