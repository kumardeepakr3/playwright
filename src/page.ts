/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as dom from './dom';
import * as frames from './frames';
import { assert, debugError, helper } from './helper';
import * as input from './input';
import * as js from './javascript';
import * as network from './network';
import { Screenshotter } from './screenshotter';
import { TimeoutSettings } from './timeoutSettings';
import * as types from './types';
import { Events } from './events';
import { BrowserContext, BrowserContextBase } from './browserContext';
import { ConsoleMessage, ConsoleMessageLocation } from './console';
import * as accessibility from './accessibility';
import * as platform from './platform';

export interface PageDelegate {
  readonly rawMouse: input.RawMouse;
  readonly rawKeyboard: input.RawKeyboard;

  opener(): Promise<Page | null>;

  reload(): Promise<void>;
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
  exposeBinding(binding: PageBinding): Promise<void>;
  evaluateOnNewDocument(source: string): Promise<void>;
  closePage(runBeforeUnload: boolean): Promise<void>;

  navigateFrame(frame: frames.Frame, url: string, referrer: string | undefined): Promise<frames.GotoResult>;

  updateExtraHTTPHeaders(): Promise<void>;
  setViewportSize(viewportSize: types.Size): Promise<void>;
  setEmulateMedia(mediaType: types.MediaType | null, colorScheme: types.ColorScheme | null): Promise<void>;
  updateRequestInterception(): Promise<void>;
  setFileChooserIntercepted(enabled: boolean): Promise<void>;

  canScreenshotOutsideViewport(): boolean;
  resetViewport(): Promise<void>; // Only called if canScreenshotOutsideViewport() returns false.
  setBackgroundColor(color?: { r: number; g: number; b: number; a: number; }): Promise<void>;
  takeScreenshot(format: string, documentRect: types.Rect | undefined, viewportRect: types.Rect | undefined, quality: number | undefined): Promise<platform.BufferType>;

  isElementHandle(remoteObject: any): boolean;
  adoptElementHandle<T extends Node>(handle: dom.ElementHandle<T>, to: dom.FrameExecutionContext): Promise<dom.ElementHandle<T>>;
  getContentFrame(handle: dom.ElementHandle): Promise<frames.Frame | null>;  // Only called for frame owner elements.
  getOwnerFrame(handle: dom.ElementHandle): Promise<string | null>; // Returns frameId.
  getContentQuads(handle: dom.ElementHandle): Promise<types.Quad[] | null>;
  layoutViewport(): Promise<{ width: number, height: number }>;
  setInputFiles(handle: dom.ElementHandle<HTMLInputElement>, files: types.FilePayload[]): Promise<void>;
  getBoundingBox(handle: dom.ElementHandle): Promise<types.Rect | null>;
  getFrameElement(frame: frames.Frame): Promise<dom.ElementHandle>;
  scrollRectIntoViewIfNeeded(handle: dom.ElementHandle, rect?: types.Rect): Promise<void>;

  getAccessibilityTree(needle?: dom.ElementHandle): Promise<{tree: accessibility.AXNode, needle: accessibility.AXNode | null}>;
  pdf?: (options?: types.PDFOptions) => Promise<platform.BufferType>;
  coverage?: () => any;

  // Work around Chrome's non-associated input and protocol.
  inputActionEpilogue(): Promise<void>;
}

type PageState = {
  viewportSize: types.Size | null;
  mediaType: types.MediaType | null;
  colorScheme: types.ColorScheme | null;
  extraHTTPHeaders: network.Headers | null;
};

export type FileChooser = {
  element: dom.ElementHandle,
  multiple: boolean
};

export class Page extends platform.EventEmitter {
  private _closed = false;
  private _closedCallback: () => void;
  private _closedPromise: Promise<void>;
  private _disconnected = false;
  private _disconnectedCallback: (e: Error) => void;
  readonly _disconnectedPromise: Promise<Error>;
  readonly _browserContext: BrowserContextBase;
  readonly keyboard: input.Keyboard;
  readonly mouse: input.Mouse;
  readonly _timeoutSettings: TimeoutSettings;
  readonly _delegate: PageDelegate;
  readonly _state: PageState;
  readonly _pageBindings = new Map<string, PageBinding>();
  readonly _screenshotter: Screenshotter;
  readonly _frameManager: frames.FrameManager;
  readonly accessibility: accessibility.Accessibility;
  private _workers = new Map<string, Worker>();
  readonly pdf: ((options?: types.PDFOptions) => Promise<platform.BufferType>) | undefined;
  readonly coverage: any;
  readonly _routes: { url: types.URLMatch, handler: network.RouteHandler }[] = [];
  _ownedContext: BrowserContext | undefined;

  constructor(delegate: PageDelegate, browserContext: BrowserContextBase) {
    super();
    this._delegate = delegate;
    this._closedCallback = () => {};
    this._closedPromise = new Promise(f => this._closedCallback = f);
    this._disconnectedCallback = () => {};
    this._disconnectedPromise = new Promise(f => this._disconnectedCallback = f);
    this._browserContext = browserContext;
    let viewportSize: types.Size | null = null;
    if (browserContext._options.viewport) {
      viewportSize = {
        width: browserContext._options.viewport.width,
        height: browserContext._options.viewport.height,
      };
    }
    this._state = {
      viewportSize,
      mediaType: null,
      colorScheme: null,
      extraHTTPHeaders: null,
    };
    this.accessibility = new accessibility.Accessibility(delegate.getAccessibilityTree.bind(delegate));
    this.keyboard = new input.Keyboard(delegate.rawKeyboard);
    this.mouse = new input.Mouse(delegate.rawMouse, this.keyboard);
    this._timeoutSettings = new TimeoutSettings(browserContext._timeoutSettings);
    this._screenshotter = new Screenshotter(this);
    this._frameManager = new frames.FrameManager(this);
    if (delegate.pdf)
      this.pdf = delegate.pdf.bind(delegate);
    this.coverage = delegate.coverage ? delegate.coverage() : null;
  }

  _didClose() {
    assert(!this._closed, 'Page closed twice');
    this._closed = true;
    this.emit(Events.Page.Close);
    this._closedCallback();
  }

  _didCrash() {
    const error = new Error('Page crashed!');
    // Do not report node.js stack.
    error.stack = 'Error: ' + error.message; // Stack is supposed to contain error message as the first line.
    this.emit('error', error);
  }

  _didDisconnect() {
    assert(!this._disconnected, 'Page disconnected twice');
    this._disconnected = true;
    this._disconnectedCallback(new Error('Target closed'));
  }

  async _onFileChooserOpened(handle: dom.ElementHandle) {
    const multiple = await handle.evaluate(element => !!(element as HTMLInputElement).multiple);
    if (!this.listenerCount(Events.Page.FileChooser)) {
      handle.dispose();
      return;
    }
    const fileChooser: FileChooser = { element: handle, multiple };
    this.emit(Events.Page.FileChooser, fileChooser);
  }

  context(): BrowserContext {
    return this._browserContext;
  }

  async opener(): Promise<Page | null> {
    return await this._delegate.opener();
  }

  mainFrame(): frames.Frame {
    return this._frameManager.mainFrame();
  }

  frame(options: string | { name?: string, url?: types.URLMatch }): frames.Frame | null {
    const name = helper.isString(options) ? options : options.name;
    const url = helper.isObject(options) ? options.url : undefined;
    assert(name || url, 'Either name or url matcher should be specified');
    return this.frames().find(f => {
      if (name)
        return f.name() === name;
      return helper.urlMatches(f.url(), url);
    }) || null;
  }

  frames(): frames.Frame[] {
    return this._frameManager.frames();
  }

  setDefaultNavigationTimeout(timeout: number) {
    this._timeoutSettings.setDefaultNavigationTimeout(timeout);
  }

  setDefaultTimeout(timeout: number) {
    this._timeoutSettings.setDefaultTimeout(timeout);
  }

  async $(selector: string): Promise<dom.ElementHandle<Element> | null> {
    return this.mainFrame().$(selector);
  }

  async waitForSelector(selector: string, options?: types.WaitForElementOptions): Promise<dom.ElementHandle<Element> | null> {
    return this.mainFrame().waitForSelector(selector, options);
  }

  evaluateHandle: types.EvaluateHandle = async (pageFunction, ...args) => {
    return this.mainFrame().evaluateHandle(pageFunction, ...args as any);
  }

  $eval: types.$Eval = async  (selector, pageFunction, ...args) => {
    return this.mainFrame().$eval(selector, pageFunction, ...args as any);
  }

  $$eval: types.$$Eval = async (selector, pageFunction, ...args) => {
    return this.mainFrame().$$eval(selector, pageFunction, ...args as any);
  }

  async $$(selector: string): Promise<dom.ElementHandle<Element>[]> {
    return this.mainFrame().$$(selector);
  }

  async addScriptTag(options: { url?: string; path?: string; content?: string; type?: string; }): Promise<dom.ElementHandle> {
    return this.mainFrame().addScriptTag(options);
  }

  async addStyleTag(options: { url?: string; path?: string; content?: string; }): Promise<dom.ElementHandle> {
    return this.mainFrame().addStyleTag(options);
  }

  async exposeFunction(name: string, playwrightFunction: Function) {
    if (this._pageBindings.has(name))
      throw new Error(`Function "${name}" has been already registered`);
    if (this._browserContext._pageBindings.has(name))
      throw new Error(`Function "${name}" has been already registered in the browser context`);
    const binding = new PageBinding(name, playwrightFunction);
    this._pageBindings.set(name, binding);
    await this._delegate.exposeBinding(binding);
  }

  setExtraHTTPHeaders(headers: network.Headers) {
    this._state.extraHTTPHeaders = network.verifyHeaders(headers);
    return this._delegate.updateExtraHTTPHeaders();
  }

  async _onBindingCalled(payload: string, context: js.ExecutionContext) {
    await PageBinding.dispatch(this, payload, context);
  }

  _addConsoleMessage(type: string, args: js.JSHandle[], location: ConsoleMessageLocation, text?: string) {
    const message = new ConsoleMessage(type, text, args, location);
    const intercepted = this._frameManager.interceptConsoleMessage(message);
    if (intercepted || !this.listenerCount(Events.Page.Console))
      args.forEach(arg => arg.dispose());
    else
      this.emit(Events.Page.Console, message);
  }

  url(): string {
    return this.mainFrame().url();
  }

  async content(): Promise<string> {
    return this.mainFrame().content();
  }

  async setContent(html: string, options?: types.NavigateOptions): Promise<void> {
    return this.mainFrame().setContent(html, options);
  }

  async goto(url: string, options?: frames.GotoOptions): Promise<network.Response | null> {
    return this.mainFrame().goto(url, options);
  }

  async reload(options?: types.NavigateOptions): Promise<network.Response | null> {
    const waitPromise = this.waitForNavigation(options);
    await this._delegate.reload();
    return waitPromise;
  }

  async waitForLoadState(options?: types.NavigateOptions): Promise<void> {
    return this.mainFrame().waitForLoadState(options);
  }

  async waitForNavigation(options?: types.WaitForNavigationOptions): Promise<network.Response | null> {
    return this.mainFrame().waitForNavigation(options);
  }

  async waitForEvent(event: string, optionsOrPredicate: Function | (types.TimeoutOptions & { predicate?: Function }) = {}): Promise<any> {
    if (typeof optionsOrPredicate === 'function')
      optionsOrPredicate = { predicate: optionsOrPredicate };
    const { timeout = this._timeoutSettings.timeout(), predicate = () => true } = optionsOrPredicate;
    return helper.waitForEvent(this, event, (...args: any[]) => !!predicate(...args), timeout, this._disconnectedPromise);
  }

  async waitForRequest(urlOrPredicate: string | RegExp | ((r: network.Request) => boolean), options: types.TimeoutOptions = {}): Promise<network.Request> {
    const { timeout = this._timeoutSettings.timeout() } = options;
    return helper.waitForEvent(this, Events.Page.Request, (request: network.Request) => {
      if (helper.isString(urlOrPredicate) || helper.isRegExp(urlOrPredicate))
        return helper.urlMatches(request.url(), urlOrPredicate);
      return urlOrPredicate(request);
    }, timeout, this._disconnectedPromise);
  }

  async waitForResponse(urlOrPredicate: string | RegExp | ((r: network.Response) => boolean), options: types.TimeoutOptions = {}): Promise<network.Response> {
    const { timeout = this._timeoutSettings.timeout() } = options;
    return helper.waitForEvent(this, Events.Page.Response, (response: network.Response) => {
      if (helper.isString(urlOrPredicate) || helper.isRegExp(urlOrPredicate))
        return helper.urlMatches(response.url(), urlOrPredicate);
      return urlOrPredicate(response);
    }, timeout, this._disconnectedPromise);
  }

  async goBack(options?: types.NavigateOptions): Promise<network.Response | null> {
    const waitPromise = this.waitForNavigation(options);
    const result = await this._delegate.goBack();
    if (!result) {
      waitPromise.catch(() => {});
      return null;
    }
    return waitPromise;
  }

  async goForward(options?: types.NavigateOptions): Promise<network.Response | null> {
    const waitPromise = this.waitForNavigation(options);
    const result = await this._delegate.goForward();
    if (!result) {
      waitPromise.catch(() => {});
      return null;
    }
    return waitPromise;
  }

  async emulateMedia(options: { media?: types.MediaType, colorScheme?: types.ColorScheme }) {
    assert(!options.media || types.mediaTypes.has(options.media), 'Unsupported media: ' + options.media);
    assert(!options.colorScheme || types.colorSchemes.has(options.colorScheme), 'Unsupported color scheme: ' + options.colorScheme);
    if (options.media !== undefined)
      this._state.mediaType = options.media;
    if (options.colorScheme !== undefined)
      this._state.colorScheme = options.colorScheme;
    await this._delegate.setEmulateMedia(this._state.mediaType, this._state.colorScheme);
  }

  async setViewportSize(viewportSize: types.Size) {
    this._state.viewportSize = { ...viewportSize };
    await this._delegate.setViewportSize(this._state.viewportSize);
  }

  viewportSize(): types.Size | null {
    return this._state.viewportSize;
  }

  evaluate: types.Evaluate = async (pageFunction, ...args) => {
    return this.mainFrame().evaluate(pageFunction, ...args as any);
  }

  async addInitScript(script: Function | string | { path?: string, content?: string }, ...args: any[]) {
    await this._delegate.evaluateOnNewDocument(await helper.evaluationScript(script, args));
  }

  _needsRequestInterception(): boolean {
    return this._routes.length > 0 || this._browserContext._routes.length > 0;
  }

  async route(url: types.URLMatch, handler: network.RouteHandler): Promise<void> {
    this._routes.push({ url, handler });
    await this._delegate.updateRequestInterception();
  }

  _requestStarted(request: network.Request) {
    this.emit(Events.Page.Request, request);
    const route = request._route();
    if (!route)
      return;
    for (const { url, handler } of this._routes) {
      if (helper.urlMatches(request.url(), url)) {
        handler(route, request);
        return;
      }
    }
    for (const { url, handler } of this._browserContext._routes) {
      if (helper.urlMatches(request.url(), url)) {
        handler(route, request);
        return;
      }
    }
    route.continue();
  }

  async screenshot(options?: types.ScreenshotOptions): Promise<platform.BufferType> {
    return this._screenshotter.screenshotPage(options);
  }

  async title(): Promise<string> {
    return this.mainFrame().title();
  }

  async close(options: { runBeforeUnload: (boolean | undefined); } = {runBeforeUnload: undefined}) {
    if (this._closed)
      return;
    assert(!this._disconnected, 'Protocol error: Connection closed. Most likely the page has been closed.');
    const runBeforeUnload = !!options.runBeforeUnload;
    await this._delegate.closePage(runBeforeUnload);
    if (!runBeforeUnload)
      await this._closedPromise;
    if (this._ownedContext)
      await this._ownedContext.close();
  }

  isClosed(): boolean {
    return this._closed;
  }

  async click(selector: string, options?: dom.ClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions) {
    return this.mainFrame().click(selector, options);
  }

  async dblclick(selector: string, options?: dom.MultiClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions) {
    return this.mainFrame().dblclick(selector, options);
  }

  async fill(selector: string, value: string, options?: types.NavigatingActionWaitOptions) {
    return this.mainFrame().fill(selector, value, options);
  }

  async focus(selector: string, options?: types.TimeoutOptions) {
    return this.mainFrame().focus(selector, options);
  }

  async hover(selector: string, options?: dom.PointerActionOptions & types.PointerActionWaitOptions) {
    return this.mainFrame().hover(selector, options);
  }

  async selectOption(selector: string, values: string | dom.ElementHandle | types.SelectOption | string[] | dom.ElementHandle[] | types.SelectOption[], options?: types.NavigatingActionWaitOptions): Promise<string[]> {
    return this.mainFrame().selectOption(selector, values, options);
  }

  async type(selector: string, text: string, options?: { delay?: number } & types.NavigatingActionWaitOptions) {
    return this.mainFrame().type(selector, text, options);
  }

  async press(selector: string, key: string, options?: { delay?: number } & types.NavigatingActionWaitOptions) {
    return this.mainFrame().press(selector, key, options);
  }

  async check(selector: string, options?: types.PointerActionWaitOptions & types.NavigatingActionWaitOptions) {
    return this.mainFrame().check(selector, options);
  }

  async uncheck(selector: string, options?: types.PointerActionWaitOptions & types.NavigatingActionWaitOptions) {
    return this.mainFrame().uncheck(selector, options);
  }

  async waitFor(selectorOrFunctionOrTimeout: (string | number | Function), options?: types.WaitForFunctionOptions & types.WaitForElementOptions, ...args: any[]): Promise<js.JSHandle | null> {
    return this.mainFrame().waitFor(selectorOrFunctionOrTimeout, options, ...args);
  }

  async waitForFunction(pageFunction: Function | string, options?: types.WaitForFunctionOptions, ...args: any[]): Promise<js.JSHandle> {
    return this.mainFrame().waitForFunction(pageFunction, options, ...args);
  }

  workers(): Worker[] {
    return [...this._workers.values()];
  }

  _addWorker(workerId: string, worker: Worker) {
    this._workers.set(workerId, worker);
    this.emit(Events.Page.Worker, worker);
  }

  _removeWorker(workerId: string) {
    const worker = this._workers.get(workerId);
    if (!worker)
      return;
    worker.emit(Events.Worker.Close, worker);
    this._workers.delete(workerId);
  }

  _clearWorkers() {
    for (const [workerId, worker] of this._workers) {
      worker.emit(Events.Worker.Close, worker);
      this._workers.delete(workerId);
    }
  }

  on(event: string | symbol, listener: platform.Listener): this {
    if (event === Events.Page.FileChooser) {
      if (!this.listenerCount(event))
        this._delegate.setFileChooserIntercepted(true);
    }
    super.on(event, listener);
    return this;
  }

  removeListener(event: string | symbol, listener: platform.Listener): this {
    super.removeListener(event, listener);
    if (event === Events.Page.FileChooser && !this.listenerCount(event))
      this._delegate.setFileChooserIntercepted(false);
    return this;
  }
}

export class Worker extends platform.EventEmitter {
  private _url: string;
  private _executionContextPromise: Promise<js.ExecutionContext>;
  private _executionContextCallback: (value?: js.ExecutionContext) => void;
  _existingExecutionContext: js.ExecutionContext | null = null;

  constructor(url: string) {
    super();
    this._url = url;
    this._executionContextCallback = () => {};
    this._executionContextPromise = new Promise(x => this._executionContextCallback = x);
  }

  _createExecutionContext(delegate: js.ExecutionContextDelegate) {
    this._existingExecutionContext = new js.ExecutionContext(delegate);
    this._executionContextCallback(this._existingExecutionContext);
  }

  url(): string {
    return this._url;
  }

  evaluate: types.Evaluate = async (pageFunction, ...args) => {
    return (await this._executionContextPromise).evaluate(pageFunction, ...args as any);
  }

  evaluateHandle: types.EvaluateHandle = async (pageFunction, ...args) => {
    return (await this._executionContextPromise).evaluateHandle(pageFunction, ...args as any);
  }
}

export class PageBinding {
  readonly name: string;
  readonly playwrightFunction: Function;
  readonly source: string;

  constructor(name: string, playwrightFunction: Function) {
    this.name = name;
    this.playwrightFunction = playwrightFunction;
    this.source = helper.evaluationString(addPageBinding, name);
  }

  static async dispatch(page: Page, payload: string, context: js.ExecutionContext) {
    const {name, seq, args} = JSON.parse(payload);
    let expression = null;
    try {
      let binding = page._pageBindings.get(name);
      if (!binding)
        binding = page._browserContext._pageBindings.get(name);
      const result = await binding!.playwrightFunction(...args);
      expression = helper.evaluationString(deliverResult, name, seq, result);
    } catch (error) {
      if (error instanceof Error)
        expression = helper.evaluationString(deliverError, name, seq, error.message, error.stack);
      else
        expression = helper.evaluationString(deliverErrorValue, name, seq, error);
    }
    context.evaluate(expression).catch(debugError);

    function deliverResult(name: string, seq: number, result: any) {
      (window as any)[name]['callbacks'].get(seq).resolve(result);
      (window as any)[name]['callbacks'].delete(seq);
    }

    function deliverError(name: string, seq: number, message: string, stack: string) {
      const error = new Error(message);
      error.stack = stack;
      (window as any)[name]['callbacks'].get(seq).reject(error);
      (window as any)[name]['callbacks'].delete(seq);
    }

    function deliverErrorValue(name: string, seq: number, value: any) {
      (window as any)[name]['callbacks'].get(seq).reject(value);
      (window as any)[name]['callbacks'].delete(seq);
    }
  }
}

function addPageBinding(bindingName: string) {
  const binding = (window as any)[bindingName];
  if (binding.__installed)
    return;
  (window as any)[bindingName] = (...args: any[]) => {
    const me = (window as any)[bindingName];
    let callbacks = me['callbacks'];
    if (!callbacks) {
      callbacks = new Map();
      me['callbacks'] = callbacks;
    }
    const seq = (me['lastSeq'] || 0) + 1;
    me['lastSeq'] = seq;
    const promise = new Promise((resolve, reject) => callbacks.set(seq, {resolve, reject}));
    binding(JSON.stringify({name: bindingName, seq, args}));
    return promise;
  };
  (window as any)[bindingName].__installed = true;
}
