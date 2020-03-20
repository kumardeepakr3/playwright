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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectOptions, LaunchType } from '../browser';
import { BrowserContext } from '../browserContext';
import { TimeoutError } from '../errors';
import { Events } from '../events';
import { FFBrowser } from '../firefox/ffBrowser';
import { kBrowserCloseMessageId } from '../firefox/ffConnection';
import { helper } from '../helper';
import * as platform from '../platform';
import { BrowserServer } from './browserServer';
import { BrowserArgOptions, BrowserType, LaunchOptions } from './browserType';
import { launchProcess, waitForLine } from './processLauncher';

const mkdtempAsync = platform.promisify(fs.mkdtemp);

export class Firefox implements BrowserType<FFBrowser> {
  private _executablePath: (string|undefined);

  executablePath(): string {
    if (!this._executablePath)
      throw new Error('No executable path!');
    return this._executablePath;
  }

  name() {
    return 'firefox';
  }

  async launch(options?: LaunchOptions & { slowMo?: number }): Promise<FFBrowser> {
    if (options && (options as any).userDataDir)
      throw new Error('userDataDir option is not supported in `browserType.launch`. Use `browserType.launchPersistentContext` instead');
    const browserServer = await this._launchServer(options, 'local');
    const browser = await platform.connectToWebsocket(browserServer.wsEndpoint()!, transport => {
      return FFBrowser.connect(transport, false, options && options.slowMo);
    });
    // Hack: for typical launch scenario, ensure that close waits for actual process termination.
    browser.close = () => browserServer.close();
    (browser as any)['__server__'] = browserServer;
    return browser;
  }

  async launchServer(options?: LaunchOptions & { port?: number }): Promise<BrowserServer> {
    return await this._launchServer(options, 'server', undefined, options && options.port);
  }

  async launchPersistentContext(userDataDir: string, options?: LaunchOptions): Promise<BrowserContext> {
    const { timeout = 30000 } = options || {};
    const browserServer = await this._launchServer(options, 'persistent', userDataDir);
    const browser = await platform.connectToWebsocket(browserServer.wsEndpoint()!, transport => {
      return FFBrowser.connect(transport, true);
    });
    await helper.waitWithTimeout(browser._firstPagePromise, 'first page', timeout);
    // Hack: for typical launch scenario, ensure that close waits for actual process termination.
    const browserContext = browser._defaultContext;
    browserContext.close = () => browserServer.close();
    return browserContext;
  }

  private async _launchServer(options: LaunchOptions = {}, launchType: LaunchType, userDataDir?: string, port?: number): Promise<BrowserServer> {
    const {
      ignoreDefaultArgs = false,
      args = [],
      dumpio = false,
      executablePath = null,
      env = process.env,
      handleSIGHUP = true,
      handleSIGINT = true,
      handleSIGTERM = true,
      timeout = 30000,
    } = options;

    const firefoxArguments = [];

    let temporaryProfileDir = null;
    if (!userDataDir) {
      userDataDir = await mkdtempAsync(path.join(os.tmpdir(), 'playwright_dev_firefox_profile-'));
      temporaryProfileDir = userDataDir;
    }

    if (!ignoreDefaultArgs)
      firefoxArguments.push(...this._defaultArgs(options, launchType, userDataDir!, port || 0));
    else if (Array.isArray(ignoreDefaultArgs))
      firefoxArguments.push(...this._defaultArgs(options, launchType, userDataDir!, port || 0).filter(arg => !ignoreDefaultArgs.includes(arg)));
    else
      firefoxArguments.push(...args);

    const firefoxExecutable = executablePath || this._executablePath;
    if (!firefoxExecutable)
      throw new Error(`No executable path is specified. Pass "executablePath" option directly.`);

    let browserServer: BrowserServer | undefined = undefined;
    const { launchedProcess, gracefullyClose } = await launchProcess({
      executablePath: firefoxExecutable,
      args: firefoxArguments,
      env: os.platform() === 'linux' ? {
        ...env,
        // On linux Juggler ships the libstdc++ it was linked against.
        LD_LIBRARY_PATH: `${path.dirname(firefoxExecutable)}:${process.env.LD_LIBRARY_PATH}`,
      } : env,
      handleSIGINT,
      handleSIGTERM,
      handleSIGHUP,
      dumpio,
      pipe: false,
      tempDir: temporaryProfileDir || undefined,
      attemptToGracefullyClose: async () => {
        if (!browserServer)
          return Promise.reject();
        // We try to gracefully close to prevent crash reporting and core dumps.
        // Note that it's fine to reuse the pipe transport, since
        // our connection ignores kBrowserCloseMessageId.
        const transport = await platform.connectToWebsocket(browserWSEndpoint, async transport => transport);
        const message = { method: 'Browser.close', params: {}, id: kBrowserCloseMessageId };
        await transport.send(JSON.stringify(message));
      },
      onkill: (exitCode, signal) => {
        if (browserServer)
          browserServer.emit(Events.BrowserServer.Close, exitCode, signal);
      },
    });

    const timeoutError = new TimeoutError(`Timed out after ${timeout} ms while trying to connect to Firefox!`);
    const match = await waitForLine(launchedProcess, launchedProcess.stdout, /^Juggler listening on (ws:\/\/.*)$/, timeout, timeoutError);
    const browserWSEndpoint = match[1];
    browserServer = new BrowserServer(launchedProcess, gracefullyClose, browserWSEndpoint);
    return browserServer;
  }

  async connect(options: ConnectOptions): Promise<FFBrowser> {
    return await platform.connectToWebsocket(options.wsEndpoint, transport => {
      return FFBrowser.connect(transport, false, options.slowMo);
    });
  }

  private _defaultArgs(options: BrowserArgOptions = {}, launchType: LaunchType, userDataDir: string, port: number): string[] {
    const {
      devtools = false,
      headless = !devtools,
      args = [],
    } = options;
    if (devtools)
      throw new Error('Option "devtools" is not supported by Firefox');
    const userDataDirArg = args.find(arg => arg.startsWith('-profile') || arg.startsWith('--profile'));
    if (userDataDirArg)
      throw new Error('Pass userDataDir parameter instead of specifying -profile argument');
    if (args.find(arg => arg.startsWith('-juggler')))
      throw new Error('Use the port parameter instead of -juggler argument');
    if (launchType !== 'persistent' && args.find(arg => !arg.startsWith('-')))
      throw new Error('Arguments can not specify page to be opened');

    const firefoxArguments = ['-no-remote'];
    if (headless) {
      firefoxArguments.push('-headless');
    } else {
      firefoxArguments.push('-wait-for-browser');
      firefoxArguments.push('-foreground');
    }

    firefoxArguments.push(`-profile`, userDataDir);
    firefoxArguments.push('-juggler', String(port));
    firefoxArguments.push(...args);

    if (args.every(arg => arg.startsWith('-')))
      firefoxArguments.push('about:blank');
    return firefoxArguments;
  }
}

