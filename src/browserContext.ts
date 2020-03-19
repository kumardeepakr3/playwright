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

import { helper } from './helper';
import * as network from './network';
import { Page, PageBinding } from './page';
import * as platform from './platform';
import { TimeoutSettings } from './timeoutSettings';
import * as types from './types';
import { Events } from './events';

export type BrowserContextOptions = {
  viewport?: types.Size | null,
  ignoreHTTPSErrors?: boolean,
  javaScriptEnabled?: boolean,
  bypassCSP?: boolean,
  userAgent?: string,
  locale?: string,
  timezoneId?: string,
  geolocation?: types.Geolocation,
  permissions?: string[],
  extraHTTPHeaders?: network.Headers,
  offline?: boolean,
  httpCredentials?: types.Credentials,
  deviceScaleFactor?: number,
  isMobile?: boolean,
  hasTouch?: boolean
};

export interface BrowserContext {
  setDefaultNavigationTimeout(timeout: number): void;
  setDefaultTimeout(timeout: number): void;
  pages(): Page[];
  newPage(): Promise<Page>;
  cookies(urls?: string | string[]): Promise<network.NetworkCookie[]>;
  addCookies(cookies: network.SetNetworkCookieParam[]): Promise<void>;
  clearCookies(): Promise<void>;
  clearCookie(name: string): Promise<void>;
  grantPermissions(permissions: string[], options?: { origin?: string }): Promise<void>;
  clearPermissions(): Promise<void>;
  setGeolocation(geolocation: types.Geolocation | null): Promise<void>;
  setExtraHTTPHeaders(headers: network.Headers): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  setHTTPCredentials(httpCredentials: types.Credentials | null): Promise<void>;
  addInitScript(script: Function | string | { path?: string, content?: string }, ...args: any[]): Promise<void>;
  exposeFunction(name: string, playwrightFunction: Function): Promise<void>;
  route(url: types.URLMatch, handler: network.RouteHandler): Promise<void>;
  waitForEvent(event: string, optionsOrPredicate?: Function | (types.TimeoutOptions & { predicate?: Function })): Promise<any>;
  close(): Promise<void>;
}

export abstract class BrowserContextBase extends platform.EventEmitter implements BrowserContext {
  readonly _timeoutSettings = new TimeoutSettings();
  readonly _pageBindings = new Map<string, PageBinding>();
  readonly _options: BrowserContextOptions;
  readonly _routes: { url: types.URLMatch, handler: network.RouteHandler }[] = [];
  _closed = false;
  private readonly _closePromise: Promise<Error>;
  private _closePromiseFulfill: ((error: Error) => void) | undefined;
  private _permissions = new Map<string, string[]>();

  constructor(options: BrowserContextOptions) {
    super();
    this._options = options;
    this._closePromise = new Promise(fulfill => this._closePromiseFulfill = fulfill);
  }

  _browserClosed() {
    for (const page of this.pages())
      page._didClose();
    this._didCloseInternal();
  }

  _didCloseInternal() {
    this._closed = true;
    this.emit(Events.BrowserContext.Close);
    this._closePromiseFulfill!(new Error('Context closed'));
  }

  // BrowserContext methods.
  abstract pages(): Page[];
  abstract newPage(): Promise<Page>;
  abstract cookies(...urls: string[]): Promise<network.NetworkCookie[]>;
  abstract addCookies(cookies: network.SetNetworkCookieParam[]): Promise<void>;
  abstract clearCookies(): Promise<void>;
  abstract clearCookie(name: string): Promise<void>;
  abstract _doGrantPermissions(origin: string, permissions: string[]): Promise<void>;
  abstract _doClearPermissions(): Promise<void>;
  abstract setGeolocation(geolocation: types.Geolocation | null): Promise<void>;
  abstract setHTTPCredentials(httpCredentials: types.Credentials | null): Promise<void>;
  abstract setExtraHTTPHeaders(headers: network.Headers): Promise<void>;
  abstract setOffline(offline: boolean): Promise<void>;
  abstract addInitScript(script: string | Function | { path?: string | undefined; content?: string | undefined; }, ...args: any[]): Promise<void>;
  abstract exposeFunction(name: string, playwrightFunction: Function): Promise<void>;
  abstract route(url: types.URLMatch, handler: network.RouteHandler): Promise<void>;
  abstract close(): Promise<void>;

  async grantPermissions(permissions: string[], options?: { origin?: string }) {
    let origin = '*';
    if (options && options.origin) {
      const url = new URL(options.origin);
      origin = url.origin;
    }
    const existing = new Set(this._permissions.get(origin) || []);
    permissions.forEach(p => existing.add(p));
    const list = [...existing.values()];
    this._permissions.set(origin, list);
    await this._doGrantPermissions(origin, list);
  }

  async clearPermissions() {
    this._permissions.clear();
    await this._doClearPermissions();
  }

  setDefaultNavigationTimeout(timeout: number) {
    this._timeoutSettings.setDefaultNavigationTimeout(timeout);
  }

  setDefaultTimeout(timeout: number) {
    this._timeoutSettings.setDefaultTimeout(timeout);
  }

  async waitForEvent(event: string, optionsOrPredicate?: Function | (types.TimeoutOptions & { predicate?: Function })): Promise<any> {
    if (!optionsOrPredicate)
      optionsOrPredicate = {};
    if (typeof optionsOrPredicate === 'function')
      optionsOrPredicate = { predicate: optionsOrPredicate };
    const { timeout = this._timeoutSettings.timeout(), predicate = () => true } = optionsOrPredicate;

    const abortPromise = (event === Events.BrowserContext.Close) ? new Promise<Error>(() => { }) : this._closePromise;
    return helper.waitForEvent(this, event, (...args: any[]) => !!predicate(...args), timeout, abortPromise);
  }
}

export function assertBrowserContextIsNotOwned(context: BrowserContextBase) {
  for (const page of context.pages()) {
    if (page._ownedContext)
      throw new Error('Please use browser.newContext() for multi-page scripts that share the context.');
  }
}

export function validateBrowserContextOptions(options: BrowserContextOptions): BrowserContextOptions {
  const result = { ...options };
  if (!result.viewport && result.viewport !== null)
    result.viewport = { width: 1280, height: 720 };
  if (result.viewport)
    result.viewport = { ...result.viewport };
  if (result.geolocation)
    result.geolocation = verifyGeolocation(result.geolocation);
  if (result.extraHTTPHeaders)
    result.extraHTTPHeaders = network.verifyHeaders(result.extraHTTPHeaders);
  return result;
}

export function verifyGeolocation(geolocation: types.Geolocation): types.Geolocation {
  const result = { ...geolocation };
  result.accuracy = result.accuracy || 0;
  const { longitude, latitude, accuracy } = result;
  if (!helper.isNumber(longitude) || longitude < -180 || longitude > 180)
    throw new Error(`Invalid longitude "${longitude}": precondition -180 <= LONGITUDE <= 180 failed.`);
  if (!helper.isNumber(latitude) || latitude < -90 || latitude > 90)
    throw new Error(`Invalid latitude "${latitude}": precondition -90 <= LATITUDE <= 90 failed.`);
  if (!helper.isNumber(accuracy) || accuracy < 0)
    throw new Error(`Invalid accuracy "${accuracy}": precondition 0 <= ACCURACY failed.`);
  return result;
}
