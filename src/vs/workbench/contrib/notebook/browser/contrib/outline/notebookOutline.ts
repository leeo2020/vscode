/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./notebookOutline';
import { Codicon } from 'vs/base/common/codicons';
import { Emitter, Event } from 'vs/base/common/event';
import { combinedDisposable, IDisposable, Disposable, DisposableStore, MutableDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { IThemeService, ThemeIcon } from 'vs/platform/theme/common/themeService';
import { CellRevealType, IActiveNotebookEditor, ICellViewModel, INotebookEditorOptions, INotebookEditorPane, INotebookViewCellsUpdateEvent } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { NotebookEditor } from 'vs/workbench/contrib/notebook/browser/notebookEditor';
import { CellKind } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { IOutline, IOutlineComparator, IOutlineCreator, IOutlineListConfig, IOutlineService, IQuickPickDataSource, IQuickPickOutlineElement, OutlineChangeEvent, OutlineConfigCollapseItemsValues, OutlineConfigKeys, OutlineTarget } from 'vs/workbench/services/outline/browser/outline';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/registry/common/platform';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { IEditorPane } from 'vs/workbench/common/editor';
import { IKeyboardNavigationLabelProvider, IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { IDataSource, ITreeNode, ITreeRenderer } from 'vs/base/browser/ui/tree/tree';
import { createMatches, FuzzyScore } from 'vs/base/common/filters';
import { IconLabel, IIconLabelValueOptions } from 'vs/base/browser/ui/iconLabel/iconLabel';
import { IListAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';
import { IEditorOptions } from 'vs/platform/editor/common/editor';
import { IEditorService, SIDE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { getIconClassesForLanguageId } from 'vs/editor/common/services/getIconClasses';
import { IWorkbenchDataTreeOptions } from 'vs/platform/list/browser/listService';
import { localize } from 'vs/nls';
import { IMarkerService, MarkerSeverity } from 'vs/platform/markers/common/markers';
import { listErrorForeground, listWarningForeground } from 'vs/platform/theme/common/colorRegistry';
import { isEqual } from 'vs/base/common/resources';
import { IdleValue } from 'vs/base/common/async';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { marked } from 'vs/base/common/marked/marked';
import { renderMarkdownAsPlaintext } from 'vs/base/browser/markdownRenderer';
import { INotebookExecutionStateService } from 'vs/workbench/contrib/notebook/common/notebookExecutionStateService';
import { executingStateIcon } from 'vs/workbench/contrib/notebook/browser/notebookIcons';
import { URI } from 'vs/base/common/uri';

export interface IOutlineMarkerInfo {
	readonly count: number;
	readonly topSev: MarkerSeverity;
}

export class OutlineEntry {

	private _children: OutlineEntry[] = [];
	private _parent: OutlineEntry | undefined;
	private _markerInfo: IOutlineMarkerInfo | undefined;

	get icon(): ThemeIcon {
		return this.isExecuting && this.isPaused ? executingStateIcon :
			this.isExecuting ? ThemeIcon.modify(executingStateIcon, 'spin') :
				this.cell.cellKind === CellKind.Markup ? Codicon.markdown : Codicon.code;
	}

	constructor(
		readonly index: number,
		readonly level: number,
		readonly cell: ICellViewModel,
		readonly label: string,
		readonly isExecuting: boolean,
		readonly isPaused: boolean
	) { }

	addChild(entry: OutlineEntry) {
		this._children.push(entry);
		entry._parent = this;
	}

	get parent(): OutlineEntry | undefined {
		return this._parent;
	}

	get children(): Iterable<OutlineEntry> {
		return this._children;
	}

	get markerInfo(): IOutlineMarkerInfo | undefined {
		return this._markerInfo;
	}

	updateMarkers(markerService: IMarkerService): void {
		if (this.cell.cellKind === CellKind.Code) {
			// a code cell can have marker
			const marker = markerService.read({ resource: this.cell.uri, severities: MarkerSeverity.Error | MarkerSeverity.Warning });
			if (marker.length === 0) {
				this._markerInfo = undefined;
			} else {
				const topSev = marker.find(a => a.severity === MarkerSeverity.Error)?.severity ?? MarkerSeverity.Warning;
				this._markerInfo = { topSev, count: marker.length };
			}
		} else {
			// a markdown cell can inherit markers from its children
			let topChild: MarkerSeverity | undefined;
			for (const child of this.children) {
				child.updateMarkers(markerService);
				if (child.markerInfo) {
					topChild = !topChild ? child.markerInfo.topSev : Math.max(child.markerInfo.topSev, topChild);
				}
			}
			this._markerInfo = topChild && { topSev: topChild, count: 0 };
		}
	}

	clearMarkers(): void {
		this._markerInfo = undefined;
		for (const child of this.children) {
			child.clearMarkers();
		}
	}

	find(cell: ICellViewModel, parents: OutlineEntry[]): OutlineEntry | undefined {
		if (cell.id === this.cell.id) {
			return this;
		}
		parents.push(this);
		for (const child of this.children) {
			const result = child.find(cell, parents);
			if (result) {
				return result;
			}
		}
		parents.pop();
		return undefined;
	}

	asFlatList(bucket: OutlineEntry[]): void {
		bucket.push(this);
		for (const child of this.children) {
			child.asFlatList(bucket);
		}
	}
}

class NotebookOutlineTemplate {

	static readonly templateId = 'NotebookOutlineRenderer';

	constructor(
		readonly container: HTMLElement,
		readonly iconClass: HTMLElement,
		readonly iconLabel: IconLabel,
		readonly decoration: HTMLElement
	) { }
}

class NotebookOutlineRenderer implements ITreeRenderer<OutlineEntry, FuzzyScore, NotebookOutlineTemplate> {

	templateId: string = NotebookOutlineTemplate.templateId;

	constructor(
		@IThemeService private readonly _themeService: IThemeService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	renderTemplate(container: HTMLElement): NotebookOutlineTemplate {
		container.classList.add('notebook-outline-element', 'show-file-icons');
		const iconClass = document.createElement('div');
		container.append(iconClass);
		const iconLabel = new IconLabel(container, { supportHighlights: true });
		const decoration = document.createElement('div');
		decoration.className = 'element-decoration';
		container.append(decoration);
		return new NotebookOutlineTemplate(container, iconClass, iconLabel, decoration);
	}

	renderElement(node: ITreeNode<OutlineEntry, FuzzyScore>, _index: number, template: NotebookOutlineTemplate, _height: number | undefined): void {
		const extraClasses: string[] = [];
		const options: IIconLabelValueOptions = {
			matches: createMatches(node.filterData),
			labelEscapeNewLines: true,
			extraClasses,
		};

		if (node.element.cell.cellKind === CellKind.Code && this._themeService.getFileIconTheme().hasFileIcons && !node.element.isExecuting) {
			template.iconClass.className = '';
			extraClasses.push(...getIconClassesForLanguageId(node.element.cell.language ?? ''));
		} else {
			template.iconClass.className = 'element-icon ' + ThemeIcon.asClassNameArray(node.element.icon).join(' ');
		}

		template.iconLabel.setLabel(node.element.label, undefined, options);

		const { markerInfo } = node.element;

		template.container.style.removeProperty('--outline-element-color');
		template.decoration.innerText = '';
		if (markerInfo) {
			const useBadges = this._configurationService.getValue(OutlineConfigKeys.problemsBadges);
			if (!useBadges) {
				template.decoration.classList.remove('bubble');
				template.decoration.innerText = '';
			} else if (markerInfo.count === 0) {
				template.decoration.classList.add('bubble');
				template.decoration.innerText = '\uea71';
			} else {
				template.decoration.classList.remove('bubble');
				template.decoration.innerText = markerInfo.count > 9 ? '9+' : String(markerInfo.count);
			}
			const color = this._themeService.getColorTheme().getColor(markerInfo.topSev === MarkerSeverity.Error ? listErrorForeground : listWarningForeground);
			const useColors = this._configurationService.getValue(OutlineConfigKeys.problemsColors);
			if (!useColors) {
				template.container.style.removeProperty('--outline-element-color');
				template.decoration.style.setProperty('--outline-element-color', color?.toString() ?? 'inherit');
			} else {
				template.container.style.setProperty('--outline-element-color', color?.toString() ?? 'inherit');
			}
		}
	}

	disposeTemplate(templateData: NotebookOutlineTemplate): void {
		templateData.iconLabel.dispose();
	}
}

class NotebookOutlineAccessibility implements IListAccessibilityProvider<OutlineEntry> {
	getAriaLabel(element: OutlineEntry): string | null {
		return element.label;
	}
	getWidgetAriaLabel(): string {
		return '';
	}
}

class NotebookNavigationLabelProvider implements IKeyboardNavigationLabelProvider<OutlineEntry> {
	getKeyboardNavigationLabel(element: OutlineEntry): { toString(): string | undefined } | { toString(): string | undefined }[] | undefined {
		return element.label;
	}
}

class NotebookOutlineVirtualDelegate implements IListVirtualDelegate<OutlineEntry> {

	getHeight(_element: OutlineEntry): number {
		return 22;
	}

	getTemplateId(_element: OutlineEntry): string {
		return NotebookOutlineTemplate.templateId;
	}
}

class NotebookQuickPickProvider implements IQuickPickDataSource<OutlineEntry> {

	constructor(
		private _getEntries: () => OutlineEntry[],
		@IThemeService private readonly _themeService: IThemeService
	) { }

	getQuickPickElements(): IQuickPickOutlineElement<OutlineEntry>[] {
		const bucket: OutlineEntry[] = [];
		for (const entry of this._getEntries()) {
			entry.asFlatList(bucket);
		}
		const result: IQuickPickOutlineElement<OutlineEntry>[] = [];
		const { hasFileIcons } = this._themeService.getFileIconTheme();
		for (const element of bucket) {
			// todo@jrieken it is fishy that codicons cannot be used with iconClasses
			// but file icons can...
			result.push({
				element,
				label: hasFileIcons ? element.label : `$(${element.icon.id}) ${element.label}`,
				ariaLabel: element.label,
				iconClasses: hasFileIcons ? getIconClassesForLanguageId(element.cell.language ?? '') : undefined,
			});
		}
		return result;
	}
}

class NotebookComparator implements IOutlineComparator<OutlineEntry> {

	private readonly _collator = new IdleValue<Intl.Collator>(() => new Intl.Collator(undefined, { numeric: true }));

	compareByPosition(a: OutlineEntry, b: OutlineEntry): number {
		return a.index - b.index;
	}
	compareByType(a: OutlineEntry, b: OutlineEntry): number {
		return a.cell.cellKind - b.cell.cellKind || this._collator.value.compare(a.label, b.label);
	}
	compareByName(a: OutlineEntry, b: OutlineEntry): number {
		return this._collator.value.compare(a.label, b.label);
	}
}

export class NotebookCellOutline implements IOutline<OutlineEntry> {

	private readonly _dispoables = new DisposableStore();

	private readonly _onDidChange = new Emitter<OutlineChangeEvent>();

	readonly onDidChange: Event<OutlineChangeEvent> = this._onDidChange.event;

	private _uri: URI | undefined;
	private _entries: OutlineEntry[] = [];
	private _activeEntry?: OutlineEntry;
	private readonly _entriesDisposables = new DisposableStore();

	readonly config: IOutlineListConfig<OutlineEntry>;
	readonly outlineKind = 'notebookCells';

	get activeElement(): OutlineEntry | undefined {
		return this._activeEntry;
	}

	constructor(
		private readonly _editor: INotebookEditorPane,
		private readonly _target: OutlineTarget,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IEditorService private readonly _editorService: IEditorService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotebookExecutionStateService private readonly _notebookExecutionStateService: INotebookExecutionStateService,
	) {
		const selectionListener = new MutableDisposable();
		this._dispoables.add(selectionListener);
		const installSelectionListener = () => {
			const notebookEditor = _editor.getControl();
			if (!notebookEditor?.hasModel()) {
				selectionListener.clear();
			} else {
				selectionListener.value = combinedDisposable(
					Event.debounce<void, void>(
						notebookEditor.onDidChangeSelection,
						(last, _current) => last,
						200
					)(this._recomputeActive, this),
					Event.debounce<INotebookViewCellsUpdateEvent, INotebookViewCellsUpdateEvent>(
						notebookEditor.onDidChangeViewCells,
						(last, _current) => last ?? _current,
						200
					)(this._recomputeState, this)
				);
			}
		};

		this._dispoables.add(_editor.onDidChangeModel(() => {
			this._recomputeState();
			installSelectionListener();
		}));

		this._dispoables.add(_configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('notebook.outline.showCodeCells')) {
				this._recomputeState();
			}
		}));

		this._dispoables.add(themeService.onDidFileIconThemeChange(() => {
			this._onDidChange.fire({});
		}));

		this._dispoables.add(_notebookExecutionStateService.onDidChangeCellExecution(e => {
			if (!!this._editor.textModel && e.affectsNotebook(this._editor.textModel?.uri)) {
				this._recomputeState();
			}
		}));

		this._recomputeState();
		installSelectionListener();

		const options: IWorkbenchDataTreeOptions<OutlineEntry, FuzzyScore> = {
			collapseByDefault: _target === OutlineTarget.Breadcrumbs || (_target === OutlineTarget.OutlinePane && _configurationService.getValue(OutlineConfigKeys.collapseItems) === OutlineConfigCollapseItemsValues.Collapsed),
			expandOnlyOnTwistieClick: true,
			multipleSelectionSupport: false,
			accessibilityProvider: new NotebookOutlineAccessibility(),
			identityProvider: { getId: element => element.cell.uri.toString() },
			keyboardNavigationLabelProvider: new NotebookNavigationLabelProvider()
		};

		const treeDataSource: IDataSource<this, OutlineEntry> = { getChildren: parent => parent instanceof NotebookCellOutline ? this._entries : parent.children };
		const delegate = new NotebookOutlineVirtualDelegate();
		const renderers = [instantiationService.createInstance(NotebookOutlineRenderer)];
		const comparator = new NotebookComparator();

		this.config = {
			breadcrumbsDataSource: {
				getBreadcrumbElements: () => {
					const result: OutlineEntry[] = [];
					let candidate = this._activeEntry;
					while (candidate) {
						result.unshift(candidate);
						candidate = candidate.parent;
					}
					return result;
				}
			},
			quickPickDataSource: instantiationService.createInstance(NotebookQuickPickProvider, () => this._entries),
			treeDataSource,
			delegate,
			renderers,
			comparator,
			options
		};
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._dispoables.dispose();
		this._entriesDisposables.dispose();
	}

	private _recomputeState(): void {
		this._entriesDisposables.clear();
		this._activeEntry = undefined;
		this._entries.length = 0;
		this._uri = undefined;

		const notebookEditorControl = this._editor.getControl();

		if (!notebookEditorControl) {
			return;
		}

		if (!notebookEditorControl.hasModel()) {
			return;
		}

		this._uri = notebookEditorControl.textModel.uri;

		const notebookEditorWidget: IActiveNotebookEditor = notebookEditorControl;

		if (notebookEditorWidget.getLength() === 0) {
			return;
		}

		let includeCodeCells = true;
		if (this._target === OutlineTarget.OutlinePane) {
			includeCodeCells = this._configurationService.getValue<boolean>('notebook.outline.showCodeCells');
		} else if (this._target === OutlineTarget.Breadcrumbs) {
			includeCodeCells = this._configurationService.getValue<boolean>('notebook.breadcrumbs.showCodeCells');
		}

		const focusedCellIndex = notebookEditorWidget.getFocus().start;
		const focused = notebookEditorWidget.cellAt(focusedCellIndex)?.handle;
		const entries: OutlineEntry[] = [];

		for (let i = 0; i < notebookEditorWidget.getLength(); i++) {
			const cell = notebookEditorWidget.cellAt(i);
			const isMarkdown = cell.cellKind === CellKind.Markup;
			if (!isMarkdown && !includeCodeCells) {
				continue;
			}

			// cap the amount of characters that we look at and use the following logic
			// - for MD prefer headings (each header is an entry)
			// - otherwise use the first none-empty line of the cell (MD or code)
			let content = this._getCellFirstNonEmptyLine(cell);
			let hasHeader = false;

			if (isMarkdown) {
				const fullContent = cell.getText().substring(0, 10_000);
				for (const token of marked.lexer(fullContent, { gfm: true })) {
					if (token.type === 'heading') {
						hasHeader = true;
						entries.push(new OutlineEntry(entries.length, token.depth, cell, renderMarkdownAsPlaintext({ value: token.text }).trim(), false, false));
					}
				}
				if (!hasHeader) {
					// no markdown syntax headers, try to find html tags
					const match = fullContent.match(/<h([1-6]).*>(.*)<\/h\1>/i);
					if (match) {
						hasHeader = true;
						const level = parseInt(match[1]);
						const text = match[2].trim();
						entries.push(new OutlineEntry(entries.length, level, cell, text, false, false));
					}
				}

				if (!hasHeader) {
					content = renderMarkdownAsPlaintext({ value: content });
				}
			}

			if (!hasHeader) {
				let preview = content.trim();
				if (preview.length === 0) {
					// empty or just whitespace
					preview = localize('empty', "empty cell");
				}

				const exeState = !isMarkdown && this._notebookExecutionStateService.getCellExecution(cell.uri);
				entries.push(new OutlineEntry(entries.length, 7, cell, preview, !!exeState, exeState ? exeState.isPaused : false));
			}

			if (cell.handle === focused) {
				this._activeEntry = entries[entries.length - 1];
			}

			// send an event whenever any of the cells change
			this._entriesDisposables.add(cell.model.onDidChangeContent(() => {
				this._recomputeState();
				this._onDidChange.fire({});
			}));
		}

		// build a tree from the list of entries
		if (entries.length > 0) {
			const result: OutlineEntry[] = [entries[0]];
			const parentStack: OutlineEntry[] = [entries[0]];

			for (let i = 1; i < entries.length; i++) {
				const entry = entries[i];

				while (true) {
					const len = parentStack.length;
					if (len === 0) {
						// root node
						result.push(entry);
						parentStack.push(entry);
						break;

					} else {
						const parentCandidate = parentStack[len - 1];
						if (parentCandidate.level < entry.level) {
							parentCandidate.addChild(entry);
							parentStack.push(entry);
							break;
						} else {
							parentStack.pop();
						}
					}
				}
			}
			this._entries = result;
		}

		// feature: show markers with each cell
		const markerServiceListener = new MutableDisposable();
		this._entriesDisposables.add(markerServiceListener);
		const updateMarkerUpdater = () => {
			const doUpdateMarker = (clear: boolean) => {
				for (const entry of this._entries) {
					if (clear) {
						entry.clearMarkers();
					} else {
						entry.updateMarkers(this._markerService);
					}
				}
			};
			if (this._configurationService.getValue(OutlineConfigKeys.problemsEnabled)) {
				markerServiceListener.value = this._markerService.onMarkerChanged(e => {
					if (e.some(uri => notebookEditorWidget.getCellsInRange().some(cell => isEqual(cell.uri, uri)))) {
						doUpdateMarker(false);
						this._onDidChange.fire({});
					}
				});
				doUpdateMarker(false);
			} else {
				markerServiceListener.clear();
				doUpdateMarker(true);
			}
		};
		updateMarkerUpdater();
		this._entriesDisposables.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(OutlineConfigKeys.problemsEnabled)) {
				updateMarkerUpdater();
				this._onDidChange.fire({});
			}
		}));

		this._onDidChange.fire({});
	}

	private _recomputeActive(): void {
		let newActive: OutlineEntry | undefined;
		const notebookEditorWidget = this._editor.getControl();

		if (notebookEditorWidget) {
			if (notebookEditorWidget.hasModel() && notebookEditorWidget.getLength() > 0) {
				const cell = notebookEditorWidget.cellAt(notebookEditorWidget.getFocus().start);
				if (cell) {
					for (const entry of this._entries) {
						newActive = entry.find(cell, []);
						if (newActive) {
							break;
						}
					}
				}
			}
		}
		if (newActive !== this._activeEntry) {
			this._activeEntry = newActive;
			this._onDidChange.fire({ affectOnlyActiveElement: true });
		}
	}

	private _getCellFirstNonEmptyLine(cell: ICellViewModel) {
		const textBuffer = cell.textBuffer;
		for (let i = 0; i < textBuffer.getLineCount(); i++) {
			const firstNonWhitespace = textBuffer.getLineFirstNonWhitespaceColumn(i + 1);
			const lineLength = textBuffer.getLineLength(i + 1);
			if (firstNonWhitespace < lineLength) {
				return textBuffer.getLineContent(i + 1);
			}
		}

		return cell.getText().substring(0, 10_000);
	}

	get isEmpty(): boolean {
		return this._entries.length === 0;
	}

	get uri() {
		return this._uri;
	}

	async reveal(entry: OutlineEntry, options: IEditorOptions, sideBySide: boolean): Promise<void> {
		await this._editorService.openEditor({
			resource: entry.cell.uri,
			options: {
				...options,
				override: this._editor.input?.editorId,
				cellRevealType: CellRevealType.NearTopIfOutsideViewport
			} as INotebookEditorOptions,
		}, sideBySide ? SIDE_GROUP : undefined);
	}

	preview(entry: OutlineEntry): IDisposable {
		const widget = this._editor.getControl();
		if (!widget) {
			return Disposable.None;
		}
		widget.revealInCenterIfOutsideViewport(entry.cell);
		const ids = widget.deltaCellDecorations([], [{
			handle: entry.cell.handle,
			options: { className: 'nb-symbolHighlight', outputClassName: 'nb-symbolHighlight' }
		}]);
		return toDisposable(() => { widget.deltaCellDecorations(ids, []); });

	}

	captureViewState(): IDisposable {
		const widget = this._editor.getControl();
		const viewState = widget?.getEditorViewState();
		return toDisposable(() => {
			if (viewState) {
				widget?.restoreListViewState(viewState);
			}
		});
	}
}

class NotebookOutlineCreator implements IOutlineCreator<NotebookEditor, OutlineEntry> {

	readonly dispose: () => void;

	constructor(
		@IOutlineService outlineService: IOutlineService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		const reg = outlineService.registerOutlineCreator(this);
		this.dispose = () => reg.dispose();
	}

	matches(candidate: IEditorPane): candidate is NotebookEditor {
		return candidate.getId() === NotebookEditor.ID;
	}

	async createOutline(editor: NotebookEditor, target: OutlineTarget): Promise<IOutline<OutlineEntry> | undefined> {
		return this._instantiationService.createInstance(NotebookCellOutline, editor, target);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(NotebookOutlineCreator, LifecyclePhase.Eventually);


Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'notebook',
	order: 100,
	type: 'object',
	'properties': {
		'notebook.outline.showCodeCells': {
			type: 'boolean',
			default: false,
			markdownDescription: localize('outline.showCodeCells', "When enabled notebook outline shows code cells.")
		},
		'notebook.breadcrumbs.showCodeCells': {
			type: 'boolean',
			default: true,
			markdownDescription: localize('breadcrumbs.showCodeCells', "When enabled notebook breadcrumbs contain code cells.")
		},
	}
});
