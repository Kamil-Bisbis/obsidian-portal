import { App, Component } from 'obsidian';

// builds a real obsidian editor inside a portal container

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = Record<string, any>;

export interface EmbeddedEditor extends Component {
	readonly value: string;
	setContent(content: string): void;
	hasFocus(): boolean;
	// focus one edge of the embedded editor while keeping the column
	focusAt(edge: 'start' | 'end', column: number): void;
	// return the command owner only when focus is inside this editor
	ownerIfContains(node: Node): unknown | null;
}

export interface ExitInfo {
	// reveal the fence instead of jumping past it
	revealFence: boolean;
	// keep the same horizontal position when leaving
	column: number;
}

export interface EmbeddedEditorOptions {
	value: string;
	onChange: () => void;
	// notify the host when the cursor leaves through a boundary
	onExit?: (direction: 'up' | 'down', info: ExitInfo) => void;
}

// tiny wrapper for temporarily patching one method
function around(
	obj: AnyObj,
	key: string,
	factory: (next: (...args: any[]) => any) => (...args: any[]) => any,
): () => void {
	const original = obj[key];
	obj[key] = factory(original);
	return () => {
		obj[key] = original;
	};
}

// find obsidian's markdown editor class by making a temporary editor
function resolveEditorPrototype(app: App): AnyObj | null {
	try {
		const registry = (app as unknown as AnyObj).embedRegistry;
		const widget = registry.embedByExtension.md(
			{ app, containerEl: document.createElement('div') },
			null,
			'',
		);
		widget.editable = true;
		widget.showEditor();
		const proto = Object.getPrototypeOf(Object.getPrototypeOf(widget.editMode));
		widget.unload();
		return proto.constructor as AnyObj;
	} catch (e) {
		console.error('[Portal] Could not resolve Obsidian editor internals:', e);
		return null;
	}
}

let EditorClass: AnyObj | null | undefined;

export function createEmbeddedEditor(
	app: App,
	container: HTMLElement,
	options: EmbeddedEditorOptions,
): EmbeddedEditor | null {
	if (EditorClass === undefined) {
		const Base = resolveEditorPrototype(app);
		EditorClass = Base === null ? null : buildEditorClass(Base);
	}
	if (EditorClass === null) return null;
	try {
		return new (EditorClass as new (
			app: App,
			container: HTMLElement,
			options: EmbeddedEditorOptions,
		) => EmbeddedEditor)(app, container, options);
	} catch (e) {
		console.error('[Portal] Could not construct embedded editor:', e);
		return null;
	}
}

function buildEditorClass(Base: AnyObj): AnyObj {
	return class EmbeddedMarkdownEditor extends (Base as any) {
		options: EmbeddedEditorOptions;

		constructor(app: App, container: HTMLElement, options: EmbeddedEditorOptions) {
			super(app, container, {
				app,
				// give the internal editor the small host object it expects
				onMarkdownScroll: () => {},
				getMode: () => 'source',
			});
			this.options = options;

			// point editor commands at this embedded editor
			this.owner.editMode = this;
			this.owner.editor = this.editor;

			// set the initial text after obsidian has built the editor
			this.set(options.value || '');

			// stop clicks inside the portal from changing the active leaf
			this.register(
				around(
					this.app.workspace,
					'setActiveLeaf',
					next =>
						(...args: any[]) => {
							if (!this.editor?.cm?.hasFocus) next.apply(this.app.workspace, args);
						},
				),
			);

			// leave active-editor ownership to the plugin's focus-based getter

			// catch boundary arrows before codemirror moves the cursor
			this.editor.cm.contentDOM.addEventListener(
				'keydown',
				(e: KeyboardEvent) => this.handleBoundaryKeys(e),
				{ capture: true },
			);
		}

		handleBoundaryKeys(e: KeyboardEvent): void {
			if (!this.options.onExit) return;
			if (e.shiftKey || e.altKey) return;
			const cm = this.editor?.cm;
			if (!cm) return;
			const sel = cm.state.selection.main;
			if (!sel.empty) return;

			const doc = cm.state.doc;
			const line = doc.lineAt(sel.head);
			const mod = e.metaKey || e.ctrlKey;

			let dir: 'up' | 'down' | null = null;
			let revealFence = false;
			let column = sel.head - line.from;

			if (mod) {
				if (e.key === 'ArrowUp' && sel.head === 0) {
					dir = 'up';
				} else if (e.key === 'ArrowDown' && sel.head === doc.length) {
					dir = 'down';
				}
			} else {
				if (e.key === 'ArrowUp' && line.number === 1) {
					dir = 'up';
				} else if (e.key === 'ArrowDown' && line.number === doc.lines) {
					dir = 'down';
				} else if (e.key === 'ArrowLeft' && sel.head === 0) {
					dir = 'up';
					column = Number.MAX_SAFE_INTEGER; // land at the end of the line above
				} else if (e.key === 'ArrowRight' && sel.head === doc.length) {
					dir = 'down';
					column = 0; // land at the start of the line below
				}
			}
			if (!dir) return;

			e.preventDefault();
			e.stopPropagation();
			this.options.onExit(dir, { revealFence, column });
		}

		focusAt(edge: 'start' | 'end', column: number): void {
			const cm = this.editor?.cm;
			if (!cm) return;
			const doc = cm.state.doc;
			const line = edge === 'start' ? doc.line(1) : doc.line(doc.lines);
			const pos = line.from + Math.min(column, line.length);
			cm.focus();
			cm.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
		}

		ownerIfContains(node: Node): unknown | null {
			return this.editor?.cm?.dom?.contains(node) ? this.owner : null;
		}

		get value(): string {
			return this.editor?.cm?.state?.doc?.toString() ?? '';
		}

		setContent(content: string): void {
			this.set(content);
		}

		hasFocus(): boolean {
			return this.editor?.cm?.hasFocus ?? false;
		}

		onUpdate(update: unknown, changed: boolean): void {
			super.onUpdate(update, changed);
			if (changed) this.options.onChange();
		}

		destroy(): void {
			if (this._loaded) this.unload();
			if (this.app.workspace.activeEditor === this.owner) {
				this.app.workspace.activeEditor = null;
			}
			super.destroy();
		}

		onunload(): void {
			super.onunload();
			this.destroy();
		}
	};
}