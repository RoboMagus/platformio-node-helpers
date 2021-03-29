/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

 import * as misc from './misc';
 import { getCoreDir, runPIOCommand } from './core';
 
 import crypto from 'crypto';
 import fs from 'fs';
 import got from 'got';
 import jsonrpc from 'jsonrpc-lite';
 import path from 'path';
 import qs from 'querystringify';
 import tcpPortUsed from 'tcp-port-used';
 import ws from 'ws';
 
 const SERVER_LAUNCH_TIMEOUT = 30; // 30 seconds
 const SERVER_AUTOSHUTDOWN_TIMEOUT = 3600; // 1 hour
 const HTTP_HOST = '127.0.0.1';
 const HTTP_PORT_BEGIN = 8010;
 const HTTP_PORT_END = 8050;
 const SESSION_ID = crypto
   .createHash('sha1')
   .update(crypto.randomBytes(512))
   .digest('hex');
 let _HTTP_PORT = 0;
 let _HTTP_HOST = HTTP_HOST;
 let _SECURE_HOST = false;
 let _IDECMDS_LISTENER_STATUS = 0;
 
 export function constructServerUrl({
   scheme = 'http',
   host = undefined,
   port = undefined,
   path = undefined,
   query = undefined,
   includeSID = true,
 } = {}) {
 
  if(typeof window !== 'undefined') {
    console.error('location stuff: ' + window.location);
  } 
  else {
    console.error('no window!...')
  }
   //return `${scheme}://${frontend_url || `${host || _HTTP_HOST}:${port || _HTTP_PORT}`}${
   let _scheme = scheme;
   if (_SECURE_HOST) {
     _scheme = (_scheme === 'http' ? 'https' : (_scheme === 'ws' ? 'wss' : _scheme));
   }
   
   // Only add port to URL if hosted locally...
   let _url = `${host || _HTTP_HOST}`;
   if (_url === HTTP_HOST) {
     _url += `:${port || _HTTP_PORT}`;
   }

   let url = `${_scheme}://${_url}${ includeSID ? `/session/${SESSION_ID}` : '' }${path || '/'}${query ? `?${qs.stringify(query)}` : ''}`;

   console.error('constructServerUrl: ' + url);
   return url;
 }
 /*
 export function constructServerUrl_Frontend({
   scheme = 'http',
   frontend_url = undefined,
   path = undefined,
   query = undefined,
   includeSID = true,
 } = {}) {
   return `${scheme}://${frontend_url || }  ${host || _HTTP_HOST}${
     includeSID ? `/session/${SESSION_ID}` : ''
   }${path || '/'}${query ? `?${qs.stringify(query)}` : ''}`;
 }
 */
 
 export function getFrontendUrl(options) {
   const stateStorage = (loadState() || {}).storage || {};
   const params = {
     start: options.start || '/',
     theme: stateStorage.theme || options.theme,
     workspace: stateStorage.workspace || options.workspace,
   };
   Object.keys(params).forEach((key) => {
     if ([undefined, null].includes(params[key])) {
       delete params[key];
     }
   });
 
   console.error('getFrontendUrl: ' + constructServerUrl({ query: params}));
   return constructServerUrl({ query: params});
 }
 
 export async function getFrontendVersion() {
   try {
     return (
       await got(constructServerUrl({ path: '/package.json' }), { timeout: 1000 }).json()
     ).version;
   } catch (err) {}
 }
 
 async function listenIDECommands(callback) {
   console.info('listenIDECommands');
   if (_IDECMDS_LISTENER_STATUS > 0) {
     return;
   }
   const sock = new ws(constructServerUrl({ scheme: 'ws', path: '/wsrpc' }), {
     perMessageDeflate: false,
   });
   sock.onopen = () => {
     _IDECMDS_LISTENER_STATUS = 1;
     // "ping" message to initiate 'ide.listen_commands'
     sock.send(
       JSON.stringify(jsonrpc.request(Math.random().toString(), 'core.version'))
     );
   };
 
   sock.onclose = () => {
     _IDECMDS_LISTENER_STATUS = 0;
   };
 
   sock.onmessage = (event) => {
     try {
       const result = jsonrpc.parse(event.data);
       switch (result.type) {
         case 'success':
           callback(result.payload.result.method, result.payload.result.params);
           break;
 
         case 'error':
           console.error('Errored result: ' + result.payload.toString());
           break;
       }
     } catch (err) {
       console.error('Invalid RPC message: ' + err.toString());
     }
     sock.send(
       JSON.stringify(jsonrpc.request(Math.random().toString(), 'ide.listen_commands'))
     );
   };
 }
 
 async function isPortUsed(host, port) {
   return new Promise((resolve) => {
     tcpPortUsed.check(port, host).then(
       (result) => {
         return resolve(result);
       },
       () => {
         return resolve(false);
       }
     );
   });
 }
 
 async function findFreePort() {
   let port = HTTP_PORT_BEGIN;
   while (port < HTTP_PORT_END) {
     if (!(await isPortUsed(_HTTP_HOST, port))) {
       return port;
     }
     port++;
   }
   return 0;
 }
 
 export async function isServerStarted() {
   if (!(await isPortUsed(_HTTP_HOST, _HTTP_PORT))) {
     return false;
   }
   return !!(await getFrontendVersion());
 }
 
 export async function ensureServerStarted(options = {}) {
   const maxAttempts = 3;
   let attemptNums = 0;
   let lastError = undefined;
   while (attemptNums < maxAttempts) {
     try {
       return await _ensureServerStarted(options);
     } catch (err) {
       lastError = err;
       console.warn(err);
       _HTTP_PORT = 0;
       // stop all PIO Home servers
       await shutdownAllServers();
     }
     attemptNums++;
   }
   misc.reportError(lastError);
   throw lastError;
 }
 
 async function _ensureServerStarted(options = {}) {
   if (_HTTP_PORT === 0) {
     _HTTP_PORT = options.port || (await findFreePort());
   }
   _HTTP_HOST = options.host || HTTP_HOST;
   _SECURE_HOST = options.secure || _SECURE_HOST;
   let cmd_host = _HTTP_HOST;
   // If hosted externally using reverse proxy (url is given), host PIO at 0.0.0.0
   if (!isValidIPaddress(_HTTP_HOST)) {
     cmd_host = '0.0.0.0';
   }
   if (!(await isServerStarted())) {
     await new Promise((resolve, reject) => {
       runPIOCommand(
         [
           'home',
           '--port',
           _HTTP_PORT,
           '--host',
           cmd_host,
           '--session-id',
           SESSION_ID,
           '--shutdown-timeout',
           SERVER_AUTOSHUTDOWN_TIMEOUT,
           '--no-open',
         ],
         (code, stdout, stderr) => {
           console.info('ensureServerStarted -> runPIOCommand: ' + stdout);
           if (code !== 0) {
             _HTTP_PORT = 0;
             return reject(new Error(stderr));
           }
         }
       );
       //tcpPortUsed.waitUntilUsed(_HTTP_PORT, _HTTP_HOST, 500, SERVER_LAUNCH_TIMEOUT * 1000).then(
       tcpPortUsed.waitUntilUsedOnHost(443, _HTTP_HOST, 500, SERVER_LAUNCH_TIMEOUT * 1000).then(
         () => {
           console.info('port in use: ' +_HTTP_HOST+':443');
           resolve(true);
         },
         (err) => {
           reject(new Error('Could not start PIO Home server ('+_HTTP_HOST+':'+_HTTP_PORT+'): ' + err.toString()));
         }
       );
     });
   }
   if (options.onIDECommand) {
     listenIDECommands(options.onIDECommand);
   }
   return true;
 }
 
 export async function shutdownServer() {
   if (!_HTTP_PORT) {
     return;
   }
   return await got.post(constructServerUrl({ path: '/__shutdown__' }), {
     timeout: 1000,
   });
 }
 
 export async function shutdownAllServers() {
   let port = HTTP_PORT_BEGIN;
   while (port < HTTP_PORT_END) {
     try {
       got(
         constructServerUrl({ port, includeSID: false, query: { __shutdown__: '1' } }),
         { timeout: 1000, throwHttpErrors: false }
       );
     } catch (err) {}
     port++;
   }
   await misc.sleep(2000); // wait for 2 secs while server stops
 }
 
 function loadState() {
   try {
     return JSON.parse(
       fs.readFileSync(path.join(getCoreDir(), 'homestate.json'), 'utf8')
     );
   } catch (err) {}
 }
 
 function isValidIPaddress(ipaddress) {  
   if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress)) {  
     return (true);
   }  
   return (false);
 }  
 
 
 export function showAtStartup(caller) {
   const state = loadState();
   return (
     !state ||
     !state.storage ||
     !state.storage.showOnStartup ||
     !(caller in state.storage.showOnStartup) ||
     state.storage.showOnStartup[caller]
   );
 }
 