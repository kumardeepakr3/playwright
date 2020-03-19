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

import { Browser, createPageInNewContext } from '../browser';
import { assertBrowserContextIsNotOwned, BrowserContext, BrowserContextBase, BrowserContextOptions, validateBrowserContextOptions, verifyGeolocation } from '../browserContext';
import { Events } from '../events';
import { assert, helper, RegisteredListener } from '../helper';
import * as network from '../network';
import { Page, PageBinding, PageEvent } from '../page';
import * as platform from '../platform';
import { ConnectionTransport, SlowMoTransport } from '../transport';
import * as types from '../types';
import { Protocol } from './protocol';
import { kPageProxyMessageReceived, PageProxyMessageReceivedPayload, WKConnection, WKSession } from './wkConnection';
import { WKPage } from './wkPage';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.4 Safari/605.1.15';

export class WKBrowser extends platform.EventEmitter implements Browser {
  private readonly _connection: WKConnection;
  private readonly _attachToDefaultContext: boolean;
  readonly _browserSession: WKSession;
  readonly _defaultContext: WKBrowserContext;
  readonly _contexts = new Map<string, WKBrowserContext>();
  readonly _wkPages = new Map<string, WKPage>();
  private readonly _eventListeners: RegisteredListener[];
  private _popupOpeners: string[] = [];

  private _firstPageCallback: () => void = () => {};
  private readonly _firstPagePromise: Promise<void>;

  static async connect(transport: ConnectionTransport, slowMo: number = 0, attachToDefaultContext: boolean = false): Promise<WKBrowser> {
    const browser = new WKBrowser(SlowMoTransport.wrap(transport, slowMo), attachToDefaultContext);
    return browser;
  }

  constructor(transport: ConnectionTransport, attachToDefaultContext: boolean) {
    super();
    this._connection = new WKConnection(transport, this._onDisconnect.bind(this));
    this._attachToDefaultContext = attachToDefaultContext;
    this._browserSession = this._connection.browserSession;

    this._defaultContext = new WKBrowserContext(this, undefined, validateBrowserContextOptions({}));

    this._eventListeners = [
      helper.addEventListener(this._browserSession, 'Playwright.pageProxyCreated', this._onPageProxyCreated.bind(this)),
      helper.addEventListener(this._browserSession, 'Playwright.pageProxyDestroyed', this._onPageProxyDestroyed.bind(this)),
      helper.addEventListener(this._browserSession, 'Playwright.provisionalLoadFailed', event => this._onProvisionalLoadFailed(event)),
      helper.addEventListener(this._browserSession, 'Playwright.windowOpen', this._onWindowOpen.bind(this)),
      helper.addEventListener(this._browserSession, kPageProxyMessageReceived, this._onPageProxyMessageReceived.bind(this)),
    ];

    this._firstPagePromise = new Promise<void>(resolve => this._firstPageCallback = resolve);
  }

  _onDisconnect() {
    for (const wkPage of this._wkPages.values())
      wkPage.dispose();
    for (const context of this._contexts.values())
      context._browserClosed();
    // Note: previous method uses pages to issue 'close' event on them, so we clear them after.
    this._wkPages.clear();
    this.emit(Events.Browser.Disconnected);
  }

  async newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    options = validateBrowserContextOptions(options);
    const { browserContextId } = await this._browserSession.send('Playwright.createContext');
    options.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    const context = new WKBrowserContext(this, browserContextId, options);
    await context._initialize();
    this._contexts.set(browserContextId, context);
    return context;
  }

  contexts(): BrowserContext[] {
    return Array.from(this._contexts.values());
  }

  async newPage(options?: BrowserContextOptions): Promise<Page> {
    return createPageInNewContext(this, options);
  }

  async _waitForFirstPageTarget(): Promise<void> {
    assert(!this._wkPages.size);
    return this._firstPagePromise;
  }

  _onWindowOpen(payload: Protocol.Playwright.windowOpenPayload) {
    this._popupOpeners.push(payload.pageProxyId);
  }

  _onPageProxyCreated(event: Protocol.Playwright.pageProxyCreatedPayload) {
    const { pageProxyInfo } = event;
    const pageProxyId = pageProxyInfo.pageProxyId;
    let context: WKBrowserContext | null = null;
    if (pageProxyInfo.browserContextId) {
      // FIXME: we don't know about the default context id, so assume that all targets from
      // unknown contexts are created in the 'default' context which can in practice be represented
      // by multiple actual contexts in WebKit. Solving this properly will require adding context
      // lifecycle events.
      context = this._contexts.get(pageProxyInfo.browserContextId) || null;
    }
    if (!context && !this._attachToDefaultContext)
      return;
    if (!context)
      context =  this._defaultContext;
    const pageProxySession = new WKSession(this._connection, pageProxyId, `The page has been closed.`, (message: any) => {
      this._connection.rawSend({ ...message, pageProxyId });
    });
    const opener = pageProxyInfo.openerId ? this._wkPages.get(pageProxyInfo.openerId) : undefined;
    let hasInitialAboutBlank = false;
    if (pageProxyInfo.openerId) {
      const openerIndex = this._popupOpeners.indexOf(pageProxyInfo.openerId);
      if (openerIndex !== -1) {
        this._popupOpeners.splice(openerIndex, 1);
        // When this page is a result of window.open($url) call, we should have it's opener
        // in the list of popup openers. In this case we know there is an initial
        // about:blank navigation, followed by a navigation to $url.
        hasInitialAboutBlank = true;
      }
    }
    const wkPage = new WKPage(context, pageProxySession, opener || null, hasInitialAboutBlank);
    this._wkPages.set(pageProxyId, wkPage);

    const pageEvent = new PageEvent(context, wkPage.pageOrError());
    wkPage.pageOrError().then(async () => {
      this._firstPageCallback();
      context!.emit(Events.BrowserContext.Page, pageEvent);
      if (!opener)
        return;
      const openerPage = await opener.pageOrError();
      if (openerPage instanceof Page && !openerPage.isClosed())
        openerPage.emit(Events.Page.Popup, pageEvent);
    });
  }

  _onPageProxyDestroyed(event: Protocol.Playwright.pageProxyDestroyedPayload) {
    const pageProxyId = event.pageProxyId;
    const wkPage = this._wkPages.get(pageProxyId);
    if (!wkPage)
      return;
    wkPage.didClose();
    wkPage.dispose();
    this._wkPages.delete(pageProxyId);
  }

  _onPageProxyMessageReceived(event: PageProxyMessageReceivedPayload) {
    const wkPage = this._wkPages.get(event.pageProxyId);
    if (!wkPage)
      return;
    wkPage.dispatchMessageToSession(event.message);
  }

  _onProvisionalLoadFailed(event: Protocol.Playwright.provisionalLoadFailedPayload) {
    const wkPage = this._wkPages.get(event.pageProxyId);
    if (!wkPage)
      return;
    wkPage.handleProvisionalLoadFailed(event);
  }

  isConnected(): boolean {
    return !this._connection.isClosed();
  }

  async close() {
    helper.removeEventListeners(this._eventListeners);
    const disconnected = new Promise(f => this.once(Events.Browser.Disconnected, f));
    await Promise.all(this.contexts().map(context => context.close()));
    this._connection.close();
    await disconnected;
  }

  _setDebugFunction(debugFunction: (message: string) => void) {
    this._connection._debugFunction = debugFunction;
  }
}

export class WKBrowserContext extends BrowserContextBase {
  readonly _browser: WKBrowser;
  readonly _browserContextId: string | undefined;
  readonly _evaluateOnNewDocumentSources: string[];

  constructor(browser: WKBrowser, browserContextId: string | undefined, options: BrowserContextOptions) {
    super(options);
    this._browser = browser;
    this._browserContextId = browserContextId;
    this._evaluateOnNewDocumentSources = [];
  }

  async _initialize() {
    if (this._options.ignoreHTTPSErrors)
      await this._browser._browserSession.send('Playwright.setIgnoreCertificateErrors', { browserContextId: this._browserContextId, ignore: true });
    if (this._options.locale)
      await this._browser._browserSession.send('Playwright.setLanguages', { browserContextId: this._browserContextId, languages: [this._options.locale] });
    if (this._options.permissions)
      await this.grantPermissions(this._options.permissions);
    if (this._options.geolocation)
      await this.setGeolocation(this._options.geolocation);
    if (this._options.offline)
      await this.setOffline(this._options.offline);
    if (this._options.httpCredentials)
      await this.setHTTPCredentials(this._options.httpCredentials);
  }

  _wkPages(): WKPage[] {
    return Array.from(this._browser._wkPages.values()).filter(wkPage => wkPage._browserContext === this);
  }

  pages(): Page[] {
    return this._wkPages().map(wkPage => wkPage._initializedPage()).filter(pageOrNull => !!pageOrNull) as Page[];
  }

  async newPage(): Promise<Page> {
    assertBrowserContextIsNotOwned(this);
    const { pageProxyId } = await this._browser._browserSession.send('Playwright.createPage', { browserContextId: this._browserContextId });
    const wkPage = this._browser._wkPages.get(pageProxyId)!;
    const result = await wkPage.pageOrError();
    if (result instanceof Page) {
      if (result.isClosed())
        throw new Error('Page has been closed.');
      return result;
    }
    throw result;
  }

  async cookies(urls?: string | string[]): Promise<network.NetworkCookie[]> {
    const { cookies } = await this._browser._browserSession.send('Playwright.getAllCookies', { browserContextId: this._browserContextId });
    return network.filterCookies(cookies.map((c: network.NetworkCookie) => {
      const copy: any = { ... c };
      copy.expires = c.expires === -1 ? -1 : c.expires / 1000;
      delete copy.session;
      return copy as network.NetworkCookie;
    }), urls);
  }

  async addCookies(cookies: network.SetNetworkCookieParam[]) {
    const cc = network.rewriteCookies(cookies).map(c => ({
      ...c,
      session: c.expires === -1 || c.expires === undefined,
      expires: c.expires && c.expires !== -1 ? c.expires * 1000 : c.expires
    })) as Protocol.Playwright.SetCookieParam[];
    await this._browser._browserSession.send('Playwright.setCookies', { cookies: cc, browserContextId: this._browserContextId });
  }

  async clearCookies() {
    await this._browser._browserSession.send('Playwright.deleteAllCookies', { browserContextId: this._browserContextId });
  }

  async clearCookie(cookieToDelete: network.DeleteNetworkCookieParam) {
    const allCookies = await this.cookies();
    const cookieToUpdate = network.filterCookiesForDeletion(allCookies, cookieToDelete);
    for (const cookie of cookieToUpdate) {
      cookie.expires = 0; 
    }
    await this.addCookies(cookieToUpdate);
  }

  async _doGrantPermissions(origin: string, permissions: string[]) {
    const webPermissionToProtocol = new Map<string, string>([
      ['geolocation', 'geolocation'],
    ]);
    const filtered = permissions.map(permission => {
      const protocolPermission = webPermissionToProtocol.get(permission);
      if (!protocolPermission)
        throw new Error('Unknown permission: ' + permission);
      return protocolPermission;
    });
    await this._browser._browserSession.send('Playwright.grantPermissions', { origin, browserContextId: this._browserContextId, permissions: filtered });
  }

  async _doClearPermissions() {
    await this._browser._browserSession.send('Playwright.resetPermissions', { browserContextId: this._browserContextId });
  }

  async setGeolocation(geolocation: types.Geolocation | null): Promise<void> {
    if (geolocation)
      geolocation = verifyGeolocation(geolocation);
    this._options.geolocation = geolocation || undefined;
    const payload: any = geolocation ? { ...geolocation, timestamp: Date.now() } : undefined;
    await this._browser._browserSession.send('Playwright.setGeolocationOverride', { browserContextId: this._browserContextId, geolocation: payload });
  }

  async setExtraHTTPHeaders(headers: network.Headers): Promise<void> {
    this._options.extraHTTPHeaders = network.verifyHeaders(headers);
    for (const page of this.pages())
      await (page._delegate as WKPage).updateExtraHTTPHeaders();
  }

  async setOffline(offline: boolean): Promise<void> {
    this._options.offline = offline;
    for (const page of this.pages())
      await (page._delegate as WKPage).updateOffline();
  }

  async setHTTPCredentials(httpCredentials: types.Credentials | null): Promise<void> {
    this._options.httpCredentials = httpCredentials || undefined;
    for (const page of this.pages())
      await (page._delegate as WKPage).updateHttpCredentials();
  }

  async addInitScript(script: Function | string | { path?: string, content?: string }, ...args: any[]) {
    const source = await helper.evaluationScript(script, args);
    this._evaluateOnNewDocumentSources.push(source);
    for (const page of this.pages())
      await (page._delegate as WKPage)._updateBootstrapScript();
  }

  async exposeFunction(name: string, playwrightFunction: Function): Promise<void> {
    for (const page of this.pages()) {
      if (page._pageBindings.has(name))
        throw new Error(`Function "${name}" has been already registered in one of the pages`);
    }
    if (this._pageBindings.has(name))
      throw new Error(`Function "${name}" has been already registered`);
    const binding = new PageBinding(name, playwrightFunction);
    this._pageBindings.set(name, binding);
    for (const page of this.pages())
      await (page._delegate as WKPage).exposeBinding(binding);
  }

  async route(url: types.URLMatch, handler: network.RouteHandler): Promise<void> {
    this._routes.push({ url, handler });
    for (const page of this.pages())
      await (page._delegate as WKPage).updateRequestInterception();
  }

  async close() {
    if (this._closed)
      return;
    if (!this._browserContextId) {
      // Default context is only created in 'persistent' mode and closing it should close
      // the browser.
      await this._browser.close();
      return;
    }
    await this._browser._browserSession.send('Playwright.deleteContext', { browserContextId: this._browserContextId });
    this._browser._contexts.delete(this._browserContextId);
    this._didCloseInternal();
  }
}
