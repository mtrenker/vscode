/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const bootstrap = require('./bootstrap');

exports.parseURLQueryArgs = function () {
	const search = window.location.search || '';

	return search.split(/[?&]/)
		.filter(function (param) { return !!param; })
		.map(function (param) { return param.split('='); })
		.filter(function (param) { return param.length === 2; })
		.reduce(function (r, param) { r[param[0]] = decodeURIComponent(param[1]); return r; }, {});
};

/**
 * @param {object} destination
 * @param {object} source
 * @returns {object}
 */
exports.assign = function assign(destination, source) {
	return Object.keys(source).reduce(function (r, key) { r[key] = source[key]; return r; }, destination);
};

/**
 *
 * @param {string[]} modulePaths
 * @param {(result, configuration) => any} resultCallback
 * @param {{ forceEnableDeveloperKeybindings?: boolean, removeDeveloperKeybindingsAfterLoad?: boolean, canModifyDOM?: (config) => void, beforeLoaderConfig?: (config, loaderConfig) => void, beforeRequire?: () => void }=} options
 */
exports.load = function (modulePaths, resultCallback, options) {
	// @ts-ignore
	const webFrame = require('electron').webFrame;
	const path = require('path');

	const args = exports.parseURLQueryArgs();
	const configuration = JSON.parse(args['config'] || '{}') || {};

	// Error handler
	// @ts-ignore
	process.on('uncaughtException', function (error) { onUnexpectedError(error, enableDeveloperTools); });

	// Developer tools
	const enableDeveloperTools = (process.env['VSCODE_DEV'] || !!configuration.extensionDevelopmentPath) && !configuration.extensionTestsPath;
	let developerToolsUnbind;
	if (enableDeveloperTools || (options && options.forceEnableDeveloperKeybindings)) {
		developerToolsUnbind = registerDeveloperKeybindings();
	}

	// Correctly inherit the parent's environment
	exports.assign(process.env, configuration.userEnv);

	// Enable ASAR support
	// Note: On windows we have to be careful about the drive letter casing. If
	// the drive letter case is lowercase, we convert it to uppercase. DO NOT
	// CHANGE THIS logic or otherwise loading will fail in windows.
	let nodeModulesPath = path.join(configuration.appRoot, 'node_modules');
	if (process.platform === 'win32' && /[a-z]\:/.test(nodeModulesPath)) {
		nodeModulesPath = nodeModulesPath.charAt(0).toUpperCase() + nodeModulesPath.substr(1); // Make drive letter uppercase
	}
	bootstrap.enableASARSupport(nodeModulesPath);

	// disable pinch zoom & apply zoom level early to avoid glitches
	const zoomLevel = configuration.zoomLevel;
	webFrame.setVisualZoomLevelLimits(1, 1);
	if (typeof zoomLevel === 'number' && zoomLevel !== 0) {
		webFrame.setZoomLevel(zoomLevel);
	}

	if (options && typeof options.canModifyDOM === 'function') {
		options.canModifyDOM(configuration);
	}

	// Get the nls configuration into the process.env as early as possible.
	const nlsConfig = bootstrap.setupNLS();

	let locale = nlsConfig.availableLanguages['*'] || 'en';
	if (locale === 'zh-tw') {
		locale = 'zh-Hant';
	} else if (locale === 'zh-cn') {
		locale = 'zh-Hans';
	}

	window.document.documentElement.setAttribute('lang', locale);

	// Load the loader
	const amdLoader = require(configuration.appRoot + '/out/vs/loader.js');
	const amdRequire = amdLoader.require;
	const amdDefine = amdLoader.require.define;
	const nodeRequire = amdLoader.require.nodeRequire;

	window['nodeRequire'] = nodeRequire;
	window['require'] = amdRequire;

	// replace the patched electron fs with the original node fs for all AMD code
	amdDefine('fs', ['original-fs'], function (originalFS) { return originalFS; });

	window['MonacoEnvironment'] = {};

	const loaderConfig = {
		baseUrl: bootstrap.uriFromPath(configuration.appRoot) + '/out',
		'vs/nls': nlsConfig,
		nodeCachedDataDir: configuration.nodeCachedDataDir,
		nodeModules: [/*BUILD->INSERT_NODE_MODULES*/]
	};

	if (options && typeof options.beforeLoaderConfig === 'function') {
		options.beforeLoaderConfig(configuration, loaderConfig);
	}

	amdRequire.config(loaderConfig);

	if (nlsConfig.pseudo) {
		amdRequire(['vs/nls'], function (nlsPlugin) {
			nlsPlugin.setPseudoTranslation(nlsConfig.pseudo);
		});
	}

	if (options && typeof options.beforeRequire === 'function') {
		options.beforeRequire();
	}

	amdRequire(modulePaths, result => {
		try {
			const callbackResult = resultCallback(result, configuration);
			if (callbackResult && typeof callbackResult.then === 'function') {
				callbackResult.then(() => {
					if (developerToolsUnbind && options && options.removeDeveloperKeybindingsAfterLoad) {
						developerToolsUnbind();
					}
				}, error => {
					onUnexpectedError(error, enableDeveloperTools);
				});
			}
		} catch (error) {
			onUnexpectedError(error, enableDeveloperTools);
		}
	});
};

/**
 * @returns () => void
 */
function registerDeveloperKeybindings() {
	// @ts-ignore
	const ipc = require('electron').ipcRenderer;

	const extractKey = function (e) {
		return [
			e.ctrlKey ? 'ctrl-' : '',
			e.metaKey ? 'meta-' : '',
			e.altKey ? 'alt-' : '',
			e.shiftKey ? 'shift-' : '',
			e.keyCode
		].join('');
	};

	// Devtools & reload support
	const TOGGLE_DEV_TOOLS_KB = (process.platform === 'darwin' ? 'meta-alt-73' : 'ctrl-shift-73'); // mac: Cmd-Alt-I, rest: Ctrl-Shift-I
	const RELOAD_KB = (process.platform === 'darwin' ? 'meta-82' : 'ctrl-82'); // mac: Cmd-R, rest: Ctrl-R

	let listener = function (e) {
		const key = extractKey(e);
		if (key === TOGGLE_DEV_TOOLS_KB) {
			ipc.send('vscode:toggleDevTools');
		} else if (key === RELOAD_KB) {
			ipc.send('vscode:reloadWindow');
		}
	};

	window.addEventListener('keydown', listener);

	return function () {
		if (listener) {
			window.removeEventListener('keydown', listener);
			listener = void 0;
		}
	};
}

function onUnexpectedError(error, enableDeveloperTools) {
	// @ts-ignore
	const ipc = require('electron').ipcRenderer;

	if (enableDeveloperTools) {
		ipc.send('vscode:openDevTools');
	}

	console.error('[uncaught exception]: ' + error);

	if (error.stack) {
		console.error(error.stack);
	}
}