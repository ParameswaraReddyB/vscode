/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { window, Uri, Disposable, Event, EventEmitter, DecorationData, DecorationProvider } from 'vscode';
import { Repository, GitResourceGroup } from './repository';
import { Model } from './model';
import { debounce } from './decorators';

class GitIgnoreDecorationProvider implements DecorationProvider {

	private readonly _onDidChangeDecorations = new EventEmitter<Uri[]>();
	readonly onDidChangeDecorations: Event<Uri[]> = this._onDidChangeDecorations.event;

	private checkIgnoreQueue = new Map<string, { resolve: (status: boolean) => void, reject: (err: any) => void }>();
	private disposables: Disposable[] = [];

	constructor(private repository: Repository) {
		this.disposables.push(
			window.registerDecorationProvider(this, '.gitignore')
			//todo@joh -> events when the ignore status actually changes, not when the file changes
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.checkIgnoreQueue.clear();
	}

	provideDecoration(uri: Uri): Promise<DecorationData | undefined> {
		return new Promise<boolean>((resolve, reject) => {
			this.checkIgnoreQueue.set(uri.fsPath, { resolve, reject });
			this.checkIgnoreSoon();
		}).then(ignored => {
			if (ignored) {
				return <DecorationData>{
					priority: 3,
					opacity: 0.75
				};
			}
		});
	}

	@debounce(500)
	private checkIgnoreSoon(): void {
		const queue = new Map(this.checkIgnoreQueue.entries());
		this.checkIgnoreQueue.clear();
		this.repository.checkIgnore([...queue.keys()]).then(ignoreSet => {
			for (const [key, value] of queue.entries()) {
				value.resolve(ignoreSet.has(key));
			}
		}, err => {
			for (const [, value] of queue.entries()) {
				value.reject(err);
			}
		});
	}
}

class GitDecorationProvider implements DecorationProvider {

	private readonly _onDidChangeDecorations = new EventEmitter<Uri[]>();
	readonly onDidChangeDecorations: Event<Uri[]> = this._onDidChangeDecorations.event;

	private disposables: Disposable[] = [];
	private decorations = new Map<string, DecorationData>();

	constructor(private repository: Repository) {
		this.disposables.push(
			window.registerDecorationProvider(this, repository.root),
			repository.onDidRunOperation(this.onDidRunOperation, this)
		);
	}

	private onDidRunOperation(): void {
		let newDecorations = new Map<string, DecorationData>();
		this.collectDecorationData(this.repository.indexGroup, newDecorations);
		this.collectDecorationData(this.repository.workingTreeGroup, newDecorations);

		let uris: Uri[] = [];
		newDecorations.forEach((value, uriString) => {
			if (this.decorations.has(uriString)) {
				this.decorations.delete(uriString);
			} else {
				uris.push(Uri.parse(uriString));
			}
		});
		this.decorations.forEach((value, uriString) => {
			uris.push(Uri.parse(uriString));
		});
		this.decorations = newDecorations;
		this._onDidChangeDecorations.fire(uris);
	}

	private collectDecorationData(group: GitResourceGroup, bucket: Map<string, DecorationData>): void {
		group.resourceStates.forEach(r => {
			if (r.resourceDecoration) {
				bucket.set(r.original.toString(), r.resourceDecoration);
			}
		});
	}

	provideDecoration(uri: Uri): DecorationData | undefined {
		return this.decorations.get(uri.toString());
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}


export class GitDecorations {

	private disposables: Disposable[] = [];
	private providers = new Map<Repository, Disposable>();

	constructor(private model: Model) {
		this.disposables.push(
			model.onDidOpenRepository(this.onDidOpenRepository, this),
			model.onDidCloseRepository(this.onDidCloseRepository, this)
		);
		model.repositories.forEach(this.onDidOpenRepository, this);
	}

	private onDidOpenRepository(repository: Repository): void {
		const provider = new GitDecorationProvider(repository);
		const ignoreProvider = new GitIgnoreDecorationProvider(repository);
		this.providers.set(repository, Disposable.from(provider, ignoreProvider));
	}

	private onDidCloseRepository(repository: Repository): void {
		const provider = this.providers.get(repository);
		if (provider) {
			provider.dispose();
			this.providers.delete(repository);
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.providers.forEach(value => value.dispose);
		this.providers.clear();
	}
}
