// Interactive sign-in for the server (run once by the installer, or again any time)
const path = require('path');
const readline = require('readline');
const { app, safeStorage } = require('electron');
const U = require('../src/util');
const { Config } = require('../src/config');
const { Cloud } = require('../src/cloud');

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else if (s.match(/[\r\n]/)) rl.output.write('\n'); };
    }
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

(async () => {
  U.init(path.join(app.getPath('userData'), 'data'));
  const cfg = new Config();
  const cloud = new Cloud({ cfg, log: (m) => console.log(m), safe: safeStorage, version: app.getVersion(), hooks: { addresses: () => [] } });
  await cloud.init();
  if (cloud.signedIn) console.log(`Currently signed in as ${cloud.user.email}. Signing in again replaces it.`);
  for (let i = 0; i < 3; i++) {
    const email = (await ask('Switchboard account email: ')).trim();
    const password = await ask('Password: ', true);
    try {
      await cloud.signIn(email, password, { start: false });
      console.log(`Signed in as ${email}. This server is now at the top of your PC list, so it runs your accounts.`);
      process.exit(0);
    } catch (e) {
      console.log('Could not sign in: ' + e.message);
    }
  }
  process.exit(1);
})();
