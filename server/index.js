#!/usr/bin/env node
// Switchboard server: runs your messaging accounts 24/7 with no screen.
//   node server/index.js          start (systemd runs this)
//   node server/index.js signin   sign in to your Switchboard account (asks for email + password)
const Module = require('module');
const path = require('path');
process.env.SB_SERVER = '1';
const SHIM = path.join(__dirname, 'electron-shim.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return SHIM;
  return resolve.call(this, req, ...rest);
};

if (process.argv[2] === 'signin') require('./signin');
else require('../main.js');
