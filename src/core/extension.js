/******************************************************************************
 *
 * Shared utilities for extension scripts.
 *
 * @public {Object} scrapbook
 *****************************************************************************/

(function (root, factory) {
  // Browser globals
  factory(
    root.isDebug,
    root.browser,
    root.scrapbook,
    root,
    window,
    console,
  );
}(this, function (isDebug, browser, scrapbook, root, window, console) {

  'use strict';

  /****************************************************************************
   * ScrapBook messaging
   ***************************************************************************/

  /**
   * Add a message listener, with optional filter and errorHandler.
   *
   * @param {Function} [filter]
   * @param {Function} [errorHandler]
   * @return {Function}
   */
  scrapbook.addMessageListener = function (filter, errorHandler = ex => {
    console.error(ex);
    throw ex;
  }) {
    const listener = (message, sender) => {
      if (filter && !filter(message, sender)) { return; }

      const {cmd, args} = message;
      isDebug && console.debug(cmd, "receive", `[${sender.tab ? sender.tab.id : -1}]`, args);

      const parts = cmd.split(".");
      const subCmd = parts.pop();
      const object = parts.reduce((object, part) => {
        return object[part];
      }, root);

      // thrown Error don't show here but cause the sender to receive an error
      if (!object || !subCmd || typeof object[subCmd] !== 'function') {
        throw new Error(`Unable to invoke unknown command '${cmd}'.`);
      }

      return Promise.resolve()
        .then(() => {
          return object[subCmd](args, sender);
        })
        .catch(errorHandler);
    };
    browser.runtime.onMessage.addListener(listener);
    return listener;
  };

  /**
   * Invoke an invokable command in the background script.
   *
   * @param {Object} params
   * @param {string} params.cmd
   * @param {Object} [params.args]
   * @return {Promise<Object>}
   */
  scrapbook.invokeBackgroundScript = async function ({cmd, args}) {
    // if this is the background page
    if (window.background) {
      return window.background[cmd](args);
    }

    return scrapbook.invokeExtensionScript({cmd: `background.${cmd}`, args});
  };


  /****************************************************************************
   * ScrapBook utilities
   ***************************************************************************/

  /**
   * @return {Promise<Array>} The URL match patterns for content pages.
   */
  scrapbook.getContentPagePattern = async function () {
    const p = (async () => {
      const allowFileAccess = await browser.extension.isAllowedFileSchemeAccess();
      const urlMatch = ["http://*/*", "https://*/*"];
      if (allowFileAccess) { urlMatch.push("file:///*"); }
      return urlMatch;
    })();
    scrapbook.getContentPagePattern = () => p;
    return p;
  };

  /**
   * @return {Promise<Array>}
   */
  scrapbook.getContentTabs = async function (filter) {
    // scrapbook.getContentPagePattern() resolves to [] on Firefox Android 57
    // due to a bug of browser.tabs.query:
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1418737
    const allowFileAccess = await browser.extension.isAllowedFileSchemeAccess();
    const queryObj = Object.assign({currentWindow: true, url: "<all_urls>"}, filter);
    const tabs = await browser.tabs.query(queryObj);

    // Note that tab.hidden is only supported in Firefox >= 61. For other
    // browsers it's undefined.
    return tabs.filter((tab) => (scrapbook.isContentPage(tab.url, allowFileAccess) && !tab.hidden));
  };

  /**
   * Query for highlighted ("selected") tabs
   */
  scrapbook.getHighlightedTabs = async function ({windowId} = {}) {
    const allowFileAccess = await browser.extension.isAllowedFileSchemeAccess();
    const query = Number.isInteger(windowId) ? {windowId} : {currentWindow: true};
    // Querying for {highlighted:true} doesn't get highlighted tabs in some
    // Firefox version (e.g. 55), so we query for all tabs and filter them
    // afterwards.
    const tabs = await browser.tabs.query(query);
    return tabs.filter(t => (
      scrapbook.isContentPage(t.url, allowFileAccess) &&
      // Select active and highlighted tabs.
      //
      // Normally active tabs are always highlighted, but in some browsers
      // (e.g. Opera 58) Tab.highlighted = false, so check for active tabs
      // explictly as a fallback.
      //
      // Firefox for Android < 54 does not support Tab.highlighted. Treat
      // undefined as true.
      (t.active || t.highlighted !== false)
    ));
  };

  /**
   * @param {string} url
   * @param {boolean} [newTab] - Truthy to always open in a new tab.
   * @param {string|array|boolean} [singleton] - URL match pattern for singleton;
   *     true: match url with any query; false: not singleton.
   * @param {boolean} [inNormalWindow] - Open in a normal window only.
   * @return {Promise<Tab>}
   */
  scrapbook.visitLink = async function ({
    url,
    newTab = false,
    singleton = false,
    inNormalWindow = false,
  }) {
    // If a matched singleton tab exists, return it.
    if (singleton) {
      if (singleton === true) {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        singleton = [u.href, u.href + "?*"];
      }

      const existedTab = (await browser.tabs.query({url: singleton}))[0];

      if (existedTab) {
        if (browser.windows) {
          await browser.windows.update(existedTab.windowId, {drawAttention: true});
        }
        return await browser.tabs.update(existedTab.id, {active: true});
      }
    }

    if (newTab) {
      // If inNormalWindow, create a tab in the last focused window.
      //
      // Firefox < 60 (?) allows multiple tabs in a popup window, but the
      // user cannot switch between them.
      //
      // Chromium allows only one tab in a popup window. Although
      // tabs.create without windowId creates a new tab in the last focused
      // window, some Chromium forks has an inconsistent behavior (e.g.
      // Vivaldi creates the tab in the current window, overwriting the
      // current tab).
      if (inNormalWindow && browser.windows) {
        const win = await scrapbook.invokeBackgroundScript({
          cmd: "getLastFocusedWindow",
          args: {populate: true, windowTypes: ['normal']},
        });

        if (!win) {
          const {tabs: [tab]} = await browser.windows.create({url});
          return tab;
        }

        return await browser.tabs.create({url, windowId: win.id});
      }

      // Otherwise, create a tab in the current window.
      return await browser.tabs.create({url});
    }

    // If inNormalWindow, open in the active tab of the last focused window.
    if (inNormalWindow && browser.windows) {
      const win = await scrapbook.invokeBackgroundScript({
        cmd: "getLastFocusedWindow",
        args: {populate: true, windowTypes: ['normal']},
      });

      if (!win) {
        const {tabs: [tab]} = await browser.windows.create({url});
        return tab;
      }

      const targetTab = win.tabs.filter(x => x.active)[0];
      let currentTab;

      // In some browser the last focused window may be the extension popup
      // window, causing targetTab=currentTab. Force creating a new tab to
      // prevent an error of updating the current tab.
      if (!targetTab || ((currentTab = await browser.tabs.getCurrent()) && targetTab.id === currentTab.id)) {
        return await browser.tabs.create({url, windowId: win.id});
      }

      return await browser.tabs.update(targetTab.id, {url});
    }

    return await browser.tabs.update({url, active: true});
  };

  /**
   * Simplified API to invoke a capture with an array of tasks.
   *
   * @param {Array} tasks
   * @return {Promise<(Window|Tab)>}
   */
  scrapbook.invokeCapture = async function (tasks) {
    return await scrapbook.invokeCaptureEx({taskInfo: {tasks}, waitForResponse: false});
  };

  /**
   * Advanced API to invoke a capture.
   *
   * @param {Object} params
   * @param {?string} [params.config]
   * @param {Object} params.taskInfo
   * @param {boolean} [params.uniquify]
   * @param {boolean} [params.ignoreTitle]
   * @param {Object} [params.windowCreateData]
   * @param {Object} [params.tabCreateData]
   * @param {boolean} [params.waitForResponse]
   * @return {Promise<(Object|Window|Tab)>}
   */
  scrapbook.invokeCaptureEx = async function ({
    taskInfo,
    dialog = null,
    uniquify,
    ignoreTitle,
    windowCreateData,
    tabCreateData,
    waitForResponse = true,
  }) {
    if (dialog) {
      const missionId = scrapbook.getUuid();
      const key = {table: "batchCaptureMissionCache", id: missionId};
      await scrapbook.cache.set(key, {
        taskInfo,
        uniquify,
        ignoreTitle,
      });
      const url = browser.runtime.getURL(`capturer/${dialog}.html`) + `?mid=${missionId}`;
      return scrapbook.visitLink({url, newTab: true, inNormalWindow: true});
    }

    if (uniquify || ignoreTitle) {
      // make a deep clone
      taskInfo = JSON.parse(JSON.stringify(taskInfo));

      // remove duplicates
      if (uniquify) {
        const tabs = new Set();
        const urls = new Set();
        taskInfo.tasks = taskInfo.tasks.filter(({tabId, url}) => {
          if (Number.isInteger(tabId)) {
            if (tabs.has(tabId)) {
              return false;
            }
            tabs.add(tabId);
          } else if (url) {
            try {
              const normalizedUrl = scrapbook.normalizeUrl(url);
              if (urls.has(normalizedUrl)) {
                return false;
              }
              urls.add(normalizedUrl);
            } catch (ex) {
              throw Error(`Failed to uniquify invalid URL: ${url}`);
            }
          }
          return true;
        });
      }

      // remove title if ignoreTitle is set
      if (ignoreTitle) {
        for (const task of taskInfo.tasks) {
          delete(task.title);
        }
      }
    }

    const missionId = scrapbook.getUuid();
    const key = {table: "captureMissionCache", id: missionId};
    await scrapbook.cache.set(key, taskInfo);
    const url = browser.runtime.getURL("capturer/capturer.html") + `?mid=${missionId}`;

    // launch capturer
    let tab;
    if (browser.windows) {
      const win = await browser.windows.getCurrent();
      ({tabs: [tab]} = await browser.windows.create(Object.assign({
        url,
        type: 'popup',
        width: 400,
        height: 400,
        incognito: win.incognito,
      }, windowCreateData)));

      if (!waitForResponse) {
        return tab;
      }
    } else {
      tab = await browser.tabs.create(Object.assign({
        url,
      }, tabCreateData));

      if (!waitForResponse) {
        return tab;
      }
    }

    // wait until tab loading complete
    await new Promise((resolve, reject) => {
      const listener = (tabId, changeInfo, t) => {
        if (!(tabId === tab.id && changeInfo.status === 'complete')) { return; }
        browser.tabs.onUpdated.removeListener(listener);
        browser.tabs.onRemoved.removeListener(listener2);
        resolve(t);
      };
      const listener2 = (tabId, removeInfo) => {
        if (!(tabId === tab.id)) { return; }
        browser.tabs.onUpdated.removeListener(listener);
        browser.tabs.onRemoved.removeListener(listener2);
        reject({message: `Tab removed before loading complete.`});
      };
      browser.tabs.onUpdated.addListener(listener);
      browser.tabs.onRemoved.addListener(listener2);
    });

    // retrieve capture results
    const results = await scrapbook.invokeExtensionScript({
      id: missionId,
      cmd: 'capturer.getMissionResult',
      args: {},
    });

    return {
      tab,
      results,
    };
  };

  /**
   * Shortcut for invoking a general "capture as".
   */
  scrapbook.invokeCaptureAs = async function (taskInfo, {
    ignoreTitle = false,
  } = {}) {
    taskInfo = Object.assign({
      tasks: [],
      mode: "",
      bookId: null,
      parentId: "root",
      index: null,
      delay: null,
      options: null,
    }, taskInfo);
    if (taskInfo.options === null) {
      taskInfo.options = await scrapbook.getOptions("capture", null);
    }
    return await scrapbook.invokeCaptureEx({
      dialog: 'details',
      taskInfo,
      ignoreTitle,
    });
  };

  /**
   * @param {Object} params
   * @param {integer} params.targetTabId
   * @param {string} params.targetCallback
   * @param {string} [params.bookId]
   * @param {Object} [params.windowCreateData]
   * @param {Object} [params.tabCreateData]
   * @return {Promise<(Object|Window|Tab)>}
   */
  scrapbook.invokeItemPicker = async function ({
    targetTabId,
    targetCallback,
    bookId,
    windowCreateData,
    tabCreateData,
  }) {
    const u = new URL(browser.runtime.getURL("scrapbook/itempicker.html"));
    if (typeof targetTabId !== 'undefined') {
      u.searchParams.set('tid', targetTabId);
    }
    if (typeof targetCallback !== 'undefined') {
      u.searchParams.set('cb', targetCallback);
    }
    if (typeof bookId !== 'undefined') {
      u.searchParams.set('bookId', bookId);
    }
    const url = u.href;

    // launch 
    let tab;
    if (browser.windows) {
      const win = await browser.windows.getCurrent();
      ({tabs: [tab]} = await browser.windows.create(Object.assign({
        url,
        type: 'popup',
        width: 350,
        height: 600,
        incognito: win.incognito,
      }, windowCreateData)));
      return tab;
    } else {
      tab = await browser.tabs.create(Object.assign({
        url,
      }, tabCreateData));
      return tab;
    }
  };

  /**
   * @param {boolean} [newTab] - Whether to open in a new tab.
   * @return {undefined|Tab}
   */
  scrapbook.openScrapBook = async function ({newTab = true} = {}) {
    const url = browser.runtime.getURL("scrapbook/sidebar.html");

    if (browser.sidebarAction) {
      // This can only be called in a user action handler.
      // https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/User_actions
      return await browser.sidebarAction.open();
    }

    let sidebarTab = (await browser.tabs.query({}))
        .filter(t => scrapbook.splitUrl(t.url)[0] === url)[0];

    openInSidebarWindow: {
      // Firefox Android does not support windows
      if (!browser.windows) {
        break openInSidebarWindow;
      }

      let sidebarWindow;
      if (sidebarTab) {
        sidebarWindow = await browser.windows.get(sidebarTab.windowId);

        // Treat as if browser.windows not supported if the sidebar is opened
        // in a non-popup window.
        if (sidebarWindow.type !== 'popup') {
          break openInSidebarWindow;
        }
      }

      // get the current window before further async tasks
      // browser.windows.getCurrent throws if the current window doesn't exist
      const currentWindow = await browser.windows.getCurrent({windowTypes: ['normal']}).catch(ex => null);

      // calculate the desired position of the sidebar window
      const screenWidth = window.screen.availWidth;
      const screenHeight = window.screen.availHeight;
      const left = 0;
      const top = 0;
      const width = Math.max(Math.floor(screenWidth / 5 - 1), 200);
      const height = screenHeight - 1;

      // create or update the sidebar window
      if (sidebarWindow) {
        sidebarWindow = await browser.windows.update(sidebarWindow.id, {
          left,
          top,
          width,
          height,
          drawAttention: true,
        });
      } else {
        sidebarWindow = await browser.windows.create({
          url,
          left,
          top,
          width,
          height,
          type: 'popup',
        });
        sidebarTab = sidebarWindow.tabs[0];

        // Fix a bug for Firefox that positioning not work for windows.create
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1271047
        // @FIXME: this occasionally doesn't work.
        if (scrapbook.userAgent.is('gecko')) {
          await browser.windows.update(sidebarWindow.id, {
            left,
            top,
          });
        }
      }

      // update the current window if it exists
      if (currentWindow) {
        // calculate the desired position of the main window
        const mainLeft = Math.max(width + 1, currentWindow.left);
        const mainTop = Math.max(0, currentWindow.top);
        const mainWidth = Math.min(screenWidth - width - 1, currentWindow.width);
        const mainHeight = Math.min(screenHeight - 1, currentWindow.height);

        const axis = {state: 'normal'};
        if (mainLeft !== currentWindow.left) { axis.left = mainLeft; }
        if (mainTop !== currentWindow.top) { axis.top = mainTop; }
        if (mainWidth !== currentWindow.width) { axis.width = mainWidth; }
        if (mainHeight !== currentWindow.height) { axis.height = mainHeight; }

        await browser.windows.update(currentWindow.id, axis);
      }

      return sidebarTab;
    }

    // update the sidebar tab if it exists
    if (sidebarTab) {
      await browser.tabs.update(sidebarTab.id, {active: true});
      return sidebarTab;
    }

    return await scrapbook.visitLink({url, newTab});
  };

  scrapbook.editTab = async function ({tabId, frameId = 0, willActive, force}) {
    await scrapbook.initContentScripts(tabId);
    return await scrapbook.invokeContentScript({
      tabId,
      frameId,
      cmd: "editor.init",
      args: {willActive, force},
    });
  };

  scrapbook.searchCaptures = async function ({tabs, newTab = true}) {
    const url = new URL(browser.runtime.getURL(`scrapbook/searchCaptures.html`));
    for (const tab of tabs) {
      url.searchParams.append('q', tab.url);
    }
    return await scrapbook.visitLink({
      url: url.href,
      newTab,
    });
  };

}));
